/**
 * webhook/backlog.ts （最終版）
 * 課題タイプで処理を分岐する
 *
 * ---- 課題タイプ → 処理マッピング ----
 * ライセンス契約  ステータス→文書生成依頼  基本契約書 + 個別条件を合冊生成
 * 製造案件        ステータス→製造完了      ロイヤリティ計算 + 計算書生成
 * その他          ステータス→処理済み      検収書 + 支払通知書を生成
 *
 * ---- Backlog課題タイプID（.envで設定） ----
 * BACKLOG_ISSUE_TYPE_LICENSE   ライセンス契約
 * BACKLOG_ISSUE_TYPE_MFG       製造案件
 */

import { Router, Request, Response } from "express";
import { generateRoyaltyFromIssue } from "../documents/royaltyGenerator";
import { generateDeliveryDocuments } from "../documents/partialDeliveryGenerator";
import { renderMultipleTemplates, RenderOptions } from "../documents/templateRenderer";
import { resolveDriveFolderId, resolveDriveFolderLabel } from "../documents/driveFolders";
import { resolveConditions, RawConditionFields, ClosingType, InspectionStart } from "../documents/conditions";
import { backlog } from "../backlog/client";
import { createDeliveryEvent, findDeliveryEventByBacklogIssueKey, upsertOrderItems } from "../db/orderRepository";
import {
  createLegalRequest,
  findIssueWorkflowByIssueKey,
  findLegalRequestByBacklogKey,
  findStaffBySlackUserId,
  matchVendor,
  saveGeneratedDocuments,
  updateLegalRequestStatus,
} from "../db/repository";
import { generateOrderDocumentsFromIssue } from "../orders/generator";
import { backlog as backlogClient, BacklogIssue } from "../backlog/client";
import { resolveDriveFolderKey, resolveIssueCounterparty, resolveRequesterSlackId } from "../backlog/issueContext";
import { getBacklogCustomFieldValue, resolveIssueDocumentDate, resolveIssueDocumentNumber } from "../workflow/documentDefaults";
import { ensureIssueRootThread, postIssueAnswerback } from "../slack/threading";
import { SlackMessageClient } from "../slack/optionalClient";
import { enqueueWork, EnqueueWorkResult } from "../queue/adapter";
import { executeWorkItem } from "../queue/executor";
import { createGenerateDocumentsWorkItem, WorkIssueContent, WorkSource } from "../queue/workItems";

export function createBacklogWebhookRouter(slack: SlackMessageClient): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    res.status(200).json({ ok: true });

    const payload = req.body;
    if (payload.project?.projectKey !== process.env.BACKLOG_PROJECT_KEY) return;

    const issueTypeName: string = payload.content?.issueType?.name ?? "";
    const issueKey = `${payload.project.projectKey}-${payload.content?.keyId}`;

    console.log(`[Webhook] 受信: ${issueKey} / type=${issueTypeName} / event=${payload.type}`);

    try {
      if (payload.type === 1) {
        await handleIssueCreated(issueKey, payload, slack);
      } else if (payload.type === 2) {
        await handleIssueUpdated(issueKey, issueTypeName, payload, slack);
      } else if (payload.type === 3) {
        await handleIssueCommented(issueKey, payload, slack);
      }
    } catch (e) {
      console.error("[Webhook] 処理エラー", e);
    }
  });

  return router;
}

async function handleIssueCreated(
  issueKey: string,
  payload: BacklogWebhookPayload,
  slack: SlackMessageClient
): Promise<void> {
  await ensureIssueRootThread(slack, issueKey, undefined, { reason: "created" });

  const summary = payload.content?.summary?.trim();
  if (!summary) {
    return;
  }

  await postIssueAnswerback(slack, issueKey, {
    text: `🆕 Backlogで課題が起票されました: ${issueKey}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "*🆕 Backlogで課題が起票されました*" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*課題*\n${issueKey}` },
          { type: "mrkdwn", text: `*種別*\n${payload.content?.issueType?.name ?? "未設定"}` },
          { type: "mrkdwn", text: `*件名*\n${summary}` },
          { type: "mrkdwn", text: `*ステータス*\n${payload.content?.status?.name ?? "未設定"}` },
        ],
      },
    ] as any,
  });
}

async function handleIssueUpdated(
  issueKey: string,
  issueTypeName: string,
  payload: BacklogWebhookPayload,
  slack: SlackMessageClient
): Promise<void> {
  await postIssueAnswerback(slack, issueKey, {
    text: `📝 Backlogで課題が更新されました: ${issueKey}`,
    blocks: buildBacklogUpdateBlocks(issueKey, payload),
  });
  await routeByIssueType(issueKey, issueTypeName, payload, slack);
}

async function handleIssueCommented(
  issueKey: string,
  payload: BacklogWebhookPayload,
  slack: SlackMessageClient
): Promise<void> {
  const commentBody = truncateForSlack(normalizeBacklogText(payload.content?.comment?.content), 1200);
  await postIssueAnswerback(slack, issueKey, {
    text: `💬 Backlogにコメントが追加されました: ${issueKey}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "*💬 Backlogにコメントが追加されました*" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*課題*\n${issueKey}` },
          { type: "mrkdwn", text: `*コメント番号*\n${payload.content?.comment?.id ?? "未取得"}` },
        ],
      },
      ...(commentBody
        ? [{ type: "section", text: { type: "mrkdwn", text: `*コメント*\n>${commentBody.replace(/\n/g, "\n>")}` } }]
        : []),
    ] as any,
  });
}

function buildBacklogUpdateBlocks(issueKey: string, payload: BacklogWebhookPayload): any[] {
  const summary = payload.content?.summary?.trim() || "未設定";
  const statusName = payload.content?.status?.name ?? "未設定";
  const commentBody = truncateForSlack(normalizeBacklogText(payload.content?.comment?.content), 900);

  return [
    { type: "section", text: { type: "mrkdwn", text: "*📝 Backlogで課題が更新されました*" } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*課題*\n${issueKey}` },
        { type: "mrkdwn", text: `*ステータス*\n${statusName}` },
        { type: "mrkdwn", text: `*種別*\n${payload.content?.issueType?.name ?? "未設定"}` },
        { type: "mrkdwn", text: `*件名*\n${summary}` },
      ],
    },
    ...(commentBody
      ? [{ type: "section", text: { type: "mrkdwn", text: `*更新メモ*\n>${commentBody.replace(/\n/g, "\n>")}` } }]
      : []),
  ];
}

function normalizeBacklogText(value: unknown): string {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function truncateForSlack(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

// ================================================================
// 課題タイプ別ルーティング
// ================================================================

async function routeByIssueType(
  issueKey: string,
  issueTypeName: string,
  payload: BacklogWebhookPayload,
  slack: SlackMessageClient
): Promise<void> {
  const { content } = payload;
  const newStatus = content.status;
  if (!newStatus) return;

  const licenseTypeName  = process.env.BACKLOG_ISSUE_TYPE_LICENSE  ?? "ライセンス契約";
  const mfgTypeName      = process.env.BACKLOG_ISSUE_TYPE_MFG      ?? "製造案件";
  const consultationTypeNames = new Set([
    process.env.BACKLOG_ISSUE_TYPE_LEGAL_CONSULTATION ?? "法務相談",
    "法律相談",
  ]);
  const deliveryTypeNames = new Set([
    process.env.BACKLOG_ISSUE_TYPE_DELIVERY ?? "納品リクエスト",
    "納品リクエスト",
    "納品報告",
  ]);

  if (issueTypeName === licenseTypeName) {
    // ---- ライセンス契約 ----
    if (newStatus.id === 3) await enqueueGenerateDocumentsForIssue(issueKey, issueTypeName, content, slack, "backlog-webhook");

  } else if (issueTypeName === mfgTypeName) {
    // ---- 製造案件 ----
    if (newStatus.id === 3) {
      await enqueueGenerateDocumentsForIssue(issueKey, issueTypeName, content, slack, "backlog-webhook");
    } else if (newStatus.id === 2) {
      await notifySlack(slack, issueKey, "🏭 製造開始", `${issueKey} の製造が開始されました。`);
    }

  } else if (deliveryTypeNames.has(issueTypeName)) {
    // ---- 納品報告 ----
    if (newStatus.id === 2) {
      // ステータス「処理中」= 納品受付 → DeliveryEventをDBに登録
      await handleDeliveryReceived(issueKey, content, slack);
    } else if (newStatus.id === 3) {
      // ステータス「処理済み」= 検収完了 → 検収書・支払通知書を生成
      await enqueueGenerateDocumentsForIssue(issueKey, issueTypeName, content, slack, "backlog-webhook");
    }

  } else if (consultationTypeNames.has(issueTypeName)) {
    // ---- 法務相談 ----
    if (newStatus.id === 4) {
      await notifyRequester(issueKey, content, slack);
    }

  } else {
    // ---- その他（NDA・売買契約・業務委託等） ----
    if (newStatus.id === 3) {
      await enqueueGenerateDocumentsForIssue(issueKey, issueTypeName, content, slack, "backlog-webhook");
    } else if (newStatus.id === 4) {
      await notifyRequester(issueKey, content, slack);
    }
  }
}

// ================================================================
// ライセンス文書生成（基本契約書 + 個別条件 合冊）
// ================================================================

async function handleLicenseDocumentGeneration(
  issueKey: string,
  content: BacklogIssueContent,
  slack: SlackMessageClient
): Promise<void> {
  console.log(`[Webhook] ライセンス文書生成: ${issueKey}`);

  try {
    const docs = await renderMultipleTemplates(await buildRenderItemsForIssue(issueKey, "ライセンス契約", content));

    const basicUrl   = docs[0].driveUrl ? `[基本契約書](${docs[0].driveUrl})` : docs[0].localPath;
    const ledgerUrl  = docs[1].driveUrl ? `[個別条件](${docs[1].driveUrl})`   : docs[1].localPath;

    await saveGeneratedDocuments(issueKey, docs.map((doc, index) => ({
      name: index === 0 ? "license_basic" : "license_ledger",
      url: doc.driveUrl,
      localPath: doc.localPath,
    })));

    await backlog.addComment(issueKey,
      `## ✅ ライセンス文書を生成しました\n\n` +
      `| 文書 | リンク |\n|------|--------|\n` +
      `| ライセンス利用許諾基本契約書 | ${basicUrl} |\n` +
      `| 別紙 個別利用許諾条件 | ${ledgerUrl} |`
    );

    await notifySlack(slack, issueKey, "📋 ライセンス文書生成完了",
      `基本契約書・個別条件を生成しました。`);
    await notifyRequesterDriveFolder(slack, issueKey, "ライセンス文書を生成しました。");

  } catch (e) {
    console.error(`[Webhook] ライセンス文書生成失敗: ${issueKey}`, e);
    await backlog.addComment(issueKey, `⚠️ ライセンス文書生成に失敗しました。エラー: ${String(e)}`);
  }
}

