/**
 * slack/handlers.ts
 * Slack Bot のイベント・アクション・スラッシュコマンドハンドラー
 *
 * 実装機能:
 * 1. /法務依頼  - Block Kitモーダルで依頼フォーム表示
 * 2. /法務ステータス [課題キー] - Backlogステータスをその場で確認
 * 3. モーダル送信 - Backlog課題起票 + 法務チャンネルへ通知
 */

import { App } from "@slack/bolt";
import { backlog } from "../backlog/client";
import { downloadSlackFile } from "../documents/fileStorage";
import { getDefaultDriveFolderKey, resolveDriveFolderLabel } from "../documents/driveFolders";
import { getDocumentRequestDefinition } from "../workflow/documentRequestConfig";
import { getBacklogCustomFieldValue } from "../workflow/documentDefaults";
import { resolveIssueDocumentNumber } from "../workflow/documentDefaults";
import { getWorkflowSettings } from "../workflow/workflowSettings";
import {
  buildLegalRequestAppendModal,
  buildLegalRequestEntryModal,
  buildRequestModal as buildLegalRequestModal,
  buildSimpleLegalRequestModal,
  buildTextareaBlock,
  extractModalValues,
} from "./modalBuilders";

async function loadApprovals() {
  return import("../workflow/approvals");
}

async function loadRepository() {
  return import("../db/repository");
}

async function loadThreading() {
  return import("./threading");
}