export async function buildRenderItemsForIssue(
  issueKey: string,
  issueTypeName: string,
  content: BacklogIssueContent,
  draftOverrides?: Record<string, string>
): Promise<RenderOptions[]> {
  await ensureBacklogDocumentNumber(issueKey, issueTypeName, content);
  const legalRequest = await findLegalRequestByBacklogKey(issueKey);
  const requesterSlackId = resolveRequesterSlackId(content as BacklogIssue, legalRequest);
  const requesterStaff = requesterSlackId ? await findStaffBySlackUserId(requesterSlackId) : null;
  const driveFolderKey = resolveDriveFolderKey(legalRequest, requesterStaff);

  if (issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_LICENSE ?? "ライセンス契約")) {
    const getField = (envKey: string): string =>
      content.customFields?.find(f => f.fieldId === Number(process.env[envKey]))?.value ?? "";
    const loadedDraft = await loadDocumentDraft(issueKey, {
      content,
      fallbackCounterparty: getField("BACKLOG_FIELD_LICENSOR") || getField("BACKLOG_FIELD_COUNTERPARTY"),
    });
    const draft = { ...loadedDraft, ...(draftOverrides ?? {}) };
    return [
      {
        templateKey: "license_basic",
        variables: {
          CONTRACT_NO:      draft.CONTRACT_NO || getField("BACKLOG_FIELD_CONTRACT_NO"),
          PARTY_A_NAME:     draft.PARTY_A_NAME || "株式会社アークライト",
          PARTY_A_ADDRESS:  draft.PARTY_A_ADDRESS || "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
          PARTY_A_REP:      draft.PARTY_A_REPRESENTATIVE || "代表取締役 青柳昌行",
          VENDOR_NAME:      draft.VENDOR_NAME || getField("BACKLOG_FIELD_LICENSOR"),
          VENDOR_ADDRESS:   draft.VENDOR_ADDRESS || getField("BACKLOG_FIELD_LICENSOR_ADDRESS"),
          VENDOR_REP:       draft.VENDOR_REP || getField("BACKLOG_FIELD_LICENSOR_REP"),
          VENDOR_PHONE:     draft.VENDOR_PHONE || getField("BACKLOG_FIELD_VENDOR_PHONE"),
          VENDOR_EMAIL:     draft.VENDOR_EMAIL || getField("BACKLOG_FIELD_VENDOR_EMAIL"),
          HAS_REMARKS:      Boolean(draft.SPECIAL_TERMS || getField("BACKLOG_FIELD_SPECIAL_NOTES")),
          REMARKS:          draft.SPECIAL_TERMS || getField("BACKLOG_FIELD_SPECIAL_NOTES"),
          ORIGINAL_WORK:    draft.ORIGINAL_WORK || getField("BACKLOG_FIELD_ORIGINAL_WORK"),
          ORIGINAL_AUTHOR:  draft.ORIGINAL_AUTHOR || getField("BACKLOG_FIELD_ORIGINAL_AUTHOR"),
          CREDIT_NAME:      draft.CREDIT_NAME || getField("BACKLOG_FIELD_CREDIT_NAME"),
          承継覚書日付:      getField("BACKLOG_FIELD_SUCCESSION_MEMORANDUM_DATE"),
          BANK_NAME:        draft.BANK_NAME || getField("BACKLOG_FIELD_LICENSOR_BANK"),
          BRANCH_NAME:      draft.BRANCH_NAME || getField("BACKLOG_FIELD_LICENSOR_BRANCH"),
          ACCOUNT_TYPE:     draft.ACCOUNT_TYPE || getField("BACKLOG_FIELD_ACCOUNT_TYPE") || "普通預金",
          ACCOUNT_NUMBER:   draft.ACCOUNT_NUMBER || getField("BACKLOG_FIELD_LICENSOR_ACCOUNT_NO"),
          ACCOUNT_HOLDER_KANA: draft.ACCOUNT_HOLDER_KANA || getField("BACKLOG_FIELD_LICENSOR_ACCOUNT_NAME"),
          IS_INVOICE_ISSUER: draft.IS_INVOICE_ISSUER || getField("BACKLOG_FIELD_IS_INVOICE_ISSUER"),
          invoiceRegistrationDisplay: draft.invoiceRegistrationDisplay || getField("BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER"),
          JURISDICTION:     draft.JURISDICTION || getField("BACKLOG_FIELD_JURISDICTION") || "東京地方裁判所",
        },
        outputBasename: `${issueKey}_ライセンス利用許諾基本契約書`,
      driveFolderKey,
      },
      {
        templateKey: "license_ledger",
        variables: {
          台帳ID:         getField("BACKLOG_FIELD_LEDGER_ID"),
          契約書番号:     draft.CONTRACT_NO || getField("BACKLOG_FIELD_CONTRACT_NO"),
          基本契約名:     `ライセンス利用許諾基本契約書（${draft.CONTRACT_NO || getField("BACKLOG_FIELD_CONTRACT_NO")}）`,
          発行日:         new Date().toLocaleDateString("ja-JP"),
          licensor名:     draft.VENDOR_NAME || getField("BACKLOG_FIELD_LICENSOR") || getField("BACKLOG_FIELD_COUNTERPARTY"),
          "licensor_氏名会社名": draft.VENDOR_NAME || getField("BACKLOG_FIELD_LICENSOR") || getField("BACKLOG_FIELD_COUNTERPARTY"),
          "licensor_住所":      draft.VENDOR_ADDRESS || getField("BACKLOG_FIELD_LICENSOR_ADDRESS"),
          "licensor_代表者名":  draft.VENDOR_REP || getField("BACKLOG_FIELD_LICENSOR_REP"),
          licensee名:     draft.PARTY_A_NAME || "株式会社アークライト",
          "licensee_氏名会社名": draft.PARTY_A_NAME || "株式会社アークライト",
          "licensee_住所":      draft.PARTY_A_ADDRESS || "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
          "licensee_代表者名":  draft.PARTY_A_REPRESENTATIVE || "代表取締役 青柳昌行",
          ライセンス種別名: draft.LICENSE_TYPE_NAME || getField("BACKLOG_FIELD_LICENSE_TYPE_NAME"),
          原著作物名:     draft.ORIGINAL_WORK || getField("BACKLOG_FIELD_ORIGINAL_WORK"),
          原著作物補記:   "",
          対象製品予定名: draft.PRODUCT_NAME || getField("BACKLOG_FIELD_PRODUCT_NAME"),
          許諾開始日:     draft.LICENSE_START || getField("BACKLOG_FIELD_LICENSE_START"),
          許諾期間注記:   "",
          素材番号:       draft.MATERIAL_CODE || getField("BACKLOG_FIELD_MATERIAL_CODE") || (getField("BACKLOG_FIELD_LEDGER_ID") + "-01"),
          素材名:         draft.MATERIAL_NAME || getField("BACKLOG_FIELD_MATERIAL_NAME") || draft.ORIGINAL_WORK || getField("BACKLOG_FIELD_ORIGINAL_WORK"),
          素材権利者:     draft.MATERIAL_RIGHTS_HOLDER || getField("BACKLOG_FIELD_MATERIAL_RIGHTS_HOLDER") || draft.VENDOR_NAME || getField("BACKLOG_FIELD_LICENSOR"),
          監修者:         draft.SUPERVISOR || getField("BACKLOG_FIELD_SUPERVISOR") || getField("BACKLOG_FIELD_LICENSOR"),
          "金銭条件1_地域言語ラベル": draft.LICENSE_REGION_LANGUAGE_LABEL || getField("BACKLOG_FIELD_TERRITORY"),
          "金銭条件1_計算方式":       draft.CONDITION1_CALC_METHOD || getField("BACKLOG_FIELD_CONDITION1_CALC_METHOD"),
          "金銭条件1_計算式":         draft.CONDITION1_FORMULA || getField("BACKLOG_FIELD_CONDITION1_FORMULA"),
          "金銭条件1_基準価格ラベル": draft.CONDITION1_BASE_PRICE_LABEL || getField("BACKLOG_FIELD_CONDITION1_BASE_PRICE_LABEL") || "MSRP（希望小売価格・税抜）",
          "金銭条件1_料率":           draft.CONDITION1_RATE || getField("BACKLOG_FIELD_CONDITION1_RATE"),
          "金銭条件1_計算期間":       "製造都度",
          "金銭条件1_通貨":           getField("BACKLOG_FIELD_CURRENCY") || "JPY",
          "金銭条件1_支払条件":       draft.CONDITION1_PAYMENT_TERMS || getField("BACKLOG_FIELD_CONDITION1_PAYMENT_TERMS"),
          "金銭条件1_MG_AG":          draft.CONDITION1_MG_AG || getField("BACKLOG_FIELD_CONDITION1_MG_AG"),
          "金銭条件1_補足条件":       draft.CONDITION1_NOTE || getField("BACKLOG_FIELD_CONDITION1_NOTE"),
          "金銭条件2_見出し":         draft.CONDITION2_HEADING || getField("BACKLOG_FIELD_CONDITION2_HEADING"),
          "金銭条件2_地域":           draft.CONDITION2_REGION || getField("BACKLOG_FIELD_CONDITION2_REGION"),
          "金銭条件2_言語":           draft.CONDITION2_LANGUAGE || getField("BACKLOG_FIELD_CONDITION2_LANGUAGE"),
          "金銭条件2_計算方式":       draft.CONDITION2_CALC_METHOD || getField("BACKLOG_FIELD_CONDITION2_CALC_METHOD"),
          "金銭条件2_概要":           draft.CONDITION2_SUMMARY || getField("BACKLOG_FIELD_CONDITION2_SUMMARY"),
          "金銭条件2_計算式":         draft.CONDITION2_FORMULA || getField("BACKLOG_FIELD_CONDITION2_FORMULA"),
          "金銭条件2_計算式注記":     "",
          "金銭条件2_分配率":         draft.CONDITION2_SHARE_RATE || getField("BACKLOG_FIELD_CONDITION2_SHARE_RATE"),
          "金銭条件2_通貨":           getField("BACKLOG_FIELD_CURRENCY") || "JPY",
          "金銭条件2_支払条件":       draft.CONDITION2_PAYMENT_TERMS || getField("BACKLOG_FIELD_CONDITION2_PAYMENT_TERMS"),
          "金銭条件2_MG_AG":          draft.CONDITION2_MG_AG || getField("BACKLOG_FIELD_CONDITION2_MG_AG"),
          "金銭条件2_補足条件":       draft.CONDITION2_NOTE || getField("BACKLOG_FIELD_CONDITION2_NOTE"),
          "金銭条件3_見出し":         draft.CONDITION3_HEADING || getField("BACKLOG_FIELD_CONDITION3_HEADING"),
          "金銭条件3_地域":           draft.CONDITION3_REGION || getField("BACKLOG_FIELD_CONDITION3_REGION"),
          "金銭条件3_言語":           draft.CONDITION3_LANGUAGE || getField("BACKLOG_FIELD_CONDITION3_LANGUAGE"),
          "金銭条件3_計算方式":       draft.CONDITION3_CALC_METHOD || getField("BACKLOG_FIELD_CONDITION3_CALC_METHOD"),
          "金銭条件3_概要":           draft.CONDITION3_SUMMARY || getField("BACKLOG_FIELD_CONDITION3_SUMMARY"),
          "金銭条件3_計算式":         draft.CONDITION3_FORMULA || getField("BACKLOG_FIELD_CONDITION3_FORMULA"),
          "金銭条件3_計算式注記":     "",
          "金銭条件3_料率":           draft.CONDITION3_RATE || getField("BACKLOG_FIELD_CONDITION3_RATE"),
          "金銭条件3_通貨":           getField("BACKLOG_FIELD_CURRENCY") || "JPY",
          "金銭条件3_支払条件":       draft.CONDITION3_PAYMENT_TERMS || getField("BACKLOG_FIELD_CONDITION3_PAYMENT_TERMS"),
          "金銭条件3_MG_AG":          draft.CONDITION3_MG_AG || getField("BACKLOG_FIELD_CONDITION3_MG_AG"),
          "金銭条件3_補足条件":       draft.CONDITION3_NOTE || getField("BACKLOG_FIELD_CONDITION3_NOTE"),
          特記事項_本文:  draft.SPECIAL_TERMS || getField("BACKLOG_FIELD_SPECIAL_NOTES"),
        },
        outputBasename: `${issueKey}_個別利用許諾条件`,
      driveFolderKey,
      },
    ];
  }

  const getField = (envKey: string): string =>
    content.customFields?.find(f => f.fieldId === Number(process.env[envKey]))?.value ?? "";
  const loadedDraft = await loadDocumentDraft(issueKey, {
    content,
    fallbackCounterparty: getField("BACKLOG_FIELD_COUNTERPARTY"),
  });
  const draft = { ...loadedDraft, ...(draftOverrides ?? {}) };
  const contractDate = draft.CONTRACT_DATE || getField("BACKLOG_FIELD_CONTRACT_DATE");
  const contractDateObj = contractDate ? new Date(contractDate) : new Date();
  const remarks = getField("BACKLOG_FIELD_REMARKS");
  const specialNotes = getField("BACKLOG_FIELD_SPECIAL_NOTES");
  const jurisdiction = getField("BACKLOG_FIELD_JURISDICTION") || "東京地方裁判所";
  const optionalField = (envKey: string, fallback = ""): string => {
    const envValue = process.env[envKey];
    if (!envValue) return fallback;
    const fieldValue = getField(envKey);
    return fieldValue || fallback;
  };
  const { ISSUE_TYPE_TO_TEMPLATE } = await import("../documents/templateRegistry");
  const templateKeys = ISSUE_TYPE_TO_TEMPLATE[issueTypeName];
  if (!templateKeys || templateKeys.length === 0) {
    return [];
  }

  const commonVars = {
    CONTRACT_NO:              getField("BACKLOG_FIELD_CONTRACT_NO"),
    CONTRACT_DATE:            contractDate,
    CONTRACT_DATE_FORMATTED:  contractDateObj.toLocaleDateString("ja-JP"),
    CONTRACT_DATE_YEAR:       String(contractDateObj.getFullYear()),
    CONTRACT_DATE_MONTH:      String(contractDateObj.getMonth() + 1),
    CONTRACT_DATE_DAY:        String(contractDateObj.getDate()),
    PARTY_A_NAME:             draft.PARTY_A_NAME || "",
    PARTY_A_ADDRESS:          draft.PARTY_A_ADDRESS || "",
    PARTY_A_REPRESENTATIVE:   draft.PARTY_A_REPRESENTATIVE || "",
    STAFF_NAME:               draft.STAFF_NAME || "",
    STAFF_DEPARTMENT:         draft.STAFF_DEPARTMENT || "",
    STAFF_PHONE:              draft.STAFF_PHONE || "",
    STAFF_EMAIL:              draft.STAFF_EMAIL || "",
    PARTY_B_NAME:             getField("BACKLOG_FIELD_COUNTERPARTY"),
    PARTY_B_ADDRESS:          getField("BACKLOG_FIELD_COUNTERPARTY_ADDRESS"),
    PARTY_B_REPRESENTATIVE:   getField("BACKLOG_FIELD_COUNTERPARTY_REP"),
    PARTY_B_REP:              getField("BACKLOG_FIELD_COUNTERPARTY_REP"),
    VENDOR_NAME:              getField("BACKLOG_FIELD_COUNTERPARTY"),
    VENDOR_ADDRESS:           getField("BACKLOG_FIELD_COUNTERPARTY_ADDRESS"),
    VENDOR_REP:               getField("BACKLOG_FIELD_COUNTERPARTY_REP"),
    VENDOR_EMAIL:             draft.VENDOR_EMAIL || optionalField("BACKLOG_FIELD_VENDOR_EMAIL", ""),
    VENDOR_PHONE:             draft.VENDOR_PHONE || optionalField("BACKLOG_FIELD_VENDOR_PHONE", ""),
    BANK_NAME:                draft.BANK_NAME || optionalField("BACKLOG_FIELD_BANK_NAME", ""),
    BRANCH_NAME:              draft.BRANCH_NAME || optionalField("BACKLOG_FIELD_BRANCH_NAME", ""),
    ACCOUNT_TYPE:             draft.ACCOUNT_TYPE || optionalField("BACKLOG_FIELD_ACCOUNT_TYPE", ""),
    ACCOUNT_NUMBER:           draft.ACCOUNT_NUMBER || optionalField("BACKLOG_FIELD_ACCOUNT_NUMBER", ""),
    ACCOUNT_HOLDER_KANA:      draft.ACCOUNT_HOLDER_KANA || optionalField("BACKLOG_FIELD_ACCOUNT_HOLDER_KANA", ""),
    IS_INVOICE_ISSUER:        draft.IS_INVOICE_ISSUER || optionalField("BACKLOG_FIELD_IS_INVOICE_ISSUER", ""),
    invoiceRegistrationDisplay: draft.invoiceRegistrationDisplay || optionalField("BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER", ""),
    SPECIAL_TERMS:            specialNotes,
    REMARKS:                  remarks,
    JURISDICTION:             jurisdiction,
    NDA_PURPOSE:              getField("BACKLOG_FIELD_NDA_PURPOSE"),
    CONTRACT_PERIOD:          getField("BACKLOG_FIELD_CONTRACT_PERIOD"),
    CONFIDENTIALITY_PERIOD:   getField("BACKLOG_FIELD_CONFIDENTIALITY_PERIOD"),
    PRODUCT_SCOPE:            optionalField("BACKLOG_FIELD_PRODUCT_SCOPE", remarks),
    DELIVERY_LOCATION:        optionalField("BACKLOG_FIELD_DELIVERY_LOCATION", "別途協議"),
    INSPECTION_PERIOD_DAYS:   optionalField("BACKLOG_FIELD_INSPECTION_PERIOD_DAYS", "5"),
    PAYMENT_CONDITION_SUMMARY: optionalField("BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY", remarks || "別途個別契約で定める"),
    WARRANTY_PERIOD:          optionalField("BACKLOG_FIELD_WARRANTY_PERIOD", "6か月"),
    CONFIDENTIALITY_YEARS:    optionalField("BACKLOG_FIELD_CONFIDENTIALITY_YEARS", "3"),
    CURE_PERIOD_DAYS:         optionalField("BACKLOG_FIELD_CURE_PERIOD_DAYS", "7"),
    DELIVERY_DAYS_AFTER_PAYMENT: optionalField("BACKLOG_FIELD_DELIVERY_DAYS_AFTER_PAYMENT", "3"),
    COD_DELIVERY_DAYS:        optionalField("BACKLOG_FIELD_COD_DELIVERY_DAYS", "3"),
    PREPAY_DEADLINE_DAYS:     optionalField("BACKLOG_FIELD_PREPAY_DEADLINE_DAYS", "5"),
    MONTHLY_CLOSING_DAY:      optionalField("BACKLOG_FIELD_MONTHLY_CLOSING_DAY", "末日"),
    PAYMENT_DUE_DAY:          optionalField("BACKLOG_FIELD_PAYMENT_DUE_DAY", "翌月末日"),
    SECURITY_DEPOSIT_AMOUNT:  optionalField("BACKLOG_FIELD_SECURITY_DEPOSIT_AMOUNT", "別途協議"),
    DEPOSIT_REPLENISH_DAYS:   optionalField("BACKLOG_FIELD_DEPOSIT_REPLENISH_DAYS", "7"),
    DELIVERY_FEE_THRESHOLD:   optionalField("BACKLOG_FIELD_DELIVERY_FEE_THRESHOLD", "別途協議"),
    ORIGINAL_WORK:            getField("BACKLOG_FIELD_ORIGINAL_WORK"),
    ORIGINAL_AUTHOR:          getField("BACKLOG_FIELD_ORIGINAL_AUTHOR"),
    CREDIT_NAME:              getField("BACKLOG_FIELD_CREDIT_NAME"),
    COUNTERPARTY_NAME:        getField("BACKLOG_FIELD_COUNTERPARTY"),
    COUNTERPARTY_ADDRESS:     getField("BACKLOG_FIELD_COUNTERPARTY_ADDRESS"),
    COUNTERPARTY_REPRESENTATIVE: getField("BACKLOG_FIELD_COUNTERPARTY_REP"),
    DEAL_STRUCTURE:           getField("BACKLOG_FIELD_DEAL_STRUCTURE"),
    CHANGE_MODE:              getField("BACKLOG_FIELD_CHANGE_MODE"),
    BASE_AGREEMENT_KEY:       getField("BACKLOG_FIELD_BASE_AGREEMENT_KEY"),
    EFFECTIVE_DATE:           getField("BACKLOG_FIELD_EFFECTIVE_DATE"),
    LICENSE_SCOPE:            getField("BACKLOG_FIELD_LICENSE_SCOPE"),
    IP_PRODUCT_SCOPE:         getField("BACKLOG_FIELD_IP_PRODUCT_SCOPE"),
    EXCLUSIVITY:              getField("BACKLOG_FIELD_EXCLUSIVITY"),
    REVENUE_MODEL:            getField("BACKLOG_FIELD_REVENUE_MODEL"),
    ROYALTY_TERMS:            getField("BACKLOG_FIELD_ROYALTY_TERMS"),
    SUBLICENSE_ALLOWED:       getField("BACKLOG_FIELD_SUBLICENSE_ALLOWED"),
    TITLE_TRANSFER_MODEL:     getField("BACKLOG_FIELD_TITLE_TRANSFER_MODEL"),
    INVENTORY_SELLOFF:        getField("BACKLOG_FIELD_INVENTORY_SELLOFF"),
    AMENDMENT_CLAUSES:        getField("BACKLOG_FIELD_AMENDMENT_CLAUSES"),
    SPECIAL_NOTES:            getField("BACKLOG_FIELD_SPECIAL_NOTES"),
    S1_ROYALTY_RATE:          getField("BACKLOG_FIELD_S1_ROYALTY_RATE"),
    S1_MINIMUM_GUARANTEE:     getField("BACKLOG_FIELD_S1_MINIMUM_GUARANTEE"),
    S1_ADVANCE:               getField("BACKLOG_FIELD_S1_ADVANCE"),
    S1_ACCOUNTING_PERIOD:     getField("BACKLOG_FIELD_S1_ACCOUNTING_PERIOD"),
    S1_PAYMENT_DUE:           getField("BACKLOG_FIELD_S1_PAYMENT_DUE"),
    S1_REPORT_DUE:            getField("BACKLOG_FIELD_S1_REPORT_DUE"),
    S1_FX_CONVERSION:         getField("BACKLOG_FIELD_S1_FX_CONVERSION"),
    S1_FIRST_PRINT_RUN:       getField("BACKLOG_FIELD_S1_FIRST_PRINT_RUN"),
    S1_TARGET_RELEASE_DATE:   getField("BACKLOG_FIELD_S1_TARGET_RELEASE_DATE"),
    S1_COMPLIMENTARY_COPIES:  getField("BACKLOG_FIELD_S1_COMPLIMENTARY_COPIES"),
    S1_CREDIT_WORDING:        getField("BACKLOG_FIELD_S1_CREDIT_WORDING"),
    S1_TERRITORY_JURISDICTION: getField("BACKLOG_FIELD_S1_TERRITORY_JURISDICTION"),
    S1_CONSUMER_LAW_CARVEOUT: getField("BACKLOG_FIELD_S1_CONSUMER_LAW_CARVEOUT"),
    S1_VAT_GST_TREATMENT:     getField("BACKLOG_FIELD_S1_VAT_GST_TREATMENT"),
    S1_COPYRIGHT_REGISTRATION: getField("BACKLOG_FIELD_S1_COPYRIGHT_REGISTRATION"),
    S1_MORAL_RIGHTS:          getField("BACKLOG_FIELD_S1_MORAL_RIGHTS"),
    S1_MANDATORY_DISTRIBUTION_LAW: getField("BACKLOG_FIELD_S1_MANDATORY_DISTRIBUTION_LAW"),
    S1_ADDITIONAL_TERMS:      getField("BACKLOG_FIELD_S1_ADDITIONAL_TERMS"),
    S2_PRODUCT_PRICE_LIST:    getField("BACKLOG_FIELD_S2_PRODUCT_PRICE_LIST"),
    S2_MPR_YEAR1:             getField("BACKLOG_FIELD_S2_MPR_YEAR1"),
    S2_MPR_YEAR2:             getField("BACKLOG_FIELD_S2_MPR_YEAR2"),
    S2_MPR_YEAR3:             getField("BACKLOG_FIELD_S2_MPR_YEAR3"),
    S2_INCOTERMS_DELIVERY:    getField("BACKLOG_FIELD_S2_INCOTERMS_DELIVERY"),
    S2_ARRIVAL_POINT:         getField("BACKLOG_FIELD_S2_ARRIVAL_POINT"),
    S2_PAYMENT_ADVANCE:       getField("BACKLOG_FIELD_S2_PAYMENT_ADVANCE"),
    S2_PAYMENT_BALANCE:       getField("BACKLOG_FIELD_S2_PAYMENT_BALANCE"),
    S2_PAYMENT_CURRENCY:      getField("BACKLOG_FIELD_S2_PAYMENT_CURRENCY"),
    S2_TERRITORY_JURISDICTION: getField("BACKLOG_FIELD_S2_TERRITORY_JURISDICTION"),
    S2_IMPORT_CUSTOMS_ALLOCATION: getField("BACKLOG_FIELD_S2_IMPORT_CUSTOMS_ALLOCATION"),
    S2_CONSUMER_PRODUCT_SAFETY: getField("BACKLOG_FIELD_S2_CONSUMER_PRODUCT_SAFETY"),
    S2_DISTRIBUTION_LAW_PROTECTIONS: getField("BACKLOG_FIELD_S2_DISTRIBUTION_LAW_PROTECTIONS"),
    S2_VAT_GST_SUPPLY:        getField("BACKLOG_FIELD_S2_VAT_GST_SUPPLY"),
    S2_PRODUCT_LIABILITY_INSURANCE: getField("BACKLOG_FIELD_S2_PRODUCT_LIABILITY_INSURANCE"),
    S2_MARKETPLACE_ONLINE_SALES: getField("BACKLOG_FIELD_S2_MARKETPLACE_ONLINE_SALES"),
    S2_ADDITIONAL_TERMS:      getField("BACKLOG_FIELD_S2_ADDITIONAL_TERMS"),
    ライセンス種別名:          draft.LICENSE_TYPE_NAME || getField("BACKLOG_FIELD_LICENSE_TYPE_NAME"),
    原著作物名:               draft.ORIGINAL_WORK || getField("BACKLOG_FIELD_ORIGINAL_WORK"),
    原著作物補記:             "",
    対象製品予定名:           draft.PRODUCT_NAME || getField("BACKLOG_FIELD_PRODUCT_NAME"),
    許諾開始日:               draft.LICENSE_START || getField("BACKLOG_FIELD_LICENSE_START"),
    許諾期間注記:             "",
    素材番号:                 draft.MATERIAL_CODE || getField("BACKLOG_FIELD_MATERIAL_CODE") || (getField("BACKLOG_FIELD_LEDGER_ID") + "-01"),
    素材名:                   draft.MATERIAL_NAME || getField("BACKLOG_FIELD_MATERIAL_NAME") || draft.ORIGINAL_WORK || getField("BACKLOG_FIELD_ORIGINAL_WORK"),
    素材権利者:               draft.MATERIAL_RIGHTS_HOLDER || getField("BACKLOG_FIELD_MATERIAL_RIGHTS_HOLDER") || draft.VENDOR_NAME || getField("BACKLOG_FIELD_COUNTERPARTY"),
    監修者:                   draft.SUPERVISOR || getField("BACKLOG_FIELD_SUPERVISOR") || getField("BACKLOG_FIELD_COUNTERPARTY"),
    "金銭条件1_地域言語ラベル": draft.LICENSE_REGION_LANGUAGE_LABEL || getField("BACKLOG_FIELD_TERRITORY"),
    "金銭条件1_見出し":        draft.CONDITION1_HEADING || getField("BACKLOG_FIELD_CONDITION1_HEADING"),
    "金銭条件1_計算方式":      draft.CONDITION1_CALC_METHOD || getField("BACKLOG_FIELD_CONDITION1_CALC_METHOD"),
    "金銭条件1_計算式":        draft.CONDITION1_FORMULA || getField("BACKLOG_FIELD_CONDITION1_FORMULA"),
    "金銭条件1_基準価格ラベル": draft.CONDITION1_BASE_PRICE_LABEL || getField("BACKLOG_FIELD_CONDITION1_BASE_PRICE_LABEL") || "MSRP（希望小売価格・税抜）",
    "金銭条件1_料率":          draft.CONDITION1_RATE || getField("BACKLOG_FIELD_CONDITION1_RATE"),
    "金銭条件1_計算期間":      "製造都度",
    "金銭条件1_通貨":          getField("BACKLOG_FIELD_CURRENCY") || "JPY",
    "金銭条件1_支払条件":      draft.CONDITION1_PAYMENT_TERMS || getField("BACKLOG_FIELD_CONDITION1_PAYMENT_TERMS"),
    "金銭条件1_MG_AG":         draft.CONDITION1_MG_AG || getField("BACKLOG_FIELD_CONDITION1_MG_AG"),
    "金銭条件1_補足条件":      draft.CONDITION1_NOTE || getField("BACKLOG_FIELD_CONDITION1_NOTE"),
    "金銭条件2_見出し":        draft.CONDITION2_HEADING || getField("BACKLOG_FIELD_CONDITION2_HEADING"),
    "金銭条件2_地域":          draft.CONDITION2_REGION || getField("BACKLOG_FIELD_CONDITION2_REGION"),
    "金銭条件2_言語":          draft.CONDITION2_LANGUAGE || getField("BACKLOG_FIELD_CONDITION2_LANGUAGE"),
    "金銭条件2_計算方式":      draft.CONDITION2_CALC_METHOD || getField("BACKLOG_FIELD_CONDITION2_CALC_METHOD"),
    "金銭条件2_概要":          draft.CONDITION2_SUMMARY || getField("BACKLOG_FIELD_CONDITION2_SUMMARY"),
    "金銭条件2_計算式":        draft.CONDITION2_FORMULA || getField("BACKLOG_FIELD_CONDITION2_FORMULA"),
    "金銭条件2_計算式注記":    "",
    "金銭条件2_分配率":        draft.CONDITION2_SHARE_RATE || getField("BACKLOG_FIELD_CONDITION2_SHARE_RATE"),
    "金銭条件2_通貨":          getField("BACKLOG_FIELD_CURRENCY") || "JPY",
    "金銭条件2_支払条件":      draft.CONDITION2_PAYMENT_TERMS || getField("BACKLOG_FIELD_CONDITION2_PAYMENT_TERMS"),
    "金銭条件2_MG_AG":         draft.CONDITION2_MG_AG || getField("BACKLOG_FIELD_CONDITION2_MG_AG"),
    "金銭条件2_補足条件":      draft.CONDITION2_NOTE || getField("BACKLOG_FIELD_CONDITION2_NOTE"),
    "金銭条件3_見出し":        draft.CONDITION3_HEADING || getField("BACKLOG_FIELD_CONDITION3_HEADING"),
    "金銭条件3_地域":          draft.CONDITION3_REGION || getField("BACKLOG_FIELD_CONDITION3_REGION"),
    "金銭条件3_言語":          draft.CONDITION3_LANGUAGE || getField("BACKLOG_FIELD_CONDITION3_LANGUAGE"),
    "金銭条件3_計算方式":      draft.CONDITION3_CALC_METHOD || getField("BACKLOG_FIELD_CONDITION3_CALC_METHOD"),
    "金銭条件3_概要":          draft.CONDITION3_SUMMARY || getField("BACKLOG_FIELD_CONDITION3_SUMMARY"),
    "金銭条件3_計算式":        draft.CONDITION3_FORMULA || getField("BACKLOG_FIELD_CONDITION3_FORMULA"),
    "金銭条件3_計算式注記":    "",
    "金銭条件3_料率":          draft.CONDITION3_RATE || getField("BACKLOG_FIELD_CONDITION3_RATE"),
    "金銭条件3_通貨":          getField("BACKLOG_FIELD_CURRENCY") || "JPY",
    "金銭条件3_支払条件":      draft.CONDITION3_PAYMENT_TERMS || getField("BACKLOG_FIELD_CONDITION3_PAYMENT_TERMS"),
    "金銭条件3_MG_AG":         draft.CONDITION3_MG_AG || getField("BACKLOG_FIELD_CONDITION3_MG_AG"),
    "金銭条件3_補足条件":      draft.CONDITION3_NOTE || getField("BACKLOG_FIELD_CONDITION3_NOTE"),
    特記事項_本文:             draft.SPECIAL_TERMS || getField("BACKLOG_FIELD_SPECIAL_NOTES"),
  };

  return templateKeys.map(key => ({
    templateKey: key as import("../documents/templateRegistry").TemplateKey,
    variables: { ...commonVars, ...draft },
    outputBasename: `${issueKey}_${issueTypeName}`,
  }));
}