export function registerSlackHandlers(app: App): void {

  // ================================================================
  // 1. スラッシュコマンド: /法務依頼
  //    → Block Kit モーダルを開く
  // ================================================================
  app.command("/法務依頼", async ({ command, ack, client, respond, logger }) => {
    await ack();

    try {
      const issueKey = normalizeIssueKeyInput(command.text);
      await client.views.open({
        trigger_id: command.trigger_id,
        view: issueKey
          ? buildLegalRequestAppendModal(command.channel_id, command.user_id, { existing_issue_key: issueKey })
          : buildLegalRequestEntryModal(command.channel_id, command.user_id),
      });
    } catch (e) {
      logger.error("[Slack] モーダル表示失敗", e);
      await respond({
        response_type: "ephemeral",
        text: "⚠️ 法務依頼フォームを開けませんでした。時間を空けて再度お試しください。解消しない場合は管理画面の Staff 登録と Slack アプリ設定をご確認ください。",
      });
    }
  });

  app.command("/法務検索", async ({ command, ack, respond, logger }) => {
    await ack();

    const query = command.text.trim();
    if (!query) {
      try {
        await app.client.views.open({
          trigger_id: command.trigger_id,
          view: buildLegalSearchModal(),
        });
      } catch (error) {
        logger.error("[Slack] 法務検索モーダル表示失敗", error);
        await respond({
          response_type: "ephemeral",
          text: "⚠️ 検索モーダルの表示に失敗しました。",
        });
      }
      return;
    }

    try {
      const results = await searchParentIssueCandidatesFromBacklog(query, 8);
      if (results.length === 0) {
        await respond({
          response_type: "ephemeral",
          text: `該当する案件が見つかりませんでした: \`${query}\``,
        });
        return;
      }

      await respond({
        response_type: "ephemeral",
        blocks: buildParentIssueSearchBlocks(query, results),
      });
    } catch (error) {
      logger.error("[Slack] 法務検索失敗", error);
      await respond({
        response_type: "ephemeral",
        text: "⚠️ 検索中にエラーが発生しました。",
      });
    }
  });

  app.view("legal_search_modal", async ({ ack, view, logger }) => {
    const query = view.state.values.search_query?.input?.value?.trim() ?? "";
    if (!query) {
      await ack({
        response_action: "errors",
        errors: { search_query: "検索語を入力してください。" },
      });
      return;
    }

    try {
      const results = await searchParentIssueCandidatesFromBacklog(query, 8);
      await ack({
        response_action: "update",
        view: buildLegalSearchResultsModal(query, results),
      });
    } catch (error) {
      logger.error("[Slack] 法務検索モーダル送信失敗", error);
      await ack({
        response_action: "update",
        view: buildLegalSearchResultsModal(query, [], "検索中にエラーが発生しました。"),
      });
    }
  });

  app.view("legal_request_entry_modal", async ({ ack, view }) => {
    const values = view.state.values;
    const mode = values.request_mode?.request_mode_select?.selected_option?.value ?? "new_request";
    const issueKey = (values.existing_issue_key?.input?.value ?? "").trim().toUpperCase();
    const metadata = JSON.parse(view.private_metadata || "{}");

    await ack({
      response_action: "update",
      view: mode === "append_request"
        ? buildLegalRequestAppendModal(metadata.channelId ?? "", metadata.userId ?? "", { existing_issue_key: issueKey })
        : buildSimpleLegalRequestModal(metadata.channelId ?? "", metadata.userId ?? {}),
    });
  });

  app.view("legal_request_simple_modal", async ({ ack, view, body, client, logger }) => {
    const values = view.state.values;
    const userId = body.user.id;
    const requestedContractType = values.contract_type?.simple_contract_type_select?.selected_option?.value ?? "legal_consultation";
    const contractType = requestedContractType === "legal_review" ? "legal_consultation" : requestedContractType;
    const summary = (values.summary?.input?.value ?? "").trim();
    const notes = (values.notes?.input?.value ?? "").trim();
    const deadline = values.deadline?.datepicker?.selected_date ?? "";
    const counterparty = (values.counterparty?.input?.value ?? "").trim();
    const slackAttachmentFileIds = extractSlackAttachmentFileIds(values);

    const validationErrors: Record<string, string> = {};
    if (!summary) {
      validationErrors.summary = "件名を入力してください。";
    }
    if (!notes) {
      validationErrors.notes = "依頼内容を入力してください。";
    }
    if (Object.keys(validationErrors).length > 0) {
      await ack({ response_action: "errors", errors: validationErrors });
      return;
    }

    await ack();

    try {
      const requestDefinition = getDocumentRequestDefinition(contractType);
      const issueTypeId = requestDefinition
        ? await backlog.findIssueTypeIdByName(requestDefinition.backlogIssueTypeName)
        : undefined;
      if (requestDefinition && !issueTypeId) {
        throw new Error(`Backlog課題タイプが見つかりません: ${requestDefinition.backlogIssueTypeName}`);
      }

      const attachmentIds = await uploadSlackModalFilesToBacklog({
        client,
        logger,
        slackFileIds: slackAttachmentFileIds,
        issueSummary: summary,
      });

      const issue = await backlog.createIssue({
        summary: buildLegalRequestIssueSummary(summary, counterparty),
        description: buildSimpleBacklogDescription({
          userId,
          contractTypeLabel: requestedContractType === "legal_review" ? "レビュー依頼" : requestDefinition?.text ?? contractType,
          summary,
          notes,
          deadline,
          counterparty,
        }),
        issueTypeId,
        dueDate: deadline || undefined,
        attachmentIds,
        customFields: buildSimpleBacklogCustomFields({
          requester: process.env.BACKLOG_FIELD_REQUESTER ? `<@${userId}>` : "",
          contractTypeLabel: requestedContractType === "legal_review" ? "レビュー依頼" : requestDefinition?.text ?? contractType,
          counterparty,
          deadline,
          remarks: notes,
        }),
      });

      await finalizeIntakeAfterIssueCreated({
        issue,
        userId,
        view,
        client,
        logger,
        effectiveContractType: contractType,
        driveFolderKey: getDefaultDriveFolderKey(),
        counterparty,
        summary,
        deadline,
        notes,
        requestDefinitionText: requestedContractType === "legal_review" ? "レビュー依頼" : requestDefinition?.text ?? contractType,
      });
    } catch (e) {
      logger.error("[Slack] 新規法務依頼起票失敗", e);
      await notifyIssueCreateFailure(client as any, logger, userId);
    }
  });

  app.view("legal_request_append_modal", async ({ ack, view, body, client, logger }) => {
    const values = view.state.values;
    const userId = body.user.id;
    const issueKey = normalizeIssueKeyInput(values.existing_issue_key?.input?.value ?? "");
    const appendNotes = (values.append_notes?.input?.value ?? "").trim();
    const slackAttachmentFileIds = extractSlackAttachmentFileIds(values);

    const validationErrors: Record<string, string> = {};
    if (!issueKey) {
      validationErrors.existing_issue_key = "課題キーを入力してください。";
    }
    if (!appendNotes && slackAttachmentFileIds.length === 0) {
      validationErrors.append_notes = "追記内容または添付ファイルのどちらかを入れてください。";
    }
    if (Object.keys(validationErrors).length > 0) {
      await ack({ response_action: "errors", errors: validationErrors });
      return;
    }

    await ack();

    try {
      const issue = await backlog.getIssue(issueKey!);
      const attachmentIds = await uploadSlackModalFilesToBacklog({
        client,
        logger,
        slackFileIds: slackAttachmentFileIds,
        issueSummary: issue.summary,
      });

      await backlog.addCommentWithAttachments(
        issue.issueKey,
        buildAppendComment({ userId, notes: appendNotes, attachmentCount: attachmentIds.length }),
        attachmentIds,
      );
      await notifyIssueAppendSuccess(client as any, logger, userId, issue.issueKey, appendNotes, attachmentIds.length);
    } catch (error) {
      logger.error("[Slack] 課題追記失敗", error);
      await notifyIssueCreateFailure(client as any, logger, userId);
    }
  });

  app.action("create_followup_delivery", async ({ ack, body, client, logger }) => {
    await ack();
    const issueKey = (body as any).actions?.[0]?.value ?? "";
    if (!issueKey) return;

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildRequestModal("", body.user.id, "delivery_request", {
          parent_issue_key: issueKey,
          drive_folder_key: getDefaultDriveFolderKey(),
        }),
      });
    } catch (error) {
      logger.error("[Slack] 納品リクエストショートカット起動失敗", error);
    }
  });

  app.action("create_followup_royalty", async ({ ack, body, client, logger }) => {
    await ack();
    const issueKey = (body as any).actions?.[0]?.value ?? "";
    if (!issueKey) return;

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildRequestModal("", body.user.id, "royalty_calculation_manufacturing", {
          license_issue_key: issueKey,
          drive_folder_key: getDefaultDriveFolderKey(),
        }),
      });
    } catch (error) {
      logger.error("[Slack] 利用許諾料計算ショートカット起動失敗", error);
    }
  });

  app.action("create_followup_royalty_sales", async ({ ack, body, client, logger }) => {
    await ack();
    const issueKey = (body as any).actions?.[0]?.value ?? "";
    if (!issueKey) return;

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildRequestModal("", body.user.id, "royalty_calculation_sales_report", {
          license_issue_key: issueKey,
          drive_folder_key: getDefaultDriveFolderKey(),
        }),
      });
    } catch (error) {
      logger.error("[Slack] 売上報告ベース利用許諾料計算ショートカット起動失敗", error);
    }
  });

  app.action("create_followup_license_schedule", async ({ ack, body, client, logger }) => {
    await ack();
    const issueKey = (body as any).actions?.[0]?.value ?? "";
    if (!issueKey) return;

    try {
      const issue = await backlog.getIssue(issueKey);
      const getField = (envKey: string) =>
        issue.customFields?.find((field) => field.fieldId === Number(process.env[envKey]))?.value ?? "";

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildRequestModal("", body.user.id, "license_schedule", {
          counterparty: getField("BACKLOG_FIELD_COUNTERPARTY") || issue.summary || "",
          original_work: getField("BACKLOG_FIELD_ORIGINAL_WORK") || "",
          license_issue_key: issueKey,
          drive_folder_key: getDefaultDriveFolderKey(),
        }),
      });
    } catch (error) {
      logger.error("[Slack] 個別利用許諾条件ショートカット起動失敗", error);
    }
  });

  // ================================================================
  // 2. モーダル送信: 依頼内容をBacklogに起票
  // ================================================================
  app.view("legal_request_modal", async ({ ack, view, body, client, logger }) => {
    const values = view.state.values;
    const userId = body.user.id;
    const textValue = (blockId: string) => values[blockId]?.input?.value ?? "";
    const dateValue = (blockId: string) => values[blockId]?.datepicker?.selected_date ?? "";

    // モーダルの入力値を取得
    const contractType = values.contract_type?.contract_type_select?.selected_option?.value ?? "nda";
    const licenseBundleMode = values.license_bundle_mode?.license_bundle_mode_select?.selected_option?.value ?? "basic_with_schedule";
    const outsourcingBundleMode =
      values.outsourcing_bundle_mode?.outsourcing_bundle_mode_select?.selected_option?.value ?? "basic_with_order";
    const effectiveContractType =
      contractType === "license" && licenseBundleMode === "schedule_only"
        ? "license_schedule"
        : contractType === "outsourcing" && outsourcingBundleMode === "order_only"
          ? "purchase_order"
          : contractType;
    const requestDefinition = getDocumentRequestDefinition(effectiveContractType);
    const driveFolderKey =
      values.drive_folder_key?.drive_folder_select?.selected_option?.value
      ?? getDefaultDriveFolderKey();
    const registrationNumber = textValue("registration_number");
    const counterparty = textValue("counterparty");
    const summary = textValue("summary");
    const deadline = dateValue("deadline");
    const contractDate = dateValue("contract_date");
    const contractNo = textValue("contract_no");
    const counterpartyAddress = textValue("counterparty_address");
    const counterpartyRepresentative = textValue("counterparty_representative");
    const remarks = textValue("remarks");
    const contractPeriod = textValue("contract_period");
    const confidentialityPeriod = textValue("confidentiality_period");
    const ndaPurpose = textValue("nda_purpose");
    const jurisdiction = textValue("jurisdiction");
    const originalWork = textValue("original_work");
    const originalAuthor = textValue("original_author");
    const creditName = textValue("credit_name");
    const successionMemoDate = textValue("succession_memorandum_date");
    const licenseTypeName = textValue("license_type_name");
    const projectTitle = textValue("project_title");
    const orderSummary = textValue("order_summary");
    const licenseStart = dateValue("license_start");
    const territory = textValue("territory");
    const dealStructure = textValue("deal_structure");
    const changeMode = textValue("change_mode");
    const baseAgreementKey = textValue("base_agreement_key");
    const effectiveDate = dateValue("effective_date");
    const licenseScope = textValue("license_scope");
    const ipProductScope = textValue("ip_product_scope");
    const exclusivity = textValue("exclusivity");
    const revenueModel = textValue("revenue_model");
    const royaltyTerms = textValue("royalty_terms");
    const sublicenseAllowed = textValue("sublicense_allowed");
    const titleTransferModel = textValue("title_transfer_model");
    const inventorySelloff = textValue("inventory_selloff");
    const amendmentClauses = textValue("amendment_clauses");
    const specialNotes = textValue("special_notes");
    const schedule1Summary = textValue("schedule_1_summary");
    const schedule1SpecialProvisions = textValue("schedule_1_special_provisions");
    const schedule2Summary = textValue("schedule_2_summary");
    const schedule2SpecialProvisions = textValue("schedule_2_special_provisions");
    const s1RoyaltyRate = textValue("s1_royalty_rate");
    const s1MinimumGuarantee = textValue("s1_minimum_guarantee");
    const s1Advance = textValue("s1_advance");
    const s1AccountingPeriod = textValue("s1_accounting_period");
    const s1PaymentDue = textValue("s1_payment_due");
    const s1ReportDue = textValue("s1_report_due");
    const s1FxConversion = textValue("s1_fx_conversion");
    const s1FirstPrintRun = textValue("s1_first_print_run");
    const s1TargetReleaseDate = textValue("s1_target_release_date");
    const s1ComplimentaryCopies = textValue("s1_complimentary_copies");
    const s1CreditWording = textValue("s1_credit_wording");
    const s1TerritoryJurisdiction = textValue("s1_territory_jurisdiction");
    const s1ConsumerLawCarveout = textValue("s1_consumer_law_carveout");
    const s1VatGstTreatment = textValue("s1_vat_gst_treatment");
    const s1CopyrightRegistration = textValue("s1_copyright_registration");
    const s1MoralRights = textValue("s1_moral_rights");
    const s1MandatoryDistributionLaw = textValue("s1_mandatory_distribution_law");
    const s1AdditionalTerms = textValue("s1_additional_terms");
    const s2ProductPriceList = textValue("s2_product_price_list");
    const s2MprYear1 = textValue("s2_mpr_year1");
    const s2MprYear2 = textValue("s2_mpr_year2");
    const s2MprYear3 = textValue("s2_mpr_year3");
    const s2IncotermsDelivery = textValue("s2_incoterms_delivery");
    const s2ArrivalPoint = textValue("s2_arrival_point");
    const s2PaymentAdvance = textValue("s2_payment_advance");
    const s2PaymentBalance = textValue("s2_payment_balance");
    const s2PaymentCurrency = textValue("s2_payment_currency");
    const s2TerritoryJurisdiction = textValue("s2_territory_jurisdiction");
    const s2ImportCustomsAllocation = textValue("s2_import_customs_allocation");
    const s2ConsumerProductSafety = textValue("s2_consumer_product_safety");
    const s2DistributionLawProtections = textValue("s2_distribution_law_protections");
    const s2VatGstSupply = textValue("s2_vat_gst_supply");
    const s2ProductLiabilityInsurance = textValue("s2_product_liability_insurance");
    const s2MarketplaceOnlineSales = textValue("s2_marketplace_online_sales");
    const s2AdditionalTerms = textValue("s2_additional_terms");
    const parentIssueKey = textValue("parent_issue_key");
    const itemNo = values.delivery_item_no?.delivery_item_no_select?.selected_option?.value ?? textValue("item_no");
    const deliveryNote = textValue("delivery_note");
    const deliveredAmount = textValue("delivered_amount");
    const licenseIssueKey = textValue("license_issue_key");
    const productName = textValue("product_name");
    const edition = textValue("edition");
    const completionDate = dateValue("completion_date");
    const quantity = textValue("quantity");
    const msrp = textValue("msrp");
    const sampleQuantity = textValue("sample_quantity");
    const reportPeriodStart = dateValue("report_period_start");
    const reportPeriodEnd = dateValue("report_period_end");
    const salesAmount = textValue("sales_amount");
    const receivedAmount = textValue("received_amount");
    const salesQuantity = textValue("sales_quantity");
    const productScope = textValue("product_scope");
    const deliveryLocation = textValue("delivery_location");
    const inspectionPeriodDays = textValue("inspection_period_days");
    const paymentConditionSummary = textValue("payment_condition_summary");
    const warrantyPeriod = textValue("warranty_period");
    const monthlyClosingDay = textValue("monthly_closing_day");
    const paymentDueDay = textValue("payment_due_day");
    const paymentMethod = textValue("payment_method");
    const securityDepositAmount = textValue("security_deposit_amount");
    const depositReplenishDays = textValue("deposit_replenish_days");
    const notes = textValue("notes");
    const outsourcingNotes = textValue("outsourcing_notes");

    const validationErrors = validateRequestSubmission({
      contractType: effectiveContractType,
      registrationNumber,
      counterparty,
      summary,
      projectTitle,
      counterpartyAddress,
      contractDate,
      originalWork,
      licenseTypeName,
      licenseStart,
      ndaPurpose,
      contractPeriod,
      jurisdiction,
      productName,
      dealStructure,
      changeMode,
      baseAgreementKey,
      effectiveDate,
      licenseScope,
      ipProductScope,
      exclusivity,
      revenueModel,
      royaltyTerms,
      sublicenseAllowed,
      titleTransferModel,
      inventorySelloff,
      amendmentClauses,
      schedule1Summary,
      schedule1SpecialProvisions,
      schedule2Summary,
      schedule2SpecialProvisions,
      s1RoyaltyRate,
      s1MinimumGuarantee,
      s1Advance,
      s1AccountingPeriod,
      s1PaymentDue,
      s1ReportDue,
      s1FxConversion,
      s1FirstPrintRun,
      s1TargetReleaseDate,
      s1ComplimentaryCopies,
      s1CreditWording,
      s1TerritoryJurisdiction,
      s1ConsumerLawCarveout,
      s1VatGstTreatment,
      s1CopyrightRegistration,
      s1MoralRights,
      s1MandatoryDistributionLaw,
      s1AdditionalTerms,
      s2ProductPriceList,
      s2MprYear1,
      s2MprYear2,
      s2MprYear3,
      s2IncotermsDelivery,
      s2ArrivalPoint,
      s2PaymentAdvance,
      s2PaymentBalance,
      s2PaymentCurrency,
      s2TerritoryJurisdiction,
      s2ImportCustomsAllocation,
      s2ConsumerProductSafety,
      s2DistributionLawProtections,
      s2VatGstSupply,
      s2ProductLiabilityInsurance,
      s2MarketplaceOnlineSales,
      s2AdditionalTerms,
      licenseIssueKey,
      parentIssueKey,
      itemNo,
      completionDate,
      quantity,
      msrp,
      reportPeriodStart,
      reportPeriodEnd,
      salesAmount,
      receivedAmount,
      salesQuantity,
      productScope,
      deliveryLocation,
      inspectionPeriodDays,
      paymentConditionSummary,
      warrantyPeriod,
      monthlyClosingDay,
      paymentDueDay,
      paymentMethod,
      securityDepositAmount,
      depositReplenishDays,
      notes: effectiveContractType === "outsourcing" ? outsourcingNotes : notes,
    });
    if (Object.keys(validationErrors).length > 0) {
      await ack({
        response_action: "errors",
        errors: validationErrors,
      });
      return;
    }

    const slackAttachmentFileIds = extractSlackAttachmentFileIds(values);
    await ack();

    logger.info(`[Slack] 依頼受信: ${effectiveContractType} / ${counterparty} / ${summary}`);

    try {
      const issueTypeId = requestDefinition
        ? await backlog.findIssueTypeIdByName(requestDefinition.backlogIssueTypeName)
        : undefined;
      if (requestDefinition && !issueTypeId) {
        throw new Error(`Backlog課題タイプが見つかりません: ${requestDefinition.backlogIssueTypeName}`);
      }

      const attachmentIds = await uploadSlackModalFilesToBacklog({
        client,
        logger,
        slackFileIds: slackAttachmentFileIds,
        issueSummary: summary,
      });

      // Backlogに課題を起票
      const issue = await backlog.createIssue({
        summary: buildLegalRequestIssueSummary(summary, counterparty),
        description: buildBacklogDescription({
          userId,
          contractType: effectiveContractType,
          registrationNumber,
          driveFolderLabel: resolveDriveFolderLabel(driveFolderKey),
          counterparty,
          summary,
          projectTitle,
          orderSummary,
          deadline,
          contractNo,
          counterpartyAddress,
          counterpartyRepresentative,
          remarks,
          contractDate,
          contractPeriod,
          confidentialityPeriod,
          licenseBundleMode,
          outsourcingBundleMode,
          ndaPurpose,
          jurisdiction,
          originalWork,
          originalAuthor,
          creditName,
          successionMemoDate,
          licenseTypeName,
          licenseStart,
          territory,
          dealStructure,
          changeMode,
          baseAgreementKey,
          effectiveDate,
          licenseScope,
          ipProductScope,
          exclusivity,
          revenueModel,
          royaltyTerms,
          sublicenseAllowed,
          titleTransferModel,
          inventorySelloff,
          amendmentClauses,
          specialNotes,
          schedule1Summary,
          schedule1SpecialProvisions,
          schedule2Summary,
          schedule2SpecialProvisions,
          s1RoyaltyRate,
          s1MinimumGuarantee,
          s1Advance,
          s1AccountingPeriod,
          s1PaymentDue,
          s1ReportDue,
          s1FxConversion,
          s1FirstPrintRun,
          s1TargetReleaseDate,
          s1ComplimentaryCopies,
          s1CreditWording,
          s1TerritoryJurisdiction,
          s1ConsumerLawCarveout,
          s1VatGstTreatment,
          s1CopyrightRegistration,
          s1MoralRights,
          s1MandatoryDistributionLaw,
          s1AdditionalTerms,
          s2ProductPriceList,
          s2MprYear1,
          s2MprYear2,
          s2MprYear3,
          s2IncotermsDelivery,
          s2ArrivalPoint,
          s2PaymentAdvance,
          s2PaymentBalance,
          s2PaymentCurrency,
          s2TerritoryJurisdiction,
          s2ImportCustomsAllocation,
          s2ConsumerProductSafety,
          s2DistributionLawProtections,
          s2VatGstSupply,
          s2ProductLiabilityInsurance,
          s2MarketplaceOnlineSales,
          s2AdditionalTerms,
          parentIssueKey,
          itemNo,
          deliveryNote,
          deliveredAmount,
          licenseIssueKey,
          productName,
          edition,
          completionDate,
          quantity,
          msrp,
          sampleQuantity,
          reportPeriodStart,
          reportPeriodEnd,
          salesAmount,
          receivedAmount,
          salesQuantity,
          productScope,
          deliveryLocation,
          inspectionPeriodDays,
          paymentConditionSummary,
          warrantyPeriod,
          monthlyClosingDay,
          paymentDueDay,
          paymentMethod,
          securityDepositAmount,
          depositReplenishDays,
          notes: effectiveContractType === "outsourcing" ? outsourcingNotes : notes,
        }),
        issueTypeId,
        dueDate: deadline || undefined,
        attachmentIds,
        customFields: buildBacklogCustomFields(effectiveContractType, {
          requester: process.env.BACKLOG_FIELD_REQUESTER ? `<@${userId}>` : "",
          contractTypeLabel: requestDefinition?.text ?? effectiveContractType,
          registrationNumber,
          counterparty,
          projectTitle,
          orderSummary,
          deadline,
          contractNo,
          counterpartyAddress,
          counterpartyRepresentative,
          remarks,
          contractDate,
          contractPeriod,
          confidentialityPeriod,
          ndaPurpose,
          jurisdiction,
          originalWork,
          originalAuthor,
          creditName,
          successionMemoDate,
          licenseTypeName,
          licenseStart,
          territory,
          dealStructure,
          changeMode,
          baseAgreementKey,
          effectiveDate,
          licenseScope,
          ipProductScope,
          exclusivity,
          revenueModel,
          royaltyTerms,
          sublicenseAllowed,
          titleTransferModel,
          inventorySelloff,
          amendmentClauses,
          specialNotes,
          schedule1Summary,
          schedule1SpecialProvisions,
          schedule2Summary,
          schedule2SpecialProvisions,
          s1RoyaltyRate,
          s1MinimumGuarantee,
          s1Advance,
          s1AccountingPeriod,
          s1PaymentDue,
          s1ReportDue,
          s1FxConversion,
          s1FirstPrintRun,
          s1TargetReleaseDate,
          s1ComplimentaryCopies,
          s1CreditWording,
          s1TerritoryJurisdiction,
          s1ConsumerLawCarveout,
          s1VatGstTreatment,
          s1CopyrightRegistration,
          s1MoralRights,
          s1MandatoryDistributionLaw,
          s1AdditionalTerms,
          s2ProductPriceList,
          s2MprYear1,
          s2MprYear2,
          s2MprYear3,
          s2IncotermsDelivery,
          s2ArrivalPoint,
          s2PaymentAdvance,
          s2PaymentBalance,
          s2PaymentCurrency,
          s2TerritoryJurisdiction,
          s2ImportCustomsAllocation,
          s2ConsumerProductSafety,
          s2DistributionLawProtections,
          s2VatGstSupply,
          s2ProductLiabilityInsurance,
          s2MarketplaceOnlineSales,
          s2AdditionalTerms,
          parentIssueKey,
          itemNo,
          deliveryNote,
          deliveredAmount,
          licenseIssueKey,
          productName,
          edition,
          completionDate,
          quantity,
          msrp,
          sampleQuantity,
          reportPeriodStart,
          reportPeriodEnd,
          salesAmount,
          receivedAmount,
          salesQuantity,
          productScope,
          deliveryLocation,
          inspectionPeriodDays,
          paymentConditionSummary,
          warrantyPeriod,
          monthlyClosingDay,
          paymentDueDay,
          paymentMethod,
          securityDepositAmount,
          depositReplenishDays,
        }),
      });

      await finalizeIntakeAfterIssueCreated({
        issue,
        userId,
        view,
        client,
        logger,
        effectiveContractType,
        driveFolderKey,
        counterparty,
        summary,
        deadline,
        notes: effectiveContractType === "outsourcing" ? outsourcingNotes : notes,
        documentDraft:
          effectiveContractType === "ip_overseas_master" || effectiveContractType === "ip_overseas_amendment"
            ? {
                LICENSE_SCOPE: licenseScope,
                IP_PRODUCT_SCOPE: ipProductScope,
                ROYALTY_TERMS: royaltyTerms,
                SUBLICENSE_ALLOWED: sublicenseAllowed,
                TITLE_TRANSFER_MODEL: titleTransferModel,
                INVENTORY_SELLOFF: inventorySelloff,
                SPECIAL_NOTES: specialNotes,
                SCHEDULE_1_SUMMARY: schedule1Summary,
                SCHEDULE_1_SPECIAL_PROVISIONS: schedule1SpecialProvisions,
                SCHEDULE_2_SUMMARY: schedule2Summary,
                SCHEDULE_2_SPECIAL_PROVISIONS: schedule2SpecialProvisions,
              }
            : undefined,
        requestDefinitionText: requestDefinition?.text ?? effectiveContractType,
      });

    } catch (e) {
      logger.error("[Slack] 課題起票失敗", e);

      await notifyIssueCreateFailure(client as any, logger, userId);
    }
  });

  app.action("contract_type_select", async ({ ack, body, client, logger }) => {
    await ack();
    const selectedType = (body as any).actions?.[0]?.selected_option?.value ?? "nda";
    const currentView = (body as any).view;
    if (!currentView?.id) return;

    try {
      await refreshLegalRequestModal(client, logger, currentView, selectedType);
    } catch (error) {
      logger.error("[Slack] 契約種別切替失敗", error);
    }
  });

  app.action("license_bundle_mode_select", async ({ ack, body, client, logger }) => {
    await ack();
    const currentView = (body as any).view;
    if (!currentView?.id) return;

    try {
      await refreshLegalRequestModal(client, logger, currentView, "license");
    } catch (error) {
      logger.error("[Slack] ライセンス作成方式切替失敗", error);
    }
  });

  app.action("outsourcing_bundle_mode_select", async ({ ack, body, client, logger }) => {
    await ack();
    const currentView = (body as any).view;
    if (!currentView?.id) return;

    try {
      await refreshLegalRequestModal(client, logger, currentView, "outsourcing");
    } catch (error) {
      logger.error("[Slack] 業務委託作成方式切替失敗", error);
    }
  });

  // ================================================================
  // 3. スラッシュコマンド: /法務ステータス [課題キー]
  //    例: /法務ステータス LEGAL-42
  // ================================================================
  app.command("/法務ステータス", async ({ command, ack, respond, logger }) => {
    await ack();

    const issueKey = command.text.trim().toUpperCase();

    if (!issueKey) {
      await respond({
        response_type: "ephemeral",
        text: "📖 使い方: `/法務ステータス LEGAL-42`\n課題キーを指定してください。",
      });
      return;
    }

    try {
      const issue = await backlog.getIssue(issueKey);
      await respond({
        response_type: "ephemeral",
        blocks: buildStatusBlocks(issue),
      });
    } catch (e) {
      logger.error(`[Slack] ステータス取得失敗: ${issueKey}`, e);
      await respond({
        response_type: "ephemeral",
        text: `⚠️ 課題 *${issueKey}* が見つかりませんでした。課題キーをご確認ください。`,
      });
    }
  });

  // ================================================================
  // 4. スラッシュコマンド: /法務一覧
  //    直近の課題ステータスを一覧表示
  // ================================================================
  app.command("/法務一覧", async ({ command, ack, respond, logger }) => {
    await ack();

    try {
      const issues = await backlog.getRecentIssues(8);

      if (issues.length === 0) {
        await respond({ response_type: "ephemeral", text: "現在進行中の案件はありません。" });
        return;
      }

      const rows = issues.map((issue) => {
        const statusEmoji = statusToEmoji(issue.status.name);
        return `${statusEmoji} *${issue.issueKey}*  ${issue.summary}  ｜  ${issue.status.name}`;
      });

      await respond({
        response_type: "ephemeral",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "📋 法務案件一覧（直近8件）" } },
          { type: "section", text: { type: "mrkdwn", text: rows.join("\n") } },
          { type: "context", elements: [{ type: "mrkdwn", text: `更新: ${new Date().toLocaleString("ja-JP")}` }] },
        ],
      });
    } catch (e) {
      logger.error("[Slack] 一覧取得失敗", e);
      await respond({ response_type: "ephemeral", text: "⚠️ 一覧の取得に失敗しました。" });
    }
  });

  // ================================================================
  // 5. 承認フロー
  // ================================================================
  app.action("approve_document", async ({ ack, body, client, logger }) => {
    await ack();
    const action = (body as any).actions?.[0];
    const issueKey = action?.value ?? "";
    if (!issueKey) return;

    try {
      const { approveIssue, sendStampRequest } = await loadApprovals();
      const { findIssueWorkflow } = await loadRepository();
      await approveIssue(client as any, issueKey, body.user.id);
      const workflow = await findIssueWorkflow(issueKey);
      const issue = await backlog.getIssue(issueKey);
      await sendStampRequest(client as any, issue, workflow?.primaryDocumentUrl ?? undefined);
    } catch (error) {
      logger.error("[Slack] 承認処理失敗", error);
    }
  });

  app.action("reject_document", async ({ ack, body, client, logger }) => {
    await ack();
    const action = (body as any).actions?.[0];
    const issueKey = action?.value ?? "";
    if (!issueKey) return;

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildRejectModal(issueKey),
      });
    } catch (error) {
      logger.error("[Slack] 否認モーダル表示失敗", error);
    }
  });

  app.view("reject_document_modal", async ({ ack, view, client, logger }) => {
    await ack();
    const privateMetadata = JSON.parse(view.private_metadata || "{}") as { issueKey?: string };
    const issueKey = privateMetadata.issueKey;
    if (!issueKey) return;

    const rejectedReason =
      view.state.values.reject_reason?.input?.value?.trim() ||
      "差戻し理由は入力されませんでした。";

    try {
      const { rejectIssue } = await loadApprovals();
      await rejectIssue(client as any, issueKey, rejectedReason);
    } catch (error) {
      logger.error("[Slack] 否認処理失敗", error);
    }
  });

  // ================================================================
  // 6. 押印方式選択
  // ================================================================
  app.action("stamp_physical", async ({ ack, body, client, logger }) => {
    await ack();
    const action = (body as any).actions?.[0];
    const issueKey = action?.value ?? "";
    if (!issueKey) return;

    try {
      const { chooseStampType } = await loadApprovals();
      const { postIssueAnswerback } = await loadThreading();
      await chooseStampType(issueKey, "PHYSICAL");
      await postIssueAnswerback(client, issueKey, {
        text: `🖊 物理押印を選択しました。押印後、この依頼メッセージのスレッドにPDFを返送してください: ${issueKey}`,
      });
    } catch (error) {
      logger.error("[Slack] 物理押印選択失敗", error);
    }
  });

  app.action("stamp_electronic", async ({ ack, body, client, logger }) => {
    await ack();
    const action = (body as any).actions?.[0];
    const issueKey = action?.value ?? "";
    if (!issueKey) return;

    try {
      const { chooseStampType } = await loadApprovals();
      const { postIssueAnswerback } = await loadThreading();
      await chooseStampType(issueKey, "ELECTRONIC");
      await postIssueAnswerback(client, issueKey, {
        text: `✍ 電子署名を選択しました。CloudSign等で署名依頼を送付し、完了後に署名済みDrive URLをBacklogへ反映してください: ${issueKey}`,
      });
    } catch (error) {
      logger.error("[Slack] 電子署名選択失敗", error);
    }
  });

  app.event("message", async ({ event, client, logger }) => {
    const message = event as any;
    if (message.subtype || message.bot_id) return;
    if (!message.thread_ts || !message.channel) return;
    if (!Array.isArray(message.files) || message.files.length === 0) return;

    try {
      const { findIssueWorkflowByStampThread } = await loadRepository();
      const { completeStamp } = await loadApprovals();
      const { postIssueAnswerback } = await loadThreading();
      const workflow = await findIssueWorkflowByStampThread(message.channel, message.thread_ts);
      if (!workflow || workflow.stampedAt || workflow.esignCompletedAt) {
        return;
      }

      const pdfFile = message.files.find((file: any) =>
        file?.mimetype === "application/pdf" ||
        file?.filetype === "pdf" ||
        String(file?.name ?? "").toLowerCase().endsWith(".pdf")
      );
      if (!pdfFile) {
        return;
      }
      if (!process.env.SLACK_BOT_TOKEN) {
        logger.warn("[Slack] SLACK_BOT_TOKEN 未設定のため押印済みPDFを取得できません。");
        return;
      }

      const stored = await downloadSlackFile({
        url: pdfFile.url_private_download ?? pdfFile.url_private,
        token: process.env.SLACK_BOT_TOKEN,
        outputBasename: `${workflow.backlogIssueKey}_stamped_${Date.now()}`,
      });

      await completeStamp(client as any, workflow.backlogIssueKey, {
        stampType: workflow.stampType === "ELECTRONIC" ? "ELECTRONIC" : "PHYSICAL",
        documentUrl: stored.driveUrl ?? stored.localPath,
        completedBySlackId: message.user,
      });

      await postIssueAnswerback(client, workflow.backlogIssueKey, {
        text: `✅ 押印済みPDFを受領しました: ${workflow.backlogIssueKey}\n${stored.driveUrl ?? stored.localPath}`,
      });
    } catch (error) {
      logger.error("[Slack] 押印済みPDF処理失敗", error);
    }
  });

  app.action("stamp_complete", async ({ ack, body, client, logger }) => {
    await ack();
    const action = (body as any).actions?.[0];
    const issueKey = action?.value ?? "";
    if (!issueKey) return;

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildStampCompleteModal(issueKey),
      });
    } catch (error) {
      logger.error("[Slack] 押印完了モーダル表示失敗", error);
    }
  });

  app.view("stamp_complete_modal", async ({ ack, view, client, body, logger }) => {
    await ack();
    const privateMetadata = JSON.parse(view.private_metadata || "{}") as { issueKey?: string };
    const issueKey = privateMetadata.issueKey;
    if (!issueKey) return;

    const documentUrl =
      view.state.values.stamp_document_url?.input?.value?.trim() ?? "";
    const stampTypeRaw =
      view.state.values.stamp_type?.select?.selected_option?.value ?? "PHYSICAL";
    const stampType = stampTypeRaw === "ELECTRONIC" ? "ELECTRONIC" : "PHYSICAL";
    if (!documentUrl) return;

    try {
      const { completeStamp } = await loadApprovals();
      await completeStamp(client as any, issueKey, {
        stampType,
        documentUrl,
        completedBySlackId: body.user.id,
      });
    } catch (error) {
      logger.error("[Slack] 押印完了処理失敗", error);
    }
  });

  app.action("stamp_reject", async ({ ack, body, client, logger }) => {
    await ack();
    const action = (body as any).actions?.[0];
    const issueKey = action?.value ?? "";
    if (!issueKey) return;

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildStampRejectModal(issueKey),
      });
    } catch (error) {
      logger.error("[Slack] 押印差戻しモーダル表示失敗", error);
    }
  });

  app.view("stamp_reject_modal", async ({ ack, view, client, body, logger }) => {
    await ack();
    const privateMetadata = JSON.parse(view.private_metadata || "{}") as { issueKey?: string };
    const issueKey = privateMetadata.issueKey;
    if (!issueKey) return;

    const rejectedReason =
      view.state.values.stamp_reject_reason?.input?.value?.trim() ||
      "押印差戻し理由は入力されませんでした。";

    try {
      const { rejectStamp } = await loadApprovals();
      await rejectStamp(client as any, issueKey, rejectedReason, body.user.id);
    } catch (error) {
      logger.error("[Slack] 押印差戻し処理失敗", error);
    }
  });
}

async function notifyIssueCreateFailure(
  client: App["client"],
  logger: Pick<Console, "warn" | "error">,
  userId: string
) {
  const text = "⚠️ 法務依頼の起票中にエラーが発生しました。法務部（倉持）まで直接ご連絡ください。";

  try {
    const { previewWorkflowAssignmentForSlackUser } = await loadApprovals();
    const { postWorkflowAnswerback } = await loadThreading();
    const assignment = await previewWorkflowAssignmentForSlackUser(userId);
    await postWorkflowAnswerback(client, {
      requesterSlackId: userId,
      managerSlackId: assignment.managerSlackId,
      channel: assignment.postChannelId,
      text,
    });
    return;
  } catch (error) {
    logger.warn("[Slack] ワークフロー向けエラー通知に失敗。DMへフォールバックします。", error);
  }

  try {
    const dm = await client.conversations.open({ users: userId });
    if (!dm.channel?.id) {
      throw new Error("DM channel が取得できませんでした。");
    }
    await client.chat.postMessage({
      channel: dm.channel.id,
      text,
    });
  } catch (error) {
    logger.error("[Slack] 起票失敗通知をDMでも送れませんでした。", error);
  }
}

async function notifyIssueAppendSuccess(
  client: App["client"],
  logger: Pick<Console, "warn" | "error">,
  userId: string,
  issueKey: string,
  notes: string,
  attachmentCount: number,
) {
  const summaryText = [
    `✅ ${issueKey} に追記しました。`,
    notes ? `追記内容: ${notes}` : "",
    attachmentCount > 0 ? `添付ファイル: ${attachmentCount}件` : "",
    `進捗確認: \`/法務ステータス ${issueKey}\``,
  ].filter(Boolean).join("\n");

  try {
    const dm = await client.conversations.open({ users: userId });
    if (!dm.channel?.id) {
      throw new Error("DM channel が取得できませんでした。");
    }
    await client.chat.postMessage({
      channel: dm.channel.id,
      text: summaryText,
    });
  } catch (error) {
    logger.warn("[Slack] 追記完了通知をDM送信できませんでした。", error);
  }
}

async function finalizeIntakeAfterIssueCreated(input: {
  issue: Awaited<ReturnType<typeof backlog.createIssue>>;
  userId: string;
  view: any;
  client: App["client"];
  logger: Pick<Console, "warn" | "error">;
  effectiveContractType: string;
  driveFolderKey: string;
  counterparty: string;
  summary: string;
  deadline: string;
  notes: string;
  documentDraft?: Record<string, string>;
  requestDefinitionText: string;
}): Promise<void> {
  await maybeIssueDocumentNumber(input);
  await maybeCreateLegalRequestRecord(input);
  await maybePostLegalChannelNotification(input);
}

async function maybeIssueDocumentNumber(input: {
  issue: Awaited<ReturnType<typeof backlog.createIssue>>;
  userId: string;
  logger: Pick<Console, "warn" | "error">;
  effectiveContractType: string;
}): Promise<void> {
  const shouldIssueDocumentNumber =
    Boolean(process.env.BACKLOG_FIELD_CONTRACT_NO) &&
    input.effectiveContractType !== "delivery_request" &&
    input.effectiveContractType !== "royalty_calculation_manufacturing" &&
    input.effectiveContractType !== "royalty_calculation_sales_report";
  if (!shouldIssueDocumentNumber) {
    return;
  }

  try {
    const { findStaffBySlackUserId } = await loadRepository();
    const requesterStaff = await findStaffBySlackUserId(input.userId);
    const issuedContractNo = await resolveIssueDocumentNumber(backlog, input.issue, {
      partyAName: requesterStaff?.partyAName,
      departmentCode: requesterStaff?.departmentCode ?? undefined,
    });

    if (issuedContractNo) {
      await backlog.updateCustomField(
        input.issue.issueKey,
        Number(process.env.BACKLOG_FIELD_CONTRACT_NO),
        issuedContractNo
      );
    }
  } catch (error) {
    input.logger.warn(`[Slack] 契約番号採番をスキップ: ${input.issue.issueKey}`, error);
  }
}

async function maybeCreateLegalRequestRecord(input: {
  issue: Awaited<ReturnType<typeof backlog.createIssue>>;
  userId: string;
  view: any;
  logger: Pick<Console, "warn" | "error">;
  effectiveContractType: string;
  driveFolderKey: string;
  counterparty: string;
  summary: string;
  deadline: string;
  notes: string;
  documentDraft?: Record<string, string>;
}): Promise<void> {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const definition = getDocumentRequestDefinition(input.effectiveContractType);
  if (definition?.dataOwner !== "db") {
    return;
  }

  try {
    const { createLegalRequest, saveIssueDocumentDraft } = await loadRepository();
    await createLegalRequest({
      backlogIssueKey: input.issue.issueKey,
      slackUserId: input.userId,
      slackChannelId: input.view.private_metadata ? JSON.parse(input.view.private_metadata).channelId || undefined : undefined,
      contractType: input.effectiveContractType,
      driveFolderKey: input.driveFolderKey,
      counterparty: input.counterparty,
      summary: input.summary,
      deadline: input.deadline ? new Date(input.deadline) : undefined,
      notes: input.notes,
    });
    if (input.documentDraft && Object.keys(input.documentDraft).length > 0) {
      await saveIssueDocumentDraft(input.issue.issueKey, input.documentDraft);
    }
  } catch (error) {
    input.logger.warn(`[Slack] LegalRequest保存をスキップ: ${input.issue.issueKey}`, error);
  }
}

async function maybePostLegalChannelNotification(input: {
  issue: Awaited<ReturnType<typeof backlog.createIssue>>;
  userId: string;
  client: App["client"];
  logger: Pick<Console, "warn" | "error">;
  counterparty: string;
  notes: string;
  requestDefinitionText: string;
}): Promise<void> {
  try {
    const { previewWorkflowAssignmentForSlackUser } = await loadApprovals();
    const { saveIssueRootThread } = await loadThreading();
    const { findIssueWorkflow } = await loadRepository();
    const notificationAssignment = await previewWorkflowAssignmentForSlackUser(input.userId);
    const legalChannel =
      notificationAssignment.postChannelId ||
      getWorkflowSettings().intakeChannelId ||
      process.env.SLACK_LEGAL_CHANNEL;
    if (!legalChannel) {
      input.logger.warn(`[Slack] 法務チャンネル未設定のため通知をスキップ: ${input.issue.issueKey}`);
      return;
    }
    const existingWorkflow = await findIssueWorkflow(input.issue.issueKey);
    if (existingWorkflow?.requestSlackChannel && existingWorkflow.requestSlackTs) {
      return;
    }

    const legalPost = await input.client.chat.postMessage({
      channel: legalChannel,
      text: buildNewRequestNotificationText(input.issue.issueKey, input.userId, notificationAssignment.managerSlackId),
      blocks: buildNewRequestBlocks(
        input.issue,
        input.userId,
        input.requestDefinitionText,
        input.counterparty,
        input.notes,
        notificationAssignment.managerSlackId,
        notificationAssignment.department
      ),
    });
    if (legalPost.ts) {
      try {
        await saveIssueRootThread(input.issue.issueKey, legalChannel, legalPost.ts);
      } catch (error) {
        input.logger.warn(`[Slack] Slack親スレッド保存をスキップ: ${input.issue.issueKey}`, error);
      }
    }
  } catch (error) {
    input.logger.warn(`[Slack] 法務チャンネル通知をスキップ: ${input.issue.issueKey}`, error);
  }
}

// ================================================================
// Block Kit ビルダー関数
// ================================================================

function buildRequestModal(
  channelId: string,
  userId: string,
  contractType: string,
  existingValues: Record<string, string> = {}
) {
  const dynamicBlocks = buildContractTypeSpecificBlocks(contractType, existingValues);
  return buildLegalRequestModal(channelId, userId, contractType, existingValues, dynamicBlocks);
}

function extractSlackAttachmentFileIds(values: Record<string, any>): string[] {
  const attachmentValue = values.request_attachments?.file_input;
  if (!attachmentValue) {
    return [];
  }

  const rawValues = [
    ...(Array.isArray(attachmentValue.selected_files) ? attachmentValue.selected_files : []),
    ...(Array.isArray(attachmentValue.files) ? attachmentValue.files : []),
    ...(Array.isArray(attachmentValue.file_ids) ? attachmentValue.file_ids : []),
    ...(attachmentValue.selected_file ? [attachmentValue.selected_file] : []),
  ];

  return rawValues
    .map((item: any) => {
      if (typeof item === "string") return item;
      if (typeof item?.id === "string") return item.id;
      return "";
    })
    .filter(Boolean);
}

function normalizeIssueKeyInput(value: string): string | undefined {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(normalized) ? normalized : undefined;
}