// ================================================================
// 納品受付（ステータス「処理中」）
// DeliveryEventをDBに登録する
// ================================================================

async function handleDeliveryReceived(
  issueKey: string,
  content: BacklogIssueContent,
  slack: SlackMessageClient
): Promise<void> {
  console.log(`[Webhook] 納品受付: ${issueKey}`);

  const existingDeliveryEvent = await findDeliveryEventByBacklogIssueKey(issueKey);
  if (existingDeliveryEvent) {
    await backlog.addComment(issueKey, "ℹ️ DeliveryEvent は既に登録済みです。管理UIまたは先行処理の結果をそのまま利用します。");
    return;
  }

  const getField = (envKey: string): string =>
    content.customFields?.find(f => f.fieldId === Number(process.env[envKey]))?.value ?? "";

  const parentIssueKey = getField("BACKLOG_FIELD_PARENT_ISSUE_KEY");
  const itemNoStr      = getField("BACKLOG_FIELD_ITEM_NO");
  const deliveredAmountStr = getField("BACKLOG_FIELD_DELIVERED_AMOUNT");
  const parentCondition = parentIssueKey ? await loadParentOrderConditionFields(parentIssueKey) : undefined;

  if (!parentIssueKey || !itemNoStr) {
    await backlog.addComment(issueKey, `⚠️ 「親課題キー」または「明細番号」が未入力です。`);
    return;
  }

  // 親課題（発注課題）をDBから取得
  const { findLegalRequestByBacklogKey } = await import("../db/repository");
  const parentRequest = await findLegalRequestByBacklogKey(parentIssueKey);
  if (!parentRequest) {
    await backlog.addComment(issueKey, `⚠️ 親課題 ${parentIssueKey} がDBに見つかりません。先に発注課題を処理済みにしてください。`);
    return;
  }

  // 対応するOrderItemを取得
  const { getOrderItemByNo } = await import("../db/orderRepository");
  const itemNo = parseInt(itemNoStr, 10);
  const orderItem = await getOrderItemByNo(parentRequest.id, itemNo);
  if (!orderItem) {
    await backlog.addComment(issueKey, `⚠️ 明細番号 ${itemNo} が ${parentIssueKey} に見つかりません。`);
    return;
  }

  // DeliveryEventを作成
  const deliveredAmount = deliveredAmountStr
    ? parseInt(deliveredAmountStr.replace(/[,，]/g, ""), 10)
    : undefined;

  await createDeliveryEvent({
    backlogIssueKey: issueKey,
    orderItemId:     orderItem.id,
    deliveredAt:     new Date(),
    deliveredAmount,
    inspectionDays:  parentCondition?.inspectionDays ?? 7,
    note:            getField("BACKLOG_FIELD_DELIVERY_NOTE"),
  });

  await backlog.addComment(issueKey,
    `✅ 納品を受け付けました。\n\n` +
    `- 発注課題: ${parentIssueKey}\n` +
    `- 明細: ①${itemNo} ${orderItem.description}\n` +
    `- 納品金額: ${deliveredAmount ? `¥${deliveredAmount.toLocaleString("ja-JP")}` : "（明細金額）"}\n\n` +
    `検収完了後、ステータスを「処理済み」に変更してください。`
  );

  await notifySlack(slack, issueKey, "📦 納品受付",
    `${issueKey}: ${parentIssueKey} ①${itemNo} の納品を受け付けました。`);
}

// ================================================================
// 検収書・支払通知書の生成（ステータス「処理済み」）
// ================================================================

async function handleDeliveryInspection(
  issueKey: string,
  content: BacklogIssueContent,
  slack: SlackMessageClient
): Promise<void> {
  console.log(`[Webhook] 検収書生成: ${issueKey}`);

  const getField = (envKey: string): string =>
    content.customFields?.find(f => f.fieldId === Number(process.env[envKey]))?.value ?? "";

  // DBからDeliveryEventを取得
  const { prisma } = await import("../db/client");
  const deliveryEvent = await prisma.deliveryEvent.findUnique({
    where: { backlogIssueKey: issueKey },
    select: { id: true, inspectionCertUrl: true, paymentNoticeUrl: true },
  });

  if (!deliveryEvent) {
    await backlog.addComment(issueKey,
      `⚠️ 納品イベントがDBに見つかりません。先にステータスを「処理中」にして納品受付を行ってください。`
    );
    return;
  }

  if (deliveryEvent.inspectionCertUrl) {
    await backlog.addComment(issueKey, "ℹ️ 検収書は既に生成済みです。既存の文書URLを利用してください。");
    return;
  }

  // 支払条件をBacklogカスタムフィールドから取得
  // （親の発注課題フィールドを使用）
  const parentIssueKey = getField("BACKLOG_FIELD_PARENT_ISSUE_KEY");
  const parentCondition = parentIssueKey ? await loadParentOrderConditionFields(parentIssueKey) : undefined;

  try {
    const { inspectionCert, paymentNotice } = await generateDeliveryDocuments({
      deliveryEventId: deliveryEvent.id,
      paymentCondition: {
        closingDay: parentCondition?.closingDay ?? "末日",
        paymentMonthOffset: parentCondition?.paymentOffset ?? "1",
        paymentDay: parentCondition?.paymentDay ?? "末日",
        inspectionDays: parentCondition?.inspectionDays ?? 7,
        taxRate: parentCondition?.taxRate ?? 10,
      },
      person: {
        name: process.env.LEGAL_STAFF_NAME ?? "倉持 達也",
        department: "法務部",
      },
      vendorInvoiceNum: parentCondition?.vendorInvoiceNum ?? getField("BACKLOG_FIELD_VENDOR_INVOICE_NUM"),
    });

    const certLink   = inspectionCert.driveUrl   ? `[開く](${inspectionCert.driveUrl})`   : inspectionCert.localPath;
    const noticeLink = paymentNotice?.driveUrl    ? `[開く](${paymentNotice.driveUrl})`    : paymentNotice?.localPath ?? "（最終納品時のみ発行）";

    await saveGeneratedDocuments(issueKey, [
      { name: "inspection_cert", url: inspectionCert.driveUrl, localPath: inspectionCert.localPath },
      ...(paymentNotice ? [{ name: "payment_notice", url: paymentNotice.driveUrl, localPath: paymentNotice.localPath }] : []),
    ]);

    await backlog.addComment(issueKey,
      `## ✅ 検収書を発行しました\n\n` +
      `| 文書 | リンク |\n|------|--------|\n` +
      `| 検収書 | ${certLink} |\n` +
      `| 支払通知書 | ${noticeLink} |`
    );

    const blocks: object[] = [
      { type: "header", text: { type: "plain_text", text: "✅ 検収書を発行しました" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*課題*\n${issueKey}` },
        ],
      },
    ];
    const actions: object[] = [];
    if (inspectionCert.driveUrl) {
      actions.push({ type: "button", text: { type: "plain_text", text: "検収書を開く" }, url: inspectionCert.driveUrl });
    }
    if (paymentNotice?.driveUrl) {
      actions.push({ type: "button", text: { type: "plain_text", text: "支払通知書を開く" }, url: paymentNotice.driveUrl, style: "primary" });
    }
    if (actions.length > 0) blocks.push({ type: "actions", elements: actions });

    await postIssueAnswerback(slack, issueKey, {
      text: `✅ 検収書発行: ${issueKey}`,
      blocks: blocks as any,
    });
    await notifyRequesterDriveFolder(slack, issueKey, "検収書・支払通知書を生成しました。");

  } catch (e) {
    console.error(`[Webhook] 検収書生成失敗: ${issueKey}`, e);
    await backlog.addComment(issueKey, `⚠️ 検収書生成に失敗しました。エラー: ${String(e)}`);
  }
}

async function loadParentOrderConditionFields(parentIssueKey: string): Promise<{
  closingDay: string;
  paymentOffset: string;
  paymentDay: string;
  inspectionDays: number;
  taxRate: number;
  vendorInvoiceNum?: string;
} | undefined> {
  try {
    const parentIssue = await backlog.getIssue(parentIssueKey);
    const getParent = (envKey: string): string =>
      parentIssue.customFields?.find(f => f.fieldId === Number(process.env[envKey]))?.value ?? "";

    const inspectionDaysRaw = getParent("BACKLOG_FIELD_INSPECTION_DAYS") || getParent("BACKLOG_FIELD_INSPECTION_PERIOD_DAYS") || "7";
    const taxRateRaw = getParent("BACKLOG_FIELD_TAX_RATE") || "10";

    return {
      closingDay: getParent("BACKLOG_FIELD_CLOSING_DAY") || "末日",
      paymentOffset: getParent("BACKLOG_FIELD_PAYMENT_OFFSET") || "1",
      paymentDay: getParent("BACKLOG_FIELD_PAYMENT_DAY") || "末日",
      inspectionDays: parseSafeInt(inspectionDaysRaw, 7),
      taxRate: parseSafeInt(taxRateRaw, 10),
      vendorInvoiceNum: getParent("BACKLOG_FIELD_VENDOR_INVOICE_NUM") || undefined,
    };
  } catch {
    console.warn(`[Webhook] 親課題フィールド取得失敗、デフォルト値を使用: ${parentIssueKey}`);
    return undefined;
  }
}

// ================================================================
// NDA・売買契約・業務委託等の契約書生成
// ================================================================

async function handleContractDocumentGeneration(
  issueKey: string,
  issueTypeName: string,
  content: BacklogIssueContent,
  slack: SlackMessageClient
): Promise<void> {
  console.log(`[Webhook] 契約書生成: ${issueKey} / ${issueTypeName}`);

  const getField = (envKey: string): string =>
    content.customFields?.find(f => f.fieldId === Number(process.env[envKey]))?.value ?? "";
  const draft = await loadDocumentDraft(issueKey, {
    content,
    fallbackCounterparty: getField("BACKLOG_FIELD_COUNTERPARTY"),
  });
  const contractDate = draft.CONTRACT_DATE || getField("BACKLOG_FIELD_CONTRACT_DATE");
  const contractDateObj = contractDate ? new Date(contractDate) : new Date();
  const remarks = getField("BACKLOG_FIELD_REMARKS");
  const specialNotes = getField("BACKLOG_FIELD_SPECIAL_NOTES");
  const jurisdiction = getField("BACKLOG_FIELD_JURISDICTION") || "東京地方裁判所";

  const optionalField = (envKey: string, fallback = ""): string => {
    const envValue = process.env[envKey];
    if (!envValue) return fallback;
    const fieldValue = getField(envKey);
    return fieldValue || fallback;
  };

  const { ISSUE_TYPE_TO_TEMPLATE } = await import("../documents/templateRegistry");
  const templateKeys = ISSUE_TYPE_TO_TEMPLATE[issueTypeName];

  if (!templateKeys || templateKeys.length === 0) {
    console.log(`[Webhook] 課題タイプ「${issueTypeName}」は文書生成対象外`);
    return;
  }

  // 共通変数（全契約書で使用）
  const commonVars = {
    CONTRACT_NO:              getField("BACKLOG_FIELD_CONTRACT_NO"),
    CONTRACT_DATE:            contractDate,
    CONTRACT_DATE_FORMATTED:  contractDateObj.toLocaleDateString("ja-JP"),
    CONTRACT_DATE_YEAR:       String(contractDateObj.getFullYear()),
    CONTRACT_DATE_MONTH:      String(contractDateObj.getMonth() + 1),
    CONTRACT_DATE_DAY:        String(contractDateObj.getDate()),
    PARTY_A_NAME:             draft.PARTY_A_NAME || "",
    PARTY_A_ADDRESS:          draft.PARTY_A_ADDRESS || "",
    PARTY_A_REPRESENTATIVE:   draft.PARTY_A_REPRESENTATIVE || "",
    STAFF_NAME:               draft.STAFF_NAME || "",
    STAFF_DEPARTMENT:         draft.STAFF_DEPARTMENT || "",
    STAFF_PHONE:              draft.STAFF_PHONE || "",
    STAFF_EMAIL:              draft.STAFF_EMAIL || "",
    PARTY_B_NAME:             getField("BACKLOG_FIELD_COUNTERPARTY"),
    PARTY_B_ADDRESS:          getField("BACKLOG_FIELD_COUNTERPARTY_ADDRESS"),
    PARTY_B_REPRESENTATIVE:   getField("BACKLOG_FIELD_COUNTERPARTY_REP"),
    PARTY_B_REP:              getField("BACKLOG_FIELD_COUNTERPARTY_REP"),
    VENDOR_NAME:              getField("BACKLOG_FIELD_COUNTERPARTY"),
    VENDOR_ADDRESS:           getField("BACKLOG_FIELD_COUNTERPARTY_ADDRESS"),
    VENDOR_REP:               getField("BACKLOG_FIELD_COUNTERPARTY_REP"),
    VENDOR_EMAIL:             draft.VENDOR_EMAIL || optionalField("BACKLOG_FIELD_VENDOR_EMAIL", ""),
    VENDOR_PHONE:             draft.VENDOR_PHONE || optionalField("BACKLOG_FIELD_VENDOR_PHONE", ""),
    BANK_NAME:                draft.BANK_NAME || optionalField("BACKLOG_FIELD_BANK_NAME", ""),
    BRANCH_NAME:              draft.BRANCH_NAME || optionalField("BACKLOG_FIELD_BRANCH_NAME", ""),
    ACCOUNT_TYPE:             draft.ACCOUNT_TYPE || optionalField("BACKLOG_FIELD_ACCOUNT_TYPE", ""),
    ACCOUNT_NUMBER:           draft.ACCOUNT_NUMBER || optionalField("BACKLOG_FIELD_ACCOUNT_NUMBER", ""),
    ACCOUNT_HOLDER_KANA:      draft.ACCOUNT_HOLDER_KANA || optionalField("BACKLOG_FIELD_ACCOUNT_HOLDER_KANA", ""),
    IS_INVOICE_ISSUER:        draft.IS_INVOICE_ISSUER || optionalField("BACKLOG_FIELD_IS_INVOICE_ISSUER", ""),
    invoiceRegistrationDisplay: draft.invoiceRegistrationDisplay || optionalField("BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER", ""),
    SPECIAL_TERMS:            specialNotes,
    REMARKS:                  remarks,
    JURISDICTION:             jurisdiction,
    NDA_PURPOSE:              getField("BACKLOG_FIELD_NDA_PURPOSE"),
    CONTRACT_PERIOD:          getField("BACKLOG_FIELD_CONTRACT_PERIOD"),
    CONFIDENTIALITY_PERIOD:   getField("BACKLOG_FIELD_CONFIDENTIALITY_PERIOD"),
    PRODUCT_SCOPE:            optionalField("BACKLOG_FIELD_PRODUCT_SCOPE", remarks),
    DELIVERY_LOCATION:        optionalField("BACKLOG_FIELD_DELIVERY_LOCATION", "別途協議"),
    INSPECTION_PERIOD_DAYS:   optionalField("BACKLOG_FIELD_INSPECTION_PERIOD_DAYS", "5"),
    PAYMENT_CONDITION_SUMMARY: optionalField("BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY", remarks || "別途個別契約で定める"),
    WARRANTY_PERIOD:          optionalField("BACKLOG_FIELD_WARRANTY_PERIOD", "6か月"),
    CONFIDENTIALITY_YEARS:    optionalField("BACKLOG_FIELD_CONFIDENTIALITY_YEARS", "3"),
    CURE_PERIOD_DAYS:         optionalField("BACKLOG_FIELD_CURE_PERIOD_DAYS", "7"),
    DELIVERY_DAYS_AFTER_PAYMENT: optionalField("BACKLOG_FIELD_DELIVERY_DAYS_AFTER_PAYMENT", "3"),
    COD_DELIVERY_DAYS:        optionalField("BACKLOG_FIELD_COD_DELIVERY_DAYS", "3"),
    PREPAY_DEADLINE_DAYS:     optionalField("BACKLOG_FIELD_PREPAY_DEADLINE_DAYS", "5"),
    MONTHLY_CLOSING_DAY:      optionalField("BACKLOG_FIELD_MONTHLY_CLOSING_DAY", "末日"),
    PAYMENT_DUE_DAY:          optionalField("BACKLOG_FIELD_PAYMENT_DUE_DAY", "翌月末日"),
    SECURITY_DEPOSIT_AMOUNT:  optionalField("BACKLOG_FIELD_SECURITY_DEPOSIT_AMOUNT", "別途協議"),
    DEPOSIT_REPLENISH_DAYS:   optionalField("BACKLOG_FIELD_DEPOSIT_REPLENISH_DAYS", "7"),
    DELIVERY_FEE_THRESHOLD:   optionalField("BACKLOG_FIELD_DELIVERY_FEE_THRESHOLD", "別途協議"),
    ORIGINAL_WORK:            getField("BACKLOG_FIELD_ORIGINAL_WORK"),
    ORIGINAL_AUTHOR:          getField("BACKLOG_FIELD_ORIGINAL_AUTHOR"),
    CREDIT_NAME:              getField("BACKLOG_FIELD_CREDIT_NAME"),
    ライセンス種別名:          draft.LICENSE_TYPE_NAME || getField("BACKLOG_FIELD_LICENSE_TYPE_NAME"),
    原著作物名:               draft.ORIGINAL_WORK || getField("BACKLOG_FIELD_ORIGINAL_WORK"),
    原著作物補記:             "",
    対象製品予定名:           draft.PRODUCT_NAME || getField("BACKLOG_FIELD_PRODUCT_NAME"),
    許諾開始日:               draft.LICENSE_START || getField("BACKLOG_FIELD_LICENSE_START"),
    許諾期間注記:             "",
    素材番号:                 draft.MATERIAL_CODE || getField("BACKLOG_FIELD_MATERIAL_CODE") || (getField("BACKLOG_FIELD_LEDGER_ID") + "-01"),
    素材名:                   draft.MATERIAL_NAME || getField("BACKLOG_FIELD_MATERIAL_NAME") || draft.ORIGINAL_WORK || getField("BACKLOG_FIELD_ORIGINAL_WORK"),
    素材権利者:               draft.MATERIAL_RIGHTS_HOLDER || getField("BACKLOG_FIELD_MATERIAL_RIGHTS_HOLDER") || draft.VENDOR_NAME || getField("BACKLOG_FIELD_COUNTERPARTY"),
    監修者:                   draft.SUPERVISOR || getField("BACKLOG_FIELD_SUPERVISOR") || getField("BACKLOG_FIELD_COUNTERPARTY"),
    "金銭条件1_地域言語ラベル": draft.LICENSE_REGION_LANGUAGE_LABEL || getField("BACKLOG_FIELD_TERRITORY"),
    "金銭条件1_見出し":        draft.CONDITION1_HEADING || getField("BACKLOG_FIELD_CONDITION1_HEADING"),
    "金銭条件1_計算方式":      draft.CONDITION1_CALC_METHOD || getField("BACKLOG_FIELD_CONDITION1_CALC_METHOD"),
    "金銭条件1_計算式":        draft.CONDITION1_FORMULA || getField("BACKLOG_FIELD_CONDITION1_FORMULA"),
    "金銭条件1_基準価格ラベル": draft.CONDITION1_BASE_PRICE_LABEL || getField("BACKLOG_FIELD_CONDITION1_BASE_PRICE_LABEL") || "MSRP（希望小売価格・税抜）",
    "金銭条件1_料率":          draft.CONDITION1_RATE || getField("BACKLOG_FIELD_CONDITION1_RATE"),
    "金銭条件1_計算期間":      "製造都度",
    "金銭条件1_通貨":          getField("BACKLOG_FIELD_CURRENCY") || "JPY",
    "金銭条件1_支払条件":      draft.CONDITION1_PAYMENT_TERMS || getField("BACKLOG_FIELD_CONDITION1_PAYMENT_TERMS"),
    "金銭条件1_MG_AG":         draft.CONDITION1_MG_AG || getField("BACKLOG_FIELD_CONDITION1_MG_AG"),
    "金銭条件1_補足条件":      draft.CONDITION1_NOTE || getField("BACKLOG_FIELD_CONDITION1_NOTE"),
    "金銭条件2_見出し":        draft.CONDITION2_HEADING || getField("BACKLOG_FIELD_CONDITION2_HEADING"),
    "金銭条件2_地域":          draft.CONDITION2_REGION || getField("BACKLOG_FIELD_CONDITION2_REGION"),
    "金銭条件2_言語":          draft.CONDITION2_LANGUAGE || getField("BACKLOG_FIELD_CONDITION2_LANGUAGE"),
    "金銭条件2_計算方式":      draft.CONDITION2_CALC_METHOD || getField("BACKLOG_FIELD_CONDITION2_CALC_METHOD"),
    "金銭条件2_概要":          draft.CONDITION2_SUMMARY || getField("BACKLOG_FIELD_CONDITION2_SUMMARY"),
    "金銭条件2_計算式":        draft.CONDITION2_FORMULA || getField("BACKLOG_FIELD_CONDITION2_FORMULA"),
    "金銭条件2_計算式注記":    "",
    "金銭条件2_分配率":        draft.CONDITION2_SHARE_RATE || getField("BACKLOG_FIELD_CONDITION2_SHARE_RATE"),
    "金銭条件2_通貨":          getField("BACKLOG_FIELD_CURRENCY") || "JPY",
    "金銭条件2_支払条件":      draft.CONDITION2_PAYMENT_TERMS || getField("BACKLOG_FIELD_CONDITION2_PAYMENT_TERMS"),
    "金銭条件2_MG_AG":         draft.CONDITION2_MG_AG || getField("BACKLOG_FIELD_CONDITION2_MG_AG"),
    "金銭条件2_補足条件":      draft.CONDITION2_NOTE || getField("BACKLOG_FIELD_CONDITION2_NOTE"),
    "金銭条件3_見出し":        draft.CONDITION3_HEADING || getField("BACKLOG_FIELD_CONDITION3_HEADING"),
    "金銭条件3_地域":          draft.CONDITION3_REGION || getField("BACKLOG_FIELD_CONDITION3_REGION"),
    "金銭条件3_言語":          draft.CONDITION3_LANGUAGE || getField("BACKLOG_FIELD_CONDITION3_LANGUAGE"),
    "金銭条件3_計算方式":      draft.CONDITION3_CALC_METHOD || getField("BACKLOG_FIELD_CONDITION3_CALC_METHOD"),
    "金銭条件3_概要":          draft.CONDITION3_SUMMARY || getField("BACKLOG_FIELD_CONDITION3_SUMMARY"),
    "金銭条件3_計算式":        draft.CONDITION3_FORMULA || getField("BACKLOG_FIELD_CONDITION3_FORMULA"),
    "金銭条件3_計算式注記":    "",
    "金銭条件3_料率":          draft.CONDITION3_RATE || getField("BACKLOG_FIELD_CONDITION3_RATE"),
    "金銭条件3_通貨":          getField("BACKLOG_FIELD_CURRENCY") || "JPY",
    "金銭条件3_支払条件":      draft.CONDITION3_PAYMENT_TERMS || getField("BACKLOG_FIELD_CONDITION3_PAYMENT_TERMS"),
    "金銭条件3_MG_AG":         draft.CONDITION3_MG_AG || getField("BACKLOG_FIELD_CONDITION3_MG_AG"),
    "金銭条件3_補足条件":      draft.CONDITION3_NOTE || getField("BACKLOG_FIELD_CONDITION3_NOTE"),
    特記事項_本文:             draft.SPECIAL_TERMS || getField("BACKLOG_FIELD_SPECIAL_NOTES"),
  };
  const selectedDriveFolderKey = resolveDriveFolderKey(await findLegalRequestByBacklogKey(issueKey));

  try {
    const renderItems = templateKeys.map(key => ({
      templateKey: key as import("../documents/templateRegistry").TemplateKey,
      variables: { ...commonVars, ...draft },
      outputBasename: `${issueKey}_${issueTypeName}`,
      driveFolderKey: selectedDriveFolderKey,
    }));

    const docs = await renderMultipleTemplates(renderItems);
    await saveGeneratedDocuments(issueKey, docs.map((doc, index) => ({
      name: templateKeys[index],
      url: doc.driveUrl,
      localPath: doc.localPath,
    })));

    const rows = docs.map((d, i) =>
      `| ${templateKeys[i]} | ${d.driveUrl ? `[開く](${d.driveUrl})` : d.localPath} |`
    ).join("\n");

    await backlog.addComment(issueKey,
      `## ✅ 文書を生成しました\n\n| 文書 | リンク |\n|------|--------|\n${rows}`
    );

    await notifySlack(slack, issueKey, `📄 文書生成完了（${issueTypeName}）`,
      `${issueKey}: ${templateKeys.length}件の文書を生成しました。`);
    await notifyRequesterDriveFolder(slack, issueKey, `${issueTypeName}の文書を生成しました。`);

  } catch (e) {
    console.error(`[Webhook] 契約書生成失敗: ${issueKey}`, e);
    await backlog.addComment(issueKey, `⚠️ 文書生成に失敗しました。エラー: ${String(e)}`);
  }
}

async function ensureBacklogDocumentNumber(
  issueKey: string,
  issueTypeName: string,
  content: BacklogIssueContent
): Promise<void> {
  if (!process.env.BACKLOG_FIELD_CONTRACT_NO) return;
  if (content.customFields?.some((field) => field.fieldId === Number(process.env.BACKLOG_FIELD_CONTRACT_NO) && field.value)) {
    return;
  }

  const legalRequest = await findLegalRequestByBacklogKey(issueKey);
  const requesterSlackId = resolveRequesterSlackId(content as BacklogIssue, legalRequest);
  const staff = requesterSlackId ? await findStaffBySlackUserId(requesterSlackId) : null;
  const documentNo = await resolveIssueDocumentNumber(backlogClient, {
    issueKey,
    created: content.created ?? "",
    issueType: content.issueType,
    customFields: content.customFields,
  } as BacklogIssue, {
    partyAName: staff?.partyAName,
    departmentCode: staff?.departmentCode ?? undefined,
  });
  await backlog.updateCustomField(issueKey, Number(process.env.BACKLOG_FIELD_CONTRACT_NO), documentNo);
}

async function loadDocumentDraft(
  issueKey: string,
  input: {
    content: BacklogIssueContent;
    fallbackCounterparty?: string;
  }
): Promise<Record<string, string>> {
  const workflow = await findIssueWorkflowByIssueKey(issueKey);
  const savedDraft = normalizeDocumentDraft(workflow?.documentDraft);
  const legalRequest = await findLegalRequestByBacklogKey(issueKey);
  const requesterSlackId = resolveRequesterSlackId(input.content as BacklogIssue, legalRequest);
  const staff = requesterSlackId ? await findStaffBySlackUserId(requesterSlackId) : null;
  const vendor = await matchVendor({ vendorName: input.fallbackCounterparty });
  const issue = {
    issueKey,
    created: input.content.created ?? "",
    issueType: input.content.issueType,
    customFields: input.content.customFields,
  } as BacklogIssue;
  const fallbackDocumentDate = resolveIssueDocumentDate(issue);
  const fallbackDocumentNo = await resolveIssueDocumentNumber(backlogClient, issue, {
    partyAName: staff?.partyAName,
    departmentCode: staff?.departmentCode ?? undefined,
  });
  const counterpartyAddress = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY_ADDRESS);
  const counterpartyRep = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY_REP);
  const vendorEmail = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_VENDOR_EMAIL);
  const vendorPhone = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_VENDOR_PHONE);
  const bankName = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_BANK_NAME);
  const branchName = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_BRANCH_NAME);
  const accountType = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCOUNT_TYPE);
  const accountNumber = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCOUNT_NUMBER);
  const accountHolderKana = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCOUNT_HOLDER_KANA);
  const isInvoiceIssuer = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_IS_INVOICE_ISSUER);
  const invoiceRegistrationNumber = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER);

  return {
    ...savedDraft,
    CONTRACT_NO: savedDraft.CONTRACT_NO || fallbackDocumentNo,
    CONTRACT_DATE: savedDraft.CONTRACT_DATE || fallbackDocumentDate,
    PARTY_A_NAME: savedDraft.PARTY_A_NAME || staff?.partyAName || "",
    PARTY_A_ADDRESS: savedDraft.PARTY_A_ADDRESS || staff?.partyAAddress || "",
    PARTY_A_REPRESENTATIVE: savedDraft.PARTY_A_REPRESENTATIVE || staff?.partyARep || "",
    STAFF_NAME: savedDraft.STAFF_NAME || staff?.staffName || "",
    STAFF_DEPARTMENT: savedDraft.STAFF_DEPARTMENT || staff?.department || "",
    STAFF_PHONE: savedDraft.STAFF_PHONE || staff?.phone || "",
    STAFF_EMAIL: savedDraft.STAFF_EMAIL || staff?.email || "",
    VENDOR_NAME: savedDraft.VENDOR_NAME || input.fallbackCounterparty || vendor?.vendorName || "",
    VENDOR_ADDRESS: savedDraft.VENDOR_ADDRESS || counterpartyAddress || vendor?.address || "",
    VENDOR_REP: savedDraft.VENDOR_REP || counterpartyRep || vendor?.contactName || "",
    VENDOR_EMAIL: savedDraft.VENDOR_EMAIL || vendorEmail || vendor?.email || "",
    VENDOR_PHONE: savedDraft.VENDOR_PHONE || vendorPhone || vendor?.phone || "",
    BANK_NAME: savedDraft.BANK_NAME || bankName || vendor?.bankName || "",
    BRANCH_NAME: savedDraft.BRANCH_NAME || branchName || vendor?.branchName || "",
    ACCOUNT_TYPE: savedDraft.ACCOUNT_TYPE || accountType || vendor?.accountType || "",
    ACCOUNT_NUMBER: savedDraft.ACCOUNT_NUMBER || accountNumber || vendor?.accountNumber || "",
    ACCOUNT_HOLDER_KANA: savedDraft.ACCOUNT_HOLDER_KANA || accountHolderKana || vendor?.accountHolderKana || "",
    IS_INVOICE_ISSUER: savedDraft.IS_INVOICE_ISSUER || isInvoiceIssuer || (vendor?.isInvoiceIssuer ? "true" : ""),
    invoiceRegistrationDisplay: savedDraft.invoiceRegistrationDisplay || invoiceRegistrationNumber || vendor?.invoiceRegistrationNumber || "",
  };
}