async function uploadSlackModalFilesToBacklog(params: {
  client: any;
  logger: any;
  slackFileIds: string[];
  issueSummary: string;
}): Promise<number[]> {
  if (params.slackFileIds.length === 0) {
    return [];
  }
  if (!process.env.SLACK_BOT_TOKEN) {
    params.logger.warn("[Slack] SLACK_BOT_TOKEN 未設定のためモーダル添付をBacklogへ転送できません。");
    return [];
  }

  const attachmentIds: number[] = [];
  for (const [index, fileId] of params.slackFileIds.entries()) {
    try {
      const fileInfo = await params.client.files.info({ file: fileId });
      const slackFile = fileInfo.file as any;
      const downloadUrl = slackFile?.url_private_download ?? slackFile?.url_private;
      if (!downloadUrl) {
        params.logger.warn("[Slack] 添付ファイルのダウンロードURLを取得できません。", { fileId });
        continue;
      }

      const stored = await downloadSlackFile({
        url: downloadUrl,
        token: process.env.SLACK_BOT_TOKEN,
        outputBasename: `${sanitizeAttachmentBasename(params.issueSummary)}_${index + 1}`,
        uploadToDrive: false,
      });

      const attachmentId = await backlog.uploadAttachment(
        stored.localPath,
        sanitizeBacklogAttachmentName(slackFile?.name, fileId),
      );
      attachmentIds.push(attachmentId);
    } catch (error) {
      params.logger.warn("[Slack] モーダル添付のBacklog転送に失敗しました。", { fileId, error });
    }
  }

  return attachmentIds;
}

function sanitizeAttachmentBasename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return `legal_request_${Date.now()}`;
  }
  return trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60) || `legal_request_${Date.now()}`;
}

function sanitizeBacklogAttachmentName(value: string | undefined, fallbackId: string): string {
  const base = (value ?? fallbackId).trim();
  return (base.replace(/[/\\:*?"<>|]/g, "_") || `${fallbackId}.bin`).slice(0, 120);
}

function buildSimpleBacklogDescription(input: {
  userId: string;
  contractTypeLabel: string;
  summary: string;
  notes: string;
  deadline: string;
  counterparty: string;
}): string {
  return [
    "【Slack法務依頼】",
    "",
    `依頼者: <@${input.userId}>`,
    `依頼種別: ${input.contractTypeLabel}`,
    `件名: ${input.summary}`,
    `相手先: ${input.counterparty || "未入力"}`,
    `希望納期: ${input.deadline || "指定なし"}`,
    "",
    "依頼内容:",
    input.notes,
    "",
    "添付ファイルがある場合は課題添付を確認してください。",
  ].join("\n");
}

function buildSimpleBacklogCustomFields(values: {
  requester: string;
  contractTypeLabel: string;
  counterparty: string;
  deadline: string;
  remarks: string;
}): Record<string, string> {
  return sanitizeCustomFieldEntries({
    [process.env.BACKLOG_FIELD_REQUESTER ?? ""]: values.requester,
    [process.env.BACKLOG_FIELD_CONTRACT_TYPE ?? ""]: values.contractTypeLabel,
    [process.env.BACKLOG_FIELD_COUNTERPARTY ?? ""]: values.counterparty,
    [process.env.BACKLOG_FIELD_DEADLINE ?? ""]: values.deadline,
    [process.env.BACKLOG_FIELD_REMARKS ?? ""]: values.remarks,
  });
}

function buildAppendComment(input: { userId: string; notes: string; attachmentCount: number }): string {
  return [
    "[Slack追記]",
    `追記者: <@${input.userId}>`,
    input.notes ? "" : "内容: 添付ファイルを追加しました。",
    input.notes ? `内容:\n${input.notes}` : "",
    input.attachmentCount > 0 ? `添付: ${input.attachmentCount}件` : "",
  ].filter(Boolean).join("\n");
}

function buildContractTypeSpecificBlocks(contractType: string, existingValues: Record<string, string>) {
  const licenseBundleMode = existingValues.license_bundle_mode ?? "basic_with_schedule";
  const outsourcingBundleMode = existingValues.outsourcing_bundle_mode ?? "basic_with_order";

  if (contractType === "nda") {
    return [
      {
        type: "input",
        block_id: "contract_date",
        label: { type: "plain_text", text: "🗓 契約日" },
        element: {
          type: "datepicker",
          action_id: "datepicker",
          initial_date: existingValues.contract_date || undefined,
        },
      },
      {
        type: "input",
        block_id: "nda_purpose",
        label: { type: "plain_text", text: "🎯 秘密保持の目的" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          initial_value: existingValues.nda_purpose ?? "",
          placeholder: { type: "plain_text", text: "例: 新規協業の検討" },
        },
      },
      {
        type: "input",
        block_id: "contract_period",
        label: { type: "plain_text", text: "⏳ 契約期間" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          initial_value: existingValues.contract_period ?? "",
          placeholder: { type: "plain_text", text: "例: 1年間" },
        },
      },
      {
        type: "input",
        block_id: "confidentiality_period",
        label: { type: "plain_text", text: "🔒 秘密保持期間" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          initial_value: existingValues.confidentiality_period ?? "",
          placeholder: { type: "plain_text", text: "例: 契約終了後3年間" },
        },
      },
    ];
  }

  if (contractType === "outsourcing") {
    if (outsourcingBundleMode === "order_only") {
      return buildPurchaseOrderBlocks(existingValues);
    }
    return buildOutsourcingContractBlocks(existingValues);
  }

  if (contractType === "license") {
    if (licenseBundleMode === "schedule_only") {
      return buildLicenseScheduleBlocks(existingValues);
    }
    return buildLicenseContractBlocks(existingValues);
  }

  if (contractType === "license_schedule") {
    return buildLicenseScheduleBlocks(existingValues);
  }

  if (contractType === "ip_overseas_master") {
    return buildIpOverseasMasterBlocks(existingValues);
  }

  if (contractType === "ip_overseas_amendment") {
    return buildIpOverseasAmendmentBlocks(existingValues);
  }

  if (contractType === "purchase_order") {
    return buildPurchaseOrderBlocks(existingValues);
  }

  if (contractType === "planning_order") {
    return buildPlanningOrderBlocks(existingValues);
  }

  if (contractType === "publishing_order") {
    return buildPublishingOrderBlocks(existingValues);
  }

  if (contractType === "legal_consultation") {
    return buildLegalConsultationBlocks();
  }

  if (contractType === "sales_buyer") {
    return buildSalesBuyerBlocks(existingValues);
  }

  if (contractType === "sales_seller_standard") {
    return buildSalesSellerStandardBlocks(existingValues);
  }

  if (contractType === "sales_seller_credit") {
    return buildSalesSellerCreditBlocks(existingValues);
  }

  if (contractType === "delivery_request") {
    return buildDeliveryRequestBlocks(existingValues);
  }

  if (contractType === "royalty_calculation_manufacturing") {
    return buildRoyaltyCalculationBlocks(existingValues);
  }

  if (contractType === "royalty_calculation_sales_report") {
    return buildRoyaltySalesReportBlocks(existingValues);
  }

  return [];
}

function buildPurchaseOrderBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("発注書ヘッダ", "案件名と発注概要を入力してください。詳細な納期、支払日、仕様は発注概要へ自由に記載します。"),
    {
      type: "input",
      block_id: "project_title",
      label: { type: "plain_text", text: "🗂 案件名" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.project_title ?? "",
        placeholder: { type: "plain_text", text: "例: イラスト制作案件" },
      },
    },
    {
      type: "input",
      block_id: "order_summary",
      optional: true,
      label: { type: "plain_text", text: "📝 発注概要" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        multiline: true,
        initial_value: existingValues.order_summary ?? "",
        placeholder: { type: "plain_text", text: "納期、支払日、仕様詳細等を入力してください。" },
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "納期、支払日、仕様詳細等を入力してください。決め打ちできない内容も含めて自由に記載できます。",
        },
      ],
    },
  ];
}

function buildPlanningOrderBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("企画発注書ヘッダ", "案件名のみ Slack で受け、参照情報や明細は XLSX / CSV 取込や Backlog 側で補完します。"),
    {
      type: "input",
      block_id: "project_title",
      label: { type: "plain_text", text: "🗂 案件名" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.project_title ?? "",
        placeholder: { type: "plain_text", text: "例: 11月分企画発注" },
      },
    },
  ];
}

function buildPublishingOrderBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("出版発注書ヘッダ", "案件名と出版進行の概要を入力してください。校了予定や検収予定の詳細は CSV / Backlog 側で管理します。"),
    {
      type: "input",
      block_id: "project_title",
      label: { type: "plain_text", text: "🗂 案件名" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.project_title ?? "",
        placeholder: { type: "plain_text", text: "例: 2026年秋刊 書籍制作発注" },
      },
    },
    {
      type: "input",
      block_id: "master_contract_ref",
      optional: true,
      label: { type: "plain_text", text: "🔗 マスター契約参照" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.master_contract_ref ?? "",
        placeholder: { type: "plain_text", text: "例: PUB-MC-001" },
      },
    },
    {
      type: "input",
      block_id: "order_summary",
      optional: true,
      label: { type: "plain_text", text: "📝 進行概要" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        multiline: true,
        initial_value: existingValues.order_summary ?? "",
        placeholder: { type: "plain_text", text: "初校締切、再校締切、校了予定、支払予定など" },
      },
    },
  ];
}

function buildIpOverseasMasterBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("海外IP契約（基本契約）", "ライセンスアウト / プロダクトアウトを deal structure で切り替えます。"),
    {
      type: "input",
      block_id: "contract_date",
      label: { type: "plain_text", text: "🗓 契約日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.contract_date || undefined,
      },
    },
    textInputBlock("deal_structure", "🧭 取引構造", existingValues.deal_structure, "license_out または product_out"),
    textInputBlock("original_work", "🎨 原著作物・IP名", existingValues.original_work, "Example IP / title"),
    textareaBlock("license_scope", "📜 許諾対象 / 権利範囲", existingValues.license_scope, "Licensed rights, media, channels"),
    textareaBlock("ip_product_scope", "📦 製品化対象 / 商品範囲", existingValues.ip_product_scope, "Board games, accessories, digital adaptations"),
    textInputBlock("territory", "🌍 地域・言語", existingValues.territory, "Worldwide / English"),
    textInputBlock("exclusivity", "🔐 独占性", existingValues.exclusivity, "Exclusive / Non-exclusive / Sole"),
    textInputBlock("revenue_model", "💰 収益モデル", existingValues.revenue_model, "Royalty / Revenue share / Purchase and resale"),
    textareaBlock("royalty_terms", "🧾 ロイヤリティ・対価条件", existingValues.royalty_terms, "Rate, MG, reporting cycle, payment timing"),
    textInputBlock("sublicense_allowed", "↪️ 再許諾可否", existingValues.sublicense_allowed, "Allowed with prior consent"),
    textareaBlock("title_transfer_model", "🧩 権利帰属 / 成果物帰属", existingValues.title_transfer_model, "Ownership and derivative works treatment"),
    textareaBlock("inventory_selloff", "📚 終了後在庫処理", existingValues.inventory_selloff, "Sell-off period and disposal rules"),
    textInputBlock("jurisdiction", "⚖️ 管轄裁判所", existingValues.jurisdiction || "Tokyo District Court", "Tokyo District Court"),
    textareaBlock("special_notes", "📝 特記事項", existingValues.special_notes, "Transitional language or prior assumptions"),
  ];
}

function buildIpOverseasAmendmentBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("海外IP契約（変更合意）", "元契約を指定し、変更方向と変更後構造を明示します。"),
    {
      type: "input",
      block_id: "contract_date",
      label: { type: "plain_text", text: "🗓 変更合意日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.contract_date || undefined,
      },
    },
    textInputBlock("base_agreement_key", "🔗 元契約課題キー", existingValues.base_agreement_key, "LEGAL-123"),
    {
      type: "input",
      block_id: "effective_date",
      label: { type: "plain_text", text: "🚦 効力発生日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.effective_date || undefined,
      },
    },
    textInputBlock("change_mode", "🔄 変更モード", existingValues.change_mode, "license_to_product / product_to_license / amendment"),
    textInputBlock("deal_structure", "🧭 変更後の取引構造", existingValues.deal_structure, "license_out または product_out"),
    textInputBlock("original_work", "🎨 原著作物・IP名", existingValues.original_work, "Example IP / title"),
    textareaBlock("amendment_clauses", "✍️ 変更対象条項", existingValues.amendment_clauses, "Clause 2, 4, 7 and schedule replacement"),
    textareaBlock("license_scope", "📜 変更後の許諾対象 / 権利範囲", existingValues.license_scope, "Updated licensed rights"),
    textareaBlock("ip_product_scope", "📦 変更後の製品化対象 / 商品範囲", existingValues.ip_product_scope, "Updated product scope"),
    textInputBlock("territory", "🌍 変更後の地域・言語", existingValues.territory, "Worldwide / English"),
    textInputBlock("revenue_model", "💰 変更後の収益モデル", existingValues.revenue_model, "Royalty / Revenue share / Purchase and resale"),
    textareaBlock("royalty_terms", "🧾 変更後の対価条件", existingValues.royalty_terms, "Updated rates, MG, settlement terms"),
    textareaBlock("inventory_selloff", "📚 在庫処理・移行措置", existingValues.inventory_selloff, "Sell-off and transition arrangement"),
    textareaBlock("title_transfer_model", "🧩 権利帰属の扱い", existingValues.title_transfer_model, "Ownership after amendment"),
    textareaBlock("special_notes", "📝 特記事項", existingValues.special_notes, "Clauses that remain unchanged"),
  ];
}

function textInputBlock(blockId: string, label: string, initialValue: string | undefined, placeholder: string) {
  return {
    type: "input",
    block_id: blockId,
    label: { type: "plain_text", text: label },
    element: {
      type: "plain_text_input",
      action_id: "input",
      initial_value: initialValue ?? "",
      placeholder: { type: "plain_text", text: placeholder },
    },
  };
}

function textareaBlock(blockId: string, label: string, initialValue: string | undefined, placeholder: string) {
  return {
    type: "input",
    block_id: blockId,
    optional: true,
    label: { type: "plain_text", text: label },
    element: {
      type: "plain_text_input",
      action_id: "input",
      multiline: true,
      initial_value: initialValue ?? "",
      placeholder: { type: "plain_text", text: placeholder },
    },
  };
}

function buildLegalConsultationBlocks() {
  return [
    buildSectionHeader(
      "法務相談",
      "他社文書のレビュー依頼と法務相談を同じ入口で受け付けます。相談内容や確認してほしい観点は下部の補足欄に入力してください。"
    ),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "相手方や登録番号が未確定でも起票できます。文書URLや論点があれば備考・補足欄にまとめてください。",
        },
      ],
    },
  ];
}

async function refreshLegalRequestModal(client: any, logger: any, currentView: any, selectedType: string) {
  const nextView = buildRequestModal(
    JSON.parse(currentView.private_metadata || "{}")?.channelId ?? "",
    JSON.parse(currentView.private_metadata || "{}")?.userId ?? "",
    selectedType,
    extractModalValues(currentView.state?.values ?? {})
  );
  logger.info("[Slack] 法務依頼モーダル再描画", {
    selectedType,
    blockIds: nextView.blocks.map((block: any) => block.block_id || block.type),
  });
  await client.views.update({
    view_id: currentView.id,
    hash: currentView.hash,
    view: nextView,
  });
}


function buildReceivedDmBlocks(
  issueKey: string,
  summary: string,
  deadline: string,
  contractTypeLabel: string,
  autoGenerated: boolean,
  dataOwner: "backlog" | "db"
) {
  const followupText = buildFollowupGuidance(contractTypeLabel, issueKey);
  const deadlineLabel = "文書作成希望完了日";
  return [
    { type: "header", text: { type: "plain_text", text: "✅ 法務依頼を受け付けました" } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*受付番号*\n${issueKey}` },
        { type: "mrkdwn", text: `*文書種別*\n${contractTypeLabel}` },
        { type: "mrkdwn", text: `*${deadlineLabel}*\n${deadline || "指定なし"}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*件名*\n${summary}` } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: autoGenerated
            ? "文書生成まで自動実行しました。"
            : dataOwner === "db"
              ? "この種別は起票後に明細取込やDB補完を行ってから文書生成します。"
              : "この種別は起票後に追加入力を確認してから文書生成します。",
        },
      ],
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `ステータスは \`/法務ステータス ${issueKey}\` で確認できます` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*この課題キーを控えてください*\n\`${issueKey}\`\n${followupText}`,
      },
    },
    ...buildFollowupShortcutBlocks(contractTypeLabel, issueKey),
  ];
}