function normalizeDocumentDraft(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => [key, rawValue == null ? "" : String(rawValue)])
  );
}

// ================================================================
// ロイヤリティ計算・計算書生成（製造案件）
// ================================================================

async function handleRoyaltyCalculation(
  issueKey: string,
  slack: SlackMessageClient
): Promise<void> {
  console.log(`[Webhook] ロイヤリティ計算開始: ${issueKey}`);

  try {
    const { royaltyReport, paymentNotice, result } = await generateRoyaltyFromIssue(issueKey);
    await saveGeneratedDocuments(issueKey, [
      { name: "royalty_report", url: royaltyReport.driveUrl, localPath: royaltyReport.localPath },
      ...(paymentNotice ? [{ name: "payment_notice", url: paymentNotice.driveUrl, localPath: paymentNotice.localPath }] : []),
    ]);

    const reportLink = royaltyReport.driveUrl
      ? `[Driveで開く](${royaltyReport.driveUrl})`
      : royaltyReport.localPath;
    const paymentNoticeLink = paymentNotice?.driveUrl
      ? `[Driveで開く](${paymentNotice.driveUrl})`
      : paymentNotice?.localPath ?? "（実支払額 0 円のため未発行）";

    // 計算結果をBacklogにコメント
    const zeroPayment = result.actualRoyalty === 0;
    await backlog.addComment(
      issueKey,
      `## ✅ ロイヤリティ計算完了\n\n` +
      `| 項目 | 金額 |\n|------|------|\n` +
      `| グロスロイヤリティ | ¥${result.grossRoyaltyStr} |\n` +
      (result.mgConsumedThisTime > 0
        ? `| MG充当額 | ▲¥${result.mgConsumedThisTime.toLocaleString("ja-JP")} |\n`
        : "") +
      `| **実支払額（税抜）** | **¥${result.actualRoyaltyStr}** |\n` +
      `| 消費税（${result.taxRate}%） | ¥${result.taxAmount.toLocaleString("ja-JP")} |\n` +
      `| **税込合計** | **¥${result.totalPaymentStr}** |\n\n` +
      (zeroPayment
        ? `⚠️ MG充当のため今期の実支払はありません（MG残高: ¥${result.mgRemaining.toLocaleString("ja-JP")}）\n\n`
        : `**支払期日: ${result.paymentDueDate}**\n**報告期限: ${result.reportingDeadline}**\n\n`) +
      `📎 利用許諾料計算書: ${reportLink}\n` +
      `🧾 支払通知書: ${paymentNoticeLink}`
    );

    // Slackに通知
    await postIssueAnswerback(slack, issueKey, {
      text: `💰 ロイヤリティ計算完了: ${issueKey}`,
      blocks: buildRoyaltyBlocks(issueKey, result, royaltyReport.driveUrl, paymentNotice?.driveUrl) as any,
    });
    await notifyRequesterDriveFolder(slack, issueKey, "利用許諾料計算書を生成しました。");

  } catch (e) {
    console.error(`[Webhook] ロイヤリティ計算失敗: ${issueKey}`, e);
    await backlog.addComment(issueKey, `⚠️ ロイヤリティ計算に失敗しました。\nエラー: ${String(e)}`);
  }
}

// ================================================================
// Slack Block Kit ビルダー
// ================================================================

function buildRoyaltyBlocks(
  issueKey: string,
  result: import("../documents/royalty").RoyaltyCalculationResult,
  driveUrl?: string,
  paymentNoticeUrl?: string
) {
  const zeroPayment = result.actualRoyalty === 0;

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `💰 ロイヤリティ計算完了: ${issueKey}` }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*製品*\n${result.productName}（${result.edition}）` },
        { type: "mrkdwn", text: `*製造完了*\n${result.completionDate}` },
        { type: "mrkdwn", text: `*課税対象数量*\n${result.billableQuantity.toLocaleString("ja-JP")}個` },
        { type: "mrkdwn", text: `*グロスロイヤリティ*\n¥${result.grossRoyaltyStr}` },
        ...(result.mgConsumedThisTime > 0
          ? [{ type: "mrkdwn", text: `*MG充当*\n▲¥${result.mgConsumedThisTime.toLocaleString("ja-JP")}` }]
          : []),
        {
          type: "mrkdwn",
          text: zeroPayment
            ? `*実支払額*\n¥0（MG充当）`
            : `*実支払額（税込）*\n¥${result.totalPaymentStr}`
        },
        ...(!zeroPayment ? [
          { type: "mrkdwn", text: `*報告期限*\n${result.reportingDeadline}` },
          { type: "mrkdwn", text: `*支払期日*\n${result.paymentDueDate}` },
        ] : [
          { type: "mrkdwn", text: `*MG残高*\n¥${result.mgRemaining.toLocaleString("ja-JP")}` },
        ]),
      ],
    },
  ];

  if (driveUrl || paymentNoticeUrl) {
    blocks.push({
      type: "actions",
      elements: [
        ...(driveUrl ? [{
          type: "button",
          text: { type: "plain_text", text: "利用許諾料計算書を開く" },
          url: driveUrl,
          style: "primary",
        }] : []),
        ...(paymentNoticeUrl ? [{
          type: "button",
          text: { type: "plain_text", text: "支払通知書を開く" },
          url: paymentNoticeUrl,
        }] : []),
      ],
    });
  }

  return blocks;
}

function parseSafeInt(value: string, fallback: number): number {
  const parsed = parseInt(String(value ?? "").replace(/[,，\s]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ================================================================
// ユーティリティ
// ================================================================

async function notifySlack(
  slack: SlackMessageClient,
  issueKey: string,
  title: string,
  message: string
): Promise<void> {
  await postIssueAnswerback(slack, issueKey, {
    text: `${title}: ${issueKey}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${title}*\n${message}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: new Date().toLocaleString("ja-JP") }] },
    ] as any,
  });
}