function buildLegalRequestIssueSummary(summary: string, counterparty: string): string {
  const cleanCounterparty = counterparty.trim();
  return cleanCounterparty
    ? `【法務依頼】${summary}（${cleanCounterparty}）`
    : `【法務依頼】${summary}`;
}

function buildNewRequestBlocks(
  issue: { issueKey: string; summary: string },
  userId: string,
  contractType: string,
  counterparty: string,
  notes: string,
  managerSlackId?: string,
  department?: string
) {
  return [
    { type: "header", text: { type: "plain_text", text: "📋 新しい法務依頼が届きました" } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*課題キー*\n${issue.issueKey}` },
        { type: "mrkdwn", text: `*依頼者*\n<@${userId}>` },
        { type: "mrkdwn", text: `*契約種別*\n${contractType}` },
        { type: "mrkdwn", text: `*相手方*\n${counterparty}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*概要*\n${issue.summary}` } },
    ...((managerSlackId || department)
      ? [{
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: [
                department ? `部署: ${department}` : "",
                managerSlackId ? `通知先上長: <@${managerSlackId}>` : "通知先上長: 未設定",
              ].filter(Boolean).join(" / "),
            },
          ],
        }]
      : []),
    ...(notes ? [{ type: "section", text: { type: "mrkdwn", text: `*補足*\n${notes}` } }] : []),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Backlogで開く" },
          url: `https://${process.env.BACKLOG_SPACE}.backlog.com/view/${issue.issueKey}`,
          style: "primary",
        },
      ],
    },
  ];
}

function buildNewRequestNotificationText(issueKey: string, requesterSlackId?: string, managerSlackId?: string) {
  const mentions = [requesterSlackId ? `<@${requesterSlackId}>` : "", managerSlackId ? `<@${managerSlackId}>` : ""]
    .filter(Boolean)
    .join(" ");
  return mentions
    ? `📋 新しい法務依頼: ${issueKey} ${mentions}`
    : `📋 新しい法務依頼: ${issueKey}`;
}

function buildFollowupGuidance(contractTypeLabel: string, issueKey: string): string {
  if (contractTypeLabel === "発注書" || contractTypeLabel === "企画発注書") {
    return `後続の納品リクエストでは親課題キーとして \`${issueKey}\` を入力します。`;
  }
  if (contractTypeLabel === "ライセンス契約") {
    return `次は個別利用許諾条件を作成し、その後に利用許諾料計算へ進みます。親ライセンス課題キーとして \`${issueKey}\` を控えてください。`;
  }
  if (contractTypeLabel === "個別利用許諾条件") {
    return `後続の利用許諾料計算では、製造ベースまたは売上報告ベースのいずれかを選び、紐付け課題キーとして \`${issueKey}\` を入力します。`;
  }
  return `関連する後続申請がある場合は、この課題キー \`${issueKey}\` を参照して入力してください。`;
}

function buildFollowupShortcutBlocks(contractTypeLabel: string, issueKey: string): any[] {
  if (contractTypeLabel === "発注書" || contractTypeLabel === "企画発注書") {
    return [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "納品リクエストを作成" },
            action_id: "create_followup_delivery",
            value: issueKey,
          },
        ],
      },
    ];
  }

  if (contractTypeLabel === "ライセンス契約") {
    return [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "個別利用許諾条件を作成" },
            action_id: "create_followup_license_schedule",
            value: issueKey,
          },
        ],
      },
    ];
  }

  if (contractTypeLabel === "個別利用許諾条件") {
    return [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "利用許諾料計算（製造）" },
            action_id: "create_followup_royalty",
            value: issueKey,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "利用許諾料計算（売上報告）" },
            action_id: "create_followup_royalty_sales",
            value: issueKey,
          },
        ],
      },
    ];
  }

  return [];
}

function buildStatusBlocks(issue: { issueKey: string; summary: string; status: { name: string }; assignee?: { name: string }; updated: string }) {
  const emoji = statusToEmoji(issue.status.name);
  return [
    { type: "header", text: { type: "plain_text", text: `${emoji} ${issue.issueKey}` } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*ステータス*\n${issue.status.name}` },
        { type: "mrkdwn", text: `*担当者*\n${issue.assignee?.name ?? "未割当"}` },
        { type: "mrkdwn", text: `*最終更新*\n${new Date(issue.updated).toLocaleString("ja-JP")}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*件名*\n${issue.summary}` } },
  ];
}

interface ParentIssueSearchResult {
  issueKey: string;
  category: "order" | "license";
  contractType: string;
  label: string;
  summary: string;
  counterparty?: string | null;
  detail?: string | null;
}

async function searchParentIssueCandidatesFromBacklog(query: string, limit = 8): Promise<ParentIssueSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const issueTypeNames = [
    process.env.BACKLOG_ISSUE_TYPE_PURCHASE_ORDER ?? "発注書",
    process.env.BACKLOG_ISSUE_TYPE_PLANNING_ORDER ?? "企画発注書",
    process.env.BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER ?? "出版発注書",
    process.env.BACKLOG_ISSUE_TYPE_LICENSE ?? "ライセンス契約",
    process.env.BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE ?? "個別利用許諾条件",
  ];
  const issueTypeIds = (
    await Promise.all(issueTypeNames.map((name) => backlog.findIssueTypeIdByName(name)))
  ).filter((id): id is number => typeof id === "number");

  const issues = await backlog.listAllIssues(issueTypeIds.length > 0 ? { issueTypeId: issueTypeIds } : undefined);
  const normalizedQuery = normalizeSearchText(q);

  const results = issues
    .map((issue) => {
      const issueTypeName = issue.issueType?.name ?? "";
      const counterparty = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY) || null;
      const originalWork = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_ORIGINAL_WORK) || null;
      const candidates = [
        issue.issueKey,
        issue.summary,
        issueTypeName,
        counterparty ?? "",
        originalWork ?? "",
      ];
      if (!candidates.some((text) => normalizeSearchText(text).includes(normalizedQuery))) {
        return null;
      }

      const isPlanningOrder = issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_PLANNING_ORDER ?? "企画発注書");
      const isPublishingOrder = issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER ?? "出版発注書");
      const isOrder =
        issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_PURCHASE_ORDER ?? "発注書")
        || isPlanningOrder
        || isPublishingOrder;
      const isLicenseSchedule = issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE ?? "個別利用許諾条件");

      return {
        issueKey: issue.issueKey,
        category: isOrder ? "order" : "license",
        contractType: isOrder
          ? (isPlanningOrder ? "planning_order" : isPublishingOrder ? "publishing_order" : "purchase_order")
          : (isLicenseSchedule ? "license_schedule" : "license"),
        label: issueTypeName || (isOrder ? "発注書" : "ライセンス契約"),
        summary: issue.summary,
        counterparty,
        detail: [issue.status?.name, originalWork].filter(Boolean).join(" / ") || null,
      } as ParentIssueSearchResult;
    })
    .filter((item): item is ParentIssueSearchResult => item !== null);

  results.sort((a, b) => {
    const aExact = a.issueKey.toLowerCase() === q.toLowerCase() ? 1 : 0;
    const bExact = b.issueKey.toLowerCase() === q.toLowerCase() ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const aIssueKeyMatch = a.issueKey.toLowerCase().includes(q.toLowerCase()) ? 1 : 0;
    const bIssueKeyMatch = b.issueKey.toLowerCase().includes(q.toLowerCase()) ? 1 : 0;
    return bIssueKeyMatch - aIssueKeyMatch;
  });

  return results.slice(0, limit);
}

function normalizeSearchText(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

function buildParentIssueSearchBlocks(query: string, results: ParentIssueSearchResult[]): any[] {
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: "🔎 法務案件検索結果" } },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `検索語: \`${query}\` / 上位 ${results.length} 件` },
      ],
    },
  ];

  for (const result of results) {
    const lines = [
      `*${result.label}*  \`${result.issueKey}\``,
      result.summary,
      result.counterparty ? `相手方: ${result.counterparty}` : "",
      result.detail ? `補足: ${result.detail}` : "",
    ].filter(Boolean);

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });

    const elements: any[] = [];
    if (result.category === "order") {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "この課題で納品リクエスト" },
        action_id: "create_followup_delivery",
        value: result.issueKey,
      });
    }

    if (result.category === "license") {
      if (result.contractType === "license") {
        elements.push({
          type: "button",
          text: { type: "plain_text", text: "個別利用許諾条件を作成" },
          action_id: "create_followup_license_schedule",
          value: result.issueKey,
        });
      }
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "利用許諾料計算（製造）" },
        action_id: "create_followup_royalty",
        value: result.issueKey,
      });
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "利用許諾料計算（売上報告）" },
        action_id: "create_followup_royalty_sales",
        value: result.issueKey,
      });
    }

    if (elements.length > 0) {
      blocks.push({
        type: "actions",
        elements,
      });
    }
  }

  return blocks;
}

function buildLegalSearchModal(initialQuery = "") {
  return {
    type: "modal" as const,
    callback_id: "legal_search_modal",
    title: { type: "plain_text" as const, text: "法務案件検索" },
    submit: { type: "plain_text" as const, text: "検索" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "search_query",
        label: { type: "plain_text", text: "検索語" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          initial_value: initialQuery,
          placeholder: { type: "plain_text", text: "発注先名、案件名、課題キーなど" },
        },
      },
    ],
  };
}

function buildLegalSearchResultsModal(query: string, results: ParentIssueSearchResult[], errorMessage?: string) {
  return {
    type: "modal" as const,
    callback_id: "legal_search_results_modal",
    title: { type: "plain_text" as const, text: "検索結果" },
    close: { type: "plain_text" as const, text: "閉じる" },
    blocks: errorMessage
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: `⚠️ ${errorMessage}` },
          },
        ]
      : results.length === 0
        ? [
            {
              type: "section",
              text: { type: "mrkdwn", text: `検索語 \`${query}\` に一致する案件は見つかりませんでした。` },
            },
          ]
        : buildParentIssueSearchBlocks(query, results),
  };
}

function buildBacklogDescription(params: {
  userId: string;
  contractType: string;
  licenseBundleMode: string;
  outsourcingBundleMode: string;
  registrationNumber: string;
  driveFolderLabel: string;
  counterparty: string;
  summary: string;
  projectTitle: string;
  orderSummary: string;
  deadline: string;
  contractNo: string;
  counterpartyAddress: string;
  counterpartyRepresentative: string;
  remarks: string;
  contractDate: string;
  contractPeriod: string;
  confidentialityPeriod: string;
  ndaPurpose: string;
  jurisdiction: string;
  originalWork: string;
  originalAuthor: string;
  creditName: string;
  successionMemoDate: string;
  licenseTypeName: string;
  licenseStart: string;
  territory: string;
  dealStructure: string;
  changeMode: string;
  baseAgreementKey: string;
  effectiveDate: string;
  licenseScope: string;
  ipProductScope: string;
  exclusivity: string;
  revenueModel: string;
  royaltyTerms: string;
  sublicenseAllowed: string;
  titleTransferModel: string;
  inventorySelloff: string;
  amendmentClauses: string;
  specialNotes: string;
  schedule1Summary: string;
  schedule1SpecialProvisions: string;
  schedule2Summary: string;
  schedule2SpecialProvisions: string;
  s1RoyaltyRate: string;
  s1MinimumGuarantee: string;
  s1Advance: string;
  s1AccountingPeriod: string;
  s1PaymentDue: string;
  s1ReportDue: string;
  s1FxConversion: string;
  s1FirstPrintRun: string;
  s1TargetReleaseDate: string;
  s1ComplimentaryCopies: string;
  s1CreditWording: string;
  s1TerritoryJurisdiction: string;
  s1ConsumerLawCarveout: string;
  s1VatGstTreatment: string;
  s1CopyrightRegistration: string;
  s1MoralRights: string;
  s1MandatoryDistributionLaw: string;
  s1AdditionalTerms: string;
  s2ProductPriceList: string;
  s2MprYear1: string;
  s2MprYear2: string;
  s2MprYear3: string;
  s2IncotermsDelivery: string;
  s2ArrivalPoint: string;
  s2PaymentAdvance: string;
  s2PaymentBalance: string;
  s2PaymentCurrency: string;
  s2TerritoryJurisdiction: string;
  s2ImportCustomsAllocation: string;
  s2ConsumerProductSafety: string;
  s2DistributionLawProtections: string;
  s2VatGstSupply: string;
  s2ProductLiabilityInsurance: string;
  s2MarketplaceOnlineSales: string;
  s2AdditionalTerms: string;
  parentIssueKey: string;
  itemNo: string;
  deliveryNote: string;
  deliveredAmount: string;
  licenseIssueKey: string;
  productName: string;
  edition: string;
  completionDate: string;
  quantity: string;
  msrp: string;
  sampleQuantity: string;
  reportPeriodStart: string;
  reportPeriodEnd: string;
  salesAmount: string;
  receivedAmount: string;
  salesQuantity: string;
  productScope: string;
  deliveryLocation: string;
  inspectionPeriodDays: string;
  paymentConditionSummary: string;
  warrantyPeriod: string;
  monthlyClosingDay: string;
  paymentDueDay: string;
  paymentMethod: string;
  securityDepositAmount: string;
  depositReplenishDays: string;
  notes: string;
}): string {
  const contractSpecific = buildContractSpecificDescription(params);
  return `## 法務依頼（Slack経由）

| 項目 | 内容 |
|------|------|
| 依頼者 | @${params.userId} |
| 契約種別 | ${params.contractType} |
| 保存先Drive | ${params.driveFolderLabel} |
| 登録番号 | ${params.registrationNumber || "未入力"} |
| 相手方 | ${params.counterparty} |
| 文書作成希望完了日 | ${params.deadline || "指定なし"} |

## 概要
${params.summary}

## 相手方情報
- 住所: ${params.counterpartyAddress || "未入力"}
- 代表者: ${params.counterpartyRepresentative || "未入力"}

## 備考
${params.remarks || "（なし）"}

## 補足・参考資料
${params.notes || "（なし）"}

${contractSpecific}

---
*このチケットはSlack Bot（LegalBridge）により自動起票されました*`;
}

function buildContractSpecificDescription(params: {
  contractType: string;
  notes: string;
} & Record<string, string>): string {
  if (params.contractType === "legal_consultation") {
    const rows = [
      `- 相手方・相談先: ${params.counterparty || "未入力"}`,
      `- 相談背景・補足: ${params.remarks || "未入力"}`,
      `- 相談内容・レビュー観点: ${params.notes || "未入力"}`,
    ];
    return `## 法務相談固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "nda") {
    const rows = [
      `- 契約日: ${params.contractDate || "未入力"}`,
      `- 秘密保持の目的: ${params.ndaPurpose || "未入力"}`,
      `- 契約期間: ${params.contractPeriod || "未入力"}`,
      `- 秘密保持期間: ${params.confidentialityPeriod || "未入力"}`,
    ];
    return `## NDA固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "outsourcing") {
    const rows = [
      `- 作成方式: ${params.outsourcingBundleMode === "order_only" ? "発注書のみ" : "基本契約 + 発注書"}`,
      `- 契約日: ${params.contractDate || "未入力"}`,
      `- 業務概要・前提情報: ${params.notes || "未入力"}`,
      ...(params.projectTitle || params.orderSummary
        ? [
            `- 発注案件名: ${params.projectTitle || "未入力"}`,
            `- 発注概要: ${params.orderSummary || "未入力"}`,
          ]
        : []),
    ];
    return `## 業務委託基本契約固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "license") {
    const rows = [
      `- 作成方式: ${params.licenseBundleMode === "schedule_only" ? "個別利用許諾条件のみ" : "基本契約 + 個別利用許諾条件"}`,
      `- 契約日: ${params.contractDate || "未入力"}`,
      `- 原著作物: ${params.originalWork || "未入力"}`,
      `- 管轄裁判所: ${params.jurisdiction || "未入力"}`,
    ];
    return `## ライセンス契約固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "license_schedule") {
    const rows = [
      `- 親ライセンス課題キー: ${params.licenseIssueKey || "未入力"}`,
      `- ライセンス種別名: ${params.licenseTypeName || "未入力"}`,
      `- 原著作物: ${params.originalWork || "未入力"}`,
      `- 許諾開始日: ${params.licenseStart || "未入力"}`,
      `- 地域・言語: ${params.territory || "未入力"}`,
    ];
    return `## 個別利用許諾条件固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "ip_overseas_master") {
    const rows = [
      `- 取引構造: ${params.dealStructure || "未入力"}`,
      `- 原著作物・IP名: ${params.originalWork || "未入力"}`,
      `- 許諾対象 / 権利範囲: ${params.licenseScope || "未入力"}`,
      `- 製品化対象 / 商品範囲: ${params.ipProductScope || "未入力"}`,
      `- 地域・言語: ${params.territory || "未入力"}`,
      `- 独占性: ${params.exclusivity || "未入力"}`,
      `- 収益モデル: ${params.revenueModel || "未入力"}`,
      `- ロイヤリティ・対価条件: ${params.royaltyTerms || "未入力"}`,
      `- 再許諾可否: ${params.sublicenseAllowed || "未入力"}`,
      `- 権利帰属 / 成果物帰属: ${params.titleTransferModel || "未入力"}`,
      `- 終了後在庫処理: ${params.inventorySelloff || "未入力"}`,
      `- Schedule 1 Summary: ${params.schedule1Summary || "未入力"}`,
      `- Schedule 1 Special Provisions: ${params.schedule1SpecialProvisions || "未入力"}`,
      `- Schedule 2 Summary: ${params.schedule2Summary || "未入力"}`,
      `- Schedule 2 Special Provisions: ${params.schedule2SpecialProvisions || "未入力"}`,
      `- S1 ロイヤルティ率: ${params.s1RoyaltyRate || "未入力"}`,
      `- S1 MG: ${params.s1MinimumGuarantee || "未入力"}`,
      `- S2 価格表: ${params.s2ProductPriceList || "未入力"}`,
      `- S2 Incoterms / Delivery: ${params.s2IncotermsDelivery || "未入力"}`,
      `- 管轄裁判所: ${params.jurisdiction || "未入力"}`,
      `- 特記事項: ${params.specialNotes || "未入力"}`,
    ];
    return `## 海外IP契約（基本契約）固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "ip_overseas_amendment") {
    const rows = [
      `- 元契約課題キー: ${params.baseAgreementKey || "未入力"}`,
      `- 効力発生日: ${params.effectiveDate || "未入力"}`,
      `- 変更モード: ${params.changeMode || "未入力"}`,
      `- 変更後の取引構造: ${params.dealStructure || "未入力"}`,
      `- 原著作物・IP名: ${params.originalWork || "未入力"}`,
      `- 変更対象条項: ${params.amendmentClauses || "未入力"}`,
      `- 許諾対象 / 権利範囲: ${params.licenseScope || "未入力"}`,
      `- 製品化対象 / 商品範囲: ${params.ipProductScope || "未入力"}`,
      `- 地域・言語: ${params.territory || "未入力"}`,
      `- 収益モデル: ${params.revenueModel || "未入力"}`,
      `- ロイヤリティ・対価条件: ${params.royaltyTerms || "未入力"}`,
      `- 在庫処理・移行措置: ${params.inventorySelloff || "未入力"}`,
      `- 権利帰属の扱い: ${params.titleTransferModel || "未入力"}`,
      `- Schedule 1 Summary: ${params.schedule1Summary || "未入力"}`,
      `- Schedule 1 Special Provisions: ${params.schedule1SpecialProvisions || "未入力"}`,
      `- Schedule 2 Summary: ${params.schedule2Summary || "未入力"}`,
      `- Schedule 2 Special Provisions: ${params.schedule2SpecialProvisions || "未入力"}`,
      `- S1 ロイヤルティ率: ${params.s1RoyaltyRate || "未入力"}`,
      `- S2 価格表: ${params.s2ProductPriceList || "未入力"}`,
      `- 特記事項: ${params.specialNotes || "未入力"}`,
    ];
    return `## 海外IP契約（変更合意）固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "purchase_order") {
    const rows = [
      `- 案件名: ${params.projectTitle || "未入力"}`,
      `- 発注概要: ${params.orderSummary || "未入力"}`,
    ];
    return `## 発注書固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "planning_order") {
    const rows = [
      `- 案件名: ${params.projectTitle || "未入力"}`,
    ];
    return `## 企画発注書固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "publishing_order") {
    const rows = [
      `- 案件名: ${params.projectTitle || "未入力"}`,
      `- マスター契約参照: ${params.masterContractRef || "未入力"}`,
      `- 進行概要: ${params.orderSummary || "未入力"}`,
    ];
    return `## 出版発注書固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "sales_buyer") {
    const rows = [
      `- 契約日: ${params.contractDate || "未入力"}`,
      `- 商品範囲: ${params.productScope || "未入力"}`,
      `- 支払条件概要: ${params.paymentConditionSummary || "未入力"}`,
      `- 補足メモ: ${params.notes || "未入力"}`,
    ];
    return `## 売買契約（当社買手）固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "sales_seller_standard") {
    const rows = [
      `- 契約日: ${params.contractDate || "未入力"}`,
      `- 商品範囲: ${params.productScope || "未入力"}`,
      `- 支払条件概要: ${params.paymentConditionSummary || "未入力"}`,
      `- 補足メモ: ${params.notes || "未入力"}`,
    ];
    return `## 売買契約（当社売手・標準）固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "sales_seller_credit") {
    const rows = [
      `- 契約日: ${params.contractDate || "未入力"}`,
      `- 商品範囲: ${params.productScope || "未入力"}`,
      `- 支払条件概要: ${params.paymentConditionSummary || "未入力"}`,
      `- 保証金額: ${params.securityDepositAmount || "未入力"}`,
      `- 保証金補充期限: ${params.depositReplenishDays || "未入力"}`,
      `- 補足メモ: ${params.notes || "未入力"}`,
    ];
    return `## 売買契約（当社売手・保証金掛け売り）固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "delivery_request") {
    const rows = [
      `- 親課題キー: ${params.parentIssueKey || "未入力"}`,
      `- 対象明細No: ${params.itemNo || "未入力"}`,
      `- 納品備考: ${params.deliveryNote || "未入力"}`,
    ];
    return `## 納品リクエスト固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "royalty_calculation_manufacturing") {
    const rows = [
      `- 紐付けライセンス課題キー: ${params.licenseIssueKey || "未入力"}`,
      `- 製品名: ${params.productName || "未入力"}`,
      `- 製造完了日: ${params.completionDate || "未入力"}`,
      `- 製造数量: ${params.quantity || "未入力"}`,
      `- 基準価格: ${params.msrp || "未入力"}`,
    ];
    return `## 利用許諾料計算（製造ベース）固有項目\n${rows.join("\n")}\n`;
  }

  if (params.contractType === "royalty_calculation_sales_report") {
    const rows = [
      `- 紐付けライセンス課題キー: ${params.licenseIssueKey || "未入力"}`,
      `- 対象商品・報告単位名: ${params.productName || "未入力"}`,
      `- 報告対象期間終了: ${params.reportPeriodEnd || "未入力"}`,
      `- 売上高・正味売上高: ${params.salesAmount || "未入力"}`,
    ];
    return `## 利用許諾料計算（売上報告ベース）固有項目\n${rows.join("\n")}\n`;
  }

  return "";
}

function buildLicenseContractBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("ライセンス基本情報", "ライセンス基本契約の最小ヘッダを入力します。詳細な表示条件や権利補足は起票後に Backlog 側で補完します。"),
    {
      type: "input",
      block_id: "license_bundle_mode",
      optional: false,
      label: { type: "plain_text", text: "🧭 作成方式" },
      element: {
        type: "static_select",
        action_id: "license_bundle_mode_select",
        initial_option: {
          text: {
            type: "plain_text",
            text: existingValues.license_bundle_mode === "schedule_only" ? "個別利用許諾条件のみ" : "基本契約 + 個別利用許諾条件",
          },
          value: existingValues.license_bundle_mode === "schedule_only" ? "schedule_only" : "basic_with_schedule",
        },
        options: [
          {
            text: { type: "plain_text", text: "基本契約 + 個別利用許諾条件" },
            value: "basic_with_schedule",
          },
          {
            text: { type: "plain_text", text: "個別利用許諾条件のみ" },
            value: "schedule_only",
          },
        ],
      },
    },
    {
      type: "input",
      block_id: "contract_date",
      optional: true,
      label: { type: "plain_text", text: "🗓 契約日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.contract_date || undefined,
      },
    },
    {
      type: "input",
      block_id: "original_work",
      label: { type: "plain_text", text: "📚 原著作物" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.original_work ?? "",
        placeholder: { type: "plain_text", text: "例: ボードゲーム『ダブルナイン』" },
      },
    },
    {
      type: "input",
      block_id: "jurisdiction",
      label: { type: "plain_text", text: "⚖️ 管轄裁判所" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.jurisdiction ?? "東京地方裁判所",
        placeholder: { type: "plain_text", text: "例: 東京地方裁判所" },
      },
    },
  ];
}

function buildOutsourcingContractBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("業務委託基本情報", "マスター契約と個別条件のどちらを作成するか選択してください。支払運用や管轄の細部は起票後に Backlog 側で補完します。"),
    {
      type: "input",
      block_id: "outsourcing_bundle_mode",
      optional: false,
      label: { type: "plain_text", text: "🧭 作成方式" },
      element: {
        type: "static_select",
        action_id: "outsourcing_bundle_mode_select",
        initial_option: {
          text: {
            type: "plain_text",
            text: existingValues.outsourcing_bundle_mode === "order_only" ? "発注書のみ" : "基本契約 + 発注書",
          },
          value: existingValues.outsourcing_bundle_mode === "order_only" ? "order_only" : "basic_with_order",
        },
        options: [
          {
            text: { type: "plain_text", text: "基本契約 + 発注書" },
            value: "basic_with_order",
          },
          {
            text: { type: "plain_text", text: "発注書のみ" },
            value: "order_only",
          },
        ],
      },
    },
    {
      type: "input",
      block_id: "contract_date",
      label: { type: "plain_text", text: "🗓 契約日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.contract_date || undefined,
      },
    },
    {
      type: "input",
      block_id: "outsourcing_notes",
      optional: true,
      label: { type: "plain_text", text: "📝 業務概要・前提情報（任意）" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        multiline: true,
        initial_value: existingValues.outsourcing_notes ?? existingValues.notes ?? "",
        placeholder: { type: "plain_text", text: "委託業務の概要や前提条件" },
      },
    },
    ...buildPurchaseOrderBlocks(existingValues),
  ];
}

function buildLicenseScheduleBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("基本条件", "個別利用許諾条件のヘッダ情報です。詳細な金銭条件や素材情報は起票後に Backlog / Local 側で管理します。"),
    {
      type: "input",
      block_id: "license_issue_key",
      label: { type: "plain_text", text: "🔗 親ライセンス課題キー" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.license_issue_key ?? "",
        placeholder: { type: "plain_text", text: "例: LEGAL-10" },
      },
    },
    {
      type: "input",
      block_id: "license_type_name",
      label: { type: "plain_text", text: "🎟 ライセンス種別名" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.license_type_name ?? "",
        placeholder: { type: "plain_text", text: "例: ボードゲーム国内・海外ライセンス" },
      },
    },
    {
      type: "input",
      block_id: "original_work",
      label: { type: "plain_text", text: "📚 原著作物" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.original_work ?? "",
        placeholder: { type: "plain_text", text: "例: ボードゲーム『ダブルナイン』" },
      },
    },
    {
      type: "input",
      block_id: "license_start",
      label: { type: "plain_text", text: "🗓 許諾開始日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.license_start || undefined,
      },
    },
    {
      type: "input",
      block_id: "territory",
      optional: true,
      label: { type: "plain_text", text: "🌏 許諾地域・言語" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.territory ?? "",
        placeholder: { type: "plain_text", text: "例: 全世界・全言語" },
      },
    },
  ];
}

function buildSalesBuyerBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("売買契約（当社買手）", "当社が買手になる契約のヘッダ条件を入力します。納入場所や検収運用の細部は起票後に Backlog 側で補完します。"),
    {
      type: "input",
      block_id: "contract_date",
      label: { type: "plain_text", text: "🗓 契約日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.contract_date || undefined,
      },
    },
    buildTextareaBlock("product_scope", "📦 商品範囲", existingValues, "例: ボードゲーム関連商品一式"),
    buildTextareaBlock("payment_condition_summary", "💴 支払条件概要", existingValues, "例: 検収月末締め翌月末払い"),
  ];
}

function buildSalesSellerStandardBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("売買契約（当社売手・標準）", "標準的な掛け売り契約のヘッダ条件を入力します。締め日や支払方法の細部は起票後に Backlog 側で補完します。"),
    {
      type: "input",
      block_id: "contract_date",
      label: { type: "plain_text", text: "🗓 契約日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.contract_date || undefined,
      },
    },
    buildTextareaBlock("product_scope", "📦 商品範囲", existingValues, "例: トレーディングカード関連商品"),
    buildTextareaBlock("payment_condition_summary", "💴 支払条件概要", existingValues, "例: 月末締め翌月末払い"),
  ];
}

function buildSalesSellerCreditBlocks(existingValues: Record<string, string>) {
  return [
    buildSectionHeader("売買契約（当社売手・保証金掛け売り）", "保証金のある掛け売り契約のヘッダ条件を入力します。締め日や支払方法の細部は起票後に Backlog 側で補完します。"),
    {
      type: "input",
      block_id: "contract_date",
      label: { type: "plain_text", text: "🗓 契約日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.contract_date || undefined,
      },
    },
    buildTextareaBlock("product_scope", "📦 商品範囲", existingValues, "例: ボードゲーム関連商品"),
    buildTextareaBlock("payment_condition_summary", "💴 支払条件概要", existingValues, "例: 月末締め翌月20日払い"),
    buildTextareaBlock("security_deposit_amount", "💰 保証金額", existingValues, "例: 300000"),
    buildTextareaBlock("deposit_replenish_days", "📆 保証金補充期限", existingValues, "例: 不足通知から5営業日以内"),
  ];
}

function buildDeliveryRequestBlocks(existingValues: Record<string, string>) {
  const parentIssueKey = existingValues.parent_issue_key ?? "";
  const itemOptions = (() => {
    try {
      const parsed = JSON.parse(existingValues.delivery_item_options ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })() as Array<{ value: string; label: string }>;

  return [
    buildSectionHeader("納品リクエスト", "対象案件を選んで、どの明細を動かすかを指定します。金額や検収条件は Backlog / Local 側で補完できます。"),
    ...(parentIssueKey
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*対象課題*\n${parentIssueKey}` },
          },
          {
            type: "input",
            block_id: "parent_issue_key",
            optional: true,
            label: { type: "plain_text", text: "🔗 親課題キー（内部保持）" },
            element: {
              type: "plain_text_input",
              action_id: "input",
              initial_value: parentIssueKey,
            },
          },
        ]
      : [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "対象案件は `/法務検索` から選択してください。ここでは課題キーの手入力は想定していません。",
            },
          },
        ]),
    ...(itemOptions.length > 0
      ? [
          {
            type: "input",
            block_id: "delivery_item_no",
            label: { type: "plain_text", text: "🔢 対象明細" },
            element: {
              type: "static_select",
              action_id: "delivery_item_no_select",
              initial_option: (() => {
                const matched = itemOptions.find((item) => item.value === (existingValues.delivery_item_no ?? existingValues.item_no));
                return matched
                  ? {
                      text: { type: "plain_text", text: matched.label.slice(0, 75) },
                      value: matched.value,
                    }
                  : undefined;
              })(),
              options: itemOptions.map((item) => ({
                text: { type: "plain_text", text: item.label.slice(0, 75) },
                value: item.value,
              })),
            },
          },
        ]
      : parentIssueKey
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "選択可能な発注明細が取得できませんでした。対象明細番号を手入力してください。",
              },
            },
            {
              type: "input",
              block_id: "item_no",
              label: { type: "plain_text", text: "🔢 対象明細番号" },
              element: {
                type: "plain_text_input",
                action_id: "input",
                initial_value: existingValues.item_no ?? "",
                placeholder: { type: "plain_text", text: "例: 1" },
              },
            },
          ]
        : []),
    {
      type: "input",
      block_id: "delivery_note",
      optional: true,
      label: { type: "plain_text", text: "📦 納品備考（任意）" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        multiline: true,
        initial_value: existingValues.delivery_note ?? "",
        placeholder: { type: "plain_text", text: "納品内容、差分、最終納品かどうかなど" },
      },
    },
  ];
}

function buildRoyaltyCalculationBlocks(existingValues: Record<string, string>) {
  const licenseIssueKey = existingValues.license_issue_key ?? "";
  return [
    buildSectionHeader("利用許諾料計算", "検索で選んだライセンス案件に紐づく製造情報を入力します。"),
    ...(licenseIssueKey
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*対象ライセンス案件*\n${licenseIssueKey}` },
          },
          {
            type: "input",
            block_id: "license_issue_key",
            optional: true,
            label: { type: "plain_text", text: "🔗 紐付けライセンス課題キー（内部保持）" },
            element: {
              type: "plain_text_input",
              action_id: "input",
              initial_value: licenseIssueKey,
            },
          },
        ]
      : [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "対象ライセンス案件は `/法務検索` から選択してください。ここでは課題キーの手入力は想定していません。",
            },
          },
        ]),
    {
      type: "input",
      block_id: "product_name",
      label: { type: "plain_text", text: "🧸 製品名" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.product_name ?? "",
        placeholder: { type: "plain_text", text: "例: ダブルナイン 日本語版" },
      },
    },
    {
      type: "input",
      block_id: "completion_date",
      label: { type: "plain_text", text: "🏁 製造完了日" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.completion_date || undefined,
      },
    },
    {
      type: "input",
      block_id: "quantity",
      label: { type: "plain_text", text: "📦 製造数量" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.quantity ?? "",
        placeholder: { type: "plain_text", text: "例: 5000" },
      },
    },
    {
      type: "input",
      block_id: "msrp",
      label: { type: "plain_text", text: "💴 基準価格（税抜）" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.msrp ?? "",
        placeholder: { type: "plain_text", text: "例: 3000" },
      },
    },
  ];
}