async function notifyRequesterDriveFolder(
  slack: SlackMessageClient,
  issueKey: string,
  title: string,
): Promise<void> {
  const issue = await backlogClient.getIssue(issueKey);
  const legalRequest = await findLegalRequestByBacklogKey(issueKey);
  const requesterSlackId = resolveRequesterSlackId(issue, legalRequest);
  const requesterStaff = requesterSlackId ? await findStaffBySlackUserId(requesterSlackId) : null;
  const folderKey = resolveDriveFolderKey(legalRequest, requesterStaff);
  const folderLabel = resolveDriveFolderLabel(folderKey);
  const folderId = resolveDriveFolderId(folderKey);
  const folderUrl = folderId ? `https://drive.google.com/drive/folders/${folderId}` : "";
  const counterparty = resolveIssueCounterparty(issue, legalRequest) || "未設定";

  await postIssueAnswerback(slack, issueKey, {
    text: `📁 ${title}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "📁 文書保存先のお知らせ" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*課題*\n${issueKey}` },
          { type: "mrkdwn", text: `*相手方*\n${counterparty}` },
          { type: "mrkdwn", text: `*保存先*\n${folderLabel}` },
          { type: "mrkdwn", text: `*フォルダID*\n${folderId || "未設定"}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: folderUrl
            ? `${title}\n保存先フォルダ: <${folderUrl}|Driveで開く>`
            : `${title}\n保存先フォルダIDはまだ未設定です。`,
        },
      },
    ] as any,
  });
}

async function notifyRequester(
  issueKey: string,
  content: BacklogIssueContent,
  slack: SlackMessageClient
): Promise<void> {
  const match = content.customFields
    ?.find(f => f.fieldId === Number(process.env.BACKLOG_FIELD_REQUESTER))
    ?.value?.match(/<@(\w+)>/);
  if (!match) return;

  await postIssueAnswerback(slack, issueKey, {
    text: `✅ 法務依頼が完了しました: ${issueKey}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "✅ 法務依頼が完了しました" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*受付番号*\n${issueKey}` },
          { type: "mrkdwn", text: `*件名*\n${content.summary ?? ""}` },
        ],
      },
    ] as any,
  });
}

// ---- 型定義 ----
interface BacklogWebhookPayload {
  type: number;
  project: { projectKey: string };
  content: BacklogIssueContent;
}
export interface BacklogIssueContent {
  keyId?: number;
  summary?: string;
  status?: { id: number; name: string };
  issueType?: { id: number; name: string };
  customFields?: Array<{ fieldId: number; value: string | null }>;
  comment?: { id?: number; content?: string | null };
  created?: string;
  updated?: string;
}

export async function generateDocumentsForIssue(
  issueKey: string,
  issueTypeName: string,
  content: BacklogIssueContent,
  slack: SlackMessageClient
): Promise<void> {
  const consultationTypeNames = new Set([
    process.env.BACKLOG_ISSUE_TYPE_LEGAL_CONSULTATION ?? "法務相談",
    "法律相談",
  ]);
  const deliveryTypeNames = new Set([
    process.env.BACKLOG_ISSUE_TYPE_DELIVERY ?? "納品リクエスト",
    "納品リクエスト",
    "納品報告",
  ]);
  const licenseTypeName = process.env.BACKLOG_ISSUE_TYPE_LICENSE ?? "ライセンス契約";
  const mfgTypeName = process.env.BACKLOG_ISSUE_TYPE_MFG ?? "製造案件";

  if (issueTypeName === licenseTypeName) {
    await handleLicenseDocumentGeneration(issueKey, content, slack);
    return;
  }

  if (issueTypeName === mfgTypeName) {
    await handleRoyaltyCalculation(issueKey, slack);
    return;
  }

  if (consultationTypeNames.has(issueTypeName)) {
    return;
  }

  if (deliveryTypeNames.has(issueTypeName)) {
    await handleDeliveryInspection(issueKey, content, slack);
    return;
  }

  if (issueTypeName === "発注書" || issueTypeName === "企画発注書") {
    const issue = await backlogClient.getIssue(issueKey);
    await generateOrderDocumentsFromIssue(issue as BacklogIssue);
    await notifySlack(slack, issueKey, "🧾 発注書生成完了", `${issueKey}: 発注書を生成しました。`);
    await notifyRequesterDriveFolder(slack, issueKey, "発注書を生成しました。");
    return;
  }

  await handleContractDocumentGeneration(issueKey, issueTypeName, content, slack);
}

export async function enqueueGenerateDocumentsForIssue(
  issueKey: string,
  issueTypeName: string,
  content: WorkIssueContent,
  slack: SlackMessageClient,
  source: WorkSource,
): Promise<EnqueueWorkResult> {
  const item = createGenerateDocumentsWorkItem({
    source,
    issueKey,
    issueTypeName,
    content,
  });

  return enqueueWork(item, {
    inline: async () => {
      await executeWorkItem(item, { slack });
    },
  });
}