function buildRoyaltySalesReportBlocks(existingValues: Record<string, string>) {
  const licenseIssueKey = existingValues.license_issue_key ?? "";
  return [
    buildSectionHeader("利用許諾料計算（売上報告ベース）", "検索で選んだライセンス案件に紐づく売上報告情報を入力します。"),
    ...(licenseIssueKey
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*対象ライセンス案件*\n${licenseIssueKey}` },
          },
          {
            type: "input",
            block_id: "license_issue_key",
            optional: true,
            label: { type: "plain_text", text: "🔗 紐付けライセンス課題キー（内部保持）" },
            element: {
              type: "plain_text_input",
              action_id: "input",
              initial_value: licenseIssueKey,
            },
          },
        ]
      : [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "対象ライセンス案件は `/法務検索` から選択してください。ここでは課題キーの手入力は想定していません。",
            },
          },
        ]),
    {
      type: "input",
      block_id: "product_name",
      label: { type: "plain_text", text: "🧾 対象商品・報告単位名" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.product_name ?? "",
        placeholder: { type: "plain_text", text: "例: ダブルナイン 日本語版" },
      },
    },
    {
      type: "input",
      block_id: "report_period_end",
      label: { type: "plain_text", text: "🗓 報告対象期間終了" },
      element: {
        type: "datepicker",
        action_id: "datepicker",
        initial_date: existingValues.report_period_end || undefined,
      },
    },
    {
      type: "input",
      block_id: "sales_amount",
      label: { type: "plain_text", text: "💴 売上高・正味売上高" },
      element: {
        type: "plain_text_input",
        action_id: "input",
        initial_value: existingValues.sales_amount ?? "",
        placeholder: { type: "plain_text", text: "例: 3500000" },
      },
    },
  ];
}

function buildSectionHeader(title: string, description?: string) {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: description ? `*${title}*\n${description}` : `*${title}*`,
    },
  };
}

function buildBacklogCustomFields(contractType: string, values: Record<string, string>): Record<string, string> {
  const isOrderType = contractType === "purchase_order" || contractType === "planning_order" || contractType === "publishing_order";
  const baseEntries = {
    [process.env.BACKLOG_FIELD_REQUESTER ?? ""]: values.requester,
    [process.env.BACKLOG_FIELD_CONTRACT_TYPE ?? ""]: values.contractTypeLabel,
    [process.env.BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER ?? ""]: values.registrationNumber,
    [process.env.BACKLOG_FIELD_COUNTERPARTY ?? ""]: values.counterparty,
    [process.env.BACKLOG_FIELD_DEADLINE ?? ""]: values.deadline,
    [process.env.BACKLOG_FIELD_CONTRACT_NO ?? ""]: isOrderType ? "" : values.contractNo,
    [process.env.BACKLOG_FIELD_COUNTERPARTY_ADDRESS ?? ""]: values.counterpartyAddress,
    [process.env.BACKLOG_FIELD_COUNTERPARTY_REP ?? ""]: values.counterpartyRepresentative,
    [process.env.BACKLOG_FIELD_REMARKS ?? ""]: values.remarks,
    [process.env.BACKLOG_FIELD_CONTRACT_DATE ?? ""]: values.contractDate,
  };

  if (contractType === "nda") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_NDA_PURPOSE ?? ""]: values.ndaPurpose,
      [process.env.BACKLOG_FIELD_CONTRACT_PERIOD ?? ""]: values.contractPeriod,
      [process.env.BACKLOG_FIELD_CONFIDENTIALITY_PERIOD ?? ""]: values.confidentialityPeriod,
    });
  }

  if (contractType === "outsourcing") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
    });
  }

  if (contractType === "license") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_ORIGINAL_WORK ?? ""]: values.originalWork,
      [process.env.BACKLOG_FIELD_JURISDICTION ?? ""]: values.jurisdiction,
    });
  }

  if (contractType === "license_schedule") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_LICENSE_KEY ?? ""]: values.licenseIssueKey,
      [process.env.BACKLOG_FIELD_LICENSE_TYPE_NAME ?? ""]: values.licenseTypeName,
      [process.env.BACKLOG_FIELD_ORIGINAL_WORK ?? ""]: values.originalWork,
      [process.env.BACKLOG_FIELD_LICENSE_START ?? ""]: values.licenseStart,
    });
  }

  if (contractType === "ip_overseas_master") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_ORIGINAL_WORK ?? ""]: values.originalWork,
      [process.env.BACKLOG_FIELD_CONTRACT_PERIOD ?? ""]: values.contractPeriod,
      [process.env.BACKLOG_FIELD_JURISDICTION ?? ""]: values.jurisdiction,
      [process.env.BACKLOG_FIELD_DEAL_STRUCTURE ?? ""]: values.dealStructure,
      [process.env.BACKLOG_FIELD_LICENSE_SCOPE ?? ""]: values.licenseScope,
      [process.env.BACKLOG_FIELD_IP_PRODUCT_SCOPE ?? ""]: values.ipProductScope,
      [process.env.BACKLOG_FIELD_TERRITORY ?? ""]: values.territory,
      [process.env.BACKLOG_FIELD_EXCLUSIVITY ?? ""]: values.exclusivity,
      [process.env.BACKLOG_FIELD_REVENUE_MODEL ?? ""]: values.revenueModel,
      [process.env.BACKLOG_FIELD_ROYALTY_TERMS ?? ""]: values.royaltyTerms,
      [process.env.BACKLOG_FIELD_SUBLICENSE_ALLOWED ?? ""]: values.sublicenseAllowed,
      [process.env.BACKLOG_FIELD_TITLE_TRANSFER_MODEL ?? ""]: values.titleTransferModel,
      [process.env.BACKLOG_FIELD_INVENTORY_SELLOFF ?? ""]: values.inventorySelloff,
      [process.env.BACKLOG_FIELD_SPECIAL_NOTES ?? ""]: values.specialNotes,
      [process.env.BACKLOG_FIELD_S1_ROYALTY_RATE ?? ""]: values.s1RoyaltyRate,
      [process.env.BACKLOG_FIELD_S1_MINIMUM_GUARANTEE ?? ""]: values.s1MinimumGuarantee,
      [process.env.BACKLOG_FIELD_S1_ADVANCE ?? ""]: values.s1Advance,
      [process.env.BACKLOG_FIELD_S1_ACCOUNTING_PERIOD ?? ""]: values.s1AccountingPeriod,
      [process.env.BACKLOG_FIELD_S1_PAYMENT_DUE ?? ""]: values.s1PaymentDue,
      [process.env.BACKLOG_FIELD_S1_REPORT_DUE ?? ""]: values.s1ReportDue,
      [process.env.BACKLOG_FIELD_S1_FX_CONVERSION ?? ""]: values.s1FxConversion,
      [process.env.BACKLOG_FIELD_S1_FIRST_PRINT_RUN ?? ""]: values.s1FirstPrintRun,
      [process.env.BACKLOG_FIELD_S1_TARGET_RELEASE_DATE ?? ""]: values.s1TargetReleaseDate,
      [process.env.BACKLOG_FIELD_S1_COMPLIMENTARY_COPIES ?? ""]: values.s1ComplimentaryCopies,
      [process.env.BACKLOG_FIELD_S1_CREDIT_WORDING ?? ""]: values.s1CreditWording,
      [process.env.BACKLOG_FIELD_S1_TERRITORY_JURISDICTION ?? ""]: values.s1TerritoryJurisdiction,
      [process.env.BACKLOG_FIELD_S1_CONSUMER_LAW_CARVEOUT ?? ""]: values.s1ConsumerLawCarveout,
      [process.env.BACKLOG_FIELD_S1_VAT_GST_TREATMENT ?? ""]: values.s1VatGstTreatment,
      [process.env.BACKLOG_FIELD_S1_COPYRIGHT_REGISTRATION ?? ""]: values.s1CopyrightRegistration,
      [process.env.BACKLOG_FIELD_S1_MORAL_RIGHTS ?? ""]: values.s1MoralRights,
      [process.env.BACKLOG_FIELD_S1_MANDATORY_DISTRIBUTION_LAW ?? ""]: values.s1MandatoryDistributionLaw,
      [process.env.BACKLOG_FIELD_S1_ADDITIONAL_TERMS ?? ""]: values.s1AdditionalTerms,
      [process.env.BACKLOG_FIELD_S2_PRODUCT_PRICE_LIST ?? ""]: values.s2ProductPriceList,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR1 ?? ""]: values.s2MprYear1,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR2 ?? ""]: values.s2MprYear2,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR3 ?? ""]: values.s2MprYear3,
      [process.env.BACKLOG_FIELD_S2_INCOTERMS_DELIVERY ?? ""]: values.s2IncotermsDelivery,
      [process.env.BACKLOG_FIELD_S2_ARRIVAL_POINT ?? ""]: values.s2ArrivalPoint,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_ADVANCE ?? ""]: values.s2PaymentAdvance,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_BALANCE ?? ""]: values.s2PaymentBalance,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_CURRENCY ?? ""]: values.s2PaymentCurrency,
      [process.env.BACKLOG_FIELD_S2_TERRITORY_JURISDICTION ?? ""]: values.s2TerritoryJurisdiction,
      [process.env.BACKLOG_FIELD_S2_IMPORT_CUSTOMS_ALLOCATION ?? ""]: values.s2ImportCustomsAllocation,
      [process.env.BACKLOG_FIELD_S2_CONSUMER_PRODUCT_SAFETY ?? ""]: values.s2ConsumerProductSafety,
      [process.env.BACKLOG_FIELD_S2_DISTRIBUTION_LAW_PROTECTIONS ?? ""]: values.s2DistributionLawProtections,
      [process.env.BACKLOG_FIELD_S2_VAT_GST_SUPPLY ?? ""]: values.s2VatGstSupply,
      [process.env.BACKLOG_FIELD_S2_PRODUCT_LIABILITY_INSURANCE ?? ""]: values.s2ProductLiabilityInsurance,
      [process.env.BACKLOG_FIELD_S2_MARKETPLACE_ONLINE_SALES ?? ""]: values.s2MarketplaceOnlineSales,
      [process.env.BACKLOG_FIELD_S2_ADDITIONAL_TERMS ?? ""]: values.s2AdditionalTerms,
    });
  }

  if (contractType === "ip_overseas_amendment") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_ORIGINAL_WORK ?? ""]: values.originalWork,
      [process.env.BACKLOG_FIELD_DEAL_STRUCTURE ?? ""]: values.dealStructure,
      [process.env.BACKLOG_FIELD_CHANGE_MODE ?? ""]: values.changeMode,
      [process.env.BACKLOG_FIELD_BASE_AGREEMENT_KEY ?? ""]: values.baseAgreementKey,
      [process.env.BACKLOG_FIELD_EFFECTIVE_DATE ?? ""]: values.effectiveDate,
      [process.env.BACKLOG_FIELD_LICENSE_SCOPE ?? ""]: values.licenseScope,
      [process.env.BACKLOG_FIELD_IP_PRODUCT_SCOPE ?? ""]: values.ipProductScope,
      [process.env.BACKLOG_FIELD_TERRITORY ?? ""]: values.territory,
      [process.env.BACKLOG_FIELD_REVENUE_MODEL ?? ""]: values.revenueModel,
      [process.env.BACKLOG_FIELD_ROYALTY_TERMS ?? ""]: values.royaltyTerms,
      [process.env.BACKLOG_FIELD_TITLE_TRANSFER_MODEL ?? ""]: values.titleTransferModel,
      [process.env.BACKLOG_FIELD_INVENTORY_SELLOFF ?? ""]: values.inventorySelloff,
      [process.env.BACKLOG_FIELD_AMENDMENT_CLAUSES ?? ""]: values.amendmentClauses,
      [process.env.BACKLOG_FIELD_SPECIAL_NOTES ?? ""]: values.specialNotes,
      [process.env.BACKLOG_FIELD_S1_ROYALTY_RATE ?? ""]: values.s1RoyaltyRate,
      [process.env.BACKLOG_FIELD_S1_MINIMUM_GUARANTEE ?? ""]: values.s1MinimumGuarantee,
      [process.env.BACKLOG_FIELD_S1_ADVANCE ?? ""]: values.s1Advance,
      [process.env.BACKLOG_FIELD_S1_ACCOUNTING_PERIOD ?? ""]: values.s1AccountingPeriod,
      [process.env.BACKLOG_FIELD_S1_PAYMENT_DUE ?? ""]: values.s1PaymentDue,
      [process.env.BACKLOG_FIELD_S1_REPORT_DUE ?? ""]: values.s1ReportDue,
      [process.env.BACKLOG_FIELD_S1_FX_CONVERSION ?? ""]: values.s1FxConversion,
      [process.env.BACKLOG_FIELD_S1_FIRST_PRINT_RUN ?? ""]: values.s1FirstPrintRun,
      [process.env.BACKLOG_FIELD_S1_TARGET_RELEASE_DATE ?? ""]: values.s1TargetReleaseDate,
      [process.env.BACKLOG_FIELD_S1_COMPLIMENTARY_COPIES ?? ""]: values.s1ComplimentaryCopies,
      [process.env.BACKLOG_FIELD_S1_CREDIT_WORDING ?? ""]: values.s1CreditWording,
      [process.env.BACKLOG_FIELD_S1_TERRITORY_JURISDICTION ?? ""]: values.s1TerritoryJurisdiction,
      [process.env.BACKLOG_FIELD_S1_CONSUMER_LAW_CARVEOUT ?? ""]: values.s1ConsumerLawCarveout,
      [process.env.BACKLOG_FIELD_S1_VAT_GST_TREATMENT ?? ""]: values.s1VatGstTreatment,
      [process.env.BACKLOG_FIELD_S1_COPYRIGHT_REGISTRATION ?? ""]: values.s1CopyrightRegistration,
      [process.env.BACKLOG_FIELD_S1_MORAL_RIGHTS ?? ""]: values.s1MoralRights,
      [process.env.BACKLOG_FIELD_S1_MANDATORY_DISTRIBUTION_LAW ?? ""]: values.s1MandatoryDistributionLaw,
      [process.env.BACKLOG_FIELD_S1_ADDITIONAL_TERMS ?? ""]: values.s1AdditionalTerms,
      [process.env.BACKLOG_FIELD_S2_PRODUCT_PRICE_LIST ?? ""]: values.s2ProductPriceList,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR1 ?? ""]: values.s2MprYear1,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR2 ?? ""]: values.s2MprYear2,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR3 ?? ""]: values.s2MprYear3,
      [process.env.BACKLOG_FIELD_S2_INCOTERMS_DELIVERY ?? ""]: values.s2IncotermsDelivery,
      [process.env.BACKLOG_FIELD_S2_ARRIVAL_POINT ?? ""]: values.s2ArrivalPoint,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_ADVANCE ?? ""]: values.s2PaymentAdvance,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_BALANCE ?? ""]: values.s2PaymentBalance,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_CURRENCY ?? ""]: values.s2PaymentCurrency,
      [process.env.BACKLOG_FIELD_S2_TERRITORY_JURISDICTION ?? ""]: values.s2TerritoryJurisdiction,
      [process.env.BACKLOG_FIELD_S2_IMPORT_CUSTOMS_ALLOCATION ?? ""]: values.s2ImportCustomsAllocation,
      [process.env.BACKLOG_FIELD_S2_CONSUMER_PRODUCT_SAFETY ?? ""]: values.s2ConsumerProductSafety,
      [process.env.BACKLOG_FIELD_S2_DISTRIBUTION_LAW_PROTECTIONS ?? ""]: values.s2DistributionLawProtections,
      [process.env.BACKLOG_FIELD_S2_VAT_GST_SUPPLY ?? ""]: values.s2VatGstSupply,
      [process.env.BACKLOG_FIELD_S2_PRODUCT_LIABILITY_INSURANCE ?? ""]: values.s2ProductLiabilityInsurance,
      [process.env.BACKLOG_FIELD_S2_MARKETPLACE_ONLINE_SALES ?? ""]: values.s2MarketplaceOnlineSales,
      [process.env.BACKLOG_FIELD_S2_ADDITIONAL_TERMS ?? ""]: values.s2AdditionalTerms,
    });
  }

  if (contractType === "sales_buyer") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_PRODUCT_SCOPE ?? ""]: values.productScope,
      [process.env.BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY ?? ""]: values.paymentConditionSummary,
    });
  }

  if (contractType === "sales_seller_standard") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_PRODUCT_SCOPE ?? ""]: values.productScope,
      [process.env.BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY ?? ""]: values.paymentConditionSummary,
    });
  }

  if (contractType === "sales_seller_credit") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_PRODUCT_SCOPE ?? ""]: values.productScope,
      [process.env.BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY ?? ""]: values.paymentConditionSummary,
      [process.env.BACKLOG_FIELD_SECURITY_DEPOSIT_AMOUNT ?? ""]: values.securityDepositAmount,
      [process.env.BACKLOG_FIELD_DEPOSIT_REPLENISH_DAYS ?? ""]: values.depositReplenishDays,
    });
  }

  if (contractType === "delivery_request") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_PARENT_ISSUE_KEY ?? ""]: values.parentIssueKey,
      [process.env.BACKLOG_FIELD_ITEM_NO ?? ""]: values.itemNo,
      [process.env.BACKLOG_FIELD_DELIVERED_AMOUNT ?? ""]: values.deliveredAmount,
      [process.env.BACKLOG_FIELD_DELIVERY_NOTE ?? ""]: values.deliveryNote,
    });
  }

  if (contractType === "royalty_calculation_manufacturing") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_LICENSE_KEY ?? ""]: values.licenseIssueKey,
      [process.env.BACKLOG_FIELD_PRODUCT_NAME ?? ""]: values.productName,
      [process.env.BACKLOG_FIELD_EDITION ?? ""]: values.edition,
      [process.env.BACKLOG_FIELD_COMPLETION_DATE ?? ""]: values.completionDate,
      [process.env.BACKLOG_FIELD_QUANTITY ?? ""]: values.quantity,
      [process.env.BACKLOG_FIELD_MSRP ?? ""]: values.msrp,
      [process.env.BACKLOG_FIELD_SAMPLE_QUANTITY ?? ""]: values.sampleQuantity,
    });
  }

  if (contractType === "royalty_calculation_sales_report") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_LICENSE_KEY ?? ""]: values.licenseIssueKey,
      [process.env.BACKLOG_FIELD_PRODUCT_NAME ?? ""]: values.productName,
      [process.env.BACKLOG_FIELD_REPORT_PERIOD_START ?? ""]: values.reportPeriodStart,
      [process.env.BACKLOG_FIELD_REPORT_PERIOD_END ?? ""]: values.reportPeriodEnd,
      [process.env.BACKLOG_FIELD_NET_SALES ?? ""]: values.salesAmount,
      [process.env.BACKLOG_FIELD_RECEIVED_AMOUNT ?? ""]: values.receivedAmount,
      [process.env.BACKLOG_FIELD_SALES_QUANTITY ?? ""]: values.salesQuantity,
    });
  }

  if (contractType === "purchase_order" || contractType === "planning_order" || contractType === "publishing_order") {
    return sanitizeCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_PROJECT_TITLE ?? ""]: values.projectTitle,
      ...(contractType === "purchase_order"
        ? {
            [process.env.BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY ?? ""]: values.orderSummary,
          }
        : {}),
      ...(contractType === "planning_order" || contractType === "publishing_order"
        ? {
            [process.env.BACKLOG_FIELD_MASTER_CONTRACT_REF ?? ""]: values.masterContractRef,
          }
        : {}),
    });
  }

  return sanitizeCustomFieldEntries(baseEntries);
}

function sanitizeCustomFieldEntries(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter(([fieldId, value]) => fieldId.trim() && value.trim())
  );
}

function validateRequestSubmission(params: {
  contractType: string;
  registrationNumber: string;
  counterparty: string;
  summary: string;
  projectTitle: string;
  counterpartyAddress: string;
  contractDate: string;
  originalWork: string;
  licenseTypeName: string;
  licenseStart: string;
  ndaPurpose: string;
  contractPeriod: string;
  jurisdiction: string;
  productName: string;
  dealStructure: string;
  changeMode: string;
  baseAgreementKey: string;
  effectiveDate: string;
  licenseScope: string;
  ipProductScope: string;
  exclusivity: string;
  revenueModel: string;
  royaltyTerms: string;
  sublicenseAllowed: string;
  titleTransferModel: string;
  inventorySelloff: string;
  amendmentClauses: string;
  schedule1Summary: string;
  schedule1SpecialProvisions: string;
  schedule2Summary: string;
  schedule2SpecialProvisions: string;
  s1RoyaltyRate: string;
  s1MinimumGuarantee: string;
  s1Advance: string;
  s1AccountingPeriod: string;
  s1PaymentDue: string;
  s1ReportDue: string;
  s1FxConversion: string;
  s1FirstPrintRun: string;
  s1TargetReleaseDate: string;
  s1ComplimentaryCopies: string;
  s1CreditWording: string;
  s1TerritoryJurisdiction: string;
  s1ConsumerLawCarveout: string;
  s1VatGstTreatment: string;
  s1CopyrightRegistration: string;
  s1MoralRights: string;
  s1MandatoryDistributionLaw: string;
  s1AdditionalTerms: string;
  s2ProductPriceList: string;
  s2MprYear1: string;
  s2MprYear2: string;
  s2MprYear3: string;
  s2IncotermsDelivery: string;
  s2ArrivalPoint: string;
  s2PaymentAdvance: string;
  s2PaymentBalance: string;
  s2PaymentCurrency: string;
  s2TerritoryJurisdiction: string;
  s2ImportCustomsAllocation: string;
  s2ConsumerProductSafety: string;
  s2DistributionLawProtections: string;
  s2VatGstSupply: string;
  s2ProductLiabilityInsurance: string;
  s2MarketplaceOnlineSales: string;
  s2AdditionalTerms: string;
  licenseIssueKey: string;
  parentIssueKey: string;
  itemNo: string;
  completionDate: string;
  quantity: string;
  msrp: string;
  reportPeriodStart: string;
  reportPeriodEnd: string;
  salesAmount: string;
  receivedAmount: string;
  salesQuantity: string;
  productScope: string;
  deliveryLocation: string;
  inspectionPeriodDays: string;
  paymentConditionSummary: string;
  warrantyPeriod: string;
  monthlyClosingDay: string;
  paymentDueDay: string;
  paymentMethod: string;
  securityDepositAmount: string;
  depositReplenishDays: string;
  notes: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  const registrationRequiredTypes = new Set([
    "nda",
    "outsourcing",
    "license",
    "ip_overseas_master",
    "ip_overseas_amendment",
    "sales_buyer",
    "sales_seller_standard",
    "sales_seller_credit",
  ]);
  const counterpartyRequiredTypes = new Set([
    "nda",
    "outsourcing",
    "license",
    "ip_overseas_master",
    "ip_overseas_amendment",
    "sales_buyer",
    "sales_seller_standard",
    "sales_seller_credit",
    "purchase_order",
    "planning_order",
    "publishing_order",
  ]);

  if (registrationRequiredTypes.has(params.contractType) && !params.registrationNumber.trim()) {
    errors.registration_number = "登録番号を入力してください。";
  }
  if (counterpartyRequiredTypes.has(params.contractType) && !params.counterparty.trim()) {
    errors.counterparty = "相手方名を入力してください。";
  }
  if (!params.summary.trim()) {
    errors.summary = "概要を入力してください。";
  }

  if (
    (params.contractType === "purchase_order"
      || params.contractType === "planning_order"
      || params.contractType === "publishing_order")
    && !params.projectTitle.trim()
  ) {
    errors.project_title = "案件名を入力してください。";
  }

  if (params.contractType === "nda") {
    if (!params.contractDate) {
      errors.contract_date = "契約日を入力してください。";
    }
    if (!params.ndaPurpose.trim()) {
      errors.nda_purpose = "秘密保持の目的を入力してください。";
    }
    if (!params.contractPeriod.trim()) {
      errors.contract_period = "契約期間を入力してください。";
    }
  }

  if (params.contractType === "outsourcing") {
    if (!params.contractDate) {
      errors.contract_date = "契約日を入力してください。";
    }
  }

  if (params.contractType === "license") {
    if (!params.originalWork.trim()) {
      errors.original_work = "原著作物を入力してください。";
    }
    if (!params.jurisdiction.trim()) {
      errors.jurisdiction = "管轄裁判所を入力してください。";
    }
  }

  if (params.contractType === "license_schedule") {
    if (!params.licenseIssueKey.trim()) {
      errors.license_issue_key = "親ライセンス課題キーを入力してください。";
    }
    if (!params.licenseTypeName.trim()) {
      errors.license_type_name = "ライセンス種別名を入力してください。";
    }
    if (!params.originalWork.trim()) {
      errors.original_work = "原著作物を入力してください。";
    }
    if (!params.licenseStart) {
      errors.license_start = "許諾開始日を入力してください。";
    }
  }

  if (params.contractType === "ip_overseas_master") {
    if (!params.contractDate) {
      errors.contract_date = "契約日を入力してください。";
    }
    if (!params.dealStructure.trim()) {
      errors.deal_structure = "取引構造を入力してください。";
    }
    if (!params.originalWork.trim()) {
      errors.original_work = "原著作物・IP名を入力してください。";
    }
    if (!params.jurisdiction.trim()) {
      errors.jurisdiction = "管轄裁判所を入力してください。";
    }
  }

  if (params.contractType === "ip_overseas_amendment") {
    if (!params.contractDate) {
      errors.contract_date = "変更合意日を入力してください。";
    }
    if (!params.baseAgreementKey.trim()) {
      errors.base_agreement_key = "元契約課題キーを入力してください。";
    }
    if (!params.effectiveDate.trim()) {
      errors.effective_date = "効力発生日を入力してください。";
    }
    if (!params.changeMode.trim()) {
      errors.change_mode = "変更モードを入力してください。";
    }
    if (!params.dealStructure.trim()) {
      errors.deal_structure = "変更後の取引構造を入力してください。";
    }
    if (!params.originalWork.trim()) {
      errors.original_work = "原著作物・IP名を入力してください。";
    }
  }

  if (
    params.contractType === "sales_buyer" ||
    params.contractType === "sales_seller_standard" ||
    params.contractType === "sales_seller_credit"
  ) {
    if (!params.contractDate) {
      errors.contract_date = "契約日を入力してください。";
    }
  }

  if (params.contractType === "sales_buyer") {
    if (!params.productScope.trim()) {
      errors.product_scope = "商品範囲を入力してください。";
    }
    if (!params.paymentConditionSummary.trim()) {
      errors.payment_condition_summary = "支払条件概要を入力してください。";
    }
  }

  if (params.contractType === "sales_seller_standard") {
    if (!params.productScope.trim()) {
      errors.product_scope = "商品範囲を入力してください。";
    }
    if (!params.paymentConditionSummary.trim()) {
      errors.payment_condition_summary = "支払条件概要を入力してください。";
    }
  }

  if (params.contractType === "sales_seller_credit") {
    if (!params.productScope.trim()) {
      errors.product_scope = "商品範囲を入力してください。";
    }
    if (!params.paymentConditionSummary.trim()) {
      errors.payment_condition_summary = "支払条件概要を入力してください。";
    }
    if (!params.securityDepositAmount.trim()) {
      errors.security_deposit_amount = "保証金額を入力してください。";
    }
    if (!params.depositReplenishDays.trim()) {
      errors.deposit_replenish_days = "保証金補充期限を入力してください。";
    }
  }

  if (params.contractType === "delivery_request" && !params.parentIssueKey.trim()) {
    errors.parent_issue_key = "親課題キーを入力してください。";
  }

  if (params.contractType === "delivery_request" && !params.itemNo.trim()) {
    errors.delivery_item_no = "対象明細を選択してください。";
  }

  if (params.contractType === "royalty_calculation_manufacturing") {
    if (!params.licenseIssueKey.trim()) {
      errors.license_issue_key = "紐付けライセンス課題キーを入力してください。";
    }
    if (!params.productName.trim()) {
      errors.product_name = "製品名を入力してください。";
    }
    if (!params.completionDate.trim()) {
      errors.completion_date = "製造完了日を入力してください。";
    }
    if (!params.quantity.trim()) {
      errors.quantity = "製造数量を入力してください。";
    }
    if (!params.msrp.trim()) {
      errors.msrp = "基準価格を入力してください。";
    }
  }

  if (params.contractType === "royalty_calculation_sales_report") {
    if (!params.licenseIssueKey.trim()) {
      errors.license_issue_key = "紐付けライセンス課題キーを入力してください。";
    }
    if (!params.productName.trim()) {
      errors.product_name = "対象商品・報告単位名を入力してください。";
    }
    if (!params.reportPeriodStart.trim()) {
      errors.report_period_start = "報告対象期間開始を入力してください。";
    }
    if (!params.reportPeriodEnd.trim()) {
      errors.report_period_end = "報告対象期間終了を入力してください。";
    }
    if (!params.salesAmount.trim()) {
      errors.sales_amount = "売上高・正味売上高を入力してください。";
    }
  }

  return errors;
}

function statusToEmoji(statusName: string): string {
  const map: Record<string, string> = {
    "未対応": "🔴",
    "処理中": "🟡",
    "処理済み": "🟢",
    "完了": "✅",
  };
  return map[statusName] ?? "⚪";
}

function buildRejectModal(issueKey: string) {
  return {
    type: "modal" as const,
    callback_id: "reject_document_modal",
    private_metadata: JSON.stringify({ issueKey }),
    title: { type: "plain_text" as const, text: "否認理由" },
    submit: { type: "plain_text" as const, text: "送信" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "reject_reason",
        label: { type: "plain_text", text: "差戻し理由" },
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "input",
          multiline: true,
          placeholder: { type: "plain_text", text: "必要なら修正内容を入力してください" },
        },
      },
    ],
  };
}

function buildStampCompleteModal(issueKey: string) {
  return {
    type: "modal" as const,
    callback_id: "stamp_complete_modal",
    private_metadata: JSON.stringify({ issueKey }),
    title: { type: "plain_text" as const, text: "押印完了登録" },
    submit: { type: "plain_text" as const, text: "登録" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "stamp_type",
        label: { type: "plain_text", text: "押印方式" },
        element: {
          type: "static_select",
          action_id: "select",
          initial_option: {
            text: { type: "plain_text", text: "物理押印" },
            value: "PHYSICAL",
          },
          options: [
            {
              text: { type: "plain_text", text: "物理押印" },
              value: "PHYSICAL",
            },
            {
              text: { type: "plain_text", text: "電子署名" },
              value: "ELECTRONIC",
            },
          ],
        },
      },
      {
        type: "input",
        block_id: "stamp_document_url",
        label: { type: "plain_text", text: "押印済みファイルURL" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          placeholder: { type: "plain_text", text: "Google Drive URL など" },
        },
      },
    ],
  };
}

function buildStampRejectModal(issueKey: string) {
  return {
    type: "modal" as const,
    callback_id: "stamp_reject_modal",
    private_metadata: JSON.stringify({ issueKey }),
    title: { type: "plain_text" as const, text: "押印差戻し" },
    submit: { type: "plain_text" as const, text: "送信" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "stamp_reject_reason",
        label: { type: "plain_text", text: "差戻し理由" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          multiline: true,
          placeholder: { type: "plain_text", text: "押印差戻し理由を入力してください" },
        },
      },
    ],
  };
}
