import fs from "fs";
import { Router, Request, Response } from "express";
import { spawn } from "child_process";
import path from "path";
import { backlog } from "../backlog/client";
import { resolveDriveFolderKey, resolveRequesterSlackId } from "../backlog/issueContext";
import { extractCsvHeaders, importOrderCsvForIssue, parseOrderCsv, parsePlanningInspectionCsv } from "../orders/csvImport";
import { generateOrderDocumentsFromIssue } from "../orders/generator";
import { createBacklogSyncRun, createLegalRequest, findIssueWorkflowByIssueKey, findLegalRequestByBacklogKey, findManufacturingEventByBacklogIssueKey, findStaffBySlackUserId, findVendorByCode, getAdminDashboardSnapshot, listDepartmentWorkflowRules, listStaff, listStaffDepartments, listStampWorkflows, listVendors, matchVendor, saveGeneratedDocuments, saveIssueDocumentDraft, upsertDepartmentWorkflowRule, upsertStaff, upsertVendor } from "../db/repository";
import { assignOrderItemBacklogIssueKey, createDeliveryEvent, findDeliveryEventByBacklogIssueKey, getDeliveryEventWithContext, getOrderItems, getOrderSummary } from "../db/orderRepository";
import { resolveDriveFolderId, resolveDriveFolderLabel } from "../documents/driveFolders";
import { tryUploadToDrive } from "../documents/fileStorage";
import { generateDeliveryDocuments } from "../documents/partialDeliveryGenerator";
import { generateRoyaltyFromIssue, getRoyaltyIssueSnapshot, resolveRoyaltyLicenseCondition } from "../documents/royaltyGenerator";
import { renderTemplateHtml } from "../documents/templateRenderer";
import { buildRenderItemsForIssue, generateDocumentsForIssue } from "../webhook/backlog";
import { getPaymentMethodLabel, normalizePaymentMethodCode, PAYMENT_METHOD_OPTIONS } from "../payments/methods";
import { summarizeLicenseMoneyCondition } from "../payments/performance";
import { WORKFLOW_STATUS } from "../workflow/statusConfig";
import {
  getActivePlanningImportProfileId,
  getPlanningImportProfile,
  getPlanningImportProfiles,
  getPlanningImportSettings,
  savePlanningImportSettings,
  setActivePlanningImportProfile,
} from "../orders/planningImportSettings";
import { convertWorkbookSheetToCsv, listWorkbookSheetsFromBase64 } from "../orders/xlsxImport";
import { chooseStampType, completeStamp, previewWorkflowAssignmentForSlackUser, rejectStamp, sendStampRequest } from "../workflow/approvals";
import { getWorkflowSettings, saveWorkflowSettings } from "../workflow/workflowSettings";
import { DOCUMENT_REQUEST_DEFINITIONS, getDocumentRequestDefinition, type DocumentRequestType } from "../workflow/documentRequestConfig";
import { getDocumentRequestFieldGroups, validateDocumentRequestValues } from "../workflow/documentRequestFields";
import { getBacklogCustomFieldValue, resolveIssueDocumentDate, resolveIssueDocumentNumber } from "../workflow/documentDefaults";
import { runBacklogPollingOnce } from "../backlog/poller";
import { getLocalRuntimeStatus, updateLocalComponentStatus } from "../local/status";
import { createOptionalSlackClient } from "../slack/optionalClient";
import { WebClient } from "@slack/web-api";
import Papa from "papaparse";

let isManualBacklogSyncRunning = false;

export function createAdminRouter(): Router {
  const router = Router();
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  const optionalSlackClient = createOptionalSlackClient(process.env.SLACK_BOT_TOKEN);

  router.get("/", async (_req: Request, res: Response) => {
    try {
      const snapshot = await getAdminDashboardSnapshot(6);
      const workflowAttentionSummary = await buildWorkflowAttentionSummary();
      const workflowPriorityQueue = await buildWorkflowPriorityQueue();
      res.type("html").send(buildAdminHomeHtml(snapshot, getLocalRuntimeStatus(), workflowAttentionSummary, workflowPriorityQueue));
    } catch (error) {
      const emptySnapshot = {
        recentWorkflows: [],
        statusGroups: [],
        statusSummary: [],
        recentStatusItems: [],
        recentGeneratedDocs: [],
        recentGeneratedDocuments: [],
        attentionItems: [],
        attentionWorkflows: [],
        syncFailures: [],
        workflowRunHistory: [],
        workflowExecutionSummary: null,
        recentActivity: [],
      };
      res.type("html").send(buildAdminHomeHtml(emptySnapshot as any, getLocalRuntimeStatus(), [], []));
    }
  });

  router.get("/masters", (_req: Request, res: Response) => {
    res.type("html").send(buildMasterAdminHtml());
  });

  router.get("/orders", async (_req: Request, res: Response) => {
    try {
      const snapshot = await getAdminDashboardSnapshot(10);
      res.type("html").send(buildOrdersAdminHubHtml(snapshot));
    } catch {
      res.type("html").send(buildOrdersAdminHubHtml({ recentWorkflows: [], statusSummary: [], recentStatusItems: [], recentGeneratedDocuments: [], attentionItems: [], syncFailures: [] } as any));
    }
  });

  router.get("/contracts", async (_req: Request, res: Response) => {
    try {
      const [snapshot, workflowPriorityQueue] = await Promise.all([
        getAdminDashboardSnapshot(10),
        buildWorkflowPriorityQueue(10),
      ]);
      res.type("html").send(buildContractsAdminHubHtml(snapshot, workflowPriorityQueue));
    } catch {
      res.type("html").send(buildContractsAdminHubHtml({ recentWorkflows: [], statusSummary: [], recentStatusItems: [], recentGeneratedDocuments: [], attentionItems: [], syncFailures: [] } as any, []));
    }
  });

  router.get("/delivery", async (_req: Request, res: Response) => {
    try {
      const [snapshot, workflowPriorityQueue] = await Promise.all([
        getAdminDashboardSnapshot(10),
        buildWorkflowPriorityQueue(10),
      ]);
      res.type("html").send(buildDeliveryAdminHubHtml(snapshot, workflowPriorityQueue));
    } catch {
      res.type("html").send(buildDeliveryAdminHubHtml({ recentWorkflows: [], statusSummary: [], recentStatusItems: [], recentGeneratedDocuments: [], attentionItems: [], syncFailures: [] } as any, []));
    }
  });

  router.get("/royalty", async (_req: Request, res: Response) => {
    try {
      const [snapshot, workflowPriorityQueue] = await Promise.all([
        getAdminDashboardSnapshot(10),
        buildWorkflowPriorityQueue(10),
      ]);
      res.type("html").send(buildRoyaltyAdminHubHtml(snapshot, workflowPriorityQueue));
    } catch {
      res.type("html").send(buildRoyaltyAdminHubHtml({ recentWorkflows: [], statusSummary: [], recentStatusItems: [], recentGeneratedDocuments: [], attentionItems: [], syncFailures: [] } as any, []));
    }
  });

  router.get("/settings", (_req: Request, res: Response) => {
    res.type("html").send(buildSettingsAdminHubHtml());
  });

  router.get("/tools", (_req: Request, res: Response) => {
    res.type("html").send(buildToolsAdminHubHtml());
  });

  router.get("/orders/csv", (_req: Request, res: Response) => {
    res.type("html").send(buildCsvAdminHtml());
  });

  router.get("/settings/mapping", (_req: Request, res: Response) => {
    res.type("html").send(buildMappingAdminHtml());
  });

  router.get("/settings/workflow", (_req: Request, res: Response) => {
    res.type("html").send(buildWorkflowSettingsAdminHtml());
  });

  router.get("/workflow/stamp", (_req: Request, res: Response) => {
    res.type("html").send(buildStampAdminHtml());
  });

  router.get("/workflow/delivery", (_req: Request, res: Response) => {
    res.type("html").send(buildDeliveryAdminHtml());
  });

  router.get("/workflow/contracts", (_req: Request, res: Response) => {
    res.type("html").send(buildContractAdminHtml());
  });

  router.get("/workflow/royalty", (_req: Request, res: Response) => {
    res.type("html").send(buildRoyaltyAdminHtml());
  });

  router.get("/workflow/request-simulator", (req: Request, res: Response) => {
    const requestedType = String(req.query?.type ?? "").trim() as DocumentRequestType;
    res.type("html").send(buildRequestSimulatorAdminHtml(requestedType));
  });

  router.get("/workflow/orders/create", (req: Request, res: Response) => {
    const requestedType = String(req.query?.type ?? "").trim() as DocumentRequestType;
    const orderTypes = new Set<DocumentRequestType>(["purchase_order", "planning_order", "publishing_order"]);
    const resolvedType = orderTypes.has(requestedType) ? requestedType : "purchase_order";
    res.type("html").send(buildRequestSimulatorAdminHtml(resolvedType));
  });

  router.get("/api/workflow/resolve-launcher", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.query?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "Backlog課題キーを入力してください。" });
        return;
      }

      let summary = "";
      let issueTypeName = "";
      try {
        const issue = await backlog.getIssue(issueKey);
        summary = String(issue.summary ?? "").trim();
        issueTypeName = String(issue.issueType?.name ?? "").trim();
      } catch {
        // Backlog 参照に失敗しても、ランチャー自体は使えるように既定導線へフォールバックする。
      }

      const resolved = resolveAdminLauncherForIssueType(issueTypeName) ?? {
        path: "/admin/workflow/contracts",
        label: "契約書編集",
        workflowKind: "contracts" as const,
      };

      res.json({
        ok: true,
        issueKey,
        summary,
        issueTypeName,
        issueUrl: buildBacklogIssueUrl(issueKey) ?? "",
        recommendedPath: resolved.path,
        recommendedLabel: resolved.label,
        workflowKind: resolved.workflowKind,
        note: issueTypeName
          ? `種別「${issueTypeName}」として判定しました。`
          : "Backlog の種別判定ができなかったため、既定では契約書編集を開きます。",
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/system/restart", (_req: Request, res: Response) => {
    try {
      const repoRoot = path.resolve(__dirname, "../../");
      const scriptPath = path.join(repoRoot, "scripts", "restart-app.ps1");
      const child = spawn("powershell", [
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-RepoRoot",
        repoRoot,
        "-CurrentPid",
        String(process.pid),
      ], {
        cwd: repoRoot,
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      res.json({ ok: true, message: "再起動を開始しました。" });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/system/diagnostics", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      diagnostics: buildLocalWorkflowDiagnostics(getLocalRuntimeStatus()),
      updatedAt: new Date().toISOString(),
    });
  });

  router.post("/api/system/backlog-sync", async (_req: Request, res: Response) => {
    if (isManualBacklogSyncRunning) {
      res.status(409).json({
        ok: false,
        error: "Backlog 同期はすでに実行中です。",
      });
      return;
    }

    isManualBacklogSyncRunning = true;
    updateLocalComponentStatus("poller", {
      severity: "pending",
      detail: "Backlog 同期を手動実行しています。",
    });

    try {
      const summary = await runBacklogPollingOnce(optionalSlackClient);
      await createBacklogSyncRun({
        triggerSource: "admin-ui",
        status: "SUCCEEDED",
        issueCount: summary.issueCount,
        changedCount: summary.changedCount,
        processedCount: summary.processedCount,
        failedCount: summary.failedCount,
        bootstrapped: summary.bootstrapped,
      });
      updateLocalComponentStatus("poller", {
        severity: summary.failedCount > 0 ? "warning" : "ok",
        detail: summary.bootstrapped
          ? `Backlog 同期を完了しました。変更 ${summary.changedCount} 件、処理 ${summary.processedCount} 件、失敗 ${summary.failedCount} 件です。`
          : `Backlog の初回スナップショットを保存しました。対象 ${summary.issueCount} 件です。`,
        success: summary.failedCount === 0,
        meta: summary,
      });
      res.json({
        ok: true,
        summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await createBacklogSyncRun({
        triggerSource: "admin-ui",
        status: "FAILED",
        errorMessage: message,
      });
      updateLocalComponentStatus("poller", {
        severity: "error",
        detail: `Backlog 手動同期に失敗しました。${message}`,
        error: true,
      });
      res.status(503).json({
        ok: false,
        error: message,
      });
    } finally {
      isManualBacklogSyncRunning = false;
    }
  });

  router.get("/api/settings/mapping", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      activeProfileId: getActivePlanningImportProfileId(),
      activeProfile: getPlanningImportProfile(),
      profiles: getPlanningImportProfiles().map((profile) => ({
        id: profile.id,
        label: profile.label,
      })),
      settings: getPlanningImportSettings(),
    });
  });

  router.post("/api/settings/mapping", (req: Request, res: Response) => {
    try {
      const profile = savePlanningImportSettings({
        projectTitleSource: req.body?.projectTitleSource === "manual" ? "manual" : "filename",
        projectTitleManualValue: String(req.body?.projectTitleManualValue ?? "").trim(),
        requesterSlackUserIdColumn: String(req.body?.requesterSlackUserIdColumn ?? "").trim(),
        orderDateColumn: String(req.body?.orderDateColumn ?? "").trim(),
        vendorLookupColumn: String(req.body?.vendorLookupColumn ?? "").trim(),
        vendorCodeColumn: String(req.body?.vendorCodeColumn ?? "").trim(),
        itemNameColumn: String(req.body?.itemNameColumn ?? "").trim(),
        completionDateColumn: String(req.body?.completionDateColumn ?? "").trim(),
        completionDateFallbackColumn: String(req.body?.completionDateFallbackColumn ?? "").trim(),
        finalDeadlineColumn: String(req.body?.finalDeadlineColumn ?? "").trim(),
        quantityColumn: String(req.body?.quantityColumn ?? "").trim(),
        unitPriceColumn: String(req.body?.unitPriceColumn ?? "").trim(),
        paymentDateColumn: String(req.body?.paymentDateColumn ?? "").trim(),
        amountColumn: String(req.body?.amountColumn ?? "").trim(),
        amountFallbackColumn: String(req.body?.amountFallbackColumn ?? "").trim(),
        detailColumns: splitLines(req.body?.detailColumns),
        constants: {
          category: String(req.body?.category ?? "").trim(),
          payMethod: String(req.body?.payMethod ?? "").trim(),
          rightsLabel: String(req.body?.rightsLabel ?? "").trim(),
          transferFee: String(req.body?.transferFee ?? "").trim(),
          transferFeePayer: String(req.body?.transferFeePayer ?? "").trim(),
          deliveryDateLabel: String(req.body?.deliveryDateLabel ?? "").trim(),
          paymentDateLabel: String(req.body?.paymentDateLabel ?? "").trim(),
          finalDeadlineFallback: String(req.body?.finalDeadlineFallback ?? "").trim(),
        },
        defaults: {
          specialTerms: String(req.body?.defaultSpecialTerms ?? "").trim(),
          remarks: String(req.body?.defaultRemarks ?? "").trim(),
          acceptMethod: String(req.body?.defaultAcceptMethod ?? "").trim(),
          acceptReplyDueDate: String(req.body?.defaultAcceptReplyDueDate ?? "").trim(),
        },
      }, String(req.body?.profileId ?? "").trim() || undefined, true);
      res.json({
        ok: true,
        activeProfileId: profile.id,
        profile: {
          id: profile.id,
          label: profile.label,
        },
        settings: profile.settings,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/settings/mapping/active", (req: Request, res: Response) => {
    try {
      const profile = setActivePlanningImportProfile(String(req.body?.profileId ?? "").trim());
      res.json({
        ok: true,
        activeProfileId: profile.id,
        profile: {
          id: profile.id,
          label: profile.label,
        },
        settings: profile.settings,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/settings/workflow", (_req: Request, res: Response) => {
    Promise.all([listDepartmentWorkflowRules(), listStaffDepartments()])
      .then(([rules, departments]) => res.json({ ok: true, settings: getWorkflowSettings(), rules, departments }))
      .catch((error) => res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  });

  router.post("/api/settings/workflow", (req: Request, res: Response) => {
    try {
      const settings = saveWorkflowSettings({
        approverSlackId: String(req.body?.approverSlackId ?? "").trim(),
        stampOperatorSlackId: String(req.body?.stampOperatorSlackId ?? "").trim(),
        intakeChannelId: String(req.body?.intakeChannelId ?? "").trim(),
      });
      res.json({ ok: true, settings });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/settings/workflow/rules", async (req: Request, res: Response) => {
    try {
      const rule = await upsertDepartmentWorkflowRule({
        department: String(req.body?.department ?? "").trim(),
        postChannelId: emptyToUndefined(req.body?.postChannelId),
        approverSlackId: emptyToUndefined(req.body?.approverSlackId),
        stampOperatorSlackId: emptyToUndefined(req.body?.stampOperatorSlackId),
        managerSlackId: emptyToUndefined(req.body?.managerSlackId),
        isActive: req.body?.isActive !== false,
      });
      res.json({ ok: true, rule });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/settings/workflow/resolve", async (req: Request, res: Response) => {
    try {
      const slackUserId = String(req.query?.slackUserId ?? "").trim();
      const assignment = await previewWorkflowAssignmentForSlackUser(slackUserId || undefined);
      res.json({ ok: true, assignment });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/request-simulator/schema", (req: Request, res: Response) => {
    const type = String(req.query?.type ?? "").trim() as DocumentRequestType;
    const definition = getDocumentRequestDefinition(type);
    if (!definition) {
      res.status(404).json({ ok: false, error: "文書種別が見つかりません。" });
      return;
    }
    res.json({
      ok: true,
      definition,
      groups: getDocumentRequestFieldGroups(type),
    });
  });

  router.post("/api/workflow/request-simulator/validate", (req: Request, res: Response) => {
    const type = String(req.body?.type ?? "").trim() as DocumentRequestType;
    const definition = getDocumentRequestDefinition(type);
    if (!definition) {
      res.status(404).json({ ok: false, error: "文書種別が見つかりません。" });
      return;
    }
    const values = typeof req.body?.values === "object" && req.body?.values ? req.body.values as Record<string, string> : {};
    const errors = validateDocumentRequestValues(type, values);
    res.json({
      ok: true,
      definition,
      errorCount: errors.length,
      errors,
    });
  });

  router.post("/api/workflow/request-simulator/create", async (req: Request, res: Response) => {
    try {
      const type = String(req.body?.type ?? "").trim() as DocumentRequestType;
      const definition = getDocumentRequestDefinition(type);
      if (!definition) {
        res.status(404).json({ ok: false, error: "文書種別が見つかりません。" });
        return;
      }
      if (definition.workflowKind !== "primary") {
        res.status(400).json({ ok: false, error: "外部文書登録は主申請の文書種別のみ対応しています。" });
        return;
      }

      const values = normalizeRequestSimulatorValues(req.body?.values);
      const requesterSlackUserId = String(req.body?.requesterSlackUserId ?? "").trim();
      const summary = String(req.body?.summary ?? "").trim();
      const sourceMode = normalizeRequestSourceMode(req.body?.sourceMode);
      const externalDocumentUrl = String(req.body?.externalDocumentUrl ?? "").trim();
      const orderCsvText = String(req.body?.orderCsvText ?? "");
      const orderImportMode = req.body?.orderImportMode === "planning" ? "planning" : "generic";
      const orderSourceFileName = String(req.body?.orderSourceFileName ?? "").trim();
      const manualOrderItems = normalizeManualOrderItems(req.body?.manualOrderItems);
      const validationErrors = validateDocumentRequestValues(type, values);

      if (!requesterSlackUserId) {
        validationErrors.push({ fieldId: "requesterSlackUserId", message: "依頼者Slack IDは必須です。" });
      }
      if (!summary) {
        validationErrors.push({ fieldId: "summary", message: "案件概要は必須です。" });
      }

      const upload = normalizeUploadedFile(req.body?.uploadedFile);
      if (sourceMode !== "new" && !externalDocumentUrl && !upload) {
        validationErrors.push({ fieldId: "externalDocument", message: "締結済・交付済登録ではURLまたはファイルが必須です。" });
      }
      if ((type === "purchase_order" || type === "planning_order" || type === "publishing_order") && !orderCsvText.trim() && manualOrderItems.length === 0) {
        validationErrors.push({ fieldId: "orderCsvText", message: "発注書系は業務明細CSV/Excel取込または手入力明細が必須です。" });
      }
      if (manualOrderItems.length > 0) {
        for (const item of manualOrderItems) {
          if (!item.vendorCode) {
            validationErrors.push({ fieldId: "manualOrderItems", message: `手入力明細 ${item.no} 行目の登録番号は必須です。個人は執筆登録、法人は法人登録番号を入力してください。` });
          }
          if (!item.desc) {
            validationErrors.push({ fieldId: "manualOrderItems", message: `手入力明細 ${item.no} 行目の件名は必須です。` });
          }
          if (!item.dueDate) {
            validationErrors.push({ fieldId: "manualOrderItems", message: `手入力明細 ${item.no} 行目の納期は必須です。` });
          }
          if (!Number.isFinite(item.amount)) {
            validationErrors.push({ fieldId: "manualOrderItems", message: `手入力明細 ${item.no} 行目の金額を確認してください。` });
          }
          if (item.payMethod === "分割" && (!item.installmentCount || item.installmentCount < 2)) {
            validationErrors.push({ fieldId: "manualOrderItems", message: `手入力明細 ${item.no} 行目は分割支払のため、分割回数を2以上で入力してください。` });
          }
          if (item.payMethod === "サブスク" && (!item.subscriptionMonths || item.subscriptionMonths < 1)) {
            validationErrors.push({ fieldId: "manualOrderItems", message: `手入力明細 ${item.no} 行目はサブスク支払のため、期間(月)を入力してください。` });
          }
        }
      }

      if (validationErrors.length > 0) {
        res.status(400).json({ ok: false, error: "入力内容を確認してください。", errors: validationErrors });
        return;
      }

      const issueTypeId = await backlog.findIssueTypeIdByName(definition.backlogIssueTypeName);
      if (!issueTypeId) {
        throw new Error(`Backlog課題タイプが見つかりません: ${definition.backlogIssueTypeName}`);
      }

      const issue = await backlog.createIssue({
        summary: buildLegalRequestIssueSummary(summary, values.counterparty),
        description: buildAdminBacklogDescription({
          requesterSlackUserId,
          summary,
          sourceMode,
          type,
          definitionText: definition.text,
          values,
          externalDocumentUrl,
          uploadedFileName: upload?.name,
        }),
        issueTypeId,
        dueDate: values.desired_due_date || undefined,
        customFields: buildAdminBacklogCustomFields(type, definition.text, requesterSlackUserId, values),
      });

      const issueWithFields = await backlog.getIssue(issue.issueKey);
      const staff = await findStaffBySlackUserId(requesterSlackUserId);
      const resolvedDocumentNumber = await resolveIssueDocumentNumber(backlog, issueWithFields, {
        partyAName: staff?.partyAName ?? undefined,
        departmentCode: staff?.departmentCode ?? undefined,
      });
      if (process.env.BACKLOG_FIELD_CONTRACT_NO && !values.contract_number) {
        await backlog.updateCustomField(issue.issueKey, Number(process.env.BACKLOG_FIELD_CONTRACT_NO), resolvedDocumentNumber);
      }

      const finalizedValues: Record<string, string> = {
        ...values,
        contract_number: values.contract_number || resolvedDocumentNumber,
      };

      const legalRequest = await createLegalRequest({
        backlogIssueKey: issue.issueKey,
        slackUserId: requesterSlackUserId,
        contractType: type,
        counterparty: finalizedValues.counterparty,
        summary,
        deadline: finalizedValues.desired_due_date ? new Date(finalizedValues.desired_due_date) : undefined,
        notes: buildLegalRequestNotes(sourceMode, externalDocumentUrl, upload?.name),
      });

      let importedOrderItemsCount = 0;
      if ((type === "purchase_order" || type === "planning_order" || type === "publishing_order") && manualOrderItems.length > 0) {
        const csvTextFromManualItems = buildCsvFromManualOrderItems(manualOrderItems);
        const imported = await importOrderCsvForIssue({
          issue: issueWithFields,
          csvText: csvTextFromManualItems,
          mode: "generic",
          contractType: type,
          sourceFileName: orderSourceFileName || "manual-entry.csv",
          projectTitle: finalizedValues.project_title || summary,
          remarks: finalizedValues.remarks,
        });
        importedOrderItemsCount = imported.items.length;
      } else if ((type === "purchase_order" || type === "planning_order" || type === "publishing_order") && orderCsvText.trim()) {
        const imported = await importOrderCsvForIssue({
          issue: issueWithFields,
          csvText: orderCsvText,
          mode: orderImportMode,
          contractType: type,
          sourceFileName: orderSourceFileName,
          projectTitle: finalizedValues.project_title || summary,
          remarks: finalizedValues.remarks,
        });
        importedOrderItemsCount = imported.items.length;
      }

      let createdTrackingIssueCount = 0;
      if (type === "purchase_order" || type === "planning_order" || type === "publishing_order") {
        const trackingIssues = await ensureOrderItemTrackingIssues({
          parentIssue: issueWithFields,
          legalRequestId: legalRequest.id,
          summary,
          counterparty: finalizedValues.counterparty,
        });
        createdTrackingIssueCount = trackingIssues.createdCount;
      }

      await saveIssueDocumentDraft(issue.issueKey, buildImportedDocumentDraft(type, sourceMode, summary, finalizedValues));

      const documents: Array<{ name: string; url?: string; localPath?: string }> = [];
      if (externalDocumentUrl) {
        documents.push({
          name: sourceMode === "new" ? "reference_document" : `external_${sourceMode}_url`,
          url: externalDocumentUrl,
        });
      }
      if (upload) {
        const stored = await storeUploadedExternalDocument(issue.issueKey, sourceMode, upload);
        documents.push({
          name: stored.name,
          url: stored.url,
          localPath: stored.localPath,
        });
      }
      if (documents.length > 0) {
        await saveGeneratedDocuments(issue.issueKey, documents);
      }

      if (sourceMode !== "new") {
        const documentRefs = documents
          .map((doc) => doc.url || doc.localPath)
          .filter((value): value is string => Boolean(value));
        await backlog.addComment(
          issue.issueKey,
          [
            `外部文書登録: ${describeRequestSourceMode(sourceMode)}`,
            documentRefs.length ? `原本: ${documentRefs.join(" / ")}` : "",
          ].filter(Boolean).join("\n")
        );
      }

      res.json({
        ok: true,
        issueKey: issue.issueKey,
        issueUrl: buildBacklogIssueUrl(issue.issueKey),
        documentNumber: finalizedValues.contract_number,
        workflowMode: sourceMode,
        type,
        legalRequestId: legalRequest.id,
        importedOrderItemsCount,
        createdTrackingIssueCount,
        generatedDocuments: documents,
        nextActions: [
          {
            label: "Backlogで親課題を開く",
            href: buildBacklogIssueUrl(issue.issueKey) ?? "",
            external: true,
          },
          {
            label: "発注管理トップへ戻る",
            href: "/admin/orders",
            external: false,
          },
          ...((type === "purchase_order" || type === "planning_order" || type === "publishing_order")
            ? [
                {
                  label: "親課題で納品・検収を開く",
                  href: `/admin/workflow/delivery?parentIssueKey=${encodeURIComponent(issue.issueKey)}`,
                  external: false,
                },
              ]
            : []),
        ].filter((item) => item.href),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/masters/vendor", async (req: Request, res: Response) => {
    try {
      const vendor = await upsertVendor({
        vendorCode: String(req.body?.vendorCode ?? "").trim(),
        vendorName: String(req.body?.vendorName ?? "").trim(),
        tradeName: emptyToUndefined(req.body?.tradeName),
        penName: emptyToUndefined(req.body?.penName),
        vendorSuffix: String(req.body?.vendorSuffix ?? "御中").trim(),
        entityType: normalizeVendorEntityType(req.body?.entityType),
        withholdingEnabled: toBoolean(req.body?.withholdingEnabled),
        aliases: splitLines(req.body?.aliases),
        address: emptyToUndefined(req.body?.address),
        phone: emptyToUndefined(req.body?.phone),
        email: emptyToUndefined(req.body?.email),
        contactDepartment: emptyToUndefined(req.body?.contactDepartment),
        contactName: emptyToUndefined(req.body?.contactName),
        vendorRepresentative: emptyToUndefined(req.body?.vendorRepresentative),
        bankInfo: emptyToUndefined(req.body?.bankInfo),
        bankName: emptyToUndefined(req.body?.bankName),
        branchName: emptyToUndefined(req.body?.branchName),
        accountType: emptyToUndefined(req.body?.accountType),
        accountNumber: emptyToUndefined(req.body?.accountNumber),
        accountHolderKana: emptyToUndefined(req.body?.accountHolderKana),
        isInvoiceIssuer: toBoolean(req.body?.isInvoiceIssuer),
        invoiceRegistrationNumber: emptyToUndefined(req.body?.invoiceRegistrationNumber),
        masterContractRef: emptyToUndefined(req.body?.masterContractRef),
      });
      res.json({ ok: true, vendor });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/masters/vendor/import", async (req: Request, res: Response) => {
    try {
      const rows = parseMasterCsv(String(req.body?.csvText ?? ""));
      const results = [];
      for (const [index, row] of rows.entries()) {
        if (!String(row.vendorCode ?? "").trim() || !String(row.vendorName ?? "").trim()) {
          continue;
        }
        try {
          const vendor = await upsertVendor({
            vendorCode: String(row.vendorCode ?? "").trim(),
            vendorName: String(row.vendorName ?? "").trim(),
            tradeName: emptyToUndefined(row.tradeName),
            penName: emptyToUndefined(row.penName),
            vendorSuffix: String(row.vendorSuffix ?? "御中").trim(),
            entityType: normalizeVendorEntityType(row.entityType),
            withholdingEnabled: toBoolean(row.withholdingEnabled),
            aliases: splitDelimitedValues(row.aliases),
            address: emptyToUndefined(row.address),
            phone: emptyToUndefined(row.phone),
            email: emptyToUndefined(row.email),
            contactDepartment: emptyToUndefined(row.contactDepartment),
            contactName: emptyToUndefined(row.contactName),
            vendorRepresentative: emptyToUndefined(row.vendorRepresentative),
            bankInfo: emptyToUndefined(row.bankInfo),
            bankName: emptyToUndefined(row.bankName),
            branchName: emptyToUndefined(row.branchName),
            accountType: emptyToUndefined(row.accountType),
            accountNumber: emptyToUndefined(row.accountNumber),
            accountHolderKana: emptyToUndefined(row.accountHolderKana),
            isInvoiceIssuer: toBoolean(row.isInvoiceIssuer),
            invoiceRegistrationNumber: emptyToUndefined(row.invoiceRegistrationNumber),
            masterContractRef: emptyToUndefined(row.masterContractRef),
          });
          results.push({
            vendorCode: vendor.vendorCode,
            vendorName: vendor.vendorName,
          });
        } catch (error) {
          const rowNo = index + 2;
          const vendorCode = String(row.vendorCode ?? "").trim();
          throw new Error(`Vendor CSV ${rowNo}行目 (${vendorCode || "vendorCode未設定"}) の取込に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      res.json({ ok: true, count: results.length, vendors: results });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/masters/vendor", async (req: Request, res: Response) => {
    try {
      const vendors = await listVendors({
        query: String(req.query?.q ?? "").trim(),
        limit: Number(req.query?.limit ?? 50),
      });
      res.json({ ok: true, count: vendors.length, vendors });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/masters/vendor/sample.csv", (_req: Request, res: Response) => {
    sendUtf8BomCsv(res, "vendor-master-sample.csv", buildVendorSampleCsv());
  });

  router.get("/api/masters/vendor/:vendorCode", async (req: Request, res: Response) => {
    const vendor = await findVendorByCode(req.params.vendorCode);
    if (!vendor) {
      res.status(404).json({ ok: false, error: "Vendorが見つかりません。" });
      return;
    }
    res.json({ ok: true, vendor });
  });

  router.post("/api/masters/vendor/bootstrap", async (req: Request, res: Response) => {
    try {
      const parsed = parseOrderCsv(String(req.body?.csvText ?? ""), {
        mode: "planning",
        mappingProfileId: String(req.body?.mappingProfileId ?? ""),
        sourceFileName: String(req.body?.sourceFileName ?? ""),
        projectTitle: String(req.body?.projectTitle ?? ""),
      });
      const groups = parsed.planningContext?.groups ?? [];
      const results = [];
      for (const group of groups) {
        if (!group.vendorCode || !group.vendorLookupValue) continue;
        const vendor = await upsertVendor({
          vendorCode: group.vendorCode,
          vendorName: group.vendorLookupValue,
          entityType: "individual",
          aliases: [],
        });
        results.push({
          vendorCode: vendor.vendorCode,
          vendorName: vendor.vendorName,
        });
      }
      res.json({ ok: true, count: results.length, vendors: results });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/masters/staff", async (req: Request, res: Response) => {
    try {
      const staff = await upsertStaff({
        slackUserId: String(req.body?.slackUserId ?? "").trim(),
        staffName: String(req.body?.staffName ?? "").trim(),
        department: emptyToUndefined(req.body?.department),
        departmentCode: emptyToUndefined(req.body?.departmentCode),
        phone: emptyToUndefined(req.body?.phone),
        email: emptyToUndefined(req.body?.email),
        partyAName: emptyToUndefined(req.body?.partyAName),
        partyAAddress: emptyToUndefined(req.body?.partyAAddress),
        partyARep: emptyToUndefined(req.body?.partyARep),
      });
      res.json({ ok: true, staff });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/masters/staff/import", async (req: Request, res: Response) => {
    try {
      const rows = parseMasterCsv(String(req.body?.csvText ?? ""));
      const results = [];
      const warnings: string[] = [];
      for (const [index, row] of rows.entries()) {
        const normalizedRow = normalizeStaffCsvRow(row);
        const slackUserId = normalizeSlackUserId(normalizedRow.slackUserId);
        const staffName = String(normalizedRow.staffName ?? "").trim();
        if (!slackUserId || !staffName) {
          warnings.push(`Staff CSV ${index + 2}行目をスキップしました。slackUserId と staffName は必須です。`);
          continue;
        }
        try {
          const staff = await upsertStaff({
            slackUserId,
            staffName,
            department: emptyToUndefined(normalizedRow.department),
            departmentCode: emptyToUndefined(normalizedRow.departmentCode),
            phone: emptyToUndefined(normalizedRow.phone),
            email: emptyToUndefined(normalizedRow.email),
            partyAName: emptyToUndefined(normalizedRow.partyAName),
            partyAAddress: emptyToUndefined(normalizedRow.partyAAddress),
            partyARep: emptyToUndefined(normalizedRow.partyARep),
          });
          results.push({
            slackUserId: staff.slackUserId,
            staffName: staff.staffName,
            department: staff.department,
            departmentCode: staff.departmentCode,
          });
        } catch (error) {
          throw new Error(`Staff CSV ${index + 2}行目 (${slackUserId}) の取込に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      res.json({ ok: true, count: results.length, staffs: results, warnings });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/masters/staff", async (req: Request, res: Response) => {
    try {
      const staffs = await listStaff({
        query: String(req.query?.q ?? "").trim(),
        limit: Number(req.query?.limit ?? 50),
      });
      res.json({ ok: true, count: staffs.length, staffs });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/masters/staff/sample.csv", (_req: Request, res: Response) => {
    sendUtf8BomCsv(res, "staff-master-sample.csv", buildStaffSampleCsv());
  });

  router.get("/api/masters/staff/:slackUserId", async (req: Request, res: Response) => {
    const staff = await findStaffBySlackUserId(req.params.slackUserId);
    if (!staff) {
      res.status(404).json({ ok: false, error: "Staffが見つかりません。" });
      return;
    }
    res.json({ ok: true, staff });
  });

  router.post("/api/orders/csv/preview", async (req: Request, res: Response) => {
    try {
      const parsed = parseOrderCsv(String(req.body?.csvText ?? ""), {
        mode: req.body?.mode === "planning" ? "planning" : "generic",
        mappingProfileId: String(req.body?.mappingProfileId ?? ""),
        sourceFileName: String(req.body?.sourceFileName ?? ""),
        projectTitle: String(req.body?.projectTitle ?? ""),
        specialTerms: String(req.body?.specialTerms ?? ""),
        remarks: String(req.body?.remarks ?? ""),
        acceptMethod: String(req.body?.acceptMethod ?? ""),
        acceptReplyDueDate: String(req.body?.acceptReplyDueDate ?? ""),
      });
      const vendorStatuses = await buildVendorStatuses(parsed);
      const warnings = collectPreviewWarnings(parsed, vendorStatuses);
      res.json({
        ok: true,
        count: parsed.items.length,
        items: parsed.items,
        mode: parsed.mode,
        planningContext: parsed.planningContext,
        vendorStatuses,
        warnings,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/orders/csv/headers", (req: Request, res: Response) => {
    try {
      const headers = extractCsvHeaders(String(req.body?.csvText ?? ""));
      res.json({ ok: true, headers });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/orders/csv/sample/:profileId.csv", (req: Request, res: Response) => {
    const profileId = String(req.params?.profileId ?? "").trim();
    const sample = getOrderCsvSample(profileId);
    sendUtf8BomCsv(res, sample.fileName, sample.csv + "\n");
  });

  router.get("/api/orders/csv/variables/:profileId.csv", (req: Request, res: Response) => {
    const profileId = String(req.params?.profileId ?? "").trim();
    const mapping = getOrderCsvVariableMap(profileId);
    sendUtf8BomCsv(res, mapping.fileName, mapping.csv + "\n");
  });

  router.get("/api/workflow/delivery/variables.csv", (_req: Request, res: Response) => {
    const mapping = getInspectionVariableMap();
    sendUtf8BomCsv(res, mapping.fileName, mapping.csv + "\n");
  });

  router.post("/api/orders/xlsx/sheets", (req: Request, res: Response) => {
    try {
      const sheets = listWorkbookSheetsFromBase64(String(req.body?.fileBase64 ?? ""));
      res.json({ ok: true, sheets });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/orders/xlsx/to-csv", (req: Request, res: Response) => {
    try {
      const result = convertWorkbookSheetToCsv({
        base64: String(req.body?.fileBase64 ?? ""),
        sheetName: String(req.body?.sheetName ?? ""),
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/orders/csv/import", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "Backlog課題キーを入力してください。" });
        return;
      }

      const issue = await backlog.getIssue(issueKey);
      if (!issue.issueType || !["発注書", "企画発注書"].includes(issue.issueType.name)) {
        res.status(400).json({
          ok: false,
          error: `対象課題タイプではありません: ${issue.issueType?.name ?? "未設定"}`,
        });
        return;
      }

      const parsed = parseOrderCsv(String(req.body?.csvText ?? ""), {
        mode: req.body?.mode === "planning" ? "planning" : "generic",
        mappingProfileId: String(req.body?.mappingProfileId ?? ""),
        sourceFileName: String(req.body?.sourceFileName ?? ""),
        projectTitle: String(req.body?.projectTitle ?? ""),
        specialTerms: String(req.body?.specialTerms ?? ""),
        remarks: String(req.body?.remarks ?? ""),
        acceptMethod: String(req.body?.acceptMethod ?? ""),
        acceptReplyDueDate: String(req.body?.acceptReplyDueDate ?? ""),
      });
      const vendorStatuses = await buildVendorStatuses(parsed);
      const importWarnings = collectPreviewWarnings(parsed, vendorStatuses);
      const blockingWarnings = importWarnings.filter((warning) => warning.severity === "blocking");
      if (blockingWarnings.length > 0) {
        res.status(400).json({
          ok: false,
          error: `取込を中止しました: ${blockingWarnings.map((warning) => warning.message).join(" / ")}`,
          warnings: importWarnings,
        });
        return;
      }

      const imported = await importOrderCsvForIssue({
        issue,
        csvText: String(req.body?.csvText ?? ""),
        mode: req.body?.mode === "planning" ? "planning" : "generic",
        mappingProfileId: String(req.body?.mappingProfileId ?? ""),
        sourceFileName: String(req.body?.sourceFileName ?? ""),
        projectTitle: String(req.body?.projectTitle ?? ""),
        specialTerms: String(req.body?.specialTerms ?? ""),
        remarks: String(req.body?.remarks ?? ""),
        acceptMethod: String(req.body?.acceptMethod ?? ""),
        acceptReplyDueDate: String(req.body?.acceptReplyDueDate ?? ""),
      });

      const legalRequest = await findLegalRequestByBacklogKey(issue.issueKey);
      const trackingIssues = legalRequest
        ? await ensureOrderItemTrackingIssues({
            parentIssue: issue,
            legalRequestId: legalRequest.id,
            summary: legalRequest.summary,
            counterparty: legalRequest.counterparty,
          })
        : { createdCount: 0, updatedCount: 0 };

      const generateDocuments = Boolean(req.body?.generateDocuments);
      if (generateDocuments) {
        await generateOrderDocumentsFromIssue(issue);
      }

      res.json({
        ok: true,
        issueKey,
        importedCount: imported.items.length,
        createdTrackingIssueCount: trackingIssues.createdCount,
        generated: generateDocuments,
        mode: imported.mode,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/stamp", async (_req: Request, res: Response) => {
    const workflows = await listStampWorkflows();
    res.json({
      ok: true,
      workflows: workflows.map((workflow) => ({
        issueKey: workflow.backlogIssueKey,
        issueTypeName: workflow.issueTypeName,
        summary: workflow.currentSummary,
        currentStatusName: workflow.currentStatusName,
        stampType: workflow.stampType,
        stampRequestedAt: workflow.stampRequestedAt,
        stampedAt: workflow.stampedAt,
        stampedDriveUrl: workflow.stampedDriveUrl,
        esignCompletedAt: workflow.esignCompletedAt,
        esignDriveUrl: workflow.esignDriveUrl,
        stampRejectedAt: workflow.stampRejectedAt,
        stampRejectedReason: workflow.stampRejectedReason,
        stampOperatorSlackId: workflow.stampOperatorSlackId,
      })),
    });
  });

  router.post("/api/workflow/stamp/request", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "Backlog課題キーを入力してください。" });
        return;
      }

      const issue = await backlog.getIssue(issueKey);
      await sendStampRequest(slack, issue, String(req.body?.primaryDocumentUrl ?? "").trim() || undefined);
      res.json({ ok: true, issueKey });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/stamp/type", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      const stampType = req.body?.stampType === "ELECTRONIC" ? "ELECTRONIC" : "PHYSICAL";
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "Backlog課題キーを入力してください。" });
        return;
      }
      await chooseStampType(issueKey, stampType);
      res.json({ ok: true, issueKey, stampType });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/stamp/complete", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      const stampType = req.body?.stampType === "ELECTRONIC" ? "ELECTRONIC" : "PHYSICAL";
      const documentUrl = String(req.body?.documentUrl ?? "").trim();
      if (!issueKey || !documentUrl) {
        res.status(400).json({ ok: false, error: "Backlog課題キーと押印済みURLを入力してください。" });
        return;
      }
      await completeStamp(slack, issueKey, {
        stampType,
        documentUrl,
        completedBySlackId: String(req.body?.completedBySlackId ?? "").trim() || undefined,
      });
      res.json({ ok: true, issueKey, stampType, documentUrl });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/stamp/reject", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      const rejectedReason = String(req.body?.rejectedReason ?? "").trim();
      if (!issueKey || !rejectedReason) {
        res.status(400).json({ ok: false, error: "Backlog課題キーと差戻し理由を入力してください。" });
        return;
      }
      await rejectStamp(
        slack,
        issueKey,
        rejectedReason,
        String(req.body?.completedBySlackId ?? "").trim() || undefined
      );
      res.json({ ok: true, issueKey, rejectedReason });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/delivery/generate", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "納品課題キーを入力してください。" });
        return;
      }

      const issue = await backlog.getIssue(issueKey);
      const parentIssueKey = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PARENT_ISSUE_KEY);
      const deliveredAmount = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DELIVERED_AMOUNT);
      const finalDeadline = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_FINAL_DEADLINE) || issue.dueDate || null;
      const inspectionDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_INSPECTION_DATE) || null;
      const paymentPlannedDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PAYMENT_PLANNED_DATE) || null;
      const deliveryEvent = await findDeliveryEventByBacklogIssueKey(issueKey);
      if (!deliveryEvent) {
        res.status(404).json({ ok: false, error: "DeliveryEvent が見つかりません。先に納品受付を行ってください。" });
        return;
      }

      const parentCondition = parentIssueKey
        ? await loadParentOrderConditionFieldsForAdmin(parentIssueKey)
        : undefined;
      const warnings = buildDeliveryPreviewWarnings({
        mode: "generate",
        parentIssueKey,
        deliveredAmount,
        finalDeadline,
        inspectionDate,
        paymentPlannedDate,
        hasDeliveryEvent: Boolean(deliveryEvent),
        paymentCondition: parentCondition ?? null,
      });
      if (warnings.some((warning) => warning.level === "stop")) {
        res.status(400).json({
          ok: false,
          error: "事前チェックで停止項目があります。",
          warnings,
        });
        return;
      }

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
        vendorInvoiceNum: parentCondition?.vendorInvoiceNum,
      });

      await saveGeneratedDocuments(issueKey, [
        { name: "inspection_cert", url: inspectionCert.driveUrl, localPath: inspectionCert.localPath },
        ...(paymentNotice ? [{ name: "payment_notice", url: paymentNotice.driveUrl, localPath: paymentNotice.localPath }] : []),
      ]);

      const statusSync = await syncDeliveryIssueStatusToCompleted(issueKey);
      if (!statusSync.ok && statusSync.error) {
        await backlog.addComment(issueKey, `⚠️ 検収書生成後のステータス更新に失敗しました。${statusSync.error}`);
      }

      res.json({
        ok: true,
        issueKey,
        parentIssueKey,
        finalDeadline,
        inspectionDate,
        paymentPlannedDate,
        inspectionCert,
        paymentNotice: paymentNotice ?? null,
        paymentCondition: parentCondition ?? null,
        generationReport: buildDeliveryGenerationReport({
          inspectionCert,
          paymentNotice: paymentNotice ?? null,
          statusUpdatedTo: statusSync.ok ? statusSync.statusName : null,
          statusSyncError: statusSync.ok ? null : statusSync.error ?? "Backlogステータス更新に失敗しました。",
        }),
        nextActions: buildDeliveryNextActions({
          paymentNotice: paymentNotice ?? null,
        }),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/delivery/preview", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.query?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "納品課題キーを入力してください。" });
        return;
      }

      const issue = await backlog.getIssue(issueKey);
      const parentIssueKey = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PARENT_ISSUE_KEY);
      const itemNo = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_ITEM_NO);
      const deliveredAmount = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DELIVERED_AMOUNT);
      const deliveryNote = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DELIVERY_NOTE);
      const finalDeadline = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_FINAL_DEADLINE) || issue.dueDate || null;
      const inspectionDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_INSPECTION_DATE) || null;
      const paymentPlannedDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PAYMENT_PLANNED_DATE) || null;
      const deliveryEvent = await findDeliveryEventByBacklogIssueKey(issueKey);
      const workflow = await findIssueWorkflowByIssueKey(issueKey);
      const parentCondition = parentIssueKey
        ? await loadParentOrderConditionFieldsForAdmin(parentIssueKey)
        : undefined;
      const warnings = buildDeliveryPreviewWarnings({
        mode: "generate",
        parentIssueKey,
        deliveredAmount,
        finalDeadline,
        inspectionDate,
        paymentPlannedDate,
        hasDeliveryEvent: Boolean(deliveryEvent),
        paymentCondition: parentCondition ?? null,
      });
      const previewReport = await buildDeliveryPreviewReport({
        deliveryEventId: deliveryEvent?.id,
        parentIssueKey,
      });

      res.json({
        ok: true,
        issueKey,
        parentIssueKey,
        itemNo,
        deliveredAmount,
        deliveryNote,
        finalDeadline,
        inspectionDate,
        paymentPlannedDate,
        hasDeliveryEvent: Boolean(deliveryEvent),
        generatedDocuments: Array.isArray(workflow?.generatedDocuments) ? workflow?.generatedDocuments : [],
        paymentCondition: parentCondition ?? null,
        previewReport,
        preflight: buildDeliveryPreflight({
          issueKey,
          parentIssueKey,
          hasDeliveryEvent: Boolean(deliveryEvent),
          deliveredAmount,
          finalDeadline,
          inspectionDate,
          paymentPlannedDate,
          paymentCondition: parentCondition ?? null,
          warnings,
        }),
        warnings,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/delivery/attention", async (_req: Request, res: Response) => {
    try {
      const issues = await backlog.getRecentIssues(20);
      const attentionItems = await Promise.all(
        issues
          .filter((issue) => getDeliveryIssueTypeNames().has(issue.issueType?.name ?? ""))
          .slice(0, 10)
          .map(async (issue) => {
            const parentIssueKey = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PARENT_ISSUE_KEY);
            const deliveredAmount = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DELIVERED_AMOUNT);
            const finalDeadline = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_FINAL_DEADLINE) || issue.dueDate || null;
            const inspectionDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_INSPECTION_DATE) || null;
            const paymentPlannedDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PAYMENT_PLANNED_DATE) || null;
            const deliveryEvent = await findDeliveryEventByBacklogIssueKey(issue.issueKey);
            const parentCondition = parentIssueKey
              ? await loadParentOrderConditionFieldsForAdmin(parentIssueKey)
              : undefined;
            const warnings = buildDeliveryPreviewWarnings({
              mode: "tracking",
              parentIssueKey,
              deliveredAmount,
              finalDeadline,
              inspectionDate,
              paymentPlannedDate,
              hasDeliveryEvent: Boolean(deliveryEvent),
              paymentCondition: parentCondition ?? null,
            });
            const blockingCount = warnings.filter((warning) => warning.level === "stop").length;
            const warningCount = warnings.filter((warning) => warning.level === "warn").length;
            return {
              issueKey: issue.issueKey,
              summary: issue.summary,
              statusName: issue.status?.name ?? "",
              severity: blockingCount > 0 ? "stop" : warningCount > 0 ? "warn" : "ready",
              blockingCount,
              warningCount,
              topMessage: warnings[0]?.message ?? "停止項目・注意項目はありません。",
            };
          }),
      );

      res.json({
        ok: true,
        issues: attentionItems
          .filter((item) => item.severity !== "ready")
          .sort((a, b) => {
            const rank = (value: string) => value === "stop" ? 0 : value === "warn" ? 1 : 2;
            return rank(a.severity) - rank(b.severity);
          }),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/delivery/bulk/preview", async (req: Request, res: Response) => {
    try {
      const parentIssueKey = String(req.query?.parentIssueKey ?? "").trim().toUpperCase();
      if (!parentIssueKey) {
        res.status(400).json({ ok: false, error: "親発注課題キーを入力してください。" });
        return;
      }

      const legalRequest = await findLegalRequestByBacklogKey(parentIssueKey);
      if (!legalRequest) {
        res.status(404).json({ ok: false, error: `親課題 ${parentIssueKey} がDBに見つかりません。先に発注書または企画発注書を取り込んでください。` });
        return;
      }

      const paymentCondition = await loadParentOrderConditionFieldsForAdmin(parentIssueKey);
      const items = await getOrderItems(legalRequest.id);
      res.json({
        ok: true,
        parentIssueKey,
        summary: legalRequest.summary,
        counterparty: legalRequest.counterparty,
        paymentCondition: paymentCondition ?? null,
        items: items.map((item) => {
          const deliveredAmountTotal = item.deliveryEvents.reduce((sum, event) => sum + (event.deliveredAmount ?? item.latestAmount), 0);
          const latestDelivery = item.deliveryEvents[item.deliveryEvents.length - 1] ?? null;
          return {
            itemNo: item.itemNo,
            orderItemId: item.id,
            backlogIssueKey: item.backlogIssueKey ?? null,
            backlogIssueUrl: item.backlogIssueKey ? (buildBacklogIssueUrl(item.backlogIssueKey) ?? null) : null,
            description: item.description,
            spec: item.spec ?? "",
            vendorCode: item.vendorCode ?? "",
            latestAmount: item.latestAmount,
            latestDueDate: item.latestDueDate,
            status: item.status,
            deliveryEventCount: item.deliveryEvents.length,
            deliveredAmountTotal,
            latestDeliveryIssueKey: latestDelivery?.backlogIssueKey ?? null,
            latestInspectionCertUrl: latestDelivery?.inspectionCertUrl ?? null,
          };
        }),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/delivery/bulk/create", async (req: Request, res: Response) => {
    try {
      const parentIssueKey = String(req.body?.parentIssueKey ?? "").trim().toUpperCase();
      const generateDocuments = req.body?.generateDocuments === true;
      const selections = Array.isArray(req.body?.items) ? req.body.items : [];
      const inspectionCsvText = String(req.body?.inspectionCsvText ?? "");
      const mappingProfileId = String(req.body?.mappingProfileId ?? "").trim();
      if (!parentIssueKey) {
        res.status(400).json({ ok: false, error: "親発注課題キーを入力してください。" });
        return;
      }
      if (!selections.length) {
        res.status(400).json({ ok: false, error: "対象明細を1件以上選択してください。" });
        return;
      }

      const legalRequest = await findLegalRequestByBacklogKey(parentIssueKey);
      if (!legalRequest) {
        res.status(404).json({ ok: false, error: `親課題 ${parentIssueKey} がDBに見つかりません。先に発注書または企画発注書を取り込んでください。` });
        return;
      }

      const paymentCondition = await loadParentOrderConditionFieldsForAdmin(parentIssueKey);
      const orderItems = await getOrderItems(legalRequest.id);
      const orderItemMap = new Map(orderItems.map((item) => [item.itemNo, item]));
      const inspectionMetadataMap = generateDocuments
        ? buildInspectionMetadataMap(inspectionCsvText, mappingProfileId)
        : new Map<number, { inspectionDate?: string; paymentPlannedDate?: string }>();
      const results = [];
      const failedResults = [];

      for (const rawSelection of selections) {
        let itemNo = parseInt(String(rawSelection?.itemNo ?? ""), 10);
        let orderItem = Number.isFinite(itemNo) ? orderItemMap.get(itemNo) : undefined;
        let issueKey: string | null = null;
        let issueUrl: string | null = null;
        let deliveredAmount = 0;
        let inspectionDate: string | null = null;
        let paymentPlannedDate: string | null = null;
        let inspectionCert: { filename: string; localPath: string; driveUrl?: string } | null = null;
        let paymentNotice: { filename: string; localPath: string; driveUrl?: string } | null = null;
        try {
          if (!Number.isFinite(itemNo)) {
            throw new Error("明細番号の形式が不正です。");
          }
          if (!orderItem) {
            throw new Error(`明細番号 ${itemNo} が ${parentIssueKey} に見つかりません。`);
          }

          deliveredAmount = parseOptionalYen(rawSelection?.deliveredAmount) ?? orderItem.latestAmount;
          if (deliveredAmount <= 0) {
            throw new Error(`明細番号 ${itemNo} の今回納品金額が不正です。`);
          }

          const deliveryNote = String(rawSelection?.deliveryNote ?? "").trim();
          const finalDeadline = formatDateInput(orderItem.latestDueDate);
          const inspectionMetadata = inspectionMetadataMap.get(orderItem.itemNo);
          inspectionDate = inspectionMetadata?.inspectionDate ?? null;
          paymentPlannedDate = inspectionMetadata?.paymentPlannedDate ?? null;
          const trackingIssue = await upsertOrderItemTrackingIssue({
            parentIssueKey,
            parentSummary: legalRequest.summary,
            counterparty: legalRequest.counterparty,
            orderItem,
          });
          issueKey = trackingIssue.issueKey;
          issueUrl = trackingIssue.issueUrl;

          await backlog.updateIssue(trackingIssue.issueKey, {
            summary: buildBulkDeliveryIssueSummary(parentIssueKey, orderItem.itemNo, orderItem.description),
            description: buildBulkDeliveryIssueDescription({
              parentIssueKey,
              summary: legalRequest.summary,
              counterparty: legalRequest.counterparty,
              itemNo: orderItem.itemNo,
              description: orderItem.description,
              spec: orderItem.spec ?? "",
              deliveredAmount,
              deliveryNote,
            }),
            dueDate: formatDateInput(orderItem.latestDueDate) ?? undefined,
            customFields: sanitizeAdminCustomFieldEntries({
              [process.env.BACKLOG_FIELD_CONTRACT_TYPE ?? ""]: "納品リクエスト",
              [process.env.BACKLOG_FIELD_COUNTERPARTY ?? ""]: legalRequest.counterparty,
              [process.env.BACKLOG_FIELD_PARENT_ISSUE_KEY ?? ""]: parentIssueKey,
              [process.env.BACKLOG_FIELD_ITEM_NO ?? ""]: String(orderItem.itemNo),
              [process.env.BACKLOG_FIELD_ITEM_NAME ?? ""]: orderItem.description,
              [process.env.BACKLOG_FIELD_DELIVERED_AMOUNT ?? ""]: String(deliveredAmount),
              [process.env.BACKLOG_FIELD_DELIVERY_NOTE ?? ""]: deliveryNote,
              [process.env.BACKLOG_FIELD_FINAL_DEADLINE ?? ""]: finalDeadline ?? "",
              [process.env.BACKLOG_FIELD_INSPECTION_DATE ?? ""]: inspectionDate ?? "",
              [process.env.BACKLOG_FIELD_PAYMENT_PLANNED_DATE ?? ""]: paymentPlannedDate ?? "",
            }),
          });

          const latestDeliveryEvent = orderItem.deliveryEvents[orderItem.deliveryEvents.length - 1] ?? null;
          const deliveryEvent = latestDeliveryEvent ?? await createDeliveryEvent({
            backlogIssueKey: trackingIssue.issueKey,
            orderItemId: orderItem.id,
            deliveredAt: new Date(),
            deliveredAmount,
            inspectionDays: paymentCondition?.inspectionDays ?? 7,
            note: deliveryNote || undefined,
          });

          let statusUpdatedTo: string | null = null;
          let statusSyncError: string | null = null;
          if (generateDocuments) {
            if (!inspectionDate) {
              throw new Error(`明細番号 ${itemNo} の検収日がCSVにありません。検収日入りの同じCSVをアップロードしてください。`);
            }
            const generated = await generateDeliveryDocuments({
              deliveryEventId: deliveryEvent.id,
              inspectedAt: parseDateInputToDate(inspectionDate),
              paymentCondition: {
                closingDay: paymentCondition?.closingDay ?? "末日",
                paymentMonthOffset: paymentCondition?.paymentOffset ?? "1",
                paymentDay: paymentCondition?.paymentDay ?? "末日",
                inspectionDays: paymentCondition?.inspectionDays ?? 7,
                taxRate: paymentCondition?.taxRate ?? 10,
              },
              person: {
                name: process.env.LEGAL_STAFF_NAME ?? "倉持 達也",
                department: "法務部",
              },
              vendorInvoiceNum: paymentCondition?.vendorInvoiceNum,
            });
            inspectionCert = generated.inspectionCert;
            paymentNotice = generated.paymentNotice ?? null;
            await saveGeneratedDocuments(trackingIssue.issueKey, [
              { name: "inspection_cert", url: inspectionCert.driveUrl, localPath: inspectionCert.localPath },
              ...(paymentNotice ? [{ name: "payment_notice", url: paymentNotice.driveUrl, localPath: paymentNotice.localPath }] : []),
            ]);
            await backlog.addComment(
              trackingIssue.issueKey,
              buildBulkDeliveryGeneratedComment({
                parentIssueKey,
                itemNo: orderItem.itemNo,
                inspectionCert,
                paymentNotice,
              }),
            );

            const statusSync = await syncDeliveryIssueStatusToCompleted(trackingIssue.issueKey);
            if (statusSync.ok) {
              statusUpdatedTo = statusSync.statusName;
            } else {
              statusSyncError = statusSync.error ?? "Backlogステータス更新に失敗しました。";
              await backlog.addComment(trackingIssue.issueKey, `⚠️ 検収書生成後のステータス更新に失敗しました。${statusSyncError}`);
            }
          }

          const resultEntry = {
            issueKey: trackingIssue.issueKey,
            issueUrl,
            itemNo: orderItem.itemNo,
            description: orderItem.description,
            deliveredAmount,
            inspectionDate,
            paymentPlannedDate,
            inspectionCert,
            paymentNotice,
            statusUpdatedTo,
            statusSyncError,
          };

          if (statusSyncError) {
            failedResults.push({
              ...resultEntry,
              error: statusSyncError,
            });
            continue;
          }

          results.push(resultEntry);
        } catch (error) {
          failedResults.push({
            issueKey,
            issueUrl,
            itemNo: Number.isFinite(itemNo) ? itemNo : null,
            description: orderItem?.description ?? "",
            deliveredAmount: deliveredAmount || null,
            inspectionDate,
            paymentPlannedDate,
            inspectionCert,
            paymentNotice,
            statusUpdatedTo: null,
            statusSyncError: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      res.json({
        ok: true,
        parentIssueKey,
        generateDocuments,
        count: results.length,
        createdCount: results.length,
        failedCount: failedResults.length,
        results,
        failedResults,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/contracts/preview", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.query?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "契約課題キーを入力してください。" });
        return;
      }

      const issue = await backlog.getIssue(issueKey);
      const { draft, warnings, workflow, legalRequest, staff, vendor } = await buildContractDraft(issueKey, issue);
      const issueTypeName = issue.issueType?.name ?? "";
      if (!issueTypeName) {
        warnings.push({ level: "stop", message: "課題タイプが取得できません。" });
      }
      if (!issue.customFields?.length) {
        warnings.push({ level: "warn", message: "カスタム属性が取得できていません。" });
      }
      const preflight = await buildContractPreflight({
        issueKey,
        issue,
        issueTypeName,
        draft,
        warnings,
        workflow,
        legalRequest,
        staff,
        vendor,
      });

      res.json({
        ok: true,
        issueKey,
        summary: issue.summary,
        issueTypeName,
        statusName: issue.status?.name ?? "",
        customFieldCount: issue.customFields?.length ?? 0,
        editorGuide: getContractEditorGuide(issueTypeName),
        draft,
        sections: Array.from(new Set(CONTRACT_DRAFT_FIELDS.map((field) => field.section))),
        fields: CONTRACT_DRAFT_FIELDS,
        visibleFieldKeys: getContractDraftFieldKeysForIssueType(issueTypeName),
        draftUpdatedAt: workflow?.documentDraftUpdatedAt ?? null,
        staffSource: staff ? { slackUserId: staff.slackUserId, staffName: staff.staffName, department: staff.department ?? "", departmentCode: staff.departmentCode ?? "" } : null,
        vendorSource: vendor ? { vendorCode: vendor.vendorCode, vendorName: vendor.vendorName } : null,
        moneyConditionSummaries: buildLicenseMoneyConditionSummaries(draft),
        generatedDocuments: Array.isArray(workflow?.generatedDocuments) ? workflow.generatedDocuments : [],
        preflight,
        warnings,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/contracts/recent", async (_req: Request, res: Response) => {
    try {
      const issues = await backlog.getRecentIssues(20);
      const contractIssueNames = getContractIssueTypeNames();
      const recentContracts = issues
        .filter((issue) => contractIssueNames.has(issue.issueType?.name ?? ""))
        .slice(0, 10)
        .map((issue) => ({
          issueKey: issue.issueKey,
          summary: issue.summary,
          issueTypeName: issue.issueType?.name ?? "",
          statusName: issue.status?.name ?? "",
          updated: issue.updated,
        }));

      res.json({ ok: true, issues: recentContracts });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/contracts/attention", async (_req: Request, res: Response) => {
    try {
      const issues = await backlog.getRecentIssues(20);
      const contractIssueNames = getContractIssueTypeNames();
      const candidates = issues
        .filter((issue) => contractIssueNames.has(issue.issueType?.name ?? ""))
        .slice(0, 10);

      const attentionItems = await Promise.all(candidates.map(async (issue) => {
        const preview = await buildContractDraft(issue.issueKey, issue);
        const issueTypeName = issue.issueType?.name ?? "";
        const warnings = [...preview.warnings];
        if (!issueTypeName) {
          warnings.push({ level: "stop", message: "課題タイプが取得できません。" });
        }
        if (!issue.customFields?.length) {
          warnings.push({ level: "warn", message: "カスタム属性が取得できていません。" });
        }
        const blockingCount = warnings.filter((warning) => warning.level === "stop").length;
        const warningCount = warnings.filter((warning) => warning.level === "warn").length;
        const severity = blockingCount > 0 ? "stop" : warningCount > 0 ? "warn" : "ready";
        return {
          issueKey: issue.issueKey,
          summary: issue.summary,
          issueTypeName,
          statusName: issue.status?.name ?? "",
          updated: issue.updated,
          severity,
          blockingCount,
          warningCount,
          topMessage: warnings[0]?.message ?? "停止項目・注意項目はありません。",
        };
      }));

      res.json({
        ok: true,
        issues: attentionItems
          .filter((item) => item.severity !== "ready")
          .sort((a, b) => {
            const rank = (value: string) => value === "stop" ? 0 : value === "warn" ? 1 : 2;
            return rank(a.severity) - rank(b.severity);
          }),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/contracts/draft", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "契約課題キーを入力してください。" });
        return;
      }

      const incomingDraft = typeof req.body?.draft === "object" && req.body?.draft
        ? normalizeContractDraft(req.body.draft)
        : {};
      const saved = await saveIssueDocumentDraft(issueKey, incomingDraft);
      res.json({
        ok: true,
        issueKey,
        draft: normalizeContractDraft(saved.documentDraft),
        draftUpdatedAt: saved.documentDraftUpdatedAt,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/contracts/preflight", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "契約課題キーを入力してください。" });
        return;
      }

      const incomingDraft = typeof req.body?.draft === "object" && req.body?.draft
        ? normalizeContractDraft(req.body.draft)
        : {};
      const issue = await backlog.getIssue(issueKey);
      const preview = await buildContractDraft(issueKey, issue);
      const mergedDraft = { ...preview.draft, ...incomingDraft };
      const warnings = buildContractWarnings({
        issueTypeName: issue.issueType?.name ?? "",
        draft: mergedDraft,
        hasVendorMatch: Boolean(preview.vendor),
      });
      if (!issue.issueType?.name) {
        warnings.push({ level: "stop", message: "課題タイプが取得できません。" });
      }
      if (!issue.customFields?.length) {
        warnings.push({ level: "warn", message: "カスタム属性が取得できていません。" });
      }

      const preflight = await buildContractPreflight({
        issueKey,
        issue,
        issueTypeName: issue.issueType?.name ?? "",
        draft: mergedDraft,
        warnings,
        workflow: preview.workflow,
        legalRequest: preview.legalRequest,
        staff: preview.staff,
        vendor: preview.vendor,
      });

      res.json({
        ok: true,
        issueKey,
        draft: mergedDraft,
        warnings,
        preflight,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/contracts/render-preview", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "契約課題キーを入力してください。" });
        return;
      }

      const incomingDraft = typeof req.body?.draft === "object" && req.body?.draft
        ? normalizeContractDraft(req.body.draft)
        : {};

      const issue = await backlog.getIssue(issueKey);
      const issueTypeName = issue.issueType?.name ?? "";
      if (!issueTypeName) {
        res.status(400).json({ ok: false, error: "課題タイプが取得できません。" });
        return;
      }

      const preview = await buildContractDraft(issueKey, issue);
      const mergedDraft = { ...preview.draft, ...incomingDraft };
      const warnings = buildContractWarnings({
        issueTypeName,
        draft: mergedDraft,
        hasVendorMatch: Boolean(preview.vendor),
      });
      if (warnings.some((warning) => warning.level === "stop")) {
        res.status(400).json({
          ok: false,
          error: "事前チェックで停止項目があります。",
          warnings,
        });
        return;
      }

      const renderItems = await buildRenderItemsForIssue(issueKey, issueTypeName, {
        keyId: issue.id,
        summary: issue.summary,
        status: issue.status,
        issueType: issue.issueType,
        customFields: issue.customFields,
        created: issue.created,
        updated: issue.updated,
      }, mergedDraft);

      const previews = renderItems.map((item) => ({
        templateKey: item.templateKey,
        outputBasename: item.outputBasename,
        driveFolderKey: item.driveFolderKey ?? null,
        driveFolderLabel: resolveDriveFolderLabel(item.driveFolderKey),
        driveEnabled: Boolean(resolveDriveFolderId(item.driveFolderKey) && String(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? "").trim()),
        html: renderTemplateHtml(item.templateKey, item.variables),
      }));

      res.json({
        ok: true,
        issueKey,
        issueTypeName,
        previews,
        previewReport: {
          documentCount: previews.length,
          driveEnabled: previews.some((item) => item.driveEnabled),
          driveFolderLabels: Array.from(new Set(previews.map((item) => item.driveFolderLabel).filter(Boolean))),
        },
        warnings,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/contracts/generate", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "契約課題キーを入力してください。" });
        return;
      }

      const incomingDraft = typeof req.body?.draft === "object" && req.body?.draft
        ? normalizeContractDraft(req.body.draft)
        : {};
      if (Object.keys(incomingDraft).length > 0) {
        await saveIssueDocumentDraft(issueKey, incomingDraft);
      }

      const issue = await backlog.getIssue(issueKey);
      const issueTypeName = issue.issueType?.name ?? "";
      if (!issueTypeName) {
        res.status(400).json({ ok: false, error: "課題タイプが取得できません。" });
        return;
      }

      const preview = await buildContractDraft(issueKey, issue);
      const mergedDraft = { ...preview.draft, ...incomingDraft };
      const warnings = buildContractWarnings({
        issueTypeName,
        draft: mergedDraft,
        hasVendorMatch: Boolean(preview.vendor),
      });
      if (warnings.some((warning) => warning.level === "stop")) {
        res.status(400).json({
          ok: false,
          error: "事前チェックで停止項目があります。",
          warnings,
        });
        return;
      }

      await generateDocumentsForIssue(issueKey, issueTypeName, {
        keyId: issue.id,
        summary: issue.summary,
        status: issue.status,
        issueType: issue.issueType,
        customFields: issue.customFields,
        created: issue.created,
        updated: issue.updated,
      }, slack);

      const reviewStatusId = await backlog.findStatusIdByName(WORKFLOW_STATUS.review);
      const documentRequestedStatusId = reviewStatusId
        ? undefined
        : await backlog.findStatusIdByName(WORKFLOW_STATUS.documentRequested);
      const nextStatusId = reviewStatusId ?? documentRequestedStatusId;
      let statusUpdatedTo: string | null = null;
      if (nextStatusId) {
        await backlog.updateStatus(issueKey, nextStatusId);
        statusUpdatedTo = reviewStatusId ? WORKFLOW_STATUS.review : WORKFLOW_STATUS.documentRequested;
      }

      const workflow = await findIssueWorkflowByIssueKey(issueKey);
      const legalRequest = await findLegalRequestByBacklogKey(issueKey);
      const generatedDocuments = normalizeGeneratedDocuments(workflow?.generatedDocuments);
      const generationReport = buildContractGenerationReport({
        generatedDocuments,
        legalRequest,
        statusUpdatedTo,
      });
      res.json({
        ok: true,
        issueKey,
        issueTypeName,
        statusUpdatedTo,
        generatedDocuments,
        generationReport,
        nextActions: buildContractNextActions({
          statusUpdatedTo,
          generatedDocuments,
        }),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflow/royalty/generate", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.body?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "ロイヤリティ対象課題キーを入力してください。" });
        return;
      }

      const snapshot = await getRoyaltyIssueSnapshot(issueKey);
      const manufacturingEvent = await findManufacturingEventByBacklogIssueKey(issueKey);
      const warnings = buildRoyaltyPreviewWarnings({
        licenseIssueKey: snapshot.licenseIssueKey,
        productName: snapshot.productName,
        completionDate: snapshot.completionDate,
        quantity: String(snapshot.quantity || ""),
        msrp: String(snapshot.msrp || ""),
        manufacturingEvent,
      });
      if (warnings.some((warning) => warning.level === "stop")) {
        res.status(400).json({
          ok: false,
          error: "事前チェックで停止項目があります。",
          warnings,
        });
        return;
      }
      const { royaltyReport, paymentNotice, result } = await generateRoyaltyFromIssue(issueKey);

      await saveGeneratedDocuments(issueKey, [
        { name: "royalty_report", url: royaltyReport.driveUrl, localPath: royaltyReport.localPath },
        ...(paymentNotice ? [{ name: "payment_notice", url: paymentNotice.driveUrl, localPath: paymentNotice.localPath }] : []),
      ]);

      res.json({
        ok: true,
        issueKey,
        issueTypeName: snapshot.issueTypeName,
        licenseIssueKey: snapshot.licenseIssueKey || null,
        royaltyReport,
        paymentNotice: paymentNotice ?? null,
        generationReport: buildRoyaltyGenerationReport({
          royaltyReport,
          paymentNotice: paymentNotice ?? null,
        }),
        nextActions: buildRoyaltyNextActions({
          reportingDeadlineRaw: result.reportingDeadlineRaw,
          paymentDueDateRaw: result.paymentDueDateRaw,
          paymentNotice: paymentNotice ?? null,
        }),
        result: {
          productName: result.productName,
          edition: result.edition,
          quantity: result.quantity,
          sampleQuantity: result.sampleQuantity,
          msrp: result.msrp,
          calculationBaseDateRaw: result.calculationBaseDateRaw,
          grossRoyaltyStr: result.grossRoyaltyStr,
          actualRoyaltyStr: result.actualRoyaltyStr,
          totalPaymentStr: result.totalPaymentStr,
          paymentDueDateRaw: result.paymentDueDateRaw,
          reportingDeadlineRaw: result.reportingDeadlineRaw,
        },
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/royalty/preview", async (req: Request, res: Response) => {
    try {
      const issueKey = String(req.query?.issueKey ?? "").trim().toUpperCase();
      if (!issueKey) {
        res.status(400).json({ ok: false, error: "ロイヤリティ対象課題キーを入力してください。" });
        return;
      }

      const snapshot = await getRoyaltyIssueSnapshot(issueKey);
      const manufacturingEvent = await findManufacturingEventByBacklogIssueKey(issueKey);
      const workflow = await findIssueWorkflowByIssueKey(issueKey);
      const resolvedLicenseCondition = snapshot.licenseIssueKey
        ? await resolveRoyaltyLicenseCondition(
            snapshot.licenseIssueKey,
            undefined,
            snapshot.requestedConditionNo
          )
        : null;
      const warnings = buildRoyaltyPreviewWarnings({
        licenseIssueKey: snapshot.licenseIssueKey,
        productName: snapshot.productName,
        completionDate: snapshot.completionDate,
        quantity: String(snapshot.quantity || ""),
        msrp: String(snapshot.msrp || ""),
        manufacturingEvent,
        resolvedLicenseCondition: resolvedLicenseCondition?.meta ?? null,
      });

      res.json({
        ok: true,
        issueKey,
        issueTypeName: snapshot.issueTypeName,
        licenseIssueKey: snapshot.licenseIssueKey || null,
        productName: snapshot.productName,
        edition: snapshot.edition,
        completionDate: snapshot.completionDate,
        quantity: snapshot.quantity,
        msrp: snapshot.msrp,
        sampleQuantity: snapshot.sampleQuantity,
        notes: snapshot.notes,
        reportPeriodStart: snapshot.reportPeriodStart ?? null,
        reportPeriodEnd: snapshot.reportPeriodEnd ?? null,
        salesAmount: snapshot.salesAmount ?? null,
        receivedAmount: snapshot.receivedAmount ?? null,
        salesQuantity: snapshot.salesQuantity ?? null,
        resolvedLicenseCondition: resolvedLicenseCondition ? {
          calcType: resolvedLicenseCondition.license.calcType,
          royaltyRate: resolvedLicenseCondition.license.royaltyRate,
          distributionRate: resolvedLicenseCondition.license.distributionRate ?? null,
          mgAmount: resolvedLicenseCondition.license.mgAmount,
          paymentCycle: resolvedLicenseCondition.license.paymentCycle,
          reportingDaysAfterEvent: resolvedLicenseCondition.license.reportingDaysAfterEvent,
          paymentDaysAfterReport: resolvedLicenseCondition.license.paymentDaysAfterReport,
          source: resolvedLicenseCondition.meta.source,
          requestedConditionNo: resolvedLicenseCondition.meta.requestedConditionNo,
          resolvedConditionNo: resolvedLicenseCondition.meta.resolvedConditionNo,
          conditionHeading: resolvedLicenseCondition.meta.conditionHeading,
          rateSource: resolvedLicenseCondition.meta.rateSource,
          mgSource: resolvedLicenseCondition.meta.mgSource,
        } : null,
        hasManufacturingEvent: Boolean(manufacturingEvent),
        preflight: buildRoyaltyPreflight({
          issueKey,
          licenseIssueKey: snapshot.licenseIssueKey,
          productName: snapshot.productName,
          completionDate: snapshot.completionDate,
          quantity: String(snapshot.quantity || ""),
          msrp: String(snapshot.msrp || ""),
          hasManufacturingEvent: Boolean(manufacturingEvent),
          resolvedLicenseCondition: resolvedLicenseCondition?.meta ?? null,
          warnings,
        }),
        manufacturingEvent: manufacturingEvent ? {
          productName: manufacturingEvent.productName,
          edition: manufacturingEvent.edition,
          completionDate: manufacturingEvent.completionDate,
          quantity: manufacturingEvent.quantity,
          sampleQuantity: manufacturingEvent.sampleQuantity,
          msrp: manufacturingEvent.msrp,
          grossRoyalty: manufacturingEvent.grossRoyalty,
          actualRoyalty: manufacturingEvent.actualRoyalty,
          totalPayment: manufacturingEvent.totalPayment,
          reportingDeadline: manufacturingEvent.reportingDeadline,
          paymentDueDate: manufacturingEvent.paymentDueDate,
          royaltyReportUrl: manufacturingEvent.royaltyReportUrl,
          paymentNoticeUrl: manufacturingEvent.paymentNoticeUrl,
          licensor: manufacturingEvent.licenseContract?.licensor ?? null,
          originalWork: manufacturingEvent.licenseContract?.originalWork ?? null,
          ledgerId: manufacturingEvent.licenseContract?.ledgerId ?? null,
          licensorInvoiceNum: manufacturingEvent.licenseContract?.licensorInvoiceNum ?? null,
          bankName: manufacturingEvent.licenseContract?.licensorBankName ?? null,
          branchName: manufacturingEvent.licenseContract?.licensorBranchName ?? null,
          accountType: manufacturingEvent.licenseContract?.licensorAccountType ?? null,
          accountNo: manufacturingEvent.licenseContract?.licensorAccountNo ?? null,
          accountName: manufacturingEvent.licenseContract?.licensorAccountName ?? null,
          paymentStatus: manufacturingEvent.royaltyPayment?.status ?? null,
        } : null,
        generatedDocuments: Array.isArray(workflow?.generatedDocuments) ? workflow.generatedDocuments : [],
        warnings,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/workflow/royalty/attention", async (_req: Request, res: Response) => {
    try {
      const issues = await backlog.getRecentIssues(20);
      const issueTypeNames = new Set(["製造案件", "売上報告"]);
      const attentionItems = await Promise.all(
        issues
          .filter((issue) => issueTypeNames.has(issue.issueType?.name ?? ""))
          .slice(0, 10)
          .map(async (issue) => {
            const snapshot = await getRoyaltyIssueSnapshot(issue.issueKey);
            const manufacturingEvent = await findManufacturingEventByBacklogIssueKey(issue.issueKey);
            const resolvedLicenseCondition = snapshot.licenseIssueKey
              ? await resolveRoyaltyLicenseCondition(snapshot.licenseIssueKey, undefined, snapshot.requestedConditionNo)
              : null;
            const warnings = buildRoyaltyPreviewWarnings({
              licenseIssueKey: snapshot.licenseIssueKey,
              productName: snapshot.productName,
              completionDate: snapshot.completionDate,
              quantity: String(snapshot.quantity || ""),
              msrp: String(snapshot.msrp || ""),
              manufacturingEvent,
              resolvedLicenseCondition: resolvedLicenseCondition?.meta ?? null,
            });
            const blockingCount = warnings.filter((warning) => warning.level === "stop").length;
            const warningCount = warnings.filter((warning) => warning.level === "warn").length;
            return {
              issueKey: issue.issueKey,
              summary: issue.summary,
              severity: blockingCount > 0 ? "stop" : warningCount > 0 ? "warn" : "ready",
              blockingCount,
              warningCount,
              topMessage: warnings[0]?.message ?? "停止項目・注意項目はありません。",
            };
          }),
      );

      res.json({
        ok: true,
        issues: attentionItems
          .filter((item) => item.severity !== "ready")
          .sort((a, b) => {
            const rank = (value: string) => value === "stop" ? 0 : value === "warn" ? 1 : 2;
            return rank(a.severity) - rank(b.severity);
          }),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

function emptyToUndefined(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function toBoolean(value: unknown): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true"
    || text === "1"
    || text === "yes"
    || text === "on"
    || text === "y"
    || text === "はい"
    || text === "有"
    || text === "あり"
    || text === "対象"
    || text === "法人番号あり";
}

function normalizeVendorEntityType(value: unknown): "individual" | "corporation" {
  const text = String(value ?? "").trim().toLowerCase();
  if ([
    "individual",
    "個人",
    "個人事業主",
    "sole proprietor",
    "sole_proprietor",
    "freelance",
    "フリーランス",
  ].includes(text)) {
    return "individual";
  }
  return "corporation";
}

function normalizeRequestSimulatorValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => [key, String(rawValue ?? "").trim()])
  );
}

const ORDER_CATEGORY_EXAMPLES = [
  "イラスト制作",
  "デザイン",
  "DTP",
  "監修",
  "翻訳",
  "執筆",
  "編集",
  "制作進行",
];

const ORDER_PAY_METHOD_OPTIONS = PAYMENT_METHOD_OPTIONS.map((option) => option.label);

function normalizeRequestSourceMode(value: unknown): "new" | "signed_import" | "delivered_import" {
  const normalized = String(value ?? "").trim();
  if (normalized === "signed_import" || normalized === "delivered_import") {
    return normalized;
  }
  return "new";
}

function describeRequestSourceMode(value: "new" | "signed_import" | "delivered_import"): string {
  if (value === "signed_import") return "締結済取込";
  if (value === "delivered_import") return "交付済取込";
  return "新規作成";
}

function normalizeUploadedFile(value: unknown): { name: string; contentBase64: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const name = String(record.name ?? "").trim();
  const contentBase64 = String(record.contentBase64 ?? "").trim();
  if (!name || !contentBase64) {
    return undefined;
  }
  return { name, contentBase64 };
}

function normalizeManualOrderItems(value: unknown): Array<{
  no: number;
  vendorCode?: string;
  category?: string;
  payMethod?: string;
  installmentCount?: number;
  paymentStartDate?: string;
  paymentIntervalMonths?: number;
  subscriptionMonths?: number;
  qty: number;
  unitPrice?: number;
  desc: string;
  spec?: string;
  amount: number;
  dueDate: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((raw, index) => {
      const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const qty = parsePositiveInteger(item.qty, 1);
      const unitPrice = parseOptionalInteger(item.unitPrice);
      const amount = parseOptionalInteger(item.amount) ?? ((unitPrice ?? 0) * qty);
      return {
        no: parsePositiveInteger(item.no, index + 1),
        vendorCode: emptyToUndefined(item.vendorCode),
        category: emptyToUndefined(item.category),
        payMethod: normalizeOrderPayMethod(item.payMethod),
        installmentCount: parseOptionalInteger(item.installmentCount),
        paymentStartDate: normalizeOptionalManualDate(item.paymentStartDate),
        paymentIntervalMonths: parseOptionalInteger(item.paymentIntervalMonths),
        subscriptionMonths: parseOptionalInteger(item.subscriptionMonths),
        qty,
        unitPrice: unitPrice ?? amount,
        desc: String(item.desc ?? "").trim(),
        spec: emptyToUndefined(item.spec),
        amount,
        dueDate: normalizeManualDate(item.dueDate),
      };
    })
    .filter((item) => item.desc || item.dueDate || item.amount);
}

function normalizeOrderPayMethod(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  return getPaymentMethodLabel(normalizePaymentMethodCode(normalized));
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalInteger(value: unknown): number | undefined {
  const text = String(value ?? "").replace(/[,\s]/g, "").trim();
  if (!text) return undefined;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeManualDate(value: unknown): string {
  const text = String(value ?? "").trim().replace(/\//g, "-").replace(/\./g, "-");
  if (!text) return "";
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function normalizeOptionalManualDate(value: unknown): string | undefined {
  const normalized = normalizeManualDate(value);
  return normalized || undefined;
}

function buildCsvFromManualOrderItems(items: Array<{
  no: number;
  vendorCode?: string;
  category?: string;
  payMethod?: string;
  installmentCount?: number;
  paymentStartDate?: string;
  paymentIntervalMonths?: number;
  subscriptionMonths?: number;
  qty: number;
  unitPrice?: number;
  desc: string;
  spec?: string;
  amount: number;
  dueDate: string;
}>): string {
  const header = "no,registration_no,category,pay_method,installment_count,payment_start_date,payment_interval_months,subscription_months,qty,unit_price,desc,spec,amount,due_date";
  const rows = items.map((item) => [
    item.no,
    csvCell(item.vendorCode ?? ""),
    csvCell(item.category ?? ""),
    csvCell(item.payMethod ?? ""),
    item.installmentCount ?? "",
    item.paymentStartDate ?? "",
    item.paymentIntervalMonths ?? "",
    item.subscriptionMonths ?? "",
    item.qty,
    item.unitPrice ?? "",
    csvCell(item.desc),
    csvCell(item.spec ?? ""),
    item.amount,
    item.dueDate,
  ].join(","));
  return [header, ...rows].join("\n");
}

function csvCell(value: string): string {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function buildAdminBacklogCustomFields(
  type: DocumentRequestType,
  definitionText: string,
  requesterSlackUserId: string,
  values: Record<string, string>
): Record<string, string> {
  const isOrderType = type === "purchase_order" || type === "planning_order" || type === "publishing_order";
  const baseEntries = {
    [process.env.BACKLOG_FIELD_REQUESTER ?? ""]: process.env.BACKLOG_FIELD_REQUESTER ? `<@${requesterSlackUserId}>` : "",
    [process.env.BACKLOG_FIELD_CONTRACT_TYPE ?? ""]: definitionText,
    [process.env.BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER ?? ""]: values.registration_number,
    [process.env.BACKLOG_FIELD_COUNTERPARTY ?? ""]: values.counterparty,
    [process.env.BACKLOG_FIELD_DEADLINE ?? ""]: values.desired_due_date,
    [process.env.BACKLOG_FIELD_CONTRACT_NO ?? ""]: isOrderType ? "" : values.contract_number,
    [process.env.BACKLOG_FIELD_COUNTERPARTY_ADDRESS ?? ""]: values.counterparty_address,
    [process.env.BACKLOG_FIELD_COUNTERPARTY_REP ?? ""]: values.counterparty_representative,
    [process.env.BACKLOG_FIELD_REMARKS ?? ""]: values.remarks,
    [process.env.BACKLOG_FIELD_CONTRACT_DATE ?? ""]: values.contract_date,
    [process.env.BACKLOG_FIELD_ORDER_DATE ?? ""]: values.contract_date,
  };

  if (type === "nda") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_NDA_PURPOSE ?? ""]: values.nda_purpose,
      [process.env.BACKLOG_FIELD_CONTRACT_PERIOD ?? ""]: values.contract_period,
      [process.env.BACKLOG_FIELD_CONFIDENTIALITY_PERIOD ?? ""]: values.confidentiality_period,
      [process.env.BACKLOG_FIELD_JURISDICTION ?? ""]: values.jurisdiction,
    });
  }

  if (type === "outsourcing") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_CONTRACT_PERIOD ?? ""]: values.contract_period,
      [process.env.BACKLOG_FIELD_JURISDICTION ?? ""]: values.jurisdiction,
    });
  }

  if (type === "license") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_ORIGINAL_WORK ?? ""]: values.original_work,
      [process.env.BACKLOG_FIELD_ORIGINAL_AUTHOR ?? ""]: values.original_author,
      [process.env.BACKLOG_FIELD_CREDIT_NAME ?? ""]: values.credit_name,
      [process.env.BACKLOG_FIELD_CONTRACT_PERIOD ?? ""]: values.contract_period,
      [process.env.BACKLOG_FIELD_JURISDICTION ?? ""]: values.jurisdiction,
    });
  }

  if (type === "license_schedule") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_LICENSE_KEY ?? ""]: values.license_issue_key,
      [process.env.BACKLOG_FIELD_LICENSE_TYPE_NAME ?? ""]: values.license_type_name,
      [process.env.BACKLOG_FIELD_ORIGINAL_WORK ?? ""]: values.original_work,
      [process.env.BACKLOG_FIELD_LICENSE_START ?? ""]: values.license_start,
    });
  }

  if (type === "ip_overseas_master") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_ORIGINAL_WORK ?? ""]: values.original_work,
      [process.env.BACKLOG_FIELD_CONTRACT_PERIOD ?? ""]: values.contract_period,
      [process.env.BACKLOG_FIELD_JURISDICTION ?? ""]: values.jurisdiction,
      [process.env.BACKLOG_FIELD_DEAL_STRUCTURE ?? ""]: values.deal_structure,
      [process.env.BACKLOG_FIELD_LICENSE_SCOPE ?? ""]: values.license_scope,
      [process.env.BACKLOG_FIELD_IP_PRODUCT_SCOPE ?? ""]: values.ip_product_scope,
      [process.env.BACKLOG_FIELD_TERRITORY ?? ""]: values.territory,
      [process.env.BACKLOG_FIELD_EXCLUSIVITY ?? ""]: values.exclusivity,
      [process.env.BACKLOG_FIELD_REVENUE_MODEL ?? ""]: values.revenue_model,
      [process.env.BACKLOG_FIELD_ROYALTY_TERMS ?? ""]: values.royalty_terms,
      [process.env.BACKLOG_FIELD_SUBLICENSE_ALLOWED ?? ""]: values.sublicense_allowed,
      [process.env.BACKLOG_FIELD_TITLE_TRANSFER_MODEL ?? ""]: values.title_transfer_model,
      [process.env.BACKLOG_FIELD_INVENTORY_SELLOFF ?? ""]: values.inventory_selloff,
      [process.env.BACKLOG_FIELD_SPECIAL_NOTES ?? ""]: values.special_notes,
      [process.env.BACKLOG_FIELD_S1_ROYALTY_RATE ?? ""]: values.s1_royalty_rate,
      [process.env.BACKLOG_FIELD_S1_MINIMUM_GUARANTEE ?? ""]: values.s1_minimum_guarantee,
      [process.env.BACKLOG_FIELD_S1_ADVANCE ?? ""]: values.s1_advance,
      [process.env.BACKLOG_FIELD_S1_ACCOUNTING_PERIOD ?? ""]: values.s1_accounting_period,
      [process.env.BACKLOG_FIELD_S1_PAYMENT_DUE ?? ""]: values.s1_payment_due,
      [process.env.BACKLOG_FIELD_S1_REPORT_DUE ?? ""]: values.s1_report_due,
      [process.env.BACKLOG_FIELD_S1_FX_CONVERSION ?? ""]: values.s1_fx_conversion,
      [process.env.BACKLOG_FIELD_S1_FIRST_PRINT_RUN ?? ""]: values.s1_first_print_run,
      [process.env.BACKLOG_FIELD_S1_TARGET_RELEASE_DATE ?? ""]: values.s1_target_release_date,
      [process.env.BACKLOG_FIELD_S1_COMPLIMENTARY_COPIES ?? ""]: values.s1_complimentary_copies,
      [process.env.BACKLOG_FIELD_S1_CREDIT_WORDING ?? ""]: values.s1_credit_wording,
      [process.env.BACKLOG_FIELD_S1_TERRITORY_JURISDICTION ?? ""]: values.s1_territory_jurisdiction,
      [process.env.BACKLOG_FIELD_S1_CONSUMER_LAW_CARVEOUT ?? ""]: values.s1_consumer_law_carveout,
      [process.env.BACKLOG_FIELD_S1_VAT_GST_TREATMENT ?? ""]: values.s1_vat_gst_treatment,
      [process.env.BACKLOG_FIELD_S1_COPYRIGHT_REGISTRATION ?? ""]: values.s1_copyright_registration,
      [process.env.BACKLOG_FIELD_S1_MORAL_RIGHTS ?? ""]: values.s1_moral_rights,
      [process.env.BACKLOG_FIELD_S1_MANDATORY_DISTRIBUTION_LAW ?? ""]: values.s1_mandatory_distribution_law,
      [process.env.BACKLOG_FIELD_S1_ADDITIONAL_TERMS ?? ""]: values.s1_additional_terms,
      [process.env.BACKLOG_FIELD_S2_PRODUCT_PRICE_LIST ?? ""]: values.s2_product_price_list,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR1 ?? ""]: values.s2_mpr_year1,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR2 ?? ""]: values.s2_mpr_year2,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR3 ?? ""]: values.s2_mpr_year3,
      [process.env.BACKLOG_FIELD_S2_INCOTERMS_DELIVERY ?? ""]: values.s2_incoterms_delivery,
      [process.env.BACKLOG_FIELD_S2_ARRIVAL_POINT ?? ""]: values.s2_arrival_point,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_ADVANCE ?? ""]: values.s2_payment_advance,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_BALANCE ?? ""]: values.s2_payment_balance,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_CURRENCY ?? ""]: values.s2_payment_currency,
      [process.env.BACKLOG_FIELD_S2_TERRITORY_JURISDICTION ?? ""]: values.s2_territory_jurisdiction,
      [process.env.BACKLOG_FIELD_S2_IMPORT_CUSTOMS_ALLOCATION ?? ""]: values.s2_import_customs_allocation,
      [process.env.BACKLOG_FIELD_S2_CONSUMER_PRODUCT_SAFETY ?? ""]: values.s2_consumer_product_safety,
      [process.env.BACKLOG_FIELD_S2_DISTRIBUTION_LAW_PROTECTIONS ?? ""]: values.s2_distribution_law_protections,
      [process.env.BACKLOG_FIELD_S2_VAT_GST_SUPPLY ?? ""]: values.s2_vat_gst_supply,
      [process.env.BACKLOG_FIELD_S2_PRODUCT_LIABILITY_INSURANCE ?? ""]: values.s2_product_liability_insurance,
      [process.env.BACKLOG_FIELD_S2_MARKETPLACE_ONLINE_SALES ?? ""]: values.s2_marketplace_online_sales,
      [process.env.BACKLOG_FIELD_S2_ADDITIONAL_TERMS ?? ""]: values.s2_additional_terms,
    });
  }

  if (type === "ip_overseas_amendment") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_ORIGINAL_WORK ?? ""]: values.original_work,
      [process.env.BACKLOG_FIELD_DEAL_STRUCTURE ?? ""]: values.deal_structure,
      [process.env.BACKLOG_FIELD_CHANGE_MODE ?? ""]: values.change_mode,
      [process.env.BACKLOG_FIELD_BASE_AGREEMENT_KEY ?? ""]: values.base_agreement_key,
      [process.env.BACKLOG_FIELD_EFFECTIVE_DATE ?? ""]: values.effective_date,
      [process.env.BACKLOG_FIELD_LICENSE_SCOPE ?? ""]: values.license_scope,
      [process.env.BACKLOG_FIELD_IP_PRODUCT_SCOPE ?? ""]: values.ip_product_scope,
      [process.env.BACKLOG_FIELD_TERRITORY ?? ""]: values.territory,
      [process.env.BACKLOG_FIELD_REVENUE_MODEL ?? ""]: values.revenue_model,
      [process.env.BACKLOG_FIELD_ROYALTY_TERMS ?? ""]: values.royalty_terms,
      [process.env.BACKLOG_FIELD_TITLE_TRANSFER_MODEL ?? ""]: values.title_transfer_model,
      [process.env.BACKLOG_FIELD_INVENTORY_SELLOFF ?? ""]: values.inventory_selloff,
      [process.env.BACKLOG_FIELD_AMENDMENT_CLAUSES ?? ""]: values.amendment_clauses,
      [process.env.BACKLOG_FIELD_SPECIAL_NOTES ?? ""]: values.special_notes,
      [process.env.BACKLOG_FIELD_S1_ROYALTY_RATE ?? ""]: values.s1_royalty_rate,
      [process.env.BACKLOG_FIELD_S1_MINIMUM_GUARANTEE ?? ""]: values.s1_minimum_guarantee,
      [process.env.BACKLOG_FIELD_S1_ADVANCE ?? ""]: values.s1_advance,
      [process.env.BACKLOG_FIELD_S1_ACCOUNTING_PERIOD ?? ""]: values.s1_accounting_period,
      [process.env.BACKLOG_FIELD_S1_PAYMENT_DUE ?? ""]: values.s1_payment_due,
      [process.env.BACKLOG_FIELD_S1_REPORT_DUE ?? ""]: values.s1_report_due,
      [process.env.BACKLOG_FIELD_S1_FX_CONVERSION ?? ""]: values.s1_fx_conversion,
      [process.env.BACKLOG_FIELD_S1_FIRST_PRINT_RUN ?? ""]: values.s1_first_print_run,
      [process.env.BACKLOG_FIELD_S1_TARGET_RELEASE_DATE ?? ""]: values.s1_target_release_date,
      [process.env.BACKLOG_FIELD_S1_COMPLIMENTARY_COPIES ?? ""]: values.s1_complimentary_copies,
      [process.env.BACKLOG_FIELD_S1_CREDIT_WORDING ?? ""]: values.s1_credit_wording,
      [process.env.BACKLOG_FIELD_S1_TERRITORY_JURISDICTION ?? ""]: values.s1_territory_jurisdiction,
      [process.env.BACKLOG_FIELD_S1_CONSUMER_LAW_CARVEOUT ?? ""]: values.s1_consumer_law_carveout,
      [process.env.BACKLOG_FIELD_S1_VAT_GST_TREATMENT ?? ""]: values.s1_vat_gst_treatment,
      [process.env.BACKLOG_FIELD_S1_COPYRIGHT_REGISTRATION ?? ""]: values.s1_copyright_registration,
      [process.env.BACKLOG_FIELD_S1_MORAL_RIGHTS ?? ""]: values.s1_moral_rights,
      [process.env.BACKLOG_FIELD_S1_MANDATORY_DISTRIBUTION_LAW ?? ""]: values.s1_mandatory_distribution_law,
      [process.env.BACKLOG_FIELD_S1_ADDITIONAL_TERMS ?? ""]: values.s1_additional_terms,
      [process.env.BACKLOG_FIELD_S2_PRODUCT_PRICE_LIST ?? ""]: values.s2_product_price_list,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR1 ?? ""]: values.s2_mpr_year1,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR2 ?? ""]: values.s2_mpr_year2,
      [process.env.BACKLOG_FIELD_S2_MPR_YEAR3 ?? ""]: values.s2_mpr_year3,
      [process.env.BACKLOG_FIELD_S2_INCOTERMS_DELIVERY ?? ""]: values.s2_incoterms_delivery,
      [process.env.BACKLOG_FIELD_S2_ARRIVAL_POINT ?? ""]: values.s2_arrival_point,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_ADVANCE ?? ""]: values.s2_payment_advance,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_BALANCE ?? ""]: values.s2_payment_balance,
      [process.env.BACKLOG_FIELD_S2_PAYMENT_CURRENCY ?? ""]: values.s2_payment_currency,
      [process.env.BACKLOG_FIELD_S2_TERRITORY_JURISDICTION ?? ""]: values.s2_territory_jurisdiction,
      [process.env.BACKLOG_FIELD_S2_IMPORT_CUSTOMS_ALLOCATION ?? ""]: values.s2_import_customs_allocation,
      [process.env.BACKLOG_FIELD_S2_CONSUMER_PRODUCT_SAFETY ?? ""]: values.s2_consumer_product_safety,
      [process.env.BACKLOG_FIELD_S2_DISTRIBUTION_LAW_PROTECTIONS ?? ""]: values.s2_distribution_law_protections,
      [process.env.BACKLOG_FIELD_S2_VAT_GST_SUPPLY ?? ""]: values.s2_vat_gst_supply,
      [process.env.BACKLOG_FIELD_S2_PRODUCT_LIABILITY_INSURANCE ?? ""]: values.s2_product_liability_insurance,
      [process.env.BACKLOG_FIELD_S2_MARKETPLACE_ONLINE_SALES ?? ""]: values.s2_marketplace_online_sales,
      [process.env.BACKLOG_FIELD_S2_ADDITIONAL_TERMS ?? ""]: values.s2_additional_terms,
    });
  }

  if (type === "sales_buyer") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_PRODUCT_SCOPE ?? ""]: values.product_scope,
      [process.env.BACKLOG_FIELD_DELIVERY_LOCATION ?? ""]: values.delivery_location,
      [process.env.BACKLOG_FIELD_INSPECTION_PERIOD_DAYS ?? ""]: values.inspection_period_days,
      [process.env.BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY ?? ""]: values.payment_condition_summary,
      [process.env.BACKLOG_FIELD_WARRANTY_PERIOD ?? ""]: values.warranty_period,
      [process.env.BACKLOG_FIELD_JURISDICTION ?? ""]: values.jurisdiction,
    });
  }

  if (type === "sales_seller_standard") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_PRODUCT_SCOPE ?? ""]: values.product_scope,
      [process.env.BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY ?? ""]: values.payment_condition_summary,
      [process.env.BACKLOG_FIELD_MONTHLY_CLOSING_DAY ?? ""]: values.monthly_closing_day,
      [process.env.BACKLOG_FIELD_PAYMENT_DUE_DAY ?? ""]: values.payment_due_day,
      [process.env.BACKLOG_FIELD_PAYMENT_METHOD ?? ""]: values.payment_method,
      [process.env.BACKLOG_FIELD_WARRANTY_PERIOD ?? ""]: values.warranty_period,
      [process.env.BACKLOG_FIELD_JURISDICTION ?? ""]: values.jurisdiction,
    });
  }

  if (type === "sales_seller_credit") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_PRODUCT_SCOPE ?? ""]: values.product_scope,
      [process.env.BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY ?? ""]: values.payment_condition_summary,
      [process.env.BACKLOG_FIELD_MONTHLY_CLOSING_DAY ?? ""]: values.monthly_closing_day,
      [process.env.BACKLOG_FIELD_PAYMENT_DUE_DAY ?? ""]: values.payment_due_day,
      [process.env.BACKLOG_FIELD_PAYMENT_METHOD ?? ""]: values.payment_method,
      [process.env.BACKLOG_FIELD_SECURITY_DEPOSIT_AMOUNT ?? ""]: values.security_deposit_amount,
      [process.env.BACKLOG_FIELD_DEPOSIT_REPLENISH_DAYS ?? ""]: values.deposit_replenish_days,
      [process.env.BACKLOG_FIELD_WARRANTY_PERIOD ?? ""]: values.warranty_period,
      [process.env.BACKLOG_FIELD_JURISDICTION ?? ""]: values.jurisdiction,
    });
  }

  if (type === "purchase_order" || type === "planning_order" || type === "publishing_order") {
    return sanitizeAdminCustomFieldEntries({
      ...baseEntries,
      [process.env.BACKLOG_FIELD_PROJECT_TITLE ?? ""]: values.project_title,
      ...(type === "purchase_order"
        ? {
            [process.env.BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY ?? ""]: values.order_summary,
          }
        : {
            [process.env.BACKLOG_FIELD_MASTER_CONTRACT_REF ?? ""]: values.master_contract_ref,
          }),
    });
  }

  return sanitizeAdminCustomFieldEntries(baseEntries);
}

function sanitizeAdminCustomFieldEntries(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter(([fieldId, value]) => fieldId.trim() && value.trim())
  );
}

function buildAdminBacklogDescription(input: {
  requesterSlackUserId: string;
  summary: string;
  sourceMode: "new" | "signed_import" | "delivered_import";
  type: DocumentRequestType;
  definitionText: string;
  values: Record<string, string>;
  externalDocumentUrl: string;
  uploadedFileName?: string;
}): string {
  const rows = [
    `| 依頼者 | <@${input.requesterSlackUserId}> |`,
    `| 文書種別 | ${input.definitionText} |`,
    `| 登録モード | ${describeRequestSourceMode(input.sourceMode)} |`,
    `| 登録番号 | ${input.values.registration_number || "未入力"} |`,
    `| 相手方 | ${input.values.counterparty || "未入力"} |`,
    `| 契約書番号 | ${input.values.contract_number || "未指定"} |`,
    `| 希望期限 | ${input.values.desired_due_date || "指定なし"} |`,
  ];
  const details = Object.entries(input.values)
    .filter(([, value]) => value)
    .map(([key, value]) => `- ${humanizeRequestFieldId(key)}: ${value}`)
    .join("\n");
  const attachmentRows = [
    input.externalDocumentUrl ? `- URL: ${input.externalDocumentUrl}` : "",
    input.uploadedFileName ? `- 添付ファイル: ${input.uploadedFileName}` : "",
  ].filter(Boolean).join("\n");

  return [
    "## 法務依頼（管理UI登録）",
    "",
    "| 項目 | 内容 |",
    "|------|------|",
    ...rows,
    "",
    "## 概要",
    input.summary,
    "",
    "## 入力項目",
    details || "（入力なし）",
    "",
    input.sourceMode === "new" ? "" : "## 外部文書",
    input.sourceMode === "new" ? "" : (attachmentRows || "（添付なし）"),
    "",
    `*このチケットは管理UIの申請シミュレーターから登録されました*`,
  ].filter(Boolean).join("\n");
}

function humanizeRequestFieldId(fieldId: string): string {
  return fieldId
    .split("_")
    .map((segment) => segment ? segment[0].toUpperCase() + segment.slice(1) : "")
    .join(" ");
}

function buildLegalRequestNotes(
  sourceMode: "new" | "signed_import" | "delivered_import",
  externalDocumentUrl: string,
  uploadedFileName?: string
): string | undefined {
  const parts = [
    `source=${describeRequestSourceMode(sourceMode)}`,
    externalDocumentUrl ? `url=${externalDocumentUrl}` : "",
    uploadedFileName ? `file=${uploadedFileName}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

function buildImportedDocumentDraft(
  type: DocumentRequestType,
  sourceMode: "new" | "signed_import" | "delivered_import",
  summary: string,
  values: Record<string, string>
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key.toUpperCase(), value])
    ),
    REQUEST_TYPE: type,
    REQUEST_SOURCE_MODE: sourceMode,
    REQUEST_SUMMARY: summary,
  };
}

async function storeUploadedExternalDocument(
  issueKey: string,
  sourceMode: "new" | "signed_import" | "delivered_import",
  upload: { name: string; contentBase64: string }
): Promise<{ name: string; url?: string; localPath: string }> {
  const targetDir = path.resolve(__dirname, "../../tmp/external-imports");
  fs.mkdirSync(targetDir, { recursive: true });
  const safeName = upload.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = path.join(targetDir, `${issueKey}_${Date.now()}_${safeName}`);
  fs.writeFileSync(localPath, Buffer.from(upload.contentBase64, "base64"));
  const url = await tryUploadToDrive(path.basename(localPath), localPath);
  return {
    name: `external_${sourceMode}_file`,
    url,
    localPath,
  };
}

function buildBacklogIssueUrl(issueKey: string): string | undefined {
  const space = String(process.env.BACKLOG_SPACE ?? "").trim();
  if (!space) return undefined;
  return `https://${space}.backlog.com/view/${issueKey}`;
}

function buildLegalRequestIssueSummary(summary: string, counterparty: string): string {
  const cleanCounterparty = counterparty.trim();
  return cleanCounterparty
    ? `【法務依頼】${summary}（${cleanCounterparty}）`
    : `【法務依頼】${summary}`;
}

function getIssueCustomFieldValue(issue: Awaited<ReturnType<typeof backlog.getIssue>>, envKey?: string): string {
  return getBacklogCustomFieldValue(issue, envKey);
}

const CONTRACT_DRAFT_FIELDS: Array<{ key: string; label: string; section: string; multiline?: boolean }> = [
  { key: "CONTRACT_NO", label: "契約書番号", section: "基本情報" },
  { key: "CONTRACT_DATE", label: "契約日", section: "基本情報" },
  { key: "PARTY_A_NAME", label: "当社名", section: "自社情報" },
  { key: "PARTY_A_ADDRESS", label: "当社住所", section: "自社情報", multiline: true },
  { key: "PARTY_A_REPRESENTATIVE", label: "当社代表者", section: "自社情報" },
  { key: "STAFF_DEPARTMENT", label: "担当部署", section: "自社情報" },
  { key: "STAFF_NAME", label: "担当者名", section: "自社情報" },
  { key: "STAFF_PHONE", label: "担当者電話", section: "自社情報" },
  { key: "STAFF_EMAIL", label: "担当者メール", section: "自社情報" },
  { key: "PARTY_B_NAME", label: "相手方名", section: "相手方情報" },
  { key: "PARTY_B_ADDRESS", label: "相手方住所", section: "相手方情報", multiline: true },
  { key: "PARTY_B_REPRESENTATIVE", label: "相手方代表者", section: "相手方情報" },
  { key: "VENDOR_NAME", label: "文書上の相手方表示名", section: "相手方情報" },
  { key: "VENDOR_ADDRESS", label: "文書上の相手方住所", section: "相手方情報", multiline: true },
  { key: "VENDOR_REP", label: "文書上の相手方担当・代表", section: "相手方情報" },
  { key: "VENDOR_PHONE", label: "相手方電話", section: "相手方情報" },
  { key: "VENDOR_EMAIL", label: "相手方メール", section: "相手方情報" },
  { key: "BANK_NAME", label: "銀行名", section: "支払先情報" },
  { key: "BRANCH_NAME", label: "支店名", section: "支払先情報" },
  { key: "ACCOUNT_TYPE", label: "口座種別", section: "支払先情報" },
  { key: "ACCOUNT_NUMBER", label: "口座番号", section: "支払先情報" },
  { key: "ACCOUNT_HOLDER_KANA", label: "口座名義カナ", section: "支払先情報" },
  { key: "IS_INVOICE_ISSUER", label: "適格請求書発行事業者", section: "支払先情報" },
  { key: "invoiceRegistrationDisplay", label: "適格請求書登録番号", section: "支払先情報" },
  { key: "JURISDICTION", label: "管轄裁判所", section: "契約条件" },
  { key: "NDA_PURPOSE", label: "秘密保持の目的", section: "契約条件", multiline: true },
  { key: "CONTRACT_PERIOD", label: "契約期間", section: "契約条件" },
  { key: "CONFIDENTIALITY_PERIOD", label: "秘密保持期間", section: "契約条件" },
  { key: "ORIGINAL_WORK", label: "原著作物", section: "ライセンス情報" },
  { key: "ORIGINAL_AUTHOR", label: "原著作者", section: "ライセンス情報" },
  { key: "CREDIT_NAME", label: "クレジット表記", section: "ライセンス情報" },
  { key: "LICENSE_ISSUE_KEY", label: "親ライセンス課題キー", section: "ライセンス情報" },
  { key: "LICENSE_TYPE_NAME", label: "許諾区分", section: "ライセンス情報" },
  { key: "LICENSE_START", label: "許諾開始日", section: "ライセンス情報" },
  { key: "LICENSE_REGION_LANGUAGE_LABEL", label: "地域・言語", section: "ライセンス情報" },
  { key: "PRODUCT_NAME", label: "対象製品予定名", section: "ライセンス情報" },
  { key: "MATERIAL_CODE", label: "素材番号", section: "素材情報" },
  { key: "MATERIAL_NAME", label: "素材名", section: "素材情報" },
  { key: "MATERIAL_RIGHTS_HOLDER", label: "素材権利者", section: "素材情報" },
  { key: "SUPERVISOR", label: "監修者", section: "素材情報" },
  { key: "CONDITION1_HEADING", label: "金銭条件1 見出し", section: "金銭条件1" },
  { key: "CONDITION1_CALC_METHOD", label: "金銭条件1 計算方式", section: "金銭条件1" },
  { key: "CONDITION1_FORMULA", label: "金銭条件1 計算式", section: "金銭条件1", multiline: true },
  { key: "CONDITION1_BASE_PRICE_LABEL", label: "金銭条件1 基準価格ラベル", section: "金銭条件1" },
  { key: "CONDITION1_RATE", label: "金銭条件1 料率", section: "金銭条件1" },
  { key: "CONDITION1_PAYMENT_TERMS", label: "金銭条件1 支払条件", section: "金銭条件1", multiline: true },
  { key: "CONDITION1_MG_AG", label: "金銭条件1 MG/AG", section: "金銭条件1" },
  { key: "CONDITION1_NOTE", label: "金銭条件1 補足", section: "金銭条件1", multiline: true },
  { key: "CONDITION2_HEADING", label: "金銭条件2 見出し", section: "金銭条件2" },
  { key: "CONDITION2_REGION", label: "金銭条件2 地域", section: "金銭条件2" },
  { key: "CONDITION2_LANGUAGE", label: "金銭条件2 言語", section: "金銭条件2" },
  { key: "CONDITION2_CALC_METHOD", label: "金銭条件2 計算方式", section: "金銭条件2" },
  { key: "CONDITION2_SUMMARY", label: "金銭条件2 概要", section: "金銭条件2", multiline: true },
  { key: "CONDITION2_FORMULA", label: "金銭条件2 計算式", section: "金銭条件2", multiline: true },
  { key: "CONDITION2_SHARE_RATE", label: "金銭条件2 分配率", section: "金銭条件2" },
  { key: "CONDITION2_PAYMENT_TERMS", label: "金銭条件2 支払条件", section: "金銭条件2", multiline: true },
  { key: "CONDITION2_MG_AG", label: "金銭条件2 MG/AG", section: "金銭条件2" },
  { key: "CONDITION2_NOTE", label: "金銭条件2 補足", section: "金銭条件2", multiline: true },
  { key: "CONDITION3_HEADING", label: "金銭条件3 見出し", section: "金銭条件3" },
  { key: "CONDITION3_REGION", label: "金銭条件3 地域", section: "金銭条件3" },
  { key: "CONDITION3_LANGUAGE", label: "金銭条件3 言語", section: "金銭条件3" },
  { key: "CONDITION3_CALC_METHOD", label: "金銭条件3 計算方式", section: "金銭条件3" },
  { key: "CONDITION3_SUMMARY", label: "金銭条件3 概要", section: "金銭条件3", multiline: true },
  { key: "CONDITION3_FORMULA", label: "金銭条件3 計算式", section: "金銭条件3", multiline: true },
  { key: "CONDITION3_RATE", label: "金銭条件3 料率", section: "金銭条件3" },
  { key: "CONDITION3_PAYMENT_TERMS", label: "金銭条件3 支払条件", section: "金銭条件3", multiline: true },
  { key: "CONDITION3_MG_AG", label: "金銭条件3 MG/AG", section: "金銭条件3" },
  { key: "CONDITION3_NOTE", label: "金銭条件3 補足", section: "金銭条件3", multiline: true },
  { key: "PRODUCT_SCOPE", label: "商品範囲", section: "売買条件", multiline: true },
  { key: "DELIVERY_LOCATION", label: "納入場所", section: "売買条件" },
  { key: "INSPECTION_PERIOD_DAYS", label: "検収期間（日）", section: "売買条件" },
  { key: "PAYMENT_CONDITION_SUMMARY", label: "支払条件概要", section: "売買条件", multiline: true },
  { key: "WARRANTY_PERIOD", label: "保証期間", section: "売買条件" },
  { key: "CONFIDENTIALITY_YEARS", label: "秘密保持年数", section: "売買条件" },
  { key: "CURE_PERIOD_DAYS", label: "催告期間（日）", section: "売買条件" },
  { key: "DELIVERY_DAYS_AFTER_PAYMENT", label: "入金後納品日数", section: "売買条件" },
  { key: "COD_DELIVERY_DAYS", label: "代引納品日数", section: "売買条件" },
  { key: "PREPAY_DEADLINE_DAYS", label: "前払期限（日）", section: "売買条件" },
  { key: "MONTHLY_CLOSING_DAY", label: "月次締め日", section: "売買条件" },
  { key: "PAYMENT_DUE_DAY", label: "支払期日", section: "売買条件" },
  { key: "SECURITY_DEPOSIT_AMOUNT", label: "保証金額", section: "売買条件" },
  { key: "DEPOSIT_REPLENISH_DAYS", label: "保証金補充期限（日）", section: "売買条件" },
  { key: "DELIVERY_FEE_THRESHOLD", label: "送料負担閾値", section: "売買条件" },
  { key: "SPECIAL_TERMS", label: "特約事項", section: "特記事項", multiline: true },
  { key: "REMARKS", label: "備考", section: "特記事項", multiline: true },
];

function getContractDraftFieldKeysForIssueType(issueTypeName: string): string[] {
  const commonBase = [
    "CONTRACT_NO",
    "CONTRACT_DATE",
    "PARTY_A_NAME",
    "PARTY_A_ADDRESS",
    "PARTY_A_REPRESENTATIVE",
    "STAFF_DEPARTMENT",
    "STAFF_NAME",
    "STAFF_PHONE",
    "STAFF_EMAIL",
    "PARTY_B_NAME",
    "PARTY_B_ADDRESS",
    "PARTY_B_REPRESENTATIVE",
    "JURISDICTION",
    "SPECIAL_TERMS",
    "REMARKS",
  ];

  if (issueTypeName === "NDA") {
    return [
      ...commonBase,
      "NDA_PURPOSE",
      "CONTRACT_PERIOD",
      "CONFIDENTIALITY_PERIOD",
    ];
  }

  if (issueTypeName === "業務委託基本契約" || issueTypeName === "業務委託契約") {
    return [
      ...commonBase,
      "VENDOR_NAME",
      "VENDOR_ADDRESS",
      "VENDOR_REP",
      "VENDOR_PHONE",
      "VENDOR_EMAIL",
      "BANK_NAME",
      "BRANCH_NAME",
      "ACCOUNT_TYPE",
      "ACCOUNT_NUMBER",
      "ACCOUNT_HOLDER_KANA",
      "IS_INVOICE_ISSUER",
      "invoiceRegistrationDisplay",
    ];
  }

  if (issueTypeName === "ライセンス契約") {
    return [
      ...commonBase,
      "VENDOR_NAME",
      "VENDOR_ADDRESS",
      "VENDOR_REP",
      "VENDOR_PHONE",
      "VENDOR_EMAIL",
      "BANK_NAME",
      "BRANCH_NAME",
      "ACCOUNT_TYPE",
      "ACCOUNT_NUMBER",
      "ACCOUNT_HOLDER_KANA",
      "IS_INVOICE_ISSUER",
      "invoiceRegistrationDisplay",
      "ORIGINAL_WORK",
      "ORIGINAL_AUTHOR",
      "CREDIT_NAME",
    ];
  }

  if (issueTypeName === "個別利用許諾条件") {
    return [
      ...commonBase,
      "LICENSE_ISSUE_KEY",
      "LICENSE_TYPE_NAME",
      "LICENSE_START",
      "LICENSE_REGION_LANGUAGE_LABEL",
      "ORIGINAL_WORK",
      "ORIGINAL_AUTHOR",
      "CREDIT_NAME",
      "PRODUCT_NAME",
      "MATERIAL_CODE",
      "MATERIAL_NAME",
      "MATERIAL_RIGHTS_HOLDER",
      "SUPERVISOR",
      "CONDITION1_HEADING",
      "CONDITION1_CALC_METHOD",
      "CONDITION1_FORMULA",
      "CONDITION1_BASE_PRICE_LABEL",
      "CONDITION1_RATE",
      "CONDITION1_PAYMENT_TERMS",
      "CONDITION1_MG_AG",
      "CONDITION1_NOTE",
      "CONDITION2_HEADING",
      "CONDITION2_REGION",
      "CONDITION2_LANGUAGE",
      "CONDITION2_CALC_METHOD",
      "CONDITION2_SUMMARY",
      "CONDITION2_FORMULA",
      "CONDITION2_SHARE_RATE",
      "CONDITION2_PAYMENT_TERMS",
      "CONDITION2_MG_AG",
      "CONDITION2_NOTE",
      "CONDITION3_HEADING",
      "CONDITION3_REGION",
      "CONDITION3_LANGUAGE",
      "CONDITION3_CALC_METHOD",
      "CONDITION3_SUMMARY",
      "CONDITION3_FORMULA",
      "CONDITION3_RATE",
      "CONDITION3_PAYMENT_TERMS",
      "CONDITION3_MG_AG",
      "CONDITION3_NOTE",
      "SPECIAL_TERMS",
      "REMARKS",
    ];
  }

  if (issueTypeName === "売買契約（当社買手）") {
    return [
      ...commonBase,
      "PRODUCT_SCOPE",
      "DELIVERY_LOCATION",
      "INSPECTION_PERIOD_DAYS",
      "PAYMENT_CONDITION_SUMMARY",
      "WARRANTY_PERIOD",
      "CONFIDENTIALITY_YEARS",
      "CURE_PERIOD_DAYS",
    ];
  }

  if (issueTypeName === "売買契約（当社売手・標準）") {
    return [
      ...commonBase,
      "INSPECTION_PERIOD_DAYS",
      "WARRANTY_PERIOD",
      "CONFIDENTIALITY_YEARS",
      "DELIVERY_DAYS_AFTER_PAYMENT",
      "COD_DELIVERY_DAYS",
      "PREPAY_DEADLINE_DAYS",
    ];
  }

  if (issueTypeName === "売買契約（当社売手・保証金掛け売り）") {
    return [
      ...commonBase,
      "INSPECTION_PERIOD_DAYS",
      "WARRANTY_PERIOD",
      "CONFIDENTIALITY_YEARS",
      "MONTHLY_CLOSING_DAY",
      "PAYMENT_DUE_DAY",
      "SECURITY_DEPOSIT_AMOUNT",
      "DEPOSIT_REPLENISH_DAYS",
      "DELIVERY_FEE_THRESHOLD",
    ];
  }

  return CONTRACT_DRAFT_FIELDS.map((field) => field.key);
}

function getContractIssueTypeNames(): Set<string> {
  return new Set([
    "NDA",
    "業務委託基本契約",
    "業務委託契約",
    "ライセンス契約",
    "個別利用許諾条件",
    "売買契約（当社買手）",
    "売買契約（当社売手・標準）",
    "売買契約（当社売手・保証金掛け売り）",
  ]);
}

function getOrderIssueTypeNames(): Set<string> {
  return new Set([
    process.env.BACKLOG_ISSUE_TYPE_ORDER ?? "発注書",
    process.env.BACKLOG_ISSUE_TYPE_PLANNING_ORDER ?? "企画発注書",
    process.env.BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER ?? "出版発注書",
  ]);
}

function getDeliveryIssueTypeNames(): Set<string> {
  return new Set([
    process.env.BACKLOG_ISSUE_TYPE_DELIVERY ?? "納品リクエスト",
    "納品報告",
  ]);
}

function summarizeContractNextAction(statusName?: string | null, hasPrimaryDocument?: boolean): string {
  if (!hasPrimaryDocument) return "次: 契約本文を確認";
  if ((statusName || "").includes("押印")) return "次: 押印状況を確認";
  if ((statusName || "").includes("承認")) return "次: 承認状況を確認";
  return "次: 契約書生成画面を開く";
}

function summarizeRoyaltyNextAction(statusName?: string | null, issueTypeName?: string | null): string {
  if ((statusName || "").includes("完了")) return "次: 生成結果を確認";
  if ((issueTypeName || "").includes("売上")) return "次: 売上条件を確認";
  return "次: 計算条件を確認";
}

async function buildContractDraft(issueKey: string, issue: Awaited<ReturnType<typeof backlog.getIssue>>) {
  const workflow = await findIssueWorkflowByIssueKey(issueKey);
  const legalRequest = await findLegalRequestByBacklogKey(issueKey);
  const requesterSlackId = resolveRequesterSlackId(issue, legalRequest);
  const staff = requesterSlackId ? await findStaffBySlackUserId(requesterSlackId) : null;
  const counterparty = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY);
  const vendor = await matchVendor({ vendorName: counterparty || undefined });
  const savedDraft = normalizeContractDraft(workflow?.documentDraft);
  const contractDate = resolveIssueDocumentDate(issue);
  const contractNo = await resolveIssueDocumentNumber(backlog, issue, {
    partyAName: staff?.partyAName,
    departmentCode: staff?.departmentCode ?? undefined,
  });

  const draft = {
    CONTRACT_NO: contractNo,
    CONTRACT_DATE: contractDate,
    PARTY_A_NAME: staff?.partyAName ?? "",
    PARTY_A_ADDRESS: staff?.partyAAddress ?? "",
    PARTY_A_REPRESENTATIVE: staff?.partyARep ?? "",
    STAFF_DEPARTMENT: staff?.department ?? "",
    STAFF_NAME: staff?.staffName ?? "",
    STAFF_PHONE: staff?.phone ?? "",
    STAFF_EMAIL: staff?.email ?? "",
    PARTY_B_NAME: counterparty,
    PARTY_B_ADDRESS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY_ADDRESS),
    PARTY_B_REPRESENTATIVE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY_REP),
    VENDOR_NAME: counterparty || vendor?.vendorName || "",
    VENDOR_ADDRESS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY_ADDRESS) || vendor?.address || "",
    VENDOR_REP: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY_REP) || vendor?.vendorRepresentative || vendor?.contactName || "",
    VENDOR_PHONE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_VENDOR_PHONE) || vendor?.phone || "",
    VENDOR_EMAIL: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_VENDOR_EMAIL) || vendor?.email || "",
    BANK_NAME: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_BANK_NAME) || vendor?.bankName || "",
    BRANCH_NAME: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_BRANCH_NAME) || vendor?.branchName || "",
    ACCOUNT_TYPE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCOUNT_TYPE) || vendor?.accountType || "",
    ACCOUNT_NUMBER: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCOUNT_NUMBER) || vendor?.accountNumber || "",
    ACCOUNT_HOLDER_KANA: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCOUNT_HOLDER_KANA) || vendor?.accountHolderKana || "",
    IS_INVOICE_ISSUER: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_IS_INVOICE_ISSUER) || (vendor?.isInvoiceIssuer ? "true" : ""),
    invoiceRegistrationDisplay: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER) || vendor?.invoiceRegistrationNumber || "",
    JURISDICTION: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_JURISDICTION) || "東京地方裁判所",
    NDA_PURPOSE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_NDA_PURPOSE),
    CONTRACT_PERIOD: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONTRACT_PERIOD),
    CONFIDENTIALITY_PERIOD: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONFIDENTIALITY_PERIOD),
    ORIGINAL_WORK: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_ORIGINAL_WORK),
    ORIGINAL_AUTHOR: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_ORIGINAL_AUTHOR),
    CREDIT_NAME: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CREDIT_NAME),
    LICENSE_ISSUE_KEY: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_LICENSE_KEY),
    LICENSE_TYPE_NAME: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_LICENSE_TYPE_NAME),
    LICENSE_START: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_LICENSE_START),
    LICENSE_REGION_LANGUAGE_LABEL: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_TERRITORY),
    PRODUCT_NAME: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PRODUCT_NAME),
    MATERIAL_CODE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_MATERIAL_CODE),
    MATERIAL_NAME: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_MATERIAL_NAME),
    MATERIAL_RIGHTS_HOLDER: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_MATERIAL_RIGHTS_HOLDER),
    SUPERVISOR: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_SUPERVISOR),
    CONDITION1_HEADING: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION1_HEADING),
    CONDITION1_CALC_METHOD: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION1_CALC_METHOD),
    CONDITION1_FORMULA: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION1_FORMULA),
    CONDITION1_BASE_PRICE_LABEL: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION1_BASE_PRICE_LABEL),
    CONDITION1_RATE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION1_RATE),
    CONDITION1_PAYMENT_TERMS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION1_PAYMENT_TERMS),
    CONDITION1_MG_AG: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION1_MG_AG),
    CONDITION1_NOTE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION1_NOTE),
    CONDITION2_HEADING: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_HEADING),
    CONDITION2_REGION: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_REGION),
    CONDITION2_LANGUAGE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_LANGUAGE),
    CONDITION2_CALC_METHOD: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_CALC_METHOD),
    CONDITION2_SUMMARY: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_SUMMARY),
    CONDITION2_FORMULA: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_FORMULA),
    CONDITION2_SHARE_RATE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_SHARE_RATE),
    CONDITION2_PAYMENT_TERMS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_PAYMENT_TERMS),
    CONDITION2_MG_AG: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_MG_AG),
    CONDITION2_NOTE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION2_NOTE),
    CONDITION3_HEADING: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_HEADING),
    CONDITION3_REGION: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_REGION),
    CONDITION3_LANGUAGE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_LANGUAGE),
    CONDITION3_CALC_METHOD: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_CALC_METHOD),
    CONDITION3_SUMMARY: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_SUMMARY),
    CONDITION3_FORMULA: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_FORMULA),
    CONDITION3_RATE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_RATE),
    CONDITION3_PAYMENT_TERMS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_PAYMENT_TERMS),
    CONDITION3_MG_AG: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_MG_AG),
    CONDITION3_NOTE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONDITION3_NOTE),
    PRODUCT_SCOPE: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PRODUCT_SCOPE),
    DELIVERY_LOCATION: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DELIVERY_LOCATION),
    INSPECTION_PERIOD_DAYS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_INSPECTION_PERIOD_DAYS),
    PAYMENT_CONDITION_SUMMARY: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY),
    WARRANTY_PERIOD: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_WARRANTY_PERIOD),
    CONFIDENTIALITY_YEARS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONFIDENTIALITY_YEARS),
    CURE_PERIOD_DAYS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_CURE_PERIOD_DAYS),
    DELIVERY_DAYS_AFTER_PAYMENT: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DELIVERY_DAYS_AFTER_PAYMENT),
    COD_DELIVERY_DAYS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_COD_DELIVERY_DAYS),
    PREPAY_DEADLINE_DAYS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PREPAY_DEADLINE_DAYS),
    MONTHLY_CLOSING_DAY: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_MONTHLY_CLOSING_DAY),
    PAYMENT_DUE_DAY: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PAYMENT_DUE_DAY),
    SECURITY_DEPOSIT_AMOUNT: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_SECURITY_DEPOSIT_AMOUNT),
    DEPOSIT_REPLENISH_DAYS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DEPOSIT_REPLENISH_DAYS),
    DELIVERY_FEE_THRESHOLD: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DELIVERY_FEE_THRESHOLD),
    SPECIAL_TERMS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_SPECIAL_NOTES),
    REMARKS: getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_REMARKS),
    ...savedDraft,
  };

  const warnings = buildContractWarnings({
    issueTypeName: issue.issueType?.name ?? "",
    draft,
    hasVendorMatch: Boolean(vendor),
  });

  return { draft, warnings, workflow, legalRequest, staff, vendor };
}

function normalizeContractDraft(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => [key, rawValue == null ? "" : String(rawValue)])
  );
}

type ContractPreflightStatus = "ready" | "warn" | "stop";
type ContractPreflightWarning = { level: "stop" | "warn"; message: string; fieldKey?: string };
type ContractPreflightStep = {
  key: string;
  label: string;
  status: ContractPreflightStatus;
  detail: string;
};

async function buildContractPreflight(input: {
  issueKey: string;
  issue: Awaited<ReturnType<typeof backlog.getIssue>>;
  issueTypeName: string;
  draft: Record<string, string>;
  warnings: ContractPreflightWarning[];
  workflow: Awaited<ReturnType<typeof findIssueWorkflowByIssueKey>> | null;
  legalRequest: Awaited<ReturnType<typeof findLegalRequestByBacklogKey>> | null;
  staff: Awaited<ReturnType<typeof findStaffBySlackUserId>> | null;
  vendor: Awaited<ReturnType<typeof matchVendor>> | null;
}): Promise<{
  overallStatus: ContractPreflightStatus;
  summary: string;
  steps: ContractPreflightStep[];
}> {
  const steps: ContractPreflightStep[] = [];
  const customFieldCount = input.issue.customFields?.length ?? 0;
  const hasBlockingWarning = input.warnings.some((warning) => warning.level === "stop");
  const hasWarning = input.warnings.length > 0;
  const requiresVendorMaster = input.issueTypeName !== "NDA" && input.issueTypeName !== "個別利用許諾条件";
  const driveFolderKey = resolveDriveFolderKey(input.legalRequest);
  const driveFolderLabel = resolveDriveFolderLabel(driveFolderKey);
  const driveFolderId = resolveDriveFolderId(driveFolderKey);
  const hasDriveKeyFile = Boolean(String(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? "").trim());

  steps.push({
    key: "backlog",
    label: "Backlog課題",
    status: input.issueTypeName ? (customFieldCount > 0 ? "ready" : "warn") : "stop",
    detail: input.issueTypeName
      ? `${input.issueKey} / ${input.issueTypeName} / カスタム属性 ${customFieldCount} 件`
      : "課題タイプが取得できていません。",
  });

  const sourceParts: string[] = [];
  if (input.draft.PARTY_B_NAME || input.draft.VENDOR_NAME) {
    sourceParts.push(`相手方: ${input.draft.PARTY_B_NAME || input.draft.VENDOR_NAME}`);
  } else {
    sourceParts.push("相手方未設定");
  }
  if (input.staff) {
    sourceParts.push(`Staff: ${input.staff.staffName}${input.staff.department ? ` / ${input.staff.department}` : ""}`);
  } else {
    sourceParts.push("Staff未補完");
  }
  if (input.vendor) {
    sourceParts.push(`Vendor: ${input.vendor.vendorCode} / ${input.vendor.vendorName}`);
  } else if (requiresVendorMaster) {
    sourceParts.push("Vendorマスタ未一致");
  } else {
    sourceParts.push("Vendor補完は任意");
  }
  const sourceStatus: ContractPreflightStatus = !input.draft.PARTY_B_NAME
    ? "stop"
    : (!input.staff || (requiresVendorMaster && !input.vendor))
      ? "warn"
      : "ready";
  steps.push({
    key: "sources",
    label: "補完データ",
    status: sourceStatus,
    detail: sourceParts.join(" / "),
  });

  steps.push({
    key: "draft",
    label: "下書き整合",
    status: hasBlockingWarning ? "stop" : hasWarning ? "warn" : "ready",
    detail: hasBlockingWarning
      ? `${input.warnings.filter((warning) => warning.level === "stop").length} 件の停止項目があります。`
      : hasWarning
        ? `${input.warnings.length} 件の注意項目があります。`
        : "停止項目・注意項目ともにありません。",
  });

  try {
    const renderItems = await buildRenderItemsForIssue(
      input.issueKey,
      input.issueTypeName,
      {
        keyId: input.issue.id,
        summary: input.issue.summary,
        status: input.issue.status,
        issueType: input.issue.issueType,
        customFields: input.issue.customFields,
        created: input.issue.created,
        updated: input.issue.updated,
      },
      input.draft,
    );
    steps.push({
      key: "render",
      label: "テンプレート解決",
      status: renderItems.length > 0 ? "ready" : "stop",
      detail: renderItems.length > 0
        ? `${renderItems.length} 件のテンプレートを解決: ${renderItems.map((item) => item.templateKey).join(", ")}`
        : "この課題タイプに対応するテンプレートが見つかりません。",
    });
  } catch (error) {
    steps.push({
      key: "render",
      label: "テンプレート解決",
      status: "stop",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const driveStatus: ContractPreflightStatus = hasDriveKeyFile && driveFolderId
    ? "ready"
    : hasDriveKeyFile || driveFolderId
      ? "warn"
      : "warn";
  steps.push({
    key: "output",
    label: "出力先",
    status: driveStatus,
    detail: hasDriveKeyFile && driveFolderId
      ? `Drive保存先: ${driveFolderLabel} (${driveFolderKey})`
      : `Drive保存は未完全です。フォルダ: ${driveFolderLabel} (${driveFolderKey}) / ${hasDriveKeyFile ? "サービスアカウントキーあり" : "サービスアカウントキー未設定"} / ${driveFolderId ? "フォルダIDあり" : "フォルダID未設定"}。ローカル生成は継続できます。`,
  });

  const generatedDocuments = Array.isArray(input.workflow?.generatedDocuments)
    ? input.workflow.generatedDocuments
    : [];
  steps.push({
    key: "history",
    label: "生成履歴",
    status: generatedDocuments.length > 0 ? "ready" : "warn",
    detail: generatedDocuments.length > 0
      ? `過去に ${generatedDocuments.length} 件の生成履歴があります。`
      : "まだ生成履歴はありません。今回が初回生成です。",
  });

  const overallStatus: ContractPreflightStatus = steps.some((step) => step.status === "stop")
    ? "stop"
    : steps.some((step) => step.status === "warn")
      ? "warn"
      : "ready";
  const summary = overallStatus === "stop"
    ? "停止項目があります。下書きまたはBacklog設定を修正してから生成してください。"
    : overallStatus === "warn"
      ? "生成は可能ですが、補完不足や出力先設定を確認してから進めるのが安全です。"
      : "契約書生成の主要工程は準備完了です。文面プレビュー後に生成へ進めます。";

  return { overallStatus, summary, steps };
}

function buildContractGenerationReport(input: {
  generatedDocuments: Array<{ name?: string; url?: string; localPath?: string }>;
  legalRequest?: Awaited<ReturnType<typeof findLegalRequestByBacklogKey>> | null;
  statusUpdatedTo?: string | null;
}): {
  summary: string;
  driveFolderKey: string;
  driveFolderLabel: string;
  driveEnabled: boolean;
  driveDocumentCount: number;
  localDocumentCount: number;
  statusUpdatedTo: string | null;
  generatedDocuments: Array<{ name?: string; url?: string; localPath?: string }>;
} {
  const driveFolderKey = resolveDriveFolderKey(input.legalRequest);
  const driveFolderLabel = resolveDriveFolderLabel(driveFolderKey);
  const driveEnabled = Boolean(resolveDriveFolderId(driveFolderKey) && String(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? "").trim());
  const driveDocumentCount = input.generatedDocuments.filter((doc) => Boolean(doc.url)).length;
  const localDocumentCount = input.generatedDocuments.filter((doc) => Boolean(doc.localPath)).length;
  const summary = input.generatedDocuments.length > 0
    ? `${input.generatedDocuments.length} 件の文書を生成しました。${driveDocumentCount > 0 ? ` Drive ${driveDocumentCount} 件` : ""}${localDocumentCount > 0 ? ` / ローカル ${localDocumentCount} 件` : ""}`.trim()
    : "生成済み文書を確認できませんでした。";

  return {
    summary,
    driveFolderKey,
    driveFolderLabel,
    driveEnabled,
    driveDocumentCount,
    localDocumentCount,
    statusUpdatedTo: input.statusUpdatedTo ?? null,
    generatedDocuments: input.generatedDocuments,
  };
}

function buildContractNextActions(input: {
  statusUpdatedTo?: string | null;
  generatedDocuments: Array<{ name?: string; url?: string; localPath?: string }>;
}): string[] {
  const actions: string[] = [];
  if (input.generatedDocuments.length > 0) {
    actions.push("生成済み文書のリンクを開き、体裁と差し込み値を確認する");
  }
  if (input.statusUpdatedTo) {
    actions.push(`Backlog の状態が「${input.statusUpdatedTo}」へ変わったか確認する`);
  }
  actions.push("必要なら承認・押印フローへ進める");
  return actions;
}

function normalizeGeneratedDocuments(value: unknown): Array<{ name?: string; url?: string; localPath?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      name: item.name == null ? undefined : String(item.name),
      url: item.url == null ? undefined : String(item.url),
      localPath: item.localPath == null ? undefined : String(item.localPath),
    }));
}

function buildContractWarnings(input: {
  issueTypeName: string;
  draft: Record<string, string>;
  hasVendorMatch: boolean;
}): ContractPreflightWarning[] {
  const warnings: ContractPreflightWarning[] = [];
  if (!input.draft.PARTY_B_NAME) warnings.push({ level: "stop", message: "相手方名が未設定です。", fieldKey: "PARTY_B_NAME" });
  if (!input.draft.PARTY_B_ADDRESS) warnings.push({ level: "warn", message: "相手方住所が未設定です。", fieldKey: "PARTY_B_ADDRESS" });
  if (!input.draft.PARTY_B_REPRESENTATIVE) warnings.push({ level: "warn", message: "相手方代表者が未設定です。", fieldKey: "PARTY_B_REPRESENTATIVE" });
  if (!input.draft.PARTY_A_NAME) warnings.push({ level: "warn", message: "当社名が未設定です。Staffマスタまたは下書きで補完してください。", fieldKey: "PARTY_A_NAME" });
  if (!input.draft.PARTY_A_ADDRESS) warnings.push({ level: "warn", message: "当社住所が未設定です。", fieldKey: "PARTY_A_ADDRESS" });
  if (!input.draft.PARTY_A_REPRESENTATIVE) warnings.push({ level: "warn", message: "当社代表者が未設定です。", fieldKey: "PARTY_A_REPRESENTATIVE" });
  if (!input.draft.CONTRACT_DATE) warnings.push({ level: "warn", message: "契約日が未設定です。", fieldKey: "CONTRACT_DATE" });
  if (!input.hasVendorMatch && input.issueTypeName !== "NDA" && input.issueTypeName !== "個別利用許諾条件") {
    warnings.push({ level: "warn", message: "Vendorマスタが未一致です。口座情報は下書きで補完してください。", fieldKey: "VENDOR_NAME" });
  }
  if (input.issueTypeName === "個別利用許諾条件" && !input.draft.LICENSE_ISSUE_KEY) {
    warnings.push({ level: "stop", message: "親ライセンス課題キーが未設定です。", fieldKey: "LICENSE_ISSUE_KEY" });
  }
  if (input.issueTypeName === "個別利用許諾条件" && !input.draft.LICENSE_TYPE_NAME) {
    warnings.push({ level: "warn", message: "許諾区分が未設定です。", fieldKey: "LICENSE_TYPE_NAME" });
  }
  if (input.issueTypeName === "個別利用許諾条件" && !input.draft.MATERIAL_NAME) {
    warnings.push({ level: "warn", message: "素材名が未設定です。", fieldKey: "MATERIAL_NAME" });
  }
  if (input.issueTypeName === "個別利用許諾条件" && !input.draft.CONDITION1_FORMULA) {
    warnings.push({ level: "warn", message: "金銭条件1の計算式が未設定です。", fieldKey: "CONDITION1_FORMULA" });
  }
  return warnings;
}

function getContractEditorGuide(issueTypeName: string): {
  title: string;
  summary: string;
  flow: string;
} {
  if (issueTypeName === "ライセンス契約") {
    return {
      title: "ライセンス基本契約の編集",
      summary: "基本契約の当事者情報と一般条項を確認する画面です。個別の許諾条件や金銭条件は、この後に個別利用許諾条件で扱います。",
      flow: "基本契約を確認・編集 → 文書生成 → 個別利用許諾条件を作成 → 利用許諾料計算へ進行",
    };
  }

  if (issueTypeName === "個別利用許諾条件") {
    return {
      title: "個別利用許諾条件の編集",
      summary: "親ライセンス課題にぶら下がる案件別条件の編集画面です。素材情報、許諾対象、個別の条件整理をここで行います。",
      flow: "親ライセンス課題キーを確認 → 個別条件を編集 → 文書生成 → 利用許諾料計算へ進行",
    };
  }

  if (issueTypeName === "NDA") {
    return {
      title: "NDAの編集",
      summary: "秘密保持契約の基本条件を確認する画面です。口座情報は不要のため表示しません。",
      flow: "相手方情報とNDA条件を確認 → 文書生成 → 承認へ進行",
    };
  }

  return {
    title: "契約書編集",
    summary: "Backlog と DB の既定値を確認しながら、文書生成前の最終編集を行う画面です。",
    flow: "Backlog確認 → 編集・保存 → 文書生成 → Backlog状態更新 → 後続フローへ進行",
  };
}

function buildLicenseMoneyConditionSummaries(draft: Record<string, string>) {
  return [
    summarizeLicenseMoneyCondition({
      heading: draft.CONDITION1_HEADING || "金銭条件1",
      calcMethod: draft.CONDITION1_CALC_METHOD,
      formula: draft.CONDITION1_FORMULA,
      basePriceLabel: draft.CONDITION1_BASE_PRICE_LABEL,
      rateLabel: draft.CONDITION1_RATE,
      paymentTerms: draft.CONDITION1_PAYMENT_TERMS,
      mgAgLabel: draft.CONDITION1_MG_AG,
    }),
    summarizeLicenseMoneyCondition({
      heading: draft.CONDITION2_HEADING || "金銭条件2",
      calcMethod: draft.CONDITION2_CALC_METHOD,
      formula: draft.CONDITION2_FORMULA,
      shareRateLabel: draft.CONDITION2_SHARE_RATE,
      paymentTerms: draft.CONDITION2_PAYMENT_TERMS,
      mgAgLabel: draft.CONDITION2_MG_AG,
      summary: draft.CONDITION2_SUMMARY,
      region: draft.CONDITION2_REGION,
      language: draft.CONDITION2_LANGUAGE,
    }),
    summarizeLicenseMoneyCondition({
      heading: draft.CONDITION3_HEADING || "金銭条件3",
      calcMethod: draft.CONDITION3_CALC_METHOD,
      formula: draft.CONDITION3_FORMULA,
      rateLabel: draft.CONDITION3_RATE,
      paymentTerms: draft.CONDITION3_PAYMENT_TERMS,
      mgAgLabel: draft.CONDITION3_MG_AG,
      summary: draft.CONDITION3_SUMMARY,
      region: draft.CONDITION3_REGION,
      language: draft.CONDITION3_LANGUAGE,
    }),
  ].filter((item) => item.formula || item.paymentTerms || item.parsedRate != null || item.parsedDistributionRate != null || item.parsedFixedAmount != null || item.parsedMgAmount != null);
}

function buildDeliveryPreviewWarnings(input: {
  mode?: "tracking" | "generate";
  parentIssueKey?: string | null;
  deliveredAmount?: string;
  finalDeadline?: string | null;
  inspectionDate?: string | null;
  paymentPlannedDate?: string | null;
  hasDeliveryEvent: boolean;
  paymentCondition?: {
    closingDay: string;
    paymentOffset: string;
    paymentDay: string;
    inspectionDays: number;
    taxRate: number;
    vendorInvoiceNum?: string;
  } | null;
}): Array<{ level: "stop" | "warn"; message: string }> {
  const warnings: Array<{ level: "stop" | "warn"; message: string }> = [];
  const mode = input.mode ?? "generate";
  const deliveredAmountValue = input.deliveredAmount
    ? Number(String(input.deliveredAmount).replace(/[,，]/g, ""))
    : 0;
  const deliveryStarted = input.hasDeliveryEvent
    || deliveredAmountValue > 0
    || Boolean(input.inspectionDate)
    || Boolean(input.paymentPlannedDate);

  if (!input.parentIssueKey) {
    warnings.push({ level: "stop", message: "親発注課題キーが未設定です。" });
  }
  if ((mode === "generate" || deliveryStarted) && !input.hasDeliveryEvent) {
    warnings.push({ level: "stop", message: "DeliveryEvent が未登録です。先に納品受付を行ってください。" });
  }
  if ((mode === "generate" || deliveryStarted) && deliveredAmountValue <= 0) {
    warnings.push({ level: "stop", message: "今回納品金額が未設定、または0です。" });
  }
  if (!input.finalDeadline) {
    warnings.push({ level: "warn", message: "納期 / 校了予定が未設定です。" });
  }
  if ((mode === "generate" || deliveryStarted) && !input.inspectionDate) {
    warnings.push({ level: "warn", message: "検収日が未設定です。" });
  }
  if ((mode === "generate" || deliveryStarted) && !input.paymentPlannedDate) {
    warnings.push({ level: "warn", message: "支払予定日が未設定です。" });
  }

  if ((mode === "generate" || deliveryStarted) && !input.paymentCondition) {
    warnings.push({ level: "warn", message: "親発注課題の支払条件が取得できていません。既定値で生成されます。" });
  } else if (mode === "generate" || deliveryStarted) {
    if (!input.paymentCondition?.vendorInvoiceNum) {
      warnings.push({ level: "warn", message: "Vendor請求書番号が未設定です。" });
    }
  }

  return warnings;
}

type DeliveryPreflightStatus = "ready" | "warn" | "stop";
type DeliveryPreflightStep = {
  key: string;
  label: string;
  status: DeliveryPreflightStatus;
  detail: string;
};

function buildDeliveryPreflight(input: {
  issueKey: string;
  parentIssueKey?: string | null;
  hasDeliveryEvent: boolean;
  deliveredAmount?: string;
  finalDeadline?: string | null;
  inspectionDate?: string | null;
  paymentPlannedDate?: string | null;
  paymentCondition?: {
    closingDay: string;
    paymentOffset: string;
    paymentDay: string;
    inspectionDays: number;
    taxRate: number;
    vendorInvoiceNum?: string;
  } | null;
  warnings: Array<{ level: "stop" | "warn"; message: string }>;
}): {
  overallStatus: DeliveryPreflightStatus;
  summary: string;
  steps: DeliveryPreflightStep[];
} {
  const steps: DeliveryPreflightStep[] = [];
  const deliveredAmountValue = Number(String(input.deliveredAmount ?? "").replace(/[,，]/g, ""));

  steps.push({
    key: "parent",
    label: "親発注課題",
    status: input.parentIssueKey ? "ready" : "stop",
    detail: input.parentIssueKey ? `親課題: ${input.parentIssueKey}` : "親発注課題キーが未設定です。",
  });
  steps.push({
    key: "delivery_event",
    label: "DeliveryEvent",
    status: input.hasDeliveryEvent ? "ready" : "stop",
    detail: input.hasDeliveryEvent ? "DeliveryEvent を確認できました。" : "DeliveryEvent が未登録です。",
  });
  steps.push({
    key: "amount",
    label: "今回納品金額",
    status: Number.isFinite(deliveredAmountValue) && deliveredAmountValue > 0 ? "ready" : "stop",
    detail: Number.isFinite(deliveredAmountValue) && deliveredAmountValue > 0
      ? `今回納品金額: ¥${deliveredAmountValue.toLocaleString("ja-JP")}`
      : "今回納品金額が未設定、または 0 円です。",
  });
  steps.push({
    key: "deadline",
    label: "納期 / 校了予定",
    status: input.finalDeadline ? "ready" : "warn",
    detail: input.finalDeadline ? `納期 / 校了予定: ${input.finalDeadline}` : "納期 / 校了予定が未設定です。",
  });
  steps.push({
    key: "inspection_date",
    label: "検収日",
    status: input.inspectionDate ? "ready" : "warn",
    detail: input.inspectionDate ? `検収日: ${input.inspectionDate}` : "検収日が未設定です。",
  });
  steps.push({
    key: "payment_planned_date",
    label: "支払予定日",
    status: input.paymentPlannedDate ? "ready" : "warn",
    detail: input.paymentPlannedDate ? `支払予定日: ${input.paymentPlannedDate}` : "支払予定日が未設定です。",
  });
  steps.push({
    key: "payment",
    label: "支払条件",
    status: input.paymentCondition
      ? (input.paymentCondition.vendorInvoiceNum ? "ready" : "warn")
      : "warn",
    detail: input.paymentCondition
      ? `締め日 ${input.paymentCondition.closingDay} / 支払 ${input.paymentCondition.paymentOffset} か月後 ${input.paymentCondition.paymentDay} / 検収 ${input.paymentCondition.inspectionDays} 日`
      : "親発注課題の支払条件が未取得です。既定値で継続します。",
  });
  steps.push({
    key: "warnings",
    label: "事前警告",
    status: input.warnings.some((warning) => warning.level === "stop")
      ? "stop"
      : input.warnings.length > 0
        ? "warn"
        : "ready",
    detail: input.warnings.length > 0
      ? input.warnings.map((warning) => warning.message).join(" / ")
      : "停止項目・注意項目ともにありません。",
  });

  const overallStatus: DeliveryPreflightStatus = steps.some((step) => step.status === "stop")
    ? "stop"
    : steps.some((step) => step.status === "warn")
      ? "warn"
      : "ready";
  const summary = overallStatus === "stop"
    ? "停止項目があります。納品受付情報を修正してから生成してください。"
    : overallStatus === "warn"
      ? "生成は可能ですが、支払条件や請求書番号を確認してから進めるのが安全です。"
      : "納品帳票生成の主要工程は準備完了です。";

  return { overallStatus, summary, steps };
}

function buildDeliveryGenerationReport(input: {
  inspectionCert: { filename: string; localPath: string; driveUrl?: string };
  paymentNotice?: { filename: string; localPath: string; driveUrl?: string } | null;
  statusUpdatedTo?: string | null;
  statusSyncError?: string | null;
}): {
  summary: string;
  driveDocumentCount: number;
  localDocumentCount: number;
  documents: Array<{ filename: string; localPath: string; driveUrl?: string }>;
  statusUpdatedTo: string | null;
  statusSyncError: string | null;
} {
  const documents = [input.inspectionCert, ...(input.paymentNotice ? [input.paymentNotice] : [])];
  return {
    summary: `${documents.length} 件の帳票を生成しました。`,
    driveDocumentCount: documents.filter((doc) => Boolean(doc.driveUrl)).length,
    localDocumentCount: documents.filter((doc) => Boolean(doc.localPath)).length,
    documents,
    statusUpdatedTo: input.statusUpdatedTo ?? null,
    statusSyncError: input.statusSyncError ?? null,
  };
}

function buildDeliveryNextActions(input: {
  paymentNotice?: { filename: string; localPath: string; driveUrl?: string } | null;
}): string[] {
  return [
    "検収書を開き、明細・納品金額・検収日を確認する",
    input.paymentNotice
      ? "支払通知書を開き、支払期日と支払先情報を確認する"
      : "支払通知書は未発行のため、最終納品時に再確認する",
    "必要なら親発注課題側の納品進捗も確認する",
  ];
}

function buildRoyaltyPreflight(input: {
  issueKey: string;
  licenseIssueKey?: string | null;
  productName?: string;
  completionDate?: string;
  quantity?: string;
  msrp?: string;
  hasManufacturingEvent: boolean;
  resolvedLicenseCondition?: {
    source: "license_fields" | "license_condition1_fallback";
    calcTypeLabel: string;
    rateSource: string | null;
    mgSource: string | null;
    requestedConditionNo: 1 | 2 | 3;
    resolvedConditionNo: 1 | 2 | 3;
    conditionHeading?: string | null;
  } | null;
  warnings: Array<{ level: "stop" | "warn"; message: string }>;
}): {
  overallStatus: "ready" | "warn" | "stop";
  summary: string;
  steps: Array<{ key: string; label: string; status: "ready" | "warn" | "stop"; detail: string }>;
} {
  const steps = [
    {
      key: "license",
      label: "ライセンス紐付け",
      status: input.licenseIssueKey ? "ready" : "stop",
      detail: input.licenseIssueKey ? `ライセンス課題: ${input.licenseIssueKey}` : "紐付けライセンス課題が未設定です。",
    },
    {
      key: "product",
      label: "製造情報",
      status: input.productName && input.completionDate && Number(input.quantity || 0) > 0 ? "ready" : "stop",
      detail: input.productName
        ? `${input.productName}${input.completionDate ? ` / 完了日 ${input.completionDate}` : ""}${input.quantity ? ` / 数量 ${input.quantity}` : ""}`
        : "製品名・製造完了日・数量のいずれかが不足しています。",
    },
    {
      key: "condition",
      label: "計算条件",
      status: input.resolvedLicenseCondition ? "ready" : "stop",
      detail: input.resolvedLicenseCondition
        ? `採用条件 ${input.resolvedLicenseCondition.resolvedConditionNo} / ${input.resolvedLicenseCondition.calcTypeLabel}`
        : "利用許諾条件から計算条件を解決できていません。",
    },
    {
      key: "db",
      label: "DB製造案件",
      status: input.hasManufacturingEvent ? "ready" : "warn",
      detail: input.hasManufacturingEvent ? "DB 上の製造案件があります。" : "DB 上の製造案件は未登録です。今回生成時に作成されます。",
    },
    {
      key: "warnings",
      label: "事前警告",
      status: input.warnings.some((warning) => warning.level === "stop")
        ? "stop"
        : input.warnings.length > 0
          ? "warn"
          : "ready",
      detail: input.warnings.length
        ? input.warnings.map((warning) => warning.message).join(" / ")
        : "停止項目・注意項目ともにありません。",
    },
  ] as const;

  const overallStatus = steps.some((step) => step.status === "stop")
    ? "stop"
    : steps.some((step) => step.status === "warn")
      ? "warn"
      : "ready";
  const summary = overallStatus === "stop"
    ? "停止項目があります。ライセンス紐付けや計算条件を修正してから生成してください。"
    : overallStatus === "warn"
      ? "生成は可能ですが、DB 状態や補足条件を確認してから進めるのが安全です。"
      : "利用許諾料計算の主要工程は準備完了です。";
  return { overallStatus, summary, steps: [...steps] };
}

function buildRoyaltyGenerationReport(input: {
  royaltyReport: { filename: string; localPath: string; driveUrl?: string };
  paymentNotice?: { filename: string; localPath: string; driveUrl?: string } | null;
}): {
  summary: string;
  driveDocumentCount: number;
  localDocumentCount: number;
} {
  const documents = [input.royaltyReport, ...(input.paymentNotice ? [input.paymentNotice] : [])];
  return {
    summary: `${documents.length} 件の帳票を生成しました。`,
    driveDocumentCount: documents.filter((doc) => Boolean(doc.driveUrl)).length,
    localDocumentCount: documents.filter((doc) => Boolean(doc.localPath)).length,
  };
}

function buildRoyaltyNextActions(input: {
  reportingDeadlineRaw?: string | null;
  paymentDueDateRaw?: string | null;
  paymentNotice?: { filename: string; localPath: string; driveUrl?: string } | null;
}): string[] {
  const actions: string[] = [
    "利用許諾料計算書を開き、計算式と金額を確認する",
  ];
  if (input.paymentNotice) {
    actions.push("支払通知書を開き、支払先情報と金額を確認する");
  }
  if (input.reportingDeadlineRaw) {
    actions.push(`報告期限 ${new Date(input.reportingDeadlineRaw).toLocaleDateString("ja-JP")} を確認する`);
  }
  if (input.paymentDueDateRaw) {
    actions.push(`支払期限 ${new Date(input.paymentDueDateRaw).toLocaleDateString("ja-JP")} を確認する`);
  }
  return actions;
}

async function buildDeliveryPreviewReport(input: {
  deliveryEventId?: string;
  parentIssueKey?: string | null;
}): Promise<{
  summary: string;
  expectedDocuments: string[];
  paymentNoticeExpected: boolean | null;
}> {
  if (!input.deliveryEventId) {
    return {
      summary: "DeliveryEvent が未登録のため、出力見込みを判定できません。",
      expectedDocuments: [],
      paymentNoticeExpected: null,
    };
  }

  const event = await getDeliveryEventWithContext(input.deliveryEventId);
  if (!event) {
    return {
      summary: "DeliveryEvent コンテキストを取得できないため、出力見込みを判定できません。",
      expectedDocuments: [],
      paymentNoticeExpected: null,
    };
  }

  const orderSummary = await getOrderSummary(event.orderItem.legalRequestId);
  const deliveredAmount = event.deliveredAmount ?? event.orderItem.latestAmount;
  const isPartialDelivery = event.orderItem.deliveryEvents.length > 1
    || (event.deliveredAmount !== null && event.deliveredAmount < event.orderItem.latestAmount);
  const isFinalDelivery = !isPartialDelivery || orderSummary.pendingAmount - deliveredAmount <= 0;
  const expectedDocuments = ["検収書", ...(isFinalDelivery ? ["支払通知書"] : [])];

  return {
    summary: isFinalDelivery
      ? "今回の納品では検収書と支払通知書を生成する見込みです。"
      : "今回の納品では検収書を生成し、支払通知書は最終納品時に生成する見込みです。",
    expectedDocuments,
    paymentNoticeExpected: isFinalDelivery,
  };
}

function buildRoyaltyPreviewWarnings(input: {
  licenseIssueKey?: string | null;
  productName?: string;
  completionDate?: string;
  quantity?: string;
  msrp?: string;
  manufacturingEvent?: Awaited<ReturnType<typeof findManufacturingEventByBacklogIssueKey>> | null;
  resolvedLicenseCondition?: {
    source: "license_fields" | "license_condition1_fallback";
    calcTypeLabel: string;
    rateSource: string | null;
    mgSource: string | null;
    requestedConditionNo: 1 | 2 | 3;
    resolvedConditionNo: 1 | 2 | 3;
    conditionHeading: string | null;
  } | null;
}): Array<{ level: "stop" | "warn"; message: string }> {
  const warnings: Array<{ level: "stop" | "warn"; message: string }> = [];

  if (!input.licenseIssueKey) {
    warnings.push({ level: "stop", message: "紐付けライセンス課題キーが未設定です。" });
  }
  if (!input.productName) {
    warnings.push({ level: "stop", message: "製品名が未設定です。" });
  }
  if (!input.completionDate) {
    warnings.push({ level: "stop", message: "製造完了日が未設定です。" });
  }
  if (!input.quantity || Number(input.quantity) <= 0) {
    warnings.push({ level: "stop", message: "製造数量が未設定、または0です。" });
  }
  if (!input.msrp || Number(String(input.msrp).replace(/[,，]/g, "")) <= 0) {
    warnings.push({ level: "stop", message: "MSRPが未設定、または0です。" });
  }
  if (input.resolvedLicenseCondition?.source === "license_condition1_fallback") {
    const fallbackMessage = input.resolvedLicenseCondition.requestedConditionNo !== input.resolvedLicenseCondition.resolvedConditionNo
      ? `ロイヤリティ条件${input.resolvedLicenseCondition.requestedConditionNo}の設定が不足しているため、金銭条件${input.resolvedLicenseCondition.resolvedConditionNo}へフォールバックして計算します。`
      : `ロイヤリティ条件は個別利用許諾条件の金銭条件${input.resolvedLicenseCondition.resolvedConditionNo}から補完して計算します。`;
    warnings.push({ level: "warn", message: fallbackMessage });
  }

  if (input.manufacturingEvent?.licenseContract) {
    if (!input.manufacturingEvent.licenseContract.licensorInvoiceNum) {
      warnings.push({ level: "warn", message: "ライセンサー登録番号がDB未設定です。" });
    }
    if (
      !input.manufacturingEvent.licenseContract.licensorBankName ||
      !input.manufacturingEvent.licenseContract.licensorAccountNo ||
      !input.manufacturingEvent.licenseContract.licensorAccountName
    ) {
      warnings.push({ level: "warn", message: "ライセンサー振込先情報がDBで不足しています。" });
    }
  } else {
    warnings.push({ level: "warn", message: "DB上の製造案件またはライセンス契約が未登録です。生成時にBacklog値から補完を試みます。" });
  }

  return warnings;
}

async function loadParentOrderConditionFieldsForAdmin(parentIssueKey: string): Promise<{
  closingDay: string;
  paymentOffset: string;
  paymentDay: string;
  inspectionDays: number;
  taxRate: number;
  vendorInvoiceNum?: string;
} | undefined> {
  try {
    const parentIssue = await backlog.getIssue(parentIssueKey);
    const getParent = (envKey?: string) => getIssueCustomFieldValue(parentIssue, envKey);
    return {
      closingDay: getParent(process.env.BACKLOG_FIELD_CLOSING_DAY) || "末日",
      paymentOffset: getParent(process.env.BACKLOG_FIELD_PAYMENT_OFFSET) || "1",
      paymentDay: getParent(process.env.BACKLOG_FIELD_PAYMENT_DAY) || "末日",
      inspectionDays: parseInt(getParent(process.env.BACKLOG_FIELD_INSPECTION_DAYS) || getParent(process.env.BACKLOG_FIELD_INSPECTION_PERIOD_DAYS) || "7", 10),
      taxRate: parseInt(getParent(process.env.BACKLOG_FIELD_TAX_RATE) || "10", 10),
      vendorInvoiceNum: getParent(process.env.BACKLOG_FIELD_VENDOR_INVOICE_NUM) || undefined,
    };
  } catch {
    return undefined;
  }
}

function splitLines(value: unknown): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function splitDelimitedValues(value: unknown): string[] {
  return String(value ?? "")
    .split(/[|\n\r]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseOptionalYen(value: unknown): number | undefined {
  const normalized = String(value ?? "").trim().replace(/[,，]/g, "");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`金額の形式が不正です: ${value}`);
  }
  return Math.round(parsed);
}

function buildInspectionMetadataMap(csvText: string, mappingProfileId: string): Map<number, { inspectionDate?: string; paymentPlannedDate?: string }> {
  if (!csvText.trim()) {
    throw new Error("検収書を同時生成する場合は、検収日入りのCSVをアップロードしてください。");
  }
  const rows = parsePlanningInspectionCsv(csvText, { mappingProfileId: mappingProfileId || undefined });
  return new Map(
    rows.map((row) => [
      row.itemNo,
      {
        inspectionDate: row.inspectionDate,
        paymentPlannedDate: row.paymentPlannedDate,
      },
    ]),
  );
}

function parseDateInputToDate(value: string): Date {
  const date = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`日付の形式が不正です: ${value}`);
  }
  return date;
}

function formatDateInput(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function buildBulkDeliveryIssueSummary(parentIssueKey: string, itemNo: number, description: string): string {
  const tail = description.trim() ? ` ${description.trim()}` : "";
  return `【納品リクエスト】${parentIssueKey} ①${itemNo}${tail}`;
}

function buildOrderItemTrackingIssueSummary(parentIssueKey: string, itemNo: number, description: string): string {
  const tail = description.trim() ? ` ${description.trim()}` : "";
  return `【納品管理】${parentIssueKey} ①${itemNo}${tail}`;
}

function buildOrderItemTrackingIssueDescription(input: {
  parentIssueKey: string;
  parentSummary: string;
  counterparty: string;
  itemNo: number;
  description: string;
  spec: string;
  amount: number;
  dueDate?: string | null;
}): string {
  const rows = [
    `| 親発注課題 | ${input.parentIssueKey} |`,
    `| 発注概要 | ${input.parentSummary || "未入力"} |`,
    `| 相手方 | ${input.counterparty || "未入力"} |`,
    `| 明細番号 | ①${input.itemNo} |`,
    `| 成果物名 | ${input.description || "未入力"} |`,
    `| 仕様 | ${input.spec || "未入力"} |`,
    `| 明細金額 | ¥${input.amount.toLocaleString("ja-JP")} |`,
    `| 納期 / 校了予定 | ${input.dueDate || "未入力"} |`,
    "| 進行状態 | 納品待ち |",
  ];
  return [
    "## 納品管理課題（発注時自動作成）",
    "",
    "| 項目 | 内容 |",
    "|------|------|",
    ...rows,
    "",
    "*この課題は発注明細から自動作成されました。納品時はこの課題を更新して検収書生成へ進みます。*",
  ].join("\n");
}

async function upsertOrderItemTrackingIssue(input: {
  parentIssueKey: string;
  parentSummary: string;
  counterparty: string;
  orderItem: Awaited<ReturnType<typeof getOrderItems>>[number];
  issueTypeId?: number;
}): Promise<{ issueKey: string; issueUrl: string | null; created: boolean }> {
  const issueTypeId = input.issueTypeId
    ?? await backlog.findIssueTypeIdByName(process.env.BACKLOG_ISSUE_TYPE_DELIVERY ?? "納品リクエスト");
  if (!issueTypeId) {
    throw new Error("Backlog課題タイプが見つかりません: 納品リクエスト");
  }

  const dueDate = formatDateInput(input.orderItem.latestDueDate);
  const summary = buildOrderItemTrackingIssueSummary(
    input.parentIssueKey,
    input.orderItem.itemNo,
    input.orderItem.description,
  );
  const description = buildOrderItemTrackingIssueDescription({
    parentIssueKey: input.parentIssueKey,
    parentSummary: input.parentSummary,
    counterparty: input.counterparty,
    itemNo: input.orderItem.itemNo,
    description: input.orderItem.description,
    spec: input.orderItem.spec ?? "",
    amount: input.orderItem.latestAmount,
    dueDate,
  });
  const customFields = sanitizeAdminCustomFieldEntries({
    [process.env.BACKLOG_FIELD_CONTRACT_TYPE ?? ""]: "納品リクエスト",
    [process.env.BACKLOG_FIELD_COUNTERPARTY ?? ""]: input.counterparty,
    [process.env.BACKLOG_FIELD_PARENT_ISSUE_KEY ?? ""]: input.parentIssueKey,
    [process.env.BACKLOG_FIELD_ITEM_NO ?? ""]: String(input.orderItem.itemNo),
    [process.env.BACKLOG_FIELD_ITEM_NAME ?? ""]: input.orderItem.description,
    [process.env.BACKLOG_FIELD_DELIVERY_NOTE ?? ""]: input.orderItem.spec ?? "",
    [process.env.BACKLOG_FIELD_FINAL_DEADLINE ?? ""]: dueDate ?? "",
  });

  if (input.orderItem.backlogIssueKey) {
    await backlog.updateIssue(input.orderItem.backlogIssueKey, {
      summary,
      description,
      dueDate: dueDate ?? undefined,
      customFields,
    });
    return {
      issueKey: input.orderItem.backlogIssueKey,
      issueUrl: buildBacklogIssueUrl(input.orderItem.backlogIssueKey) ?? null,
      created: false,
    };
  }

  const issue = await backlog.createIssue({
    summary,
    description,
    issueTypeId,
    dueDate: dueDate ?? undefined,
    customFields,
  });
  await assignOrderItemBacklogIssueKey(input.orderItem.id, issue.issueKey);
  return {
    issueKey: issue.issueKey,
    issueUrl: buildBacklogIssueUrl(issue.issueKey) ?? null,
    created: true,
  };
}

async function ensureOrderItemTrackingIssues(input: {
  parentIssue: { issueKey: string };
  legalRequestId: string;
  summary: string;
  counterparty: string;
}): Promise<{ createdCount: number; updatedCount: number }> {
  const orderItems = await getOrderItems(input.legalRequestId);
  let createdCount = 0;
  let updatedCount = 0;

  for (const orderItem of orderItems) {
    const result = await upsertOrderItemTrackingIssue({
      parentIssueKey: input.parentIssue.issueKey,
      parentSummary: input.summary,
      counterparty: input.counterparty,
      orderItem,
    });
    if (result.created) {
      createdCount += 1;
    } else {
      updatedCount += 1;
    }
  }

  if (createdCount > 0) {
    await backlog.addComment(
      input.parentIssue.issueKey,
      `✅ 発注明細から納品管理課題を自動作成しました。\n\n- 作成件数: ${createdCount}件`,
    );
  }

  return { createdCount, updatedCount };
}

function buildBulkDeliveryIssueDescription(input: {
  parentIssueKey: string;
  summary: string;
  counterparty: string;
  itemNo: number;
  description: string;
  spec: string;
  deliveredAmount: number;
  deliveryNote: string;
}): string {
  const rows = [
    `| 親発注課題 | ${input.parentIssueKey} |`,
    `| 発注概要 | ${input.summary || "未入力"} |`,
    `| 相手方 | ${input.counterparty || "未入力"} |`,
    `| 明細番号 | ①${input.itemNo} |`,
    `| 成果物名 | ${input.description || "未入力"} |`,
    `| 仕様 | ${input.spec || "未入力"} |`,
    `| 今回納品金額 | ¥${input.deliveredAmount.toLocaleString("ja-JP")} |`,
    `| 納品備考 | ${input.deliveryNote || "未入力"} |`,
  ];
  return [
    "## 納品リクエスト（管理UI一括作成）",
    "",
    "| 項目 | 内容 |",
    "|------|------|",
    ...rows,
    "",
    "*このチケットはCSV一括発注明細から管理UIで自動起票されました*",
  ].join("\n");
}

function buildBulkDeliveryGeneratedComment(input: {
  parentIssueKey: string;
  itemNo: number;
  inspectionCert: { filename: string; localPath: string; driveUrl?: string };
  paymentNotice: { filename: string; localPath: string; driveUrl?: string } | null;
}): string {
  const inspectionLink = input.inspectionCert.driveUrl
    ? `[開く](${input.inspectionCert.driveUrl})`
    : input.inspectionCert.localPath;
  const paymentLink = input.paymentNotice
    ? (input.paymentNotice.driveUrl ? `[開く](${input.paymentNotice.driveUrl})` : input.paymentNotice.localPath)
    : "（最終納品時のみ発行）";
  return [
    "## ✅ 管理UIから納品帳票を生成しました",
    "",
    `- 親発注課題: ${input.parentIssueKey}`,
    `- 明細番号: ①${input.itemNo}`,
    `- 検収書: ${inspectionLink}`,
    `- 支払通知書: ${paymentLink}`,
  ].join("\n");
}

function getDeliveryCompletedStatusName(): string {
  return process.env.BACKLOG_STATUS_DELIVERY_COMPLETED ?? "処理済み";
}

async function syncDeliveryIssueStatusToCompleted(issueKey: string): Promise<{
  ok: boolean;
  statusName: string;
  error?: string;
}> {
  const statusName = getDeliveryCompletedStatusName();
  const statusId = await backlog.findStatusIdByName(statusName);
  if (!statusId) {
    return {
      ok: false,
      statusName,
      error: `Backlogステータス「${statusName}」が見つかりません。`,
    };
  }

  await backlog.updateStatus(issueKey, statusId);
  return { ok: true, statusName };
}

function parseMasterCsv(csvText: string): Array<Record<string, string>> {
  const sanitizedCsvText = String(csvText ?? "").replace(/^\uFEFF/, "");
  const parsed = Papa.parse<Record<string, string>>(sanitizedCsvText, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => String(header ?? "").trim(),
  });
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0]?.message ?? "CSVの解析に失敗しました。");
  }
  return parsed.data.map((row) => {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(row ?? {})) {
      normalized[String(key).trim()] = String(value ?? "").trim();
    }
    return normalized;
  });
}

function buildVendorSampleCsv(): string {
  return [
    "vendorCode,vendorName,tradeName,penName,vendorSuffix,entityType,withholdingEnabled,aliases,address,phone,email,contactDepartment,contactName,vendorRepresentative,masterContractRef,bankInfo,bankName,branchName,accountType,accountNumber,accountHolderKana,isInvoiceIssuer,invoiceRegistrationNumber",
    'V0001,山田太郎合同会社,やまだ工房,山田太郎,御中,individual,true,"山田太郎|Yamada Taro","東京都千代田区1-2-3",03-1234-5678,yamada@example.com,制作部,山田太郎,代表社員 山田太郎,MC-2026-001,"三井住友銀行 神田支店 普通 1234567 ヤマダタロウ",三井住友銀行,神田支店,普通,1234567,ヤマダタロウ,true,T1234567890123',
  ].join("\n");
}

function sendUtf8BomCsv(res: Response, fileName: string, csv: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send("\uFEFF" + csv);
}

function buildStaffSampleCsv(): string {
  return [
    "slackUserId,staffName,department,departmentCode,phone,email,partyAName,partyAAddress,partyARep",
    'U0123456789,倉持達也,法務部,LGL,03-1234-5678,kuramochi@example.com,株式会社アークライト,"〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",代表取締役 青柳昌行',
  ].join("\n");
}

function normalizeSlackUserId(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  const mentionMatch = raw.match(/^<@([A-Z0-9]+)>$/i);
  return (mentionMatch?.[1] ?? raw).trim();
}

function normalizeStaffCsvRow(row: Record<string, string>): Record<string, string> {
  const normalizedEntries = new Map<string, string>();
  for (const [key, value] of Object.entries(row ?? {})) {
    const normalizedKey = String(key ?? "")
      .trim()
      .replace(/^\uFEFF/, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    normalizedEntries.set(normalizedKey, String(value ?? "").trim());
  }

  const pick = (...candidates: string[]) => {
    for (const candidate of candidates) {
      const value = normalizedEntries.get(candidate);
      if (value != null) return value;
    }
    return "";
  };

  return {
    slackUserId: pick("slackuserid", "slackid", "userid", "userid", "slackユーザーid", "slackユーザー", "slackid(必須)", "slackid※必須"),
    staffName: pick("staffname", "name", "氏名", "名前", "担当者名"),
    department: pick("department", "部署", "部門"),
    departmentCode: pick("departmentcode", "部署コード", "部門コード"),
    phone: pick("phone", "tel", "電話", "電話番号"),
    email: pick("email", "mail", "メール", "メールアドレス"),
    partyAName: pick("partyaname", "自社名", "当社名"),
    partyAAddress: pick("partyaaddress", "自社住所", "当社住所"),
    partyARep: pick("partyarep", "自社代表者", "当社代表者"),
  };
}

function buildMasterAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>マスタ管理 - LegalBridge</title>
  <style>${sharedAdminCss()}
    .master-tabs { display:flex; gap:0; border-bottom:2px solid var(--panel-border); margin-bottom:20px; }
    .master-tab {
      padding:10px 20px; cursor:pointer; font-size:14px; font-weight:600;
      color:var(--muted); border-bottom:2px solid transparent; margin-bottom:-2px;
      background:none; border-top:none; border-left:none; border-right:none;
      border-radius:0; box-shadow:none; transition:all 0.15s;
    }
    .master-tab:hover { color:var(--accent); background:var(--accent-soft); transform:none; }
    .master-tab.active { color:var(--accent); border-bottom-color:var(--accent); }
    .master-pane { display:none; }
    .master-pane.active { display:block; }
    .csv-import-area {
      border: 2px dashed var(--panel-border); border-radius: var(--radius-md);
      padding: 20px; text-align: center; transition: all 0.15s; cursor: pointer;
    }
    .csv-import-area:hover { border-color: var(--accent); background: var(--accent-soft); }
    .csv-import-area.dragging { border-color: var(--accent); background: var(--accent-soft); }
    .import-progress { display:none; }
    .import-progress.show { display:block; }
    .result-row { display:flex; gap:12px; align-items:center; padding:8px 0; border-bottom:1px solid #f0f4f8; }
    .result-row:last-child { border-bottom:none; }
    .result-ok { color: var(--success); font-weight:600; }
    .result-err { color: var(--danger); font-weight:600; }
    .search-bar { display:flex; gap:10px; align-items:center; margin-bottom:16px; }
    .search-bar input { flex:1; }
  </style>
</head>
<body>
  ${buildAdminNav("masters")}
  <div class="wrap">
    ${buildCategorySwitchHtml("Settings", "マスタ・設定", "", [
      { href: "/admin/settings", label: "マスタ・設定トップ", description: "設定の入口", active: false },
      { href: "/admin/masters", label: "マスタ管理", description: "Vendor / Staff の登録", active: true },
      { href: "/admin/settings/mapping", label: "マッピング設定", description: "CSV / Excel 取込列の設定", active: false },
      { href: "/admin/settings/workflow", label: "ワークフロー設定", description: "承認者・押印担当の設定", active: false },
    ])}

    <div style="margin-bottom:20px;">
      <h1 style="margin-bottom:4px;">📁 マスタ管理</h1>
      <p class="sub">Vendor（取引先）とStaff（社内担当者）の情報を管理します。CSV一括登録にも対応しています。</p>
    </div>

    <!-- タブ切替 -->
    <div class="master-tabs">
      <button class="master-tab active" onclick="switchTab('vendor', this)">🏢 Vendor</button>
      <button class="master-tab" onclick="switchTab('staff', this)">👤 Staff</button>
      <button class="master-tab" onclick="switchTab('search', this)">🔍 検索</button>
    </div>

    <!-- ===== Vendor タブ ===== -->
    <div id="pane-vendor" class="master-pane active">
      <div class="grid two-col" style="margin-bottom:20px;">
        <!-- 単体登録フォーム -->
        <div class="panel">
          <div class="section-heading">
            <h2 style="margin-bottom:0;">Vendor 登録 / 編集</h2>
            <button type="button" class="ghost" onclick="clearVendorForm()" style="font-size:12px;padding:6px 12px;">🗑️ クリア</button>
          </div>

          <details open>
            <summary style="cursor:pointer;font-weight:600;margin-bottom:12px;padding:8px 0;border-bottom:1px solid var(--panel-border);">基本情報</summary>
            <div style="padding-top:12px;">
              <div class="row"><label for="vendorCode">Vendor Code <span style="color:var(--danger)">*</span></label><input id="vendorCode" type="text" placeholder="artist-fujiwara" /></div>
              <div class="row"><label for="vendorName">Vendor Name <span style="color:var(--danger)">*</span></label><input id="vendorName" type="text" placeholder="藤原ひさし" /></div>
              <div class="row"><label for="tradeName">屋号 / Trade Name</label><input id="tradeName" type="text" placeholder="藤原デザイン工房" /></div>
              <div class="row"><label for="penName">ペンネーム / Pen Name</label><input id="penName" type="text" /></div>
              <div class="row"><label for="vendorSuffix">敬称 Suffix</label><input id="vendorSuffix" type="text" value="御中" /></div>
              <div class="row">
                <label for="entityType">Entity Type</label>
                <select id="entityType">
                  <option value="corporation">corporation（法人）</option>
                  <option value="individual">individual（個人）</option>
                </select>
              </div>
              <div style="display:flex;gap:16px;margin-bottom:14px;">
                <label class="inline-check"><input id="withholdingEnabled" type="checkbox" /> 源泉徴収を適用</label>
                <label class="inline-check"><input id="isInvoiceIssuer" type="checkbox" /> 適格請求書発行事業者</label>
              </div>
              <div class="row"><label for="aliases">別名 / Aliases（改行区切り）</label><textarea id="aliases" rows="3" placeholder="藤原ひさし&#10;フジワラヒサシ"></textarea></div>
            </div>
          </details>

          <details style="margin-top:8px;">
            <summary style="cursor:pointer;font-weight:600;margin-bottom:12px;padding:8px 0;border-bottom:1px solid var(--panel-border);">連絡先情報</summary>
            <div style="padding-top:12px;">
              <div class="row"><label for="address">Address</label><textarea id="address" rows="2"></textarea></div>
              <div class="row"><label for="vendorPhone">Phone</label><input id="vendorPhone" type="text" /></div>
              <div class="row"><label for="email">Email</label><input id="email" type="text" /></div>
              <div class="row"><label for="contactDepartment">Contact Department</label><input id="contactDepartment" type="text" /></div>
              <div class="row"><label for="contactName">Contact Name</label><input id="contactName" type="text" /></div>
              <div class="row"><label for="vendorRepresentative">法人代表 / Representative</label><input id="vendorRepresentative" type="text" /></div>
            </div>
          </details>

          <details style="margin-top:8px;">
            <summary style="cursor:pointer;font-weight:600;margin-bottom:12px;padding:8px 0;border-bottom:1px solid var(--panel-border);">銀行口座情報</summary>
            <div style="padding-top:12px;">
              <div class="row"><label for="bankInfo">Bank Info（自由形式）</label><textarea id="bankInfo" rows="2"></textarea></div>
              <div class="grid two-col" style="gap:10px;">
                <div class="row"><label for="bankName">銀行名</label><input id="bankName" type="text" /></div>
                <div class="row"><label for="branchName">支店名</label><input id="branchName" type="text" /></div>
                <div class="row"><label for="accountType">種別</label><input id="accountType" type="text" placeholder="普通" /></div>
                <div class="row"><label for="accountNumber">口座番号</label><input id="accountNumber" type="text" /></div>
              </div>
              <div class="row"><label for="accountHolderKana">口座名義（カナ）</label><input id="accountHolderKana" type="text" /></div>
              <div class="row"><label for="invoiceRegistrationNumber">適格請求書登録番号</label><input id="invoiceRegistrationNumber" type="text" /></div>
            </div>
          </details>

          <details style="margin-top:8px;">
            <summary style="cursor:pointer;font-weight:600;margin-bottom:12px;padding:8px 0;border-bottom:1px solid var(--panel-border);">契約情報</summary>
            <div style="padding-top:12px;">
              <div class="row"><label for="masterContractRef">基本契約参照</label><input id="masterContractRef" type="text" /></div>
            </div>
          </details>

          <div style="display:flex;gap:10px;margin-top:16px;">
            <button id="saveVendor" type="button" style="flex:1;justify-content:center;">💾 Vendor保存</button>
          </div>
          <div id="vendorStatus" class="status"></div>
        </div>

        <!-- CSV一括登録 -->
        <div class="panel">
          <h2>Vendor CSV一括登録</h2>
          <div class="summary-box" style="margin-bottom:16px;font-size:12px;">
            <strong>必須列:</strong> vendorCode, vendorName<br>
            <strong>任意列:</strong> tradeName, penName, vendorSuffix, entityType(corporation/individual), withholdingEnabled(true/false), aliases(|区切り), address, phone, email, contactDepartment, contactName, vendorRepresentative, masterContractRef, bankInfo, bankName, branchName, accountType, accountNumber, accountHolderKana, isInvoiceIssuer(true/false), invoiceRegistrationNumber
          </div>

          <div class="csv-import-area" id="vendorDropZone" onclick="document.getElementById('vendorCsvFile').click()">
            <p style="font-size:13px;color:var(--muted);margin-bottom:8px;">📄 クリックしてCSVを選択、またはドラッグ&ドロップ</p>
            <input id="vendorCsvFile" type="file" accept=".csv,text/csv" style="display:none" />
            <p id="vendorFileInfo" style="font-size:12px;color:var(--accent);"></p>
          </div>

          <div class="row" style="margin-top:14px;">
            <label for="vendorCsvText">または直接貼り付け</label>
            <textarea id="vendorCsvText" rows="6" placeholder="vendorCode,vendorName&#10;artist-001,山田花子"></textarea>
          </div>

          <div style="display:flex;gap:10px;margin-top:10px;">
            <button id="downloadVendorSample" type="button" class="ghost" style="flex:1;justify-content:center;font-size:13px;">📥 サンプルCSV</button>
            <button id="importVendorCsv" type="button" style="flex:1;justify-content:center;font-size:13px;">📤 CSV取込実行</button>
          </div>
          <div id="vendorCsvStatus" class="status"></div>

          <div id="vendorImportResult" class="import-progress" style="margin-top:12px;"></div>
        </div>
      </div>
    </div>

    <!-- ===== Staff タブ ===== -->
    <div id="pane-staff" class="master-pane">
      <div class="grid two-col" style="margin-bottom:20px;">
        <!-- 単体登録フォーム -->
        <div class="panel">
          <div class="section-heading">
            <h2 style="margin-bottom:0;">Staff 登録 / 編集</h2>
            <button type="button" class="ghost" onclick="clearStaffForm()" style="font-size:12px;padding:6px 12px;">🗑️ クリア</button>
          </div>
          <div class="row"><label for="slackUserId">Slack User ID <span style="color:var(--danger)">*</span></label><input id="slackUserId" type="text" placeholder="U0123456789" /></div>
          <div class="row"><label for="staffName">氏名 <span style="color:var(--danger)">*</span></label><input id="staffName" type="text" /></div>
          <div class="grid two-col" style="gap:10px;">
            <div class="row"><label for="department">部署名</label><input id="department" type="text" /></div>
            <div class="row"><label for="departmentCode">部署コード</label><input id="departmentCode" type="text" placeholder="LGL" /></div>
          </div>
          <div class="grid two-col" style="gap:10px;">
            <div class="row"><label for="phone">Phone</label><input id="phone" type="text" /></div>
            <div class="row"><label for="staffEmail">Email</label><input id="staffEmail" type="text" /></div>
          </div>

          <details style="margin-top:8px;">
            <summary style="cursor:pointer;font-weight:600;margin-bottom:12px;padding:8px 0;border-bottom:1px solid var(--panel-border);">会社情報（甲表示用）</summary>
            <div style="padding-top:12px;">
              <div class="row"><label for="partyAName">会社名</label><input id="partyAName" type="text" value="株式会社アークライト" /></div>
              <div class="row"><label for="partyAAddress">会社住所</label><textarea id="partyAAddress" rows="2">〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階</textarea></div>
              <div class="row"><label for="partyARep">代表者名</label><input id="partyARep" type="text" value="代表取締役 青柳昌行" /></div>
            </div>
          </details>

          <div style="display:flex;gap:10px;margin-top:16px;">
            <button id="saveStaff" type="button" style="flex:1;justify-content:center;">💾 Staff保存</button>
          </div>
          <div id="staffStatus" class="status"></div>
        </div>

        <!-- CSV一括登録 -->
        <div class="panel">
          <h2>Staff CSV一括登録</h2>
          <div class="summary-box" style="margin-bottom:16px;font-size:12px;">
            <strong>必須列:</strong> slackUserId, staffName<br>
            <strong>任意列:</strong> department, departmentCode, phone, email, partyAName, partyAAddress, partyARep
          </div>

          <div class="csv-import-area" id="staffDropZone" onclick="document.getElementById('staffCsvFile').click()">
            <p style="font-size:13px;color:var(--muted);margin-bottom:8px;">📄 クリックしてCSVを選択、またはドラッグ&ドロップ</p>
            <input id="staffCsvFile" type="file" accept=".csv,text/csv" style="display:none" />
            <p id="staffFileInfo" style="font-size:12px;color:var(--accent);"></p>
          </div>

          <div class="row" style="margin-top:14px;">
            <label for="staffCsvText">または直接貼り付け</label>
            <textarea id="staffCsvText" rows="6" placeholder="slackUserId,staffName,department&#10;U0123456789,山田花子,法務部"></textarea>
          </div>

          <div style="display:flex;gap:10px;margin-top:10px;">
            <button id="downloadStaffSample" type="button" class="ghost" style="flex:1;justify-content:center;font-size:13px;">📥 サンプルCSV</button>
            <button id="importStaffCsv" type="button" style="flex:1;justify-content:center;font-size:13px;">📤 CSV取込実行</button>
          </div>
          <div id="staffCsvStatus" class="status"></div>

          <div id="staffImportResult" class="import-progress" style="margin-top:12px;"></div>
        </div>
      </div>
    </div>

    <!-- ===== 検索タブ ===== -->
    <div id="pane-search" class="master-pane">
      <div class="panel">
        <h2>マスタ検索</h2>
        <div class="search-bar">
          <input id="masterSearchQuery" type="text" placeholder="vendorCode / 作家名 / Slack ID / 部署名..." />
          <button id="runMasterSearch" type="button">🔍 検索</button>
          <button id="resetMasterSearch" type="button" class="ghost">リセット</button>
        </div>
        <div id="masterSearchStatus" class="helper"></div>

        <div class="grid two-col" style="margin-top:16px;">
          <div>
            <h3>Vendor 一覧 <small style="font-weight:400;color:var(--muted);">（クリックで編集フォームへ）</small></h3>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Vendor Code</th><th>Name</th><th>種別</th><th>更新日</th></tr></thead>
                <tbody id="vendorSearchResults">
                  <tr><td colspan="4" style="text-align:center;padding:16px;color:var(--muted);">読み込み中...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h3>Staff 一覧 <small style="font-weight:400;color:var(--muted);">（クリックで編集フォームへ）</small></h3>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Slack ID</th><th>氏名</th><th>部署</th><th>更新日</th></tr></thead>
                <tbody id="staffSearchResults">
                  <tr><td colspan="4" style="text-align:center;padding:16px;color:var(--muted);">読み込み中...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);

    // タブ切替
    function switchTab(name, btn) {
      document.querySelectorAll(".master-pane").forEach(p => p.classList.remove("active"));
      document.querySelectorAll(".master-tab").forEach(b => b.classList.remove("active"));
      document.getElementById("pane-" + name).classList.add("active");
      btn.classList.add("active");
    }

    // URLパラメータでvendorCodeが来た場合
    if (params.get("vendorCode")) {
      document.getElementById("vendorCode").value = params.get("vendorCode");
      if (params.get("vendorName")) {
        document.getElementById("aliases").value = params.get("vendorName");
      }
      // Vendorタブはデフォルトでアクティブなので何もしない
    }

    // ===== CSV文字コード判定 =====
    async function readCsvFileWithEncoding(file) {
      const buffer = await file.arrayBuffer();
      const utf8Text = new TextDecoder("utf-8").decode(buffer);
      const shiftJisText = decodeBuffer(buffer, "shift_jis");
      if (shiftJisText && scoreText(shiftJisText) < scoreText(utf8Text)) {
        return { text: shiftJisText, encoding: "Shift_JIS" };
      }
      return { text: utf8Text, encoding: "UTF-8" };
    }
    function decodeBuffer(buffer, encoding) {
      try { return new TextDecoder(encoding).decode(buffer); } catch (decodeError) { return ""; }
    }
    function scoreText(text) {
      return (text.match(/\uFFFD/g) || []).length * 10;
    }

    // ===== Drag & Drop ======
    function setupDropZone(zoneId, fileInputId, textareaId, fileInfoId, statusId) {
      const zone = document.getElementById(zoneId);
      const fileInput = document.getElementById(fileInputId);
      const textarea = document.getElementById(textareaId);
      const fileInfo = document.getElementById(fileInfoId);

      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragging"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
      zone.addEventListener("drop", async (e) => {
        e.preventDefault();
        zone.classList.remove("dragging");
        const file = e.dataTransfer.files[0];
        if (!file) return;
        const decoded = await readCsvFileWithEncoding(file);
        textarea.value = decoded.text;
        fileInfo.textContent = file.name + " (" + decoded.encoding + ")";
        document.getElementById(statusId).textContent = "ファイルを読み込みました: " + file.name;
        document.getElementById(statusId).className = "status success";
      });
      fileInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const decoded = await readCsvFileWithEncoding(file);
        textarea.value = decoded.text;
        fileInfo.textContent = file.name + " (" + decoded.encoding + ")";
        document.getElementById(statusId).textContent = "ファイルを読み込みました: " + file.name;
        document.getElementById(statusId).className = "status success";
      });
    }

    setupDropZone("vendorDropZone", "vendorCsvFile", "vendorCsvText", "vendorFileInfo", "vendorCsvStatus");
    setupDropZone("staffDropZone", "staffCsvFile", "staffCsvText", "staffFileInfo", "staffCsvStatus");

    // ===== Vendor保存 =====
    document.getElementById("saveVendor").addEventListener("click", async () => {
      const vendorStatus = document.getElementById("vendorStatus");
      vendorStatus.textContent = "保存中...";
      vendorStatus.className = "status";
      const result = await postJson("/admin/api/masters/vendor", {
        vendorCode: val("vendorCode"),
        vendorName: val("vendorName"),
        tradeName: val("tradeName"),
        penName: val("penName"),
        vendorSuffix: val("vendorSuffix"),
        aliases: val("aliases"),
        entityType: val("entityType"),
        withholdingEnabled: document.getElementById("withholdingEnabled").checked,
        address: val("address"),
        phone: val("vendorPhone"),
        email: val("email"),
        contactDepartment: val("contactDepartment"),
        contactName: val("contactName"),
        vendorRepresentative: val("vendorRepresentative"),
        bankInfo: val("bankInfo"),
        bankName: val("bankName"),
        branchName: val("branchName"),
        accountType: val("accountType"),
        accountNumber: val("accountNumber"),
        accountHolderKana: val("accountHolderKana"),
        isInvoiceIssuer: document.getElementById("isInvoiceIssuer").checked,
        invoiceRegistrationNumber: val("invoiceRegistrationNumber"),
        masterContractRef: val("masterContractRef"),
      });
      vendorStatus.textContent = result.ok ? "✅ Vendorを保存しました。" : "❌ 保存失敗: " + result.error;
      vendorStatus.className = "status " + (result.ok ? "success" : "error");
    });

    // ===== Staff保存 =====
    document.getElementById("saveStaff").addEventListener("click", async () => {
      const staffStatus = document.getElementById("staffStatus");
      staffStatus.textContent = "保存中...";
      staffStatus.className = "status";
      const result = await postJson("/admin/api/masters/staff", {
        slackUserId: val("slackUserId"),
        staffName: val("staffName"),
        department: val("department"),
        departmentCode: val("departmentCode"),
        phone: val("phone"),
        email: val("staffEmail"),
        partyAName: val("partyAName"),
        partyAAddress: val("partyAAddress"),
        partyARep: val("partyARep"),
      });
      staffStatus.textContent = result.ok ? "✅ Staffを保存しました。" : "❌ 保存失敗: " + result.error;
      staffStatus.className = "status " + (result.ok ? "success" : "error");
    });

    // ===== Vendor CSV取込 =====
    document.getElementById("downloadVendorSample").addEventListener("click", () => {
      window.location.href = "/admin/api/masters/vendor/sample.csv";
    });

    document.getElementById("importVendorCsv").addEventListener("click", async () => {
      const statusEl = document.getElementById("vendorCsvStatus");
      const resultEl = document.getElementById("vendorImportResult");
      const csvVal = val("vendorCsvText");
      if (!csvVal.trim()) {
        statusEl.textContent = "❌ CSVを入力またはファイルを選択してください。";
        statusEl.className = "status error";
        return;
      }
      statusEl.textContent = "⏳ 取込中...";
      statusEl.className = "status";
      resultEl.innerHTML = "";
      resultEl.className = "import-progress";

      const result = await postJson("/admin/api/masters/vendor/import", { csvText: csvVal });
      if (!result.ok) {
        statusEl.textContent = "❌ 取込失敗: " + result.error;
        statusEl.className = "status error";
        return;
      }
      statusEl.textContent = "✅ Vendor CSV取込完了: " + result.count + " 件";
      statusEl.className = "status success";

      // 結果一覧表示
      if (result.vendors && result.vendors.length > 0) {
        resultEl.className = "import-progress show";
        resultEl.innerHTML = "<strong style='font-size:13px;'>取込結果:</strong>" +
          "<div class='table-wrap' style='margin-top:8px;'><table><thead><tr><th>VendorCode</th><th>名前</th></tr></thead><tbody>" +
          result.vendors.map(v => \`<tr><td><code>\${escapeHtml(v.vendorCode)}</code></td><td>\${escapeHtml(v.vendorName)}</td></tr>\`).join("") +
          "</tbody></table></div>";
      }
    });

    // ===== Staff CSV取込 =====
    document.getElementById("downloadStaffSample").addEventListener("click", () => {
      window.location.href = "/admin/api/masters/staff/sample.csv";
    });

    document.getElementById("importStaffCsv").addEventListener("click", async () => {
      const statusEl = document.getElementById("staffCsvStatus");
      const resultEl = document.getElementById("staffImportResult");
      const csvVal = val("staffCsvText");
      if (!csvVal.trim()) {
        statusEl.textContent = "❌ CSVを入力またはファイルを選択してください。";
        statusEl.className = "status error";
        return;
      }
      statusEl.textContent = "⏳ 取込中...";
      statusEl.className = "status";
      resultEl.innerHTML = "";
      resultEl.className = "import-progress";

      const result = await postJson("/admin/api/masters/staff/import", { csvText: csvVal });
      if (!result.ok) {
        statusEl.textContent = "❌ 取込失敗: " + result.error;
        statusEl.className = "status error";
        return;
      }
      statusEl.textContent = "✅ Staff CSV取込完了: " + result.count + " 件";
      statusEl.className = "status success";

      if (result.staffs && result.staffs.length > 0) {
        resultEl.className = "import-progress show";
        resultEl.innerHTML = "<strong style='font-size:13px;'>取込結果:</strong>" +
          "<div class='table-wrap' style='margin-top:8px;'><table><thead><tr><th>Slack ID</th><th>氏名</th><th>部署</th></tr></thead><tbody>" +
          result.staffs.map(s => \`<tr><td><code>\${escapeHtml(s.slackUserId)}</code></td><td>\${escapeHtml(s.staffName)}</td><td>\${escapeHtml(s.department || "-")}</td></tr>\`).join("") +
          "</tbody></table></div>";
        if (result.warnings && result.warnings.length > 0) {
          resultEl.innerHTML += "<div class='warning-summary warning-warn' style='margin-top:12px;'>スキップ行があります</div>"
            + result.warnings.map(message => "<div class='warning-line warning-warn'>" + escapeHtml(message) + "</div>").join("");
        }
      } else if (result.warnings && result.warnings.length > 0) {
        resultEl.className = "import-progress show";
        resultEl.innerHTML = "<div class='warning-summary warning-warn'>取込対象がありませんでした</div>"
          + result.warnings.map(message => "<div class='warning-line warning-warn'>" + escapeHtml(message) + "</div>").join("");
      }
    });

    // ===== フォームクリア =====
    function clearVendorForm() {
      ["vendorCode","vendorName","tradeName","penName","vendorSuffix","aliases","address","vendorPhone","email",
       "contactDepartment","contactName","vendorRepresentative","masterContractRef","bankInfo","bankName","branchName",
       "accountType","accountNumber","accountHolderKana","invoiceRegistrationNumber"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = id === "vendorSuffix" ? "御中" : "";
      });
      document.getElementById("withholdingEnabled").checked = false;
      document.getElementById("isInvoiceIssuer").checked = false;
      document.getElementById("entityType").value = "corporation";
      document.getElementById("vendorStatus").textContent = "";
      document.getElementById("vendorStatus").className = "status";
    }

    function clearStaffForm() {
      ["slackUserId","staffName","department","departmentCode","phone","staffEmail"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      document.getElementById("staffStatus").textContent = "";
      document.getElementById("staffStatus").className = "status";
    }

    // ===== 検索 =====
    document.getElementById("runMasterSearch").addEventListener("click", refreshMasterSearch);
    document.getElementById("resetMasterSearch").addEventListener("click", () => {
      document.getElementById("masterSearchQuery").value = "";
      refreshMasterSearch();
    });
    document.getElementById("masterSearchQuery").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); refreshMasterSearch(); }
    });

    async function refreshMasterSearch() {
      const query = val("masterSearchQuery");
      document.getElementById("masterSearchStatus").textContent = "検索中...";
      try {
        const [vr, sr] = await Promise.all([
          fetchJson("/admin/api/masters/vendor?q=" + encodeURIComponent(query)),
          fetchJson("/admin/api/masters/staff?q=" + encodeURIComponent(query)),
        ]);
        renderVendors(vr.vendors || []);
        renderStaffs(sr.staffs || []);
        document.getElementById("masterSearchStatus").textContent =
          "Vendor " + (vr.count || 0) + " 件 / Staff " + (sr.count || 0) + " 件";
      } catch {
        document.getElementById("masterSearchStatus").textContent = "検索に失敗しました。";
      }
    }

    function renderVendors(vendors) {
      const tbody = document.getElementById("vendorSearchResults");
      if (!vendors.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--muted);">該当なし</td></tr>';
        return;
      }
      tbody.innerHTML = vendors.map(v =>
        \`<tr style="cursor:pointer;" onclick="loadVendor('\${escapeHtml(v.vendorCode)}')" title="クリックで編集">
          <td><code>\${escapeHtml(v.vendorCode)}</code></td>
          <td>\${escapeHtml(v.vendorName || "")}</td>
          <td><span class="tag" style="font-size:11px;">\${escapeHtml(v.entityType || "")}</span></td>
          <td style="font-size:12px;color:var(--muted);">\${formatDate(v.updatedAt)}</td>
        </tr>\`
      ).join("");
    }

    function renderStaffs(staffs) {
      const tbody = document.getElementById("staffSearchResults");
      if (!staffs.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--muted);">該当なし</td></tr>';
        return;
      }
      tbody.innerHTML = staffs.map(s =>
        \`<tr style="cursor:pointer;" onclick="loadStaff('\${escapeHtml(s.slackUserId)}')" title="クリックで編集">
          <td><code>\${escapeHtml(s.slackUserId)}</code></td>
          <td>\${escapeHtml(s.staffName || "")}</td>
          <td>\${escapeHtml(s.department || "")}</td>
          <td style="font-size:12px;color:var(--muted);">\${formatDate(s.updatedAt)}</td>
        </tr>\`
      ).join("");
    }

    async function loadVendor(vendorCode) {
      const result = await fetchJson("/admin/api/masters/vendor/" + encodeURIComponent(vendorCode));
      if (!result.ok || !result.vendor) return;
      const v = result.vendor;
      document.getElementById("vendorCode").value = v.vendorCode || "";
      document.getElementById("vendorName").value = v.vendorName || "";
      document.getElementById("tradeName").value = v.tradeName || "";
      document.getElementById("penName").value = v.penName || "";
      document.getElementById("vendorSuffix").value = v.vendorSuffix || "御中";
      document.getElementById("entityType").value = v.entityType || "corporation";
      document.getElementById("withholdingEnabled").checked = Boolean(v.withholdingEnabled);
      document.getElementById("aliases").value = Array.isArray(v.aliases) ? v.aliases.join("\\n") : "";
      document.getElementById("address").value = v.address || "";
      document.getElementById("vendorPhone").value = v.phone || "";
      document.getElementById("email").value = v.email || "";
      document.getElementById("contactDepartment").value = v.contactDepartment || "";
      document.getElementById("contactName").value = v.contactName || "";
      document.getElementById("vendorRepresentative").value = v.vendorRepresentative || "";
      document.getElementById("masterContractRef").value = v.masterContractRef || "";
      document.getElementById("bankInfo").value = v.bankInfo || "";
      document.getElementById("bankName").value = v.bankName || "";
      document.getElementById("branchName").value = v.branchName || "";
      document.getElementById("accountType").value = v.accountType || "";
      document.getElementById("accountNumber").value = v.accountNumber || "";
      document.getElementById("accountHolderKana").value = v.accountHolderKana || "";
      document.getElementById("isInvoiceIssuer").checked = Boolean(v.isInvoiceIssuer);
      document.getElementById("invoiceRegistrationNumber").value = v.invoiceRegistrationNumber || "";
      document.getElementById("vendorStatus").textContent = "✅ 読み込みました。";
      document.getElementById("vendorStatus").className = "status success";
      // Vendorタブに切替
      switchTab("vendor", document.querySelectorAll(".master-tab")[0]);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    async function loadStaff(slackUserId) {
      const result = await fetchJson("/admin/api/masters/staff/" + encodeURIComponent(slackUserId));
      if (!result.ok || !result.staff) return;
      const s = result.staff;
      document.getElementById("slackUserId").value = s.slackUserId || "";
      document.getElementById("staffName").value = s.staffName || "";
      document.getElementById("department").value = s.department || "";
      document.getElementById("departmentCode").value = s.departmentCode || "";
      document.getElementById("phone").value = s.phone || "";
      document.getElementById("staffEmail").value = s.email || "";
      document.getElementById("partyAName").value = s.partyAName || "";
      document.getElementById("partyAAddress").value = s.partyAAddress || "";
      document.getElementById("partyARep").value = s.partyARep || "";
      document.getElementById("staffStatus").textContent = "✅ 読み込みました。";
      document.getElementById("staffStatus").className = "status success";
      // Staffタブに切替
      switchTab("staff", document.querySelectorAll(".master-tab")[1]);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    // ===== ユーティリティ =====
    function val(id) { return (document.getElementById(id) || {}).value || ""; }
    async function fetchJson(url) { return (await fetch(url)).json(); }
    async function postJson(url, body) {
      return (await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })).json();
    }
    function formatDate(v) {
      if (!v) return "-";
      const d = new Date(v);
      return isNaN(d.getTime()) ? "-" : d.toLocaleString("ja-JP", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    }
    function escapeHtml(v) {
      return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    }

    // 初期ロード
    refreshMasterSearch();
  </script>
</body>
</html>`;
}


async function buildWorkflowAttentionSummary(): Promise<Array<{
  label: string;
  severityLabel: string;
  detail: string;
  helper: string;
  href: string;
}>> {
  const recentIssues = await backlog.getRecentIssues(20);
  const contractIssues = recentIssues.filter((issue) => getContractIssueTypeNames().has(issue.issueType?.name ?? "")).slice(0, 10);
  const deliveryIssues = recentIssues.filter((issue) => getDeliveryIssueTypeNames().has(issue.issueType?.name ?? "")).slice(0, 10);
  const royaltyIssues = recentIssues.filter((issue) => new Set(["製造案件", "売上報告"]).has(issue.issueType?.name ?? "")).slice(0, 10);

  const summarizeWarnings = (warnings: Array<{ level: "stop" | "warn" }>) =>
    warnings.reduce((acc, warning) => {
      if (warning.level === "stop") acc.stop += 1;
      if (warning.level === "warn") acc.warn += 1;
      return acc;
    }, { stop: 0, warn: 0 });

  const contractCounts = summarizeWarnings((await Promise.all(contractIssues.map(async (issue) => {
    const preview = await buildContractDraft(issue.issueKey, issue);
    return preview.warnings;
  }))).flat());

  const deliveryCounts = summarizeWarnings((await Promise.all(deliveryIssues.map(async (issue) => {
    const parentIssueKey = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PARENT_ISSUE_KEY);
    const deliveredAmount = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DELIVERED_AMOUNT);
    const finalDeadline = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_FINAL_DEADLINE) || issue.dueDate || null;
    const inspectionDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_INSPECTION_DATE) || null;
    const paymentPlannedDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PAYMENT_PLANNED_DATE) || null;
    const deliveryEvent = await findDeliveryEventByBacklogIssueKey(issue.issueKey);
    const parentCondition = parentIssueKey ? await loadParentOrderConditionFieldsForAdmin(parentIssueKey) : undefined;
    return buildDeliveryPreviewWarnings({
      mode: "tracking",
      parentIssueKey,
      deliveredAmount,
      finalDeadline,
      inspectionDate,
      paymentPlannedDate,
      hasDeliveryEvent: Boolean(deliveryEvent),
      paymentCondition: parentCondition ?? null,
    });
  }))).flat());

  const royaltyCounts = summarizeWarnings((await Promise.all(royaltyIssues.map(async (issue) => {
    const snapshot = await getRoyaltyIssueSnapshot(issue.issueKey);
    const manufacturingEvent = await findManufacturingEventByBacklogIssueKey(issue.issueKey);
    const resolvedLicenseCondition = snapshot.licenseIssueKey
      ? await resolveRoyaltyLicenseCondition(snapshot.licenseIssueKey, undefined, snapshot.requestedConditionNo)
      : null;
    return buildRoyaltyPreviewWarnings({
      licenseIssueKey: snapshot.licenseIssueKey,
      productName: snapshot.productName,
      completionDate: snapshot.completionDate,
      quantity: String(snapshot.quantity || ""),
      msrp: String(snapshot.msrp || ""),
      manufacturingEvent,
      resolvedLicenseCondition: resolvedLicenseCondition?.meta ?? null,
    });
  }))).flat());

  return [
    {
      label: "契約書生成",
      severityLabel: contractCounts.stop > 0 ? "停止あり" : contractCounts.warn > 0 ? "注意あり" : "安定",
      detail: `停止 ${contractCounts.stop} 件 / 注意 ${contractCounts.warn} 件`,
      helper: "契約ドラフトや補完不足を確認",
      href: "/admin/workflow/contracts",
    },
    {
      label: "納品帳票生成",
      severityLabel: deliveryCounts.stop > 0 ? "停止あり" : deliveryCounts.warn > 0 ? "注意あり" : "安定",
      detail: `停止 ${deliveryCounts.stop} 件 / 注意 ${deliveryCounts.warn} 件`,
      helper: "親課題・DeliveryEvent・納品金額を確認",
      href: "/admin/workflow/delivery",
    },
    {
      label: "利用許諾料計算",
      severityLabel: royaltyCounts.stop > 0 ? "停止あり" : royaltyCounts.warn > 0 ? "注意あり" : "安定",
      detail: `停止 ${royaltyCounts.stop} 件 / 注意 ${royaltyCounts.warn} 件`,
      helper: "ライセンス紐付けと計算条件を確認",
      href: "/admin/workflow/royalty",
    },
  ];
}

async function buildWorkflowPriorityQueue(limit = 6): Promise<Array<{
  workflowLabel: string;
  issueKey: string;
  summary: string;
  severity: "stop" | "warn";
  message: string;
  reasonTag: string;
  href: string;
}>> {
  const recentIssues = await backlog.getRecentIssues(20);
  const items: Array<{
    workflowLabel: string;
    issueKey: string;
    summary: string;
    severity: "stop" | "warn";
    message: string;
    reasonTag: string;
    href: string;
  }> = [];

  for (const issue of recentIssues.filter((candidate) => getContractIssueTypeNames().has(candidate.issueType?.name ?? "")).slice(0, 10)) {
    const preview = await buildContractDraft(issue.issueKey, issue);
    const warning = preview.warnings.find((candidate) => candidate.level === "stop") ?? preview.warnings[0];
    if (!warning) continue;
    items.push({
      workflowLabel: "契約書生成",
      issueKey: issue.issueKey,
      summary: issue.summary,
      severity: warning.level,
      message: warning.message,
      reasonTag: classifyWorkflowReasonTag(warning.message),
      href: `/admin/workflow/contracts?issueKey=${encodeURIComponent(issue.issueKey)}`,
    });
  }

  for (const issue of recentIssues.filter((candidate) => getDeliveryIssueTypeNames().has(candidate.issueType?.name ?? "")).slice(0, 10)) {
    const parentIssueKey = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PARENT_ISSUE_KEY);
    const deliveredAmount = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_DELIVERED_AMOUNT);
    const finalDeadline = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_FINAL_DEADLINE) || issue.dueDate || null;
    const inspectionDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_INSPECTION_DATE) || null;
    const paymentPlannedDate = getIssueCustomFieldValue(issue, process.env.BACKLOG_FIELD_PAYMENT_PLANNED_DATE) || null;
    const deliveryEvent = await findDeliveryEventByBacklogIssueKey(issue.issueKey);
    const parentCondition = parentIssueKey ? await loadParentOrderConditionFieldsForAdmin(parentIssueKey) : undefined;
    const warnings = buildDeliveryPreviewWarnings({
      mode: "tracking",
      parentIssueKey,
      deliveredAmount,
      finalDeadline,
      inspectionDate,
      paymentPlannedDate,
      hasDeliveryEvent: Boolean(deliveryEvent),
      paymentCondition: parentCondition ?? null,
    });
    const warning = warnings.find((candidate) => candidate.level === "stop") ?? warnings[0];
    if (!warning) continue;
    items.push({
      workflowLabel: "納品帳票生成",
      issueKey: issue.issueKey,
      summary: issue.summary,
      severity: warning.level,
      message: warning.message,
      reasonTag: classifyWorkflowReasonTag(warning.message),
      href: `/admin/workflow/delivery?issueKey=${encodeURIComponent(issue.issueKey)}`,
    });
  }

  for (const issue of recentIssues.filter((candidate) => new Set(["製造案件", "売上報告"]).has(candidate.issueType?.name ?? "")).slice(0, 10)) {
    const snapshot = await getRoyaltyIssueSnapshot(issue.issueKey);
    const manufacturingEvent = await findManufacturingEventByBacklogIssueKey(issue.issueKey);
    const resolvedLicenseCondition = snapshot.licenseIssueKey
      ? await resolveRoyaltyLicenseCondition(snapshot.licenseIssueKey, undefined, snapshot.requestedConditionNo)
      : null;
    const warnings = buildRoyaltyPreviewWarnings({
      licenseIssueKey: snapshot.licenseIssueKey,
      productName: snapshot.productName,
      completionDate: snapshot.completionDate,
      quantity: String(snapshot.quantity || ""),
      msrp: String(snapshot.msrp || ""),
      manufacturingEvent,
      resolvedLicenseCondition: resolvedLicenseCondition?.meta ?? null,
    });
    const warning = warnings.find((candidate) => candidate.level === "stop") ?? warnings[0];
    if (!warning) continue;
    items.push({
      workflowLabel: "利用許諾料計算",
      issueKey: issue.issueKey,
      summary: issue.summary,
      severity: warning.level,
      message: warning.message,
      reasonTag: classifyWorkflowReasonTag(warning.message),
      href: `/admin/workflow/royalty?issueKey=${encodeURIComponent(issue.issueKey)}`,
    });
  }

  return items
    .sort((a, b) => {
      const rank = (value: "stop" | "warn") => value === "stop" ? 0 : 1;
      return rank(a.severity) - rank(b.severity);
    })
    .slice(0, limit);
}

function buildWorkflowSampleRunbooks(): Array<{
  label: string;
  href: string;
  sampleIssueHint: string;
  helper: string;
  steps: string[];
}> {
  return [
    {
      label: "契約書生成",
      href: "/admin/workflow/contracts",
      sampleIssueHint: "NDA / 業務委託基本契約 / ライセンス契約のいずれか 1 件",
      helper: "最初のサンプル確認はここから始めるのがおすすめです。",
      steps: [
        "最近の契約課題かサンプル課題キーを入れて「条件を確認」を押す",
        "生成前チェックで停止項目を解消し、必要なら「該当欄へ移動」で修正する",
        "「文面プレビュー」でテンプレートと想定保存先を確認する",
        "「下書きを保存」してから「文書を生成」し、生成サマリーと次アクションを確認する",
      ],
    },
    {
      label: "納品帳票生成",
      href: "/admin/workflow/delivery",
      sampleIssueHint: "親発注課題キーと納品金額が入った 納品リクエスト 1 件",
      helper: "親課題、DeliveryEvent、納品金額の 3 点が揃うと流れを確認しやすいです。",
      steps: [
        "納品リクエスト課題を開いて「条件を確認」し、親課題・納品金額・支払条件を確認する",
        "要修正一覧や停止理由を見て、不足している値を補う",
        "出力見込みで検収書のみか、支払通知書まで出るかを確認する",
        "文書生成後に生成サマリーと次アクションで保存先と確認項目を追う",
      ],
    },
    {
      label: "利用許諾料計算",
      href: "/admin/workflow/royalty",
      sampleIssueHint: "ライセンス課題キー、数量、MSRP が入った 製造案件 1 件",
      helper: "ライセンス紐付けと計算条件を確認できるサンプルが 1 件あると十分です。",
      steps: [
        "製造案件を開いて「条件を確認」し、ライセンス紐付けと製造情報を読む",
        "停止項目があれば数量、MSRP、完了日、ライセンス条件を優先して埋める",
        "生成前チェックで DB 保存と期限同期に必要な値が揃っているか確認する",
        "文書生成後に生成サマリーと次アクションで報告期限・支払期限の確認へ進む",
      ],
    },
  ];
}

function classifyWorkflowReasonTag(message: string): string {
  if (message.includes("相手方")) return "相手方";
  if (message.includes("契約日")) return "契約日";
  if (message.includes("親発注課題")) return "親課題";
  if (message.includes("DeliveryEvent")) return "DeliveryEvent";
  if (message.includes("納品金額")) return "納品金額";
  if (message.includes("ライセンス")) return "ライセンス";
  if (message.includes("製品名")) return "製品名";
  if (message.includes("製造完了日")) return "完了日";
  if (message.includes("製造数量")) return "数量";
  if (message.includes("MSRP")) return "MSRP";
  if (message.includes("振込先")) return "振込先";
  if (message.includes("請求書番号")) return "請求書番号";
  return "要確認";
}

function getOrderCsvSample(profileId: string): {
  fileName: string;
  csv: string;
} {
  if (profileId === "publishing_bulk") {
    return {
      fileName: "publishing_bulk_sample.csv",
      csv: [
        "担当者ID,発注日,支払日,コード,支払先（ペンネーム）,書籍名,業務概要,業務詳細（仕様）,単価（税込）,数量,発注金額（税別）,初校締切,再校締切,校了予定,備考",
        "U0123456789,2026/04/13,2026/05/20,VN-001,山田花子,空色文庫,本文組版,装画・本文192頁・A5,120000,1,120000,2026/04/15,2026/04/25,2026/04/30,初版制作",
        "U0123456789,2026/04/13,2026/06/20,VN-002,佐藤次郎,星巡り図鑑,本文組版,図版調整・本文128頁・B6,85000,1,85000,2026/04/18,,2026/05/08,重版対応含む",
      ].join("\n"),
    };
  }

  return {
    fileName: "planning_order_sample.csv",
    csv: [
      "カードNo.,カード名,色,カード種類,キャラ備考,特徴,画角,イラスト指定,作家名,完成,B〆",
      "A-001,炎の剣士,赤,ユニット,主人公,火炎・前衛,バストアップ,躍動感のある構図,山田花子,2026/04/15,2026/04/30",
      "B-014,森の賢者,緑,ユニット,老賢者,回復・支援,全身,柔らかい自然光,山田花子,2026/04/30,",
    ].join("\n"),
  };
}

function getOrderCsvVariableMap(profileId: string): {
  fileName: string;
  csv: string;
} {
  if (profileId === "publishing_bulk") {
    return {
      fileName: "publishing_bulk_variable_map.csv",
      csv: [
        "csvColumn,templateVariable,fieldPath,section,note",
        "担当者ID,STAFF_NAME / STAFF_EMAIL,staff master lookup,自社情報,Slack ID から Staff マスタを引いて担当者名とメールを補完",
        "発注日,ORDER_DATE_YEAR / ORDER_DATE_MONTH / ORDER_DATE_DAY,document header,文書ヘッダ,発注書の発行日として使用",
        "支払日,PAYMENT_TERMS / items[].payment_date,planningContext payment date,支払条件,支払日を発注書の支払条件表示に使用",
        "書籍名,ITEM_NAME,items[].description,明細,帳票の明細名として出力",
        "業務概要,ITEM_SPEC,items[].spec,明細,明細の仕様・補足へ反映",
        "業務詳細（仕様）,ITEM_SPEC,items[].spec,明細,業務概要と連結して仕様欄へ反映",
        "発注金額（税別）,ITEM_AMOUNT,items[].amount,明細,税抜金額の優先列",
        "単価（税込）,unitPrice,items[].unitPrice,明細,明細単価",
        "数量,qty,items[].quantity,明細,明細数量",
        "初校締切,ITEM_DUE_DATE,items[].dueDate,明細,明細納期の主候補",
        "再校締切,ITEM_DUE_DATE,items[].dueDate,明細,初校締切未入力時の補完候補",
        "校了予定,ITEM_DUE_DATE,items[].dueDate,明細,最終締切の補助候補",
        "支払先（ペンネーム）,VENDOR_NAME,VENDOR_NAME / items[].vendorLookup,相手方,取引先名の解決に使用",
        "コード,VENDOR_CODE,items[].vendorCode,相手方,同一取引先の束ね単位",
        "備考,REMARKS,REMARKS,備考,帳票全体の備考に追記候補",
      ].join("\n"),
    };
  }

  return {
    fileName: "planning_order_variable_map.csv",
    csv: [
      "csvColumn,templateVariable,fieldPath,section,note",
      "カード名,ITEM_NAME,items[].description,明細,帳票の明細名として出力",
      "イラスト指定,ITEM_SPEC,items[].spec,明細,仕様・指示欄へ反映",
      "完成,ITEM_DUE_DATE,items[].dueDate,明細,明細納期の主候補",
      "B〆,ITEM_DUE_DATE,items[].dueDate,明細,完成未入力時の補完候補",
      "作家名,VENDOR_NAME,VENDOR_NAME / items[].vendorLookup,相手方,取引先名の解決に使用",
      "カードNo.,ITEM_SPEC,items[].spec,明細,仕様欄へ追記候補",
      "色,ITEM_SPEC,items[].spec,明細,仕様欄へ追記候補",
      "カード種類,ITEM_SPEC,items[].spec,明細,仕様欄へ追記候補",
      "キャラ備考,ITEM_SPEC,items[].spec,明細,仕様欄へ追記候補",
      "特徴,ITEM_SPEC,items[].spec,明細,仕様欄へ追記候補",
      "画角,ITEM_SPEC,items[].spec,明細,仕様欄へ追記候補",
    ].join("\n"),
  };
}

function getInspectionVariableMap(): {
  fileName: string;
  csv: string;
} {
  return {
    fileName: "inspection_variable_map.csv",
      csv: [
        "sourceColumn,templateVariable,fieldPath,section,note",
        "検収日,approval_date,approval_date,承認欄,現行テンプレートで実際に表示される検収日",
        "検収日,items[].inspection_date,items[].inspection_date,明細,明細行の検収日列に表示",
        "支払先（ペンネーム）,vendor_name,vendor_name,相手方,検収書の宛名",
      "適格請求書番号,vendor_invoice_num,vendor_invoice_num,相手方,登録番号表示",
      "発注書番号,order_no,order_no,発注情報,発注書番号表示",
      "契約書番号,contract_no,contract_no,発注情報,任意の契約番号",
      "案件名,project_name,project_name,発注情報,案件名表示",
      "業務名,items[].name,items[].name,明細,検収対象の内容名",
      "業務概要,items[].spec,items[].spec,明細,仕様欄",
      "明細番号,items[].no,items[].no,明細,例: ①1",
      "数量,items[].thisTimeQuantity,items[].thisTimeQuantity,明細,今回検収数量",
      "金額(税抜),items[].amount_ex_tax,items[].amount_ex_tax,明細,今回検収金額",
      "備考,items[].notes,items[].notes,明細,明細備考",
      "修正内容,items[].revisionDetail,items[].revisionDetail,明細,差分説明を表示する場合",
      "金額変更前,items[].originalAmount,items[].originalAmount,明細,金額変更表示用",
      "金額変更後,items[].newAmount,items[].newAmount,明細,金額変更表示用",
      "金額変更理由,items[].amountChangeReason,items[].amountChangeReason,明細,金額変更表示用",
      "検収承認者,approver_name,approver_name,承認欄,承認者名",
      "検収承認部署,approver_department,approver_department,承認欄,承認者部署",
      "検収確認者,reviewer_name,reviewer_name,承認欄,確認者名",
      "検収確認部署,reviewer_department,reviewer_department,承認欄,確認者部署",
      "検収担当者,person_name,person_name,承認欄,担当者名",
      "検収担当部署,person_department,person_department,承認欄,担当者部署",
      "コメント,approval_comments,approval_comments,承認欄,検収コメント",
      "合計税抜,totalExTax,totalExTax,合計,税抜合計",
      "合計税込,totalIncTax,totalIncTax,合計,税込合計",
      "納品種別,deliveryTypeLabel,deliveryTypeLabel,補助,全部納品 / 一部納品",
      "業務名（単票用）,business_description,business_description,補助,items未使用時のフォールバック",
      "注意,items[].inspection_date,未実装,メモ,明細行の検収日列は現行テンプレートでは未配線",
    ].join("\n"),
  };
}

function buildAdminHomeHtml(
  snapshot: Awaited<ReturnType<typeof getAdminDashboardSnapshot>>,
  runtimeStatus: ReturnType<typeof getLocalRuntimeStatus>,
  workflowAttentionSummary: Awaited<ReturnType<typeof buildWorkflowAttentionSummary>>,
  workflowPriorityQueue: Awaited<ReturnType<typeof buildWorkflowPriorityQueue>>,
): string {
  const sections = [
    {
      title: "発注管理",
      description: "発注書の単体作成、一括取込、発注明細の管理をここに寄せています。まずは発注の入口をここから選びます。",
      accent: "Orders",
      items: [
        {
          title: "発注管理トップ",
          href: "/admin/orders",
          description: "単体作成、一括作成、前提設定まで発注まわりをまとめて見ます。",
          helper: "発注の入口",
        },
        {
          title: "発注書単体作成",
          href: "/admin/workflow/orders/create",
          description: "発注書・企画発注書・出版発注書を、単票ベースで起票します。",
          helper: "単体起票",
        },
        {
          title: "CSV / Excel 一括作成",
          href: "/admin/orders/csv",
          description: "明細をまとめて取り込み、親課題と 1 明細 1 課題を整えます。",
          helper: "一括取込",
        },
      ],
    },
    {
      title: "契約・納品・利用許諾料",
      description: "契約書生成、納品・検収、利用許諾料計算を業務単位でまとめています。対象カテゴリから入ると画面遷移が追いやすくなります。",
      accent: "Operations",
      items: [
        {
          title: "契約管理トップ",
          href: "/admin/contracts",
          description: "契約書生成と押印管理の入口です。",
          helper: "契約管理",
        },
        {
          title: "納品・検収トップ",
          href: "/admin/delivery",
          description: "発注明細課題を起点に検収書と支払通知書を扱います。",
          helper: "納品・検収",
        },
        {
          title: "利用許諾料トップ",
          href: "/admin/royalty",
          description: "製造ベース・売上報告ベースの計算と通知書を扱います。",
          helper: "利用許諾料",
        },
      ],
    },
    {
      title: "マスタ・設定・管理ツール",
      description: "前提データ、取込ルール、承認設定、申請確認ツールをここにまとめています。",
      accent: "Support",
      items: [
        {
          title: "マスタ・設定トップ",
          href: "/admin/settings",
          description: "Vendor / Staff、CSVマッピング、ワークフロー設定をまとめて見ます。",
          helper: "前提整備",
        },
        {
          title: "管理ツールトップ",
          href: "/admin/tools",
          description: "申請シミュレーターや押印管理など、確認系の画面をまとめています。",
          helper: "保守・確認",
        },
      ],
    },
  ];
  const recentItemsHtml = snapshot.recentWorkflows.length > 0
    ? snapshot.recentWorkflows.map((item) => {
        const issueUrl = buildBacklogIssueUrl(item.issueKey);
        const title = issueUrl
          ? `<a href="${escapeHtmlAttr(issueUrl)}" target="_blank" rel="noreferrer">${escapeHtmlText(item.issueKey)}</a>`
          : escapeHtmlText(item.issueKey);
        return `
          <article class="timeline-item">
            <div class="timeline-meta">
              <span class="timeline-badge">${escapeHtmlText(item.activityLabel)}</span>
              <time>${escapeHtmlText(formatAdminDate(item.updatedAt))}</time>
            </div>
            <strong>${title}</strong>
            <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
            <div class="timeline-helper">
              <span>${escapeHtmlText(item.issueTypeName || "種別未設定")}</span>
              <span>${escapeHtmlText(item.currentStatusName || "ステータス未設定")}</span>
              <span>${item.hasPrimaryDocument ? "文書あり" : "文書未生成"}</span>
            </div>
          </article>
        `;
      }).join("")
    : `<div class="empty-state">最近処理した案件はまだありません。申請や文書生成が始まるとここに表示されます。</div>`;
  const statusSummaryHtml = snapshot.statusSummary.length > 0
    ? snapshot.statusSummary.slice(0, 6).map((item) => `
        <div class="status-chip">
          <strong>${escapeHtmlText(item.statusName)}</strong>
          <span>${escapeHtmlText(String(item.count))} 件</span>
        </div>
      `).join("")
    : `<div class="empty-state">Backlog同期済みのステータス情報がまだありません。</div>`;
  const recentStatusTableRows = snapshot.recentStatusItems.length > 0
    ? snapshot.recentStatusItems.map((item) => {
        const issueUrl = buildBacklogIssueUrl(item.issueKey);
        const issueCell = issueUrl
          ? `<a href="${escapeHtmlAttr(issueUrl)}" target="_blank" rel="noreferrer">${escapeHtmlText(item.issueKey)}</a>`
          : escapeHtmlText(item.issueKey);
        return `
          <tr>
            <td>${issueCell}</td>
            <td>${escapeHtmlText(item.issueTypeName || "-")}</td>
            <td>${escapeHtmlText(item.currentStatusName || "-")}</td>
            <td>${escapeHtmlText(item.summary || "-")}</td>
            <td>${escapeHtmlText(formatAdminDate(item.updatedAt))}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="5" class="helper">表示できる課題がまだありません。</td></tr>`;
  const recentGeneratedDocumentsHtml = snapshot.recentGeneratedDocuments.length > 0
    ? snapshot.recentGeneratedDocuments.map((item) => {
        const issueUrl = buildBacklogIssueUrl(item.issueKey);
        const issueLabel = issueUrl
          ? `<a href="${escapeHtmlAttr(issueUrl)}" target="_blank" rel="noreferrer">${escapeHtmlText(item.issueKey)}</a>`
          : escapeHtmlText(item.issueKey);
        const docLabel = item.href
          ? `<a href="${escapeHtmlAttr(item.href)}" target="_blank" rel="noreferrer">${escapeHtmlText(item.name)}</a>`
          : escapeHtmlText(item.name);
        return `
          <article class="timeline-item">
            <div class="timeline-meta">
              <span class="timeline-badge">文書生成</span>
              <time>${escapeHtmlText(formatAdminDate(item.updatedAt))}</time>
            </div>
            <strong>${docLabel}</strong>
            <div class="timeline-summary">${issueLabel} / ${escapeHtmlText(item.issueTypeName || "種別未設定")}</div>
            <div class="timeline-helper">
              <span>${escapeHtmlText(item.summary || "概要未設定")}</span>
            </div>
          </article>
        `;
      }).join("")
    : `<div class="empty-state">生成済み文書はまだありません。契約書・納品帳票・利用許諾料計算書を出力するとここに表示されます。</div>`;
  const attentionItemsHtml = snapshot.attentionItems.length > 0
    ? snapshot.attentionItems.map((item) => {
        const issueUrl = buildBacklogIssueUrl(item.issueKey);
        const issueLabel = issueUrl
          ? `<a href="${escapeHtmlAttr(issueUrl)}" target="_blank" rel="noreferrer">${escapeHtmlText(item.issueKey)}</a>`
          : escapeHtmlText(item.issueKey);
        return `
          <article class="timeline-item">
            <div class="timeline-meta">
              <span class="timeline-badge runtime-alert">${escapeHtmlText(item.reason)}</span>
              <time>${escapeHtmlText(formatAdminDate(item.updatedAt))}</time>
            </div>
            <strong>${issueLabel}</strong>
            <div class="timeline-summary">${escapeHtmlText(item.issueTypeName || "種別未設定")} / ${escapeHtmlText(item.statusName || "ステータス未設定")}</div>
            <div class="timeline-helper">
              <span>${escapeHtmlText(item.kind === "sync" ? "同期系" : "ワークフロー系")}</span>
              <span>${escapeHtmlText(item.summary || "詳細未設定")}</span>
            </div>
          </article>
        `;
      }).join("")
    : `<div class="empty-state">現在、要確認案件はありません。差戻しや同期失敗があるとここに表示されます。</div>`;
  const runtimeSummaryClass = runtimeStatus.ready ? "timeline-badge" : "timeline-badge runtime-alert";
  const runtimeCardsHtml = runtimeStatus.components.map((component) => `
    <article class="quick-card runtime-card">
      <div class="card-topline">${escapeHtmlText(component.label)}</div>
      <strong>${escapeHtmlText(component.severity.toUpperCase())}</strong>
      <span>${escapeHtmlText(component.detail)}</span>
      <span class="card-link">更新: ${escapeHtmlText(formatAdminDate(component.updatedAt))}</span>
    </article>
  `).join("");
  const diagnosticsCardsHtml = buildLocalWorkflowDiagnostics(runtimeStatus).map((item) => `
    <article class="quick-card runtime-card">
      <div class="card-topline">${escapeHtmlText(item.label)}</div>
      <strong>${escapeHtmlText(item.severity.toUpperCase())}</strong>
      <span>${escapeHtmlText(item.detail)}</span>
      <span class="card-link">${escapeHtmlText(item.hint)}</span>
      <a class="inline-action" href="${escapeHtmlAttr(item.actionHref)}">${escapeHtmlText(item.actionLabel)}</a>
    </article>
  `).join("");
  const recentBacklogSyncRunsHtml = snapshot.recentBacklogSyncRuns?.length > 0
    ? snapshot.recentBacklogSyncRuns.map((item) => {
        const badgeClass = item.status === "FAILED" ? "timeline-badge runtime-alert" : "timeline-badge";
        const summaryText = item.status === "FAILED"
          ? (item.errorMessage || "Backlog 同期に失敗しました。")
          : item.bootstrapped
            ? `対象 ${item.issueCount} 件 / 変更 ${item.changedCount} 件 / 処理 ${item.processedCount} 件 / 失敗 ${item.failedCount} 件`
            : `初回スナップショット保存: 対象 ${item.issueCount} 件`;
        return `
          <article class="timeline-item">
            <div class="timeline-meta">
              <span class="${badgeClass}">${escapeHtmlText(item.status)}</span>
              <time>${escapeHtmlText(formatAdminDate(item.createdAt))}</time>
            </div>
            <strong>${escapeHtmlText(item.triggerSource === "admin-ui" ? "管理UIから手動同期" : item.triggerSource)}</strong>
            <div class="timeline-summary">${escapeHtmlText(summaryText)}</div>
          </article>
        `;
      }).join("")
    : `<div class="empty-state">Backlog 手動同期の履歴はまだありません。</div>`;
  const workflowAttentionCardsHtml = workflowAttentionSummary.map((item) => `
    <a class="quick-card runtime-card" href="${escapeHtmlAttr(item.href)}">
      <div class="card-topline">${escapeHtmlText(item.label)}</div>
      <strong>${escapeHtmlText(item.severityLabel)}</strong>
      <span>${escapeHtmlText(item.detail)}</span>
      <span class="card-link">${escapeHtmlText(item.helper)}</span>
    </a>
  `).join("");
  const workflowPriorityQueueHtml = workflowPriorityQueue.length > 0
    ? workflowPriorityQueue.map((item) => `
        <article class="timeline-item">
          <div class="timeline-meta">
            <span class="timeline-badge ${item.severity === "stop" ? "runtime-alert" : ""}">${escapeHtmlText(item.workflowLabel)}</span>
            <span>${escapeHtmlText(item.severity === "stop" ? "停止優先" : "注意確認")}</span>
          </div>
          <strong><a href="${escapeHtmlAttr(item.href)}">${escapeHtmlText(item.issueKey)}</a></strong>
          <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
          <div class="timeline-helper">
            <span class="tag">${escapeHtmlText(item.reasonTag)}</span>
            <span>${escapeHtmlText(item.message)}</span>
          </div>
        </article>
      `).join("")
    : `<div class="empty-state">優先対応が必要な案件は現在ありません。</div>`;
  const workflowSampleRunbooksHtml = buildWorkflowSampleRunbooks().map((item) => `
    <article class="quick-card runtime-card">
      <div class="card-topline">${escapeHtmlText(item.label)}</div>
      <strong>${escapeHtmlText(item.sampleIssueHint)}</strong>
      <span>${escapeHtmlText(item.helper)}</span>
      <span class="card-link">${item.steps.map((step, index) => `${index + 1}. ${step}`).join(" / ")}</span>
      <a class="inline-action" href="${escapeHtmlAttr(item.href)}">${escapeHtmlText(`${item.label}を開く`)}</a>
    </article>
  `).join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>管理ダッシュボード</title>
  <style>${sharedAdminCss()}</style>
</head>
<body>
  <div class="wrap">
    ${buildAdminNav("home")}
    <section class="hero hero-panel">
      <div class="eyebrow">LegalBridge Admin</div>
      <div class="hero-layout">
        <div>
          <h1>管理ダッシュボード</h1>
          <p class="sub">業務単位で迷わず入れるように、発注管理・契約管理・納品検収・利用許諾料・マスタ設定・管理ツールに整理しました。まずは今やりたい業務カテゴリを選び、その中から詳細画面へ進めます。</p>
        </div>
        <div class="hero-side">
          <div class="hero-kicker">よくある流れ</div>
          <div class="flow-list">
            <div class="flow-step"><strong>1. 発注管理</strong><span>単体作成か一括取込かを選び、明細課題まで整える</span></div>
            <div class="flow-step"><strong>2. 契約・納品</strong><span>契約書生成や検収フローを進める</span></div>
            <div class="flow-step"><strong>3. 利用許諾料</strong><span>計算書と支払通知までつなぐ</span></div>
          </div>
        </div>
      </div>
      <div class="hero-actions">
        <div class="tag-row">
          <span class="tag">設定と運用を分離</span>
          <span class="tag">機能説明つき</span>
          <span class="tag">モバイルでも見やすい配置</span>
        </div>
        <div class="actions">
          <button id="backlogSyncBtn" type="button">Backlogを今すぐ同期</button>
          <button id="restartAppBtn" type="button" class="ghost">アプリを再起動</button>
        </div>
      </div>
      <div id="systemActionStatus" class="status"></div>
    </section>
    <section class="panel quick-guide">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Runtime</div>
          <h2>サービス運用状態</h2>
        </div>
        <p class="section-copy">管理UIサービスの稼働状況です。DB、Backlog 設定差分、関連サービスとの役割分担をここから確認できます。</p>
      </div>
      <div class="timeline-item runtime-summary">
        <div class="timeline-meta">
          <span class="${runtimeSummaryClass}">${escapeHtmlText(runtimeStatus.mode)}</span>
          <time>${escapeHtmlText(formatAdminDate(runtimeStatus.updatedAt))}</time>
        </div>
        <strong>ready: ${escapeHtmlText(String(runtimeStatus.ready))}</strong>
        <div class="timeline-summary">詳細確認は <a href="/status" target="_blank" rel="noreferrer">/status</a>、監視や機械確認は <a href="/status.json" target="_blank" rel="noreferrer">/status.json</a> を使います。</div>
      </div>
      <div class="quick-grid">
        ${runtimeCardsHtml}
      </div>
    </section>
    <section class="panel quick-guide">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Quick Start</div>
          <h2>目的別のおすすめ入口</h2>
        </div>
      </div>
      <div class="quick-grid">
        <a class="quick-card" href="/admin/orders">
          <strong>発注まわりから始めたい</strong>
          <span>単体作成と一括取込のどちらから始めるかを、発注管理トップで選べます。</span>
        </a>
        <a class="quick-card" href="/admin/contracts">
          <strong>契約書や押印を進めたい</strong>
          <span>契約管理トップから、契約書生成と押印管理へ分かれます。</span>
        </a>
        <a class="quick-card" href="/admin/delivery">
          <strong>納品・検収を進めたい</strong>
          <span>納品・検収トップから、明細課題更新や検収書生成に進めます。</span>
        </a>
        <a class="quick-card" href="/admin/royalty">
          <strong>利用許諾料を計算したい</strong>
          <span>利用許諾料トップから、製造ベース・売上報告ベースの処理へ進めます。</span>
        </a>
      </div>
    </section>
    <section class="panel quick-guide">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Diagnostics</div>
          <h2>主要導線の自己診断</h2>
        </div>
        <p class="section-copy">CSV取込、契約書、納品、利用許諾料計算の4導線について、今の環境で着手できるかを簡易判定します。</p>
      </div>
      <div class="quick-grid">
        ${diagnosticsCardsHtml}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Backlog Sync</div>
          <h2>同期実行履歴</h2>
        </div>
        <p class="section-copy">管理UIから実行した Backlog 手動同期の結果を新しい順に表示します。</p>
      </div>
      <div class="timeline-list">
        ${recentBacklogSyncRunsHtml}
      </div>
    </section>
    <section class="panel quick-guide">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Sample Runbook</div>
          <h2>サンプルでの通し確認ガイド</h2>
        </div>
        <p class="section-copy">実案件がなくても、代表的な 1 件を使って preview から generate までを順に確認できるように、導線ごとの最短手順をまとめています。</p>
      </div>
      <div class="quick-grid">
        ${workflowSampleRunbooksHtml}
      </div>
    </section>
    <section class="panel quick-guide">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Attention Summary</div>
          <h2>導線別の要修正件数</h2>
        </div>
        <p class="section-copy">契約書、納品、利用許諾料計算のどこに停止・注意案件が溜まっているかをまとめて確認できます。</p>
      </div>
      <div class="quick-grid">
        ${workflowAttentionCardsHtml}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Priority Queue</div>
          <h2>優先対応キュー</h2>
        </div>
        <p class="section-copy">主要3導線の停止・注意案件から、先に見たほうがよい課題を横断で並べています。</p>
      </div>
      <div class="timeline-list">
        ${workflowPriorityQueueHtml}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Issue Launcher</div>
          <h2>Backlog課題キーから直接開く</h2>
        </div>
          <p class="section-copy">Backlog を起点に、課題キーだけで管理UI内の対象画面へ直接進める入口です。</p>
      </div>
      <div class="grid two-col">
        <section>
          <div class="row">
            <label for="launcherIssueKey">Backlog課題キー</label>
            <input id="launcherIssueKey" type="text" placeholder="LEGAL-123" />
          </div>
          <div id="launcherStatus" class="status"></div>
          <div id="launcherHint" class="summary-box" style="margin-top:12px;">
            課題キーを入れて「判定する」を押すと、種別に応じたおすすめ画面を表示します。
          </div>
        </section>
        <section class="summary-box">
          使い分け:
          - 契約書系は「契約書編集」
          - 納品リクエストは「納品帳票」
          - 製造案件 / 売上報告案件は「利用許諾料計算」
        </section>
      </div>
      <div class="actions">
        <button id="resolveLauncher" type="button">判定する</button>
        <button id="openContractLauncher" type="button">契約書編集を開く</button>
        <button id="openDeliveryLauncher" type="button" class="ghost">納品帳票を開く</button>
        <button id="openRoyaltyLauncher" type="button" class="ghost">利用許諾料計算を開く</button>
        <button id="openRecommendedLauncher" type="button" class="ghost">既定画面を開く</button>
        <button id="openBacklogLauncher" type="button" class="ghost">Backlogで開く</button>
      </div>
    </section>
    <div class="grid dashboard-detail-grid">
      <section class="panel">
        <div class="section-heading">
          <div>
            <div class="eyebrow">Recent Activity</div>
            <h2>最近処理した案件</h2>
          </div>
          <p class="section-copy">文書生成、承認、押印などの直近更新をまとめて確認できます。ダッシュボードからそのまま Backlog 課題へ移動できます。</p>
        </div>
        <div class="timeline-list">
          ${recentItemsHtml}
        </div>
      </section>
      <section class="panel">
        <div class="section-heading">
          <div>
            <div class="eyebrow">Backlog Status</div>
            <h2>課題ステータス一覧</h2>
          </div>
          <p class="section-copy">同期済みの課題から、今どのステータスに案件が集まっているかを把握できます。更新が新しい順に一覧化しています。</p>
        </div>
        <div class="status-chip-row">
          ${statusSummaryHtml}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>課題キー</th>
                <th>種別</th>
                <th>ステータス</th>
                <th>概要</th>
                <th>更新日時</th>
              </tr>
            </thead>
            <tbody>
              ${recentStatusTableRows}
            </tbody>
          </table>
        </div>
      </section>
    </div>
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Attention</div>
          <h2>要確認案件</h2>
        </div>
        <p class="section-copy">承認差戻し、押印差戻し、承認待ち、押印待ち、Backlog 同期失敗など、先に確認したい案件をまとめています。</p>
      </div>
      <div class="timeline-list">
        ${attentionItemsHtml}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Generated Docs</div>
          <h2>最近生成した文書</h2>
        </div>
        <p class="section-copy">契約書、検収書、支払通知書、利用許諾料計算書など、最近出力した成果物を課題単位で追えます。</p>
      </div>
      <div class="timeline-list">
        ${recentGeneratedDocumentsHtml}
      </div>
    </section>
    <div class="section-stack">
      ${sections.map((section) => `
        <section class="panel category-section">
          <div class="section-heading">
            <div>
              <div class="eyebrow">${section.accent}</div>
              <h2>${section.title}</h2>
            </div>
            <p class="section-copy">${section.description}</p>
          </div>
          <div class="grid dashboard-grid">
            ${section.items.map((item) => `
              <a class="dashboard-card" href="${item.href}">
                <div class="card-topline">${item.helper}</div>
                <strong>${item.title}</strong>
                <span>${item.description}</span>
                <div class="card-link">この機能を開く</div>
              </a>
            `).join("")}
          </div>
        </section>
      `).join("")}
    </div>
  </div>
  <script>
    const launcherIssueKey = document.getElementById("launcherIssueKey");
    const launcherStatus = document.getElementById("launcherStatus");
    const launcherHint = document.getElementById("launcherHint");
    let launcherResolved = null;

    document.getElementById("openContractLauncher").addEventListener("click", () => openIssueLauncher("/admin/workflow/contracts"));
    document.getElementById("openDeliveryLauncher").addEventListener("click", () => openIssueLauncher("/admin/workflow/delivery"));
    document.getElementById("openRoyaltyLauncher").addEventListener("click", () => openIssueLauncher("/admin/workflow/royalty"));
    document.getElementById("resolveLauncher").addEventListener("click", async () => {
      await resolveLauncher();
    });
    document.getElementById("openRecommendedLauncher").addEventListener("click", async () => {
      const payload = await resolveLauncher();
      if (!payload) return;
      window.location.href = payload.recommendedPath + "?issueKey=" + encodeURIComponent(payload.issueKey);
    });
    document.getElementById("openBacklogLauncher").addEventListener("click", async () => {
      const payload = launcherResolved ?? await resolveLauncher();
      if (!payload) return;
      if (payload.issueUrl) {
        window.location.href = payload.issueUrl;
        return;
      }
      const issueKey = normalizeIssueKey(launcherIssueKey.value);
      if (!issueKey) {
        launcherStatus.className = "status error";
        launcherStatus.textContent = "Backlog課題キーを入力してください。";
        return;
      }
      window.location.href = ${JSON.stringify(`https://${process.env.BACKLOG_SPACE}.backlog.com/view/`)} + encodeURIComponent(issueKey);
    });
    launcherIssueKey.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void resolveLauncher();
      }
    });
    launcherIssueKey.addEventListener("input", () => {
      launcherResolved = null;
      launcherHint.textContent = "課題キーを入れて「判定する」を押すと、種別に応じたおすすめ画面を表示します。";
    });

    document.getElementById("backlogSyncBtn").addEventListener("click", async () => {
      const status = document.getElementById("systemActionStatus");
      status.className = "status";
      status.textContent = "Backlog 同期を実行しています...";

      try {
        const response = await fetch("/admin/api/system/backlog-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const result = await response.json();
        if (!result.ok) {
          status.className = "status error";
          status.textContent = result.error || "Backlog 同期に失敗しました。";
          return;
        }

        const summary = result.summary || {};
        status.className = "status success";
        status.textContent = summary.bootstrapped === false
          ? "Backlog の初回スナップショットを保存しました。"
          : "Backlog 同期が完了しました。変更 "
            + (summary.changedCount ?? 0)
            + " 件 / 処理 "
            + (summary.processedCount ?? 0)
            + " 件 / 失敗 "
            + (summary.failedCount ?? 0)
            + " 件";
        setTimeout(() => {
          window.location.href = "/admin";
        }, 2000);
      } catch (error) {
        status.className = "status error";
        status.textContent = "Backlog 同期に失敗しました。数秒後に再試行してください。";
      }
    });

    document.getElementById("restartAppBtn").addEventListener("click", async () => {
      const status = document.getElementById("systemActionStatus");
      const confirmed = window.confirm("アプリを再起動します。数秒間 WebUI へアクセスできなくなります。続けますか？");
      if (!confirmed) return;

      status.className = "status";
      status.textContent = "再起動を開始しています...";

      try {
        const response = await fetch("/admin/api/system/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const result = await response.json();
        if (!result.ok) {
          status.className = "status error";
          status.textContent = result.error || "再起動に失敗しました。";
          return;
        }

        status.className = "status success";
        status.textContent = "再起動を開始しました。10秒後に画面を開き直します。";
        setTimeout(() => {
          window.location.href = "/admin";
        }, 10000);
      } catch (error) {
        status.className = "status warning";
        status.textContent = "再起動要求は送れました。数秒後に /admin を開き直してください。";
      }
    });

    function openIssueLauncher(basePath) {
      const issueKey = normalizeIssueKey(launcherIssueKey.value);
      if (!issueKey) {
        launcherStatus.className = "status error";
        launcherStatus.textContent = "Backlog課題キーを入力してください。";
        return;
      }
      launcherStatus.className = "status success";
      launcherStatus.textContent = "画面を開いています...";
      window.location.href = basePath + "?issueKey=" + encodeURIComponent(issueKey);
    }

    function normalizeIssueKey(value) {
      const normalized = String(value ?? "").trim().toUpperCase();
      return /^[A-Z][A-Z0-9_]*-\d+$/.test(normalized) ? normalized : "";
    }

    async function resolveLauncher() {
      const issueKey = normalizeIssueKey(launcherIssueKey.value);
      if (!issueKey) {
        launcherStatus.className = "status error";
        launcherStatus.textContent = "Backlog課題キーを入力してください。";
        launcherHint.textContent = "例: LEGAL-123 の形式で入力してください。";
        return null;
      }

      launcherStatus.className = "status";
      launcherStatus.textContent = "Backlog課題を確認しています...";
      try {
        const response = await fetch("/admin/api/workflow/resolve-launcher?issueKey=" + encodeURIComponent(issueKey));
        const payload = await response.json();
        if (!payload.ok) {
          launcherStatus.className = "status error";
          launcherStatus.textContent = payload.error || "既定画面を判定できませんでした。";
          launcherHint.textContent = "課題キーを確認して、もう一度試してください。";
          return null;
        }

        launcherResolved = payload;
        launcherStatus.className = "status success";
        launcherStatus.textContent = payload.note || ("既定: " + payload.recommendedLabel + " を開きます。");
        launcherHint.innerHTML = [
          payload.issueTypeName ? "種別: <strong>" + escapeHtml(payload.issueTypeName) + "</strong>" : "種別: 未判定",
          payload.summary ? "件名: <strong>" + escapeHtml(payload.summary) + "</strong>" : "",
          "おすすめ: <strong>" + escapeHtml(payload.recommendedLabel) + "</strong>",
        ].filter(Boolean).join("<br>");
        return payload;
      } catch (error) {
        launcherStatus.className = "status error";
        launcherStatus.textContent = "既定画面の判定に失敗しました。";
        launcherHint.textContent = "通信状態を確認して、もう一度試してください。";
        return null;
      }
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  </script>
</body>
</html>`;
}

type AdminHubCard = {
  title: string;
  href: string;
  description: string;
  helper?: string;
};

type AdminSectionLink = {
  href: string;
  label: string;
  description: string;
  active?: boolean;
};

function buildAdminHubHtml(
  current: AdminNavKey,
  eyebrow: string,
  title: string,
  description: string,
  cards: AdminHubCard[],
  summaryTitle: string,
  summaryLines: string[],
  extraSectionsHtml = "",
): string {
  const cardsHtml = cards.map((card) => `
    <a class="quick-card runtime-card" href="${escapeHtmlAttr(card.href)}">
      <div class="card-topline">${escapeHtmlText(card.helper || "導線")}</div>
      <strong>${escapeHtmlText(card.title)}</strong>
      <span>${escapeHtmlText(card.description)}</span>
      <span class="card-link">この画面を開く</span>
    </a>
  `).join("");
  const summaryHtml = summaryLines.map((line) => `<div>${escapeHtmlText(line)}</div>`).join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtmlText(title)}</title>
  <style>${sharedAdminCss()}</style>
</head>
<body>
  <div class="wrap">
    ${buildAdminNav(current)}
    <section class="hero hero-panel">
      <div class="eyebrow">${escapeHtmlText(eyebrow)}</div>
      <div class="hero-layout">
        <div>
          <h1>${escapeHtmlText(title)}</h1>
          <p class="sub">${escapeHtmlText(description)}</p>
        </div>
        <section class="summary-box">
          <strong>${escapeHtmlText(summaryTitle)}</strong>
          <div class="helper" style="margin-top:10px; display:grid; gap:8px;">${summaryHtml}</div>
        </section>
      </div>
    </section>
    <section class="panel quick-guide">
      <div class="section-heading">
        <div>
          <div class="eyebrow">${escapeHtmlText(eyebrow)}</div>
          <h2>このカテゴリでよく使う画面</h2>
        </div>
      </div>
      <div class="quick-grid">
        ${cardsHtml}
      </div>
    </section>
    ${extraSectionsHtml}
  </div>
</body>
</html>`;
}

function buildCategorySwitchHtml(
  _eyebrow: string,
  _title: string,
  _description: string,
  links: AdminSectionLink[],
): string {
  return `
    <div class="category-switch" style="margin-bottom:20px;">
      ${links.map((link) => `
        <a class="category-switch-link${link.active ? " active-panel-link" : ""}" href="${escapeHtmlAttr(link.href)}" title="${escapeHtmlAttr(link.description)}">
          ${escapeHtmlText(link.label)}
        </a>
      `).join("")}
    </div>
  `;
}

function buildOrdersAdminHubHtml(
  snapshot: Awaited<ReturnType<typeof getAdminDashboardSnapshot>>,
): string {
  const orderTypeNames = getOrderIssueTypeNames();
  const deliveryTypeNames = getDeliveryIssueTypeNames();
  const recentOrders = snapshot.recentWorkflows
    .filter((item) => orderTypeNames.has(item.issueTypeName || ""))
    .slice(0, 6);
  const recentTrackingIssues = snapshot.recentStatusItems
    .filter((item) => deliveryTypeNames.has(item.issueTypeName || ""))
    .slice(0, 6);
  const recentOrdersHtml = recentOrders.length > 0
    ? recentOrders.map((item) => `
      <article class="timeline-item">
        <div class="timeline-meta">
          <span class="timeline-badge">${escapeHtmlText(item.issueTypeName || "発注")}</span>
          <time>${escapeHtmlText(formatAdminDate(item.updatedAt))}</time>
        </div>
        <strong>${escapeHtmlText(item.issueKey)}</strong>
        <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
        <div class="timeline-helper">
          <span>${escapeHtmlText(item.currentStatusName || "ステータス未設定")}</span>
          <span>${item.hasPrimaryDocument ? "文書あり" : "文書未生成"}</span>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">最近の発注案件はまだありません。単体作成または一括取込を行うとここに表示されます。</div>`;
  const recentTrackingHtml = recentTrackingIssues.length > 0
    ? recentTrackingIssues.map((item) => `
      <article class="timeline-item">
        <div class="timeline-meta">
          <span class="timeline-badge">${escapeHtmlText(item.currentStatusName || "ステータス未設定")}</span>
          <time>${escapeHtmlText(formatAdminDate(item.updatedAt))}</time>
        </div>
        <strong>${escapeHtmlText(item.issueKey)}</strong>
        <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
        <div class="timeline-helper">
          <span>${escapeHtmlText(item.issueTypeName || "納品管理課題")}</span>
          <span><a href="/admin/workflow/delivery?issueKey=${encodeURIComponent(item.issueKey)}">納品・検収へ</a></span>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">発注時に自動作成された明細課題はまだありません。出版発注書や一括取込の実行後にここへ表示されます。</div>`;
  const singleCreateButtonsHtml = [
    { type: "purchase_order", label: "発注書", helper: "通常の発注書を作成" },
    { type: "planning_order", label: "企画発注書", helper: "企画用の単票を作成" },
    { type: "publishing_order", label: "出版発注書", helper: "出版用の単票を作成" },
  ].map((item) => `
    <a class="quick-card runtime-card" href="/admin/workflow/orders/create?type=${encodeURIComponent(item.type)}">
      <div class="card-topline">単体起票</div>
      <strong>${escapeHtmlText(item.label)}</strong>
      <span>${escapeHtmlText(item.helper)}</span>
      <span class="card-link">この種別で開く</span>
    </a>
  `).join("");

  return buildAdminHubHtml(
    "orders",
    "Orders",
    "発注管理",
    "単体作成、一括取込、発注明細の確認をここからまとめて進めます。発注関連の入口を1か所に寄せて、最初に迷わない構造にしています。",
    [
      {
        title: "発注書単体作成",
        href: "/admin/workflow/orders/create",
        description: "発注書・企画発注書・出版発注書を、単票ベースでそのまま起票します。",
        helper: "単体起票",
      },
      {
        title: "CSV / Excel 一括作成",
        href: "/admin/orders/csv",
        description: "企画発注書や出版発注書の明細をまとめて取り込み、親課題と明細課題を整えます。",
        helper: "一括取込",
      },
      {
        title: "マッピング設定",
        href: "/admin/settings/mapping",
        description: "列対応、初期値、企画用と出版用のプロファイルを調整します。",
        helper: "取込前提",
      },
      {
        title: "Vendor / Staff を整える",
        href: "/admin/masters",
        description: "発注書に必要な取引先情報、担当者情報、代表者名などのマスタを管理します。",
        helper: "前提データ",
      },
    ],
    "使い分け",
    [
      "1件だけ作るときは単体作成、一括で登録するときは CSV / Excel 一括作成を使います。",
      "出版発注書は、取込時点で 1 明細 1 課題の Backlog 明細課題まで自動整備されます。",
      "列名が合わないときは、先にマッピング設定を直してから取り込むと手戻りが減ります。",
    ],
    `<section class="grid two-col" style="margin-top:24px;">
    <section class="panel">
    <div class="section-heading">
      <div>
        <div class="eyebrow">Recent Orders</div>
        <h2>最近の発注案件</h2>
      </div>
      <p class="section-copy">単体作成と一括作成の結果を、発注課題単位でざっくり追える一覧です。</p>
    </div>
      <div class="timeline-list">
        ${recentOrdersHtml}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Tracking Issues</div>
          <h2>最近の発注明細課題</h2>
        </div>
        <p class="section-copy">発注時に自動作成された 1 明細 1 課題を、納品・検収へつなぐ入口として確認できます。</p>
      </div>
      <div class="timeline-list">
        ${recentTrackingHtml}
      </div>
    </section>
  </section>
  <section class="panel quick-guide">
    <div class="section-heading">
      <div>
        <div class="eyebrow">Single Create</div>
        <h2>単体作成の種別を選ぶ</h2>
      </div>
      <p class="section-copy">発注管理トップから、そのまま対象の発注書種別を選んで開始できます。</p>
    </div>
    <div class="quick-grid">
      ${singleCreateButtonsHtml}
    </div>
  </section>`,
  );
}

function buildContractsAdminHubHtml(
  snapshot: Awaited<ReturnType<typeof getAdminDashboardSnapshot>>,
  workflowPriorityQueue: Awaited<ReturnType<typeof buildWorkflowPriorityQueue>>,
): string {
  const contractTypeNames = getContractIssueTypeNames();
  const recentContracts = snapshot.recentWorkflows
    .filter((item) => contractTypeNames.has(item.issueTypeName || ""))
    .slice(0, 6);
  const contractAttentionItems = workflowPriorityQueue
    .filter((item) => item.workflowLabel === "契約書生成")
    .slice(0, 6);
  const recentContractsHtml = recentContracts.length > 0
    ? recentContracts.map((item) => `
      <article class="timeline-item">
        <div class="timeline-meta">
          <span class="timeline-badge">${escapeHtmlText(item.issueTypeName || "契約")}</span>
          <time>${escapeHtmlText(formatAdminDate(item.updatedAt))}</time>
        </div>
        <strong><a href="/admin/workflow/contracts?issueKey=${encodeURIComponent(item.issueKey)}">${escapeHtmlText(item.issueKey)}</a></strong>
        <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
        <div class="timeline-helper">
          <span>${escapeHtmlText(item.currentStatusName || "ステータス未設定")}</span>
          <span>${item.hasPrimaryDocument ? "文書あり" : "文書未生成"}</span>
          <span>${escapeHtmlText(summarizeContractNextAction(item.currentStatusName, item.hasPrimaryDocument))}</span>
          ${buildBacklogIssueUrl(item.issueKey) ? `<span><a href="${escapeHtmlAttr(buildBacklogIssueUrl(item.issueKey) || "")}" target="_blank" rel="noreferrer">Backlog</a></span>` : ""}
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">最近の契約課題はまだありません。</div>`;
  const contractAttentionHtml = contractAttentionItems.length > 0
    ? contractAttentionItems.map((item) => `
      <article class="timeline-item">
        <div class="timeline-meta">
          <span class="timeline-badge ${item.severity === "stop" ? "runtime-alert" : ""}">${escapeHtmlText(item.severity === "stop" ? "停止優先" : "注意確認")}</span>
          <span>${escapeHtmlText(item.reasonTag)}</span>
        </div>
        <strong><a href="${escapeHtmlAttr(item.href)}">${escapeHtmlText(item.issueKey)}</a></strong>
        <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
        <div class="timeline-helper">
          <span>${escapeHtmlText(item.message)}</span>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">今すぐ確認が必要な契約課題はありません。</div>`;
  return buildAdminHubHtml(
    "contracts-hub",
    "Contracts",
    "契約管理",
    "契約書の生成、Backlog 課題キーからの編集、押印前後の確認をここにまとめます。",
    [
      {
        title: "契約書生成",
        href: "/admin/workflow/contracts",
        description: "Backlog 課題キーから契約書ドラフト、プレビュー、生成結果確認まで進めます。",
        helper: "契約書作成",
      },
      {
        title: "押印管理",
        href: "/admin/workflow/stamp",
        description: "押印依頼、方式更新、完了登録、差戻しを追跡します。",
        helper: "進行管理",
      },
      {
        title: "Backlog 課題キーから開く",
        href: "/admin",
        description: "ダッシュボードの課題キーランチャーから、対象案件の契約画面へ直接移動します。",
        helper: "ショートカット",
      },
    ],
    "使い分け",
    [
      "契約本文を出すときは契約書生成、社内の押印状況を追うときは押印管理を使います。",
      "Slack 起票は最小項目に寄せ、詳細条件や補完は Backlog と管理UI側で進める前提です。",
    ],
    `<section class="grid two-col" style="margin-top:24px;">
      <section class="panel">
        <div class="section-heading">
          <div>
            <div class="eyebrow">Contract Launcher</div>
            <h2>課題キーから契約画面を開く</h2>
          </div>
          <p class="section-copy">対象の契約課題キーが分かっている場合は、そのまま契約書生成画面へ移動できます。</p>
        </div>
        <div class="row">
          <label for="contractIssueKeyLauncher">契約課題キー</label>
          <input id="contractIssueKeyLauncher" type="text" placeholder="LEGAL-123" />
        </div>
        <div class="actions">
          <button id="openContractIssueBtn" type="button">契約書生成を開く</button>
        </div>
        <div id="contractIssueKeyStatus" class="status"></div>
      </section>
      <section class="panel">
        <div class="section-heading">
          <div>
            <div class="eyebrow">Attention</div>
            <h2>要対応の契約課題</h2>
          </div>
          <p class="section-copy">停止項目や補完不足がある契約課題を先に確認できます。</p>
        </div>
        <div class="timeline-list">
          ${contractAttentionHtml}
        </div>
      </section>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Recent Contracts</div>
          <h2>最近の契約課題</h2>
        </div>
        <p class="section-copy">最近更新された契約案件を、契約管理トップから直接開けます。</p>
      </div>
      <div class="timeline-list">
        ${recentContractsHtml}
      </div>
    </section>
    <script>
      const contractIssueKeyLauncher = document.getElementById("contractIssueKeyLauncher");
      const contractIssueKeyStatus = document.getElementById("contractIssueKeyStatus");
      document.getElementById("openContractIssueBtn").addEventListener("click", () => {
        const value = String(contractIssueKeyLauncher.value || "").trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9_]*-\\d+$/.test(value)) {
          contractIssueKeyStatus.className = "status error";
          contractIssueKeyStatus.textContent = "契約課題キーを入力してください。";
          return;
        }
        contractIssueKeyStatus.className = "status success";
        contractIssueKeyStatus.textContent = "画面を開いています...";
        window.location.href = "/admin/workflow/contracts?issueKey=" + encodeURIComponent(value);
      });
    </script>`,
  );
}

function buildDeliveryAdminHubHtml(
  snapshot: Awaited<ReturnType<typeof getAdminDashboardSnapshot>>,
  workflowPriorityQueue: Awaited<ReturnType<typeof buildWorkflowPriorityQueue>>,
): string {
  const deliveryTypeNames = getDeliveryIssueTypeNames();
  const deliveryAttentionItems = workflowPriorityQueue
    .filter((item) => item.workflowLabel === "納品帳票生成")
    .slice(0, 8);
  const recentDeliveryIssues = snapshot.recentStatusItems
    .filter((item) => deliveryTypeNames.has(item.issueTypeName || ""))
    .slice(0, 6);
  const attentionHtml = deliveryAttentionItems.length > 0
    ? deliveryAttentionItems.map((item) => `
      <article class="timeline-item" data-delivery-attention="${escapeHtmlAttr(item.severity)}">
        <div class="timeline-meta">
          <span class="timeline-badge ${item.severity === "stop" ? "runtime-alert" : ""}">${escapeHtmlText(item.severity === "stop" ? "停止優先" : "注意確認")}</span>
          <span>${escapeHtmlText(item.reasonTag)}</span>
        </div>
        <strong><a href="${escapeHtmlAttr(item.href)}">${escapeHtmlText(item.issueKey)}</a></strong>
        <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
        <div class="timeline-helper">
          <span>${escapeHtmlText(item.message)}</span>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">今すぐ確認が必要な納品案件はありません。</div>`;
  const recentDeliveryHtml = recentDeliveryIssues.length > 0
    ? recentDeliveryIssues.map((item) => `
      <article class="timeline-item" data-delivery-status="${escapeHtmlAttr(item.currentStatusName || "ステータス未設定")}">
        <div class="timeline-meta">
          <span class="timeline-badge">${escapeHtmlText(item.currentStatusName || "未設定")}</span>
          <time>${escapeHtmlText(formatAdminDate(item.updatedAt))}</time>
        </div>
        <strong>${escapeHtmlText(item.issueKey)}</strong>
        <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
        <div class="timeline-helper">
          <span>${escapeHtmlText(item.issueTypeName || "納品課題")}</span>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">最近の納品課題はまだありません。発注時に明細課題が作られるとここに表示されます。</div>`;
  const recentDeliveryStatuses = Array.from(new Set(recentDeliveryIssues.map((item) => item.currentStatusName || "ステータス未設定")));
  const attentionFilterButtonsHtml = [
    { value: "all", label: "すべて" },
    { value: "stop", label: "停止優先" },
    { value: "warn", label: "注意確認" },
  ].map((filter) => `<button type="button" class="filter-chip${filter.value === "all" ? " active-filter-chip" : ""}" data-attention-filter="${filter.value}">${escapeHtmlText(filter.label)}</button>`).join("");
  const statusFilterButtonsHtml = [
    { value: "all", label: "すべて" },
    ...recentDeliveryStatuses.map((status) => ({ value: status, label: status })),
  ].map((filter, index) => `<button type="button" class="filter-chip${index === 0 ? " active-filter-chip" : ""}" data-status-filter="${escapeHtmlAttr(filter.value)}">${escapeHtmlText(filter.label)}</button>`).join("");
  const deliveryLauncherHtml = `
    <section class="panel" style="margin-top:24px;">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Parent Issue</div>
          <h2>親課題キーから開く</h2>
        </div>
        <p class="section-copy">対象の発注親課題や企画発注親課題が分かっている場合は、ここから納品・検収画面へ直接進めます。</p>
      </div>
      <div class="grid two-col">
        <section>
          <div class="row">
            <label for="deliveryParentIssueKeyLauncher">親課題キー</label>
            <input id="deliveryParentIssueKeyLauncher" type="text" placeholder="LEGAL-123" />
          </div>
          <div class="actions">
            <button id="openDeliveryParentIssueBtn" type="button">納品・検収画面を開く</button>
          </div>
          <div id="deliveryParentIssueStatus" class="status"></div>
        </section>
        <section class="summary-box">
          使い方:
          発注書・企画発注書・出版発注書の親課題キーを入れると、一括納品エリアを開いた状態で納品・検収画面へ移動します。
        </section>
      </div>
    </section>
  `;

  return buildAdminHubHtml(
    "delivery-hub",
    "Delivery",
    "納品・検収",
    "発注明細課題を起点に、納品確認、検収書生成、支払通知までをここから扱います。",
    [
      {
        title: "納品・検収ワークフロー",
        href: "/admin/workflow/delivery",
        description: "既存の明細課題を更新しながら、検収書や支払通知書を生成します。",
        helper: "主導線",
      },
      {
        title: "発注管理へ戻る",
        href: "/admin/orders",
        description: "発注明細がまだ無い場合は、先に発注管理で親課題と明細課題を整えます。",
        helper: "前提確認",
      },
      {
        title: "要確認案件を見る",
        href: "/admin",
        description: "ダッシュボードの優先対応キューから、検収日未設定や停止案件を拾えます。",
        helper: "アラート確認",
      },
    ],
    "使い分け",
    [
      "今の設計では、新規の納品課題を毎回起票するのではなく、発注時に作られた明細課題を更新します。",
      "納品済みなのに検収書未作成、検収日ありなのに未処理、といったズレはこのカテゴリで追います。",
    ],
    `<section class="grid two-col" style="margin-top:24px;">
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Attention</div>
          <h2>要対応の納品案件</h2>
        </div>
        <p class="section-copy">検収日未設定、親課題参照不足、DeliveryEvent 未作成など、先に見るべき案件です。</p>
      </div>
      <div class="chip-list" style="margin-bottom:14px;">
        ${attentionFilterButtonsHtml}
      </div>
      <div class="timeline-list">
        ${attentionHtml}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Recent Delivery</div>
          <h2>最近の納品課題</h2>
        </div>
        <p class="section-copy">発注時に自動作成された明細課題や、その後更新された納品課題の最近分です。</p>
      </div>
      <div class="chip-list" style="margin-bottom:14px;">
        ${statusFilterButtonsHtml}
      </div>
      <div class="timeline-list">
        ${recentDeliveryHtml}
      </div>
    </section>
  </section>
  ${deliveryLauncherHtml}
  <script>
    document.querySelectorAll("[data-attention-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const value = button.getAttribute("data-attention-filter");
        document.querySelectorAll("[data-attention-filter]").forEach((candidate) => candidate.classList.toggle("active-filter-chip", candidate === button));
        document.querySelectorAll("[data-delivery-attention]").forEach((item) => {
          const matches = value === "all" || item.getAttribute("data-delivery-attention") === value;
          item.style.display = matches ? "" : "none";
        });
      });
    });
    document.querySelectorAll("[data-status-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const value = button.getAttribute("data-status-filter");
        document.querySelectorAll("[data-status-filter]").forEach((candidate) => candidate.classList.toggle("active-filter-chip", candidate === button));
        document.querySelectorAll("[data-delivery-status]").forEach((item) => {
          const matches = value === "all" || item.getAttribute("data-delivery-status") === value;
          item.style.display = matches ? "" : "none";
        });
      });
    });
    const deliveryParentIssueInput = document.getElementById("deliveryParentIssueKeyLauncher");
    const deliveryParentIssueStatus = document.getElementById("deliveryParentIssueStatus");
    document.getElementById("openDeliveryParentIssueBtn").addEventListener("click", () => {
      const value = String(deliveryParentIssueInput.value || "").trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*-\\d+$/.test(value)) {
        deliveryParentIssueStatus.className = "status error";
        deliveryParentIssueStatus.textContent = "親課題キーを入力してください。";
        return;
      }
      deliveryParentIssueStatus.className = "status success";
      deliveryParentIssueStatus.textContent = "画面を開いています...";
      window.location.href = "/admin/workflow/delivery?parentIssueKey=" + encodeURIComponent(value);
    });
  </script>`,
  );
}

function buildRoyaltyAdminHubHtml(
  snapshot: Awaited<ReturnType<typeof getAdminDashboardSnapshot>>,
  workflowPriorityQueue: Awaited<ReturnType<typeof buildWorkflowPriorityQueue>>,
): string {
  const royaltyTypeNames = new Set(["製造案件", "売上報告", "売上報告案件"]);
  const recentRoyaltyIssues = snapshot.recentWorkflows
    .filter((item) => royaltyTypeNames.has(item.issueTypeName || ""))
    .slice(0, 6);
  const royaltyAttentionItems = workflowPriorityQueue
    .filter((item) => item.workflowLabel === "利用許諾料計算")
    .slice(0, 6);
  const recentRoyaltyHtml = recentRoyaltyIssues.length > 0
    ? recentRoyaltyIssues.map((item) => `
      <article class="timeline-item">
        <div class="timeline-meta">
          <span class="timeline-badge">${escapeHtmlText(item.issueTypeName || "ロイヤリティ")}</span>
          <time>${escapeHtmlText(formatAdminDate(item.updatedAt))}</time>
        </div>
        <strong><a href="/admin/workflow/royalty?issueKey=${encodeURIComponent(item.issueKey)}">${escapeHtmlText(item.issueKey)}</a></strong>
        <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
        <div class="timeline-helper">
          <span>${escapeHtmlText(item.currentStatusName || "ステータス未設定")}</span>
          <span>${escapeHtmlText(summarizeRoyaltyNextAction(item.currentStatusName, item.issueTypeName))}</span>
          ${buildBacklogIssueUrl(item.issueKey) ? `<span><a href="${escapeHtmlAttr(buildBacklogIssueUrl(item.issueKey) || "")}" target="_blank" rel="noreferrer">Backlog</a></span>` : ""}
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">最近の利用許諾料案件はまだありません。</div>`;
  const royaltyAttentionHtml = royaltyAttentionItems.length > 0
    ? royaltyAttentionItems.map((item) => `
      <article class="timeline-item">
        <div class="timeline-meta">
          <span class="timeline-badge ${item.severity === "stop" ? "runtime-alert" : ""}">${escapeHtmlText(item.severity === "stop" ? "停止優先" : "注意確認")}</span>
          <span>${escapeHtmlText(item.reasonTag)}</span>
        </div>
        <strong><a href="${escapeHtmlAttr(item.href)}">${escapeHtmlText(item.issueKey)}</a></strong>
        <div class="timeline-summary">${escapeHtmlText(item.summary || "概要未設定")}</div>
        <div class="timeline-helper">
          <span>${escapeHtmlText(item.message)}</span>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">今すぐ確認が必要な利用許諾料案件はありません。</div>`;
  return buildAdminHubHtml(
    "royalty-hub",
    "Royalty",
    "利用許諾料",
    "製造ベースと売上報告ベースの計算、計算書出力、支払通知までをまとめています。",
    [
      {
        title: "利用許諾料計算",
        href: "/admin/workflow/royalty",
        description: "ライセンス課題キーを起点に、計算プレビュー、帳票生成、通知まで確認します。",
        helper: "計算実行",
      },
      {
        title: "Backlog 期限を確認",
        href: "/admin",
        description: "報告期限や支払期限は Backlog 正本なので、ダッシュボードや対象課題から期限を確認します。",
        helper: "期日管理",
      },
    ],
    "使い分け",
    [
      "製造完了ベースと売上報告ベースで入力値は違いますが、報告期限と支払期限は Backlog 側で持ちます。",
      "Slack では最小項目だけ入力し、詳細条件は Backlog と管理UIで補完します。",
    ],
    `<section class="grid two-col" style="margin-top:24px;">
      <section class="panel">
        <div class="section-heading">
          <div>
            <div class="eyebrow">Royalty Launcher</div>
            <h2>課題キーから計算画面を開く</h2>
          </div>
          <p class="section-copy">製造案件や売上報告案件の課題キーが分かっている場合は、そのまま計算画面へ移動できます。</p>
        </div>
        <div class="row">
          <label for="royaltyIssueKeyLauncher">対象課題キー</label>
          <input id="royaltyIssueKeyLauncher" type="text" placeholder="LEGAL-456" />
        </div>
        <div class="actions">
          <button id="openRoyaltyIssueBtn" type="button">利用許諾料計算を開く</button>
        </div>
        <div id="royaltyIssueKeyStatus" class="status"></div>
      </section>
      <section class="panel">
        <div class="section-heading">
          <div>
            <div class="eyebrow">Attention</div>
            <h2>要対応の利用許諾料案件</h2>
          </div>
          <p class="section-copy">ライセンス紐付け不足や計算条件不足の案件を先に確認できます。</p>
        </div>
        <div class="timeline-list">
          ${royaltyAttentionHtml}
        </div>
      </section>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <div class="eyebrow">Recent Royalty</div>
          <h2>最近の利用許諾料案件</h2>
        </div>
        <p class="section-copy">最近更新された製造案件・売上報告案件から、そのまま計算画面へ進めます。</p>
      </div>
      <div class="timeline-list">
        ${recentRoyaltyHtml}
      </div>
    </section>
    <script>
      const royaltyIssueKeyLauncher = document.getElementById("royaltyIssueKeyLauncher");
      const royaltyIssueKeyStatus = document.getElementById("royaltyIssueKeyStatus");
      document.getElementById("openRoyaltyIssueBtn").addEventListener("click", () => {
        const value = String(royaltyIssueKeyLauncher.value || "").trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9_]*-\\d+$/.test(value)) {
          royaltyIssueKeyStatus.className = "status error";
          royaltyIssueKeyStatus.textContent = "対象課題キーを入力してください。";
          return;
        }
        royaltyIssueKeyStatus.className = "status success";
        royaltyIssueKeyStatus.textContent = "画面を開いています...";
        window.location.href = "/admin/workflow/royalty?issueKey=" + encodeURIComponent(value);
      });
    </script>`,
  );
}

function buildSettingsAdminHubHtml(): string {
  return buildAdminHubHtml(
    "settings-hub",
    "Settings",
    "マスタ・設定",
    "Vendor / Staff、CSV マッピング、ワークフロー設定など、運用の前提を整える画面をまとめています。",
    [
      {
        title: "マスタ管理",
        href: "/admin/masters",
        description: "取引先、担当者、屋号、ペンネーム、代表者名、振込先などを登録します。",
        helper: "基礎データ",
      },
      {
        title: "マッピング設定",
        href: "/admin/settings/mapping",
        description: "企画用・出版用の取込プロファイルと初期値を調整します。",
        helper: "取込設定",
      },
      {
        title: "ワークフロー設定",
        href: "/admin/settings/workflow",
        description: "承認者、押印担当、部署別ルールを設定します。",
        helper: "進行ルール",
      },
    ],
    "使い分け",
    [
      "CSV 取込でズレるときはマッピング設定、候補者や相手方が見つからないときはマスタ管理を見ます。",
      "押印・承認の流れを変えたいときはワークフロー設定を使います。",
    ],
  );
}

function buildToolsAdminHubHtml(): string {
  return buildAdminHubHtml(
    "tools",
    "Tools",
    "管理ツール",
    "日常の主導線からは少し外した確認用・保守用の画面をここにまとめています。",
    [
      {
        title: "申請シミュレーター",
        href: "/admin/workflow/request-simulator",
        description: "Slack モーダルの入力要件、分岐、Backlog 反映を確認します。",
        helper: "確認用",
      },
      {
        title: "押印管理",
        href: "/admin/workflow/stamp",
        description: "押印依頼の調査や個別対応を行います。",
        helper: "保守運用",
      },
      {
        title: "ダッシュボードへ戻る",
        href: "/admin",
        description: "Runtime 状態、優先対応キュー、要確認案件などの全体状況を見ます。",
        helper: "全体確認",
      },
    ],
    "使い分け",
    [
      "普段の操作は発注管理・契約管理・納品検収・利用許諾料から入り、ここは調査や保守のときに使います。",
    ],
  );
}

function buildCsvAdminHtml(): string {
  const settings = getPlanningImportSettings();
  const profiles = getPlanningImportProfiles();
  const activeProfileId = getActivePlanningImportProfileId();
  const profileOptions = profiles.map((profile) =>
    `<option value="${escapeHtmlAttr(profile.id)}"${profile.id === activeProfileId ? " selected" : ""}>${escapeHtmlText(profile.label)}</option>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CSV一括発注 - LegalBridge</title>
  <style>${sharedAdminCss()}
    .csv-layout { display: grid; grid-template-columns: 380px 1fr; gap: 20px; align-items: start; }
    .csv-sidebar { position: sticky; top: 20px; }
    @media(max-width:900px){ .csv-layout { grid-template-columns: 1fr; } .csv-sidebar { position: static; } }
    .field-group { border: 1px solid var(--panel-border); border-radius: var(--radius-md); overflow: hidden; margin-bottom: 16px; }
    .field-group-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; background: #f8fafc; border-bottom: 1px solid var(--panel-border);
      cursor: pointer; user-select: none; font-weight: 600; font-size: 13px;
    }
    .field-group-header:hover { background: #f1f5f9; }
    .field-group-body { padding: 16px; }
    .field-group-body .row:last-child { margin-bottom: 0; }
    .field-group-toggle { font-size: 12px; color: var(--muted); transition: transform 0.2s; }
    .field-group.collapsed .field-group-body { display: none; }
    .field-group.collapsed .field-group-toggle { transform: rotate(-90deg); }
    .status-bar {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; border-radius: var(--radius-sm);
      font-size: 13px; font-weight: 500;
      background: #f8fafc; border: 1px solid var(--panel-border);
      min-height: 42px;
    }
    .status-bar.success { background: #f0fff4; border-color: rgba(56,161,105,0.2); color: #276749; }
    .status-bar.error { background: #fff5f5; border-color: rgba(229,62,62,0.18); color: #c53030; }
    .status-bar .icon { font-size: 16px; flex-shrink: 0; }
    .preview-count { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--accent-soft); color: var(--accent); border-radius: 999px; font-size: 12px; font-weight: 700; }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 0; }
    .section-divider { border: none; border-top: 1px solid var(--panel-border); margin: 20px 0; }
    .vendor-status-table { margin-top: 10px; }
    .vendor-ok { color: var(--success); }
    .vendor-warn { color: var(--warning); }
    .vendor-err { color: var(--danger); }
    .import-result { padding: 14px; background: #f0fff4; border: 1px solid rgba(56,161,105,0.2); border-radius: var(--radius-md); }
  </style>
</head>
<body>
  ${buildAdminNav("csv")}
  <div class="wrap">
    ${buildCategorySwitchHtml("Orders", "発注管理", "", [
      { href: "/admin/orders", label: "発注管理トップ", description: "発注関連の入口", active: false },
      { href: "/admin/workflow/orders/create", label: "発注書単体作成", description: "単票作成", active: false },
      { href: "/admin/orders/csv", label: "CSV / Excel 一括作成", description: "明細一括取込", active: true },
      { href: "/admin/settings/mapping", label: "マッピング設定", description: "列対応と既定値", active: false },
    ])}

    <div style="margin-bottom:20px;">
      <h1 style="margin-bottom:4px;">📊 CSV / Excel 一括取込</h1>
      <p class="sub">通常CSV・企画発注書・出版一括発注書に対応しています。Excelからシートを選んでCSV化することもできます。</p>
    </div>

    <div class="csv-layout">
      <!-- ===== 左側: 入力フォーム ===== -->
      <div class="csv-sidebar">
        <div class="panel">
          <!-- ステップ1: 基本設定 -->
          <div class="field-group">
            <div class="field-group-header" onclick="toggleFieldGroup(this)">
              <span>① 基本設定</span>
              <span class="field-group-toggle">▼</span>
            </div>
            <div class="field-group-body">
              <div class="row">
                <label for="issueKey">Backlog課題キー <span style="color:var(--danger)">*</span></label>
                <input id="issueKey" type="text" placeholder="LEGAL-123" autocomplete="off" />
              </div>
              <div class="row">
                <label for="mode">取込モード</label>
                <select id="mode">
                  <option value="generic">通常CSV</option>
                  <option value="planning">企画発注書マッピング</option>
                </select>
              </div>
              <div class="row">
                <label for="mappingProfileId">マッピング種別</label>
                <select id="mappingProfileId">
                  ${profileOptions}
                </select>
              </div>
            </div>
          </div>

          <!-- ステップ2: ファイル選択 -->
          <div class="field-group">
            <div class="field-group-header" onclick="toggleFieldGroup(this)">
              <span>② ファイル選択</span>
              <span class="field-group-toggle">▼</span>
            </div>
            <div class="field-group-body">
              <div class="row">
                <label for="xlsxFile">Excelファイル (.xlsx)</label>
                <input id="xlsxFile" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
              </div>
              <div class="row" id="sheetRow" style="display:none;">
                <label for="sheetName">シート選択</label>
                <select id="sheetName">
                  <option value="">シートを選択...</option>
                </select>
                <div class="btn-row" style="margin-top:8px;">
                  <button id="extractXlsxBtn" type="button" class="ghost" style="font-size:12px;padding:7px 14px;">📋 選択シートをCSV化</button>
                </div>
              </div>
              <div class="row">
                <label for="csvFile">CSVファイル (.csv)</label>
                <input id="csvFile" type="file" accept=".csv,text/csv" />
              </div>
              <div class="row">
                <label for="sourceFileName">元ファイル名</label>
                <input id="sourceFileName" type="text" placeholder="OP_2025年11月分.csv" />
              </div>
            </div>
          </div>

          <!-- ステップ3: CSV内容 -->
          <div class="field-group">
            <div class="field-group-header" onclick="toggleFieldGroup(this)">
              <span>③ CSV内容</span>
              <span class="field-group-toggle">▼</span>
            </div>
            <div class="field-group-body">
              <div class="row">
                <textarea id="csvText" placeholder="no,category,pay_method,qty,unit_price,desc,spec,amount,due_date&#10;1,イラスト,一括,1,50000,キャラクターイラスト,キャラA バストアップ,50000,2026-04-30" rows="8"></textarea>
              </div>
              <div id="mappingModeNote" class="helper" style="margin-bottom:10px;"></div>
              <div class="btn-row">
                <button id="sampleBtn" type="button" class="ghost" style="font-size:12px;padding:7px 14px;">📝 サンプル挿入</button>
                <a class="link-button" style="font-size:12px;" href="/admin/api/orders/csv/sample/planning.csv">企画CSV</a>
                <a class="link-button" style="font-size:12px;" href="/admin/api/orders/csv/sample/publishing_bulk.csv">出版CSV</a>
              </div>
            </div>
          </div>

          <!-- ステップ4: 追加設定 -->
          <div class="field-group collapsed">
            <div class="field-group-header" onclick="toggleFieldGroup(this)">
              <span>④ 追加設定（任意）</span>
              <span class="field-group-toggle">▼</span>
            </div>
            <div class="field-group-body">
              <div class="row">
                <label for="projectTitle">案件タイトル上書き</label>
                <input id="projectTitle" type="text" placeholder="空欄なら設定値/ファイル名から自動" />
              </div>
              <div class="row">
                <label for="specialTerms">特約事項</label>
                <textarea id="specialTerms" rows="3" placeholder="企画発注書の共通特約">${escapeHtmlText(settings.defaults.specialTerms)}</textarea>
              </div>
              <div class="row">
                <label for="remarks">備考</label>
                <textarea id="remarks" rows="2" placeholder="発注書共通の備考">${escapeHtmlText(settings.defaults.remarks)}</textarea>
              </div>
              <div class="row">
                <label for="acceptMethod">承諾方法</label>
                <input id="acceptMethod" type="text" placeholder="メール承諾 など" value="${escapeHtmlAttr(settings.defaults.acceptMethod)}" />
              </div>
              <div class="row">
                <label for="acceptReplyDueDate">承諾期限</label>
                <input id="acceptReplyDueDate" type="text" placeholder="2026-04-15" value="${escapeHtmlAttr(settings.defaults.acceptReplyDueDate)}" />
              </div>
            </div>
          </div>

          <!-- オプション -->
          <div style="margin-bottom:16px;">
            <label class="inline-check">
              <input id="generateDocuments" type="checkbox" checked />
              取込後に発注書を生成する
            </label>
          </div>

          <!-- アクションボタン -->
          <div style="display:grid;gap:8px;">
            <button id="previewBtn" type="button" style="width:100%;justify-content:center;">🔍 プレビュー確認</button>
            <button id="importBtn" type="button" style="width:100%;justify-content:center;background:var(--accent-hover);">✅ 取込実行</button>
            <div class="btn-row" style="justify-content:center;">
              <button id="bootstrapVendorsBtn" class="ghost" type="button" style="font-size:12px;padding:7px 14px;">Vendor仮登録</button>
              <a class="link-button" style="font-size:12px;" href="/admin/api/orders/csv/variables/planning.csv">変数対応表</a>
              <a class="link-button" style="font-size:12px;" href="/admin/settings/mapping">マッピング設定</a>
            </div>
          </div>

          <!-- ステータス表示 -->
          <div id="statusBar" class="status-bar" style="margin-top:16px;"></div>
        </div>
      </div>

      <!-- ===== 右側: 結果表示 ===== -->
      <div>
        <!-- Vendor確認 -->
        <div id="vendorAlert" style="display:none;" class="panel" style="margin-bottom:16px;">
          <h3>👥 Vendor確認</h3>
          <div id="vendorAlertContent"></div>
        </div>

        <!-- 取込前チェック -->
        <div id="warningPanel" style="display:none;" class="panel" style="margin-bottom:16px;">
          <h3>⚠️ 取込前チェック</h3>
          <div id="warningContent"></div>
        </div>

        <!-- 企画発注書サマリー -->
        <div id="planningSummaryPanel" style="display:none;" class="panel" style="margin-bottom:16px;">
          <h3>📋 マッピング結果</h3>
          <div id="planningSummaryContent"></div>
        </div>

        <!-- 取込結果 -->
        <div id="importResultPanel" style="display:none;" class="panel" style="margin-bottom:16px;">
          <h3>✅ 取込結果</h3>
          <div id="importResultContent" class="import-result"></div>
        </div>

        <!-- プレビューテーブル -->
        <div class="panel">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <h2 style="margin-bottom:0;">プレビュー</h2>
            <span id="previewCount" class="preview-count" style="display:none;"></span>
          </div>
          <div class="preview">
            <table>
              <thead>
                <tr>
                  <th>No</th>
                  <th>登録番号</th>
                  <th>区分</th>
                  <th>支払方法</th>
                  <th>数量</th>
                  <th>単価</th>
                  <th>件名</th>
                  <th>仕様</th>
                  <th>金額ソース</th>
                  <th>金額</th>
                  <th>納期</th>
                </tr>
              </thead>
              <tbody id="previewBody">
                <tr><td colspan="11" style="text-align:center;padding:24px;color:var(--muted);">プレビューボタンを押すと明細が表示されます</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- サンプル表示 -->
        <div class="panel" style="margin-top:16px;">
          <h3>📄 サンプル（参考）</h3>
          <div class="sample" id="sampleText" style="font-size:12px;"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    // DOM要素
    const csvFile = document.getElementById("csvFile");
    const xlsxFile = document.getElementById("xlsxFile");
    const csvText = document.getElementById("csvText");
    const statusBar = document.getElementById("statusBar");
    const previewBody = document.getElementById("previewBody");
    const previewCount = document.getElementById("previewCount");
    const generateDocuments = document.getElementById("generateDocuments");
    const sampleText = document.getElementById("sampleText");
    const mode = document.getElementById("mode");
    const mappingProfileId = document.getElementById("mappingProfileId");
    const mappingModeNote = document.getElementById("mappingModeNote");
    const sourceFileName = document.getElementById("sourceFileName");
    const projectTitle = document.getElementById("projectTitle");
    const sheetRow = document.getElementById("sheetRow");
    const sheetName = document.getElementById("sheetName");

    const sampleMap = {
      planning: {
        note: "企画発注書モード: カード名 / 完成 / B〆 / 作家名 などの列名を読み替えます。",
        fileName: "OP_2025年11月分進行用.csv",
        csv: "カードNo.,カード名,色,カード種類,キャラ備考,特徴,画角,イラスト指定,作家名,完成,B〆\nA-001,炎の剣士,赤,ユニット,主人公,火炎・前衛,バストアップ,躍動感のある構図,山田花子,2026/04/15,2026/04/30\nB-014,森の賢者,緑,ユニット,老賢者,回復・支援,全身,柔らかい自然光,山田花子,2026/04/30,",
      },
      publishing_bulk: {
        note: "出版一括発注書モード: 担当者ID / 発注日 / 支払日 / 書籍名 / 初校締切 / 発注金額（税別） などの列名を読み替えます。",
        fileName: "出版一括発注_2026年4月.csv",
        csv: "担当者ID,発注日,支払日,コード,支払先（ペンネーム）,書籍名,業務概要,業務詳細（仕様）,単価（税込）,数量,発注金額（税別）,初校締切,再校締切,校了予定,備考\nU0123456789,2026/04/13,2026/05/20,VN-001,山田花子,空色文庫,本文組版,装画・本文192頁・A5,120000,1,120000,2026/04/15,2026/04/25,2026/04/30,初版制作",
      },
    };
    let workbookBase64 = "";

    // フィールドグループの折りたたみ
    function toggleFieldGroup(header) {
      const group = header.closest(".field-group");
      group.classList.toggle("collapsed");
    }

    function setStatus(message, type) {
      statusBar.className = "status-bar" + (type ? " " + type : "");
      const icons = { success: "✅", error: "❌", "": "ℹ️" };
      statusBar.innerHTML = \`<span class="icon">\${icons[type || ""] || "⏳"}</span> \${escapeHtml(message)}\`;
    }

    function updateProfilePresentation() {
      const selected = sampleMap[mappingProfileId.value] || sampleMap.planning;
      mappingModeNote.textContent = selected.note;
      sampleText.textContent = selected.csv;
      if (mode.value === "planning" && !csvText.value.trim()) {
        sourceFileName.value = selected.fileName;
      }
    }

    // ファイル読み込み（文字コード自動判定）
    async function readCsvFileWithEncoding(file) {
      const buffer = await file.arrayBuffer();
      const utf8Text = new TextDecoder("utf-8").decode(buffer);
      const shiftJisText = decodeWithEncoding(buffer, "shift_jis");
      const utf8Score = scoreDecodedText(utf8Text);
      const shiftJisScore = scoreDecodedText(shiftJisText);
      if (shiftJisText && shiftJisScore < utf8Score) {
        return { text: shiftJisText, encoding: "Shift_JIS" };
      }
      return { text: utf8Text, encoding: "UTF-8" };
    }
    function decodeWithEncoding(buffer, encoding) {
      try { return new TextDecoder(encoding).decode(buffer); } catch (decodeError) { return ""; }
    }
    function scoreDecodedText(text) {
      if (!text) return Number.MAX_SAFE_INTEGER;
      return (text.match(/\uFFFD/g) || []).length * 10;
    }

    // CSVファイル読み込み
    csvFile.addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const decoded = await readCsvFileWithEncoding(file);
      csvText.value = decoded.text;
      sourceFileName.value = file.name;
      setStatus("CSVファイルを読み込みました（" + decoded.encoding + "）");
    });

    // Excelファイル読み込み
    xlsxFile.addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      sourceFileName.value = file.name;
      workbookBase64 = await toBase64(file);
      setStatus("Excelファイルを読み込み中...");
      const result = await postJson("/admin/api/orders/xlsx/sheets", { fileBase64: workbookBase64 });
      if (!result.ok) {
        setStatus("Excel読込失敗: " + result.error, "error");
        return;
      }
      sheetName.innerHTML = result.sheets.map((sheet, index) =>
        \`<option value="\${escapeHtml(sheet.name)}"\${index === 0 ? " selected" : ""}>\${escapeHtml(sheet.name)} (\${sheet.rowCount}行)</option>\`
      ).join("");
      sheetRow.style.display = "block";
      if (result.sheets[0] && result.sheets[0].score >= 4) {
        mode.value = "planning";
      }
      setStatus("Excelを読み込みました。シートを選択して「選択シートをCSV化」してください。", "success");
    });

    document.getElementById("extractXlsxBtn").addEventListener("click", async () => {
      if (!workbookBase64) { setStatus("先にExcelファイルを選択してください。", "error"); return; }
      setStatus("選択シートをCSVへ変換中...");
      const result = await postJson("/admin/api/orders/xlsx/to-csv", { fileBase64: workbookBase64, sheetName: sheetName.value });
      if (!result.ok) { setStatus("Excel変換失敗: " + result.error, "error"); return; }
      csvText.value = result.csvText;
      setStatus("シート「" + result.sheetName + "」をCSV化しました。", "success");
    });

    document.getElementById("sampleBtn").addEventListener("click", () => {
      const selected = sampleMap[mappingProfileId.value] || sampleMap.planning;
      csvText.value = selected.csv;
      sourceFileName.value = selected.fileName;
      mode.value = "planning";
      setStatus("サンプルCSVを挿入しました。");
    });

    mappingProfileId.addEventListener("change", updateProfilePresentation);
    updateProfilePresentation();

    // プレビュー
    document.getElementById("previewBtn").addEventListener("click", async () => {
      try {
        setStatus("プレビューを作成中...");
        previewBody.innerHTML = \`<tr><td colspan="11" style="text-align:center;padding:20px;color:var(--muted);">読み込み中...</td></tr>\`;
        hideAlerts();

        const result = await postJson("/admin/api/orders/csv/preview", {
          csvText: csvText.value,
          mode: mode.value,
          mappingProfileId: mappingProfileId.value,
          sourceFileName: sourceFileName.value,
          projectTitle: projectTitle.value,
          specialTerms: document.getElementById("specialTerms").value,
          remarks: document.getElementById("remarks").value,
          acceptMethod: document.getElementById("acceptMethod").value,
          acceptReplyDueDate: document.getElementById("acceptReplyDueDate").value,
        });

        if (!result.ok) {
          setStatus("プレビュー失敗: " + result.error, "error");
          previewBody.innerHTML = \`<tr><td colspan="11" style="text-align:center;padding:20px;color:var(--danger);">プレビューに失敗しました</td></tr>\`;
          return;
        }

        setStatus("プレビュー完了: " + result.count + " 件", "success");
        previewCount.textContent = result.count + " 件";
        previewCount.style.display = "inline-flex";

        previewBody.innerHTML = (result.items || []).map((item) => \`
          <tr>
            <td>\${escapeHtml(item.no)}</td>
            <td>\${escapeHtml(item.vendorCode || "")}</td>
            <td>\${escapeHtml(item.category || "")}</td>
            <td>\${escapeHtml(item.payMethod || "")}</td>
            <td style="text-align:right;">\${escapeHtml(item.qty)}</td>
            <td style="text-align:right;">\${escapeHtml(item.unitPrice || "")}</td>
            <td>\${escapeHtml(item.desc)}</td>
            <td style="max-width:200px;">\${escapeHtml(item.spec || "")}</td>
            <td><span class="tag" style="font-size:11px;">\${escapeHtml(item.amountSourceLabel || "直接")}</span></td>
            <td style="text-align:right;font-weight:600;">\${escapeHtml(item.amount)}</td>
            <td>\${escapeHtml(item.dueDate)}</td>
          </tr>
        \`).join("");

        if (result.mode === "planning" && result.planningContext) {
          showPlanningSummary(result);
        }
        if (result.vendorStatuses && result.vendorStatuses.length > 0) {
          showVendorAlert(result.vendorStatuses);
        }
        if (result.warnings && result.warnings.length > 0) {
          showWarnings(result.warnings);
        }
      } catch (error) {
        setStatus("プレビュー失敗: " + getErrorMessage(error), "error");
        previewBody.innerHTML = \`<tr><td colspan="11" style="text-align:center;padding:20px;color:var(--danger);">プレビューに失敗しました</td></tr>\`;
      }
    });

    // 取込実行
    document.getElementById("importBtn").addEventListener("click", async () => {
      try {
        const issueKeyVal = document.getElementById("issueKey").value.trim();
        if (!issueKeyVal) {
          setStatus("Backlog課題キーを入力してください。", "error");
          return;
        }
        if (!csvText.value.trim()) {
          setStatus("CSVを入力またはファイルを選択してください。", "error");
          return;
        }

        setStatus("取り込みを実行中...");
        document.getElementById("importResultPanel").style.display = "none";

        const result = await postJson("/admin/api/orders/csv/import", {
          issueKey: issueKeyVal,
          csvText: csvText.value,
          generateDocuments: generateDocuments.checked,
          mode: mode.value,
          mappingProfileId: mappingProfileId.value,
          sourceFileName: sourceFileName.value,
          projectTitle: projectTitle.value,
          specialTerms: document.getElementById("specialTerms").value,
          remarks: document.getElementById("remarks").value,
          acceptMethod: document.getElementById("acceptMethod").value,
          acceptReplyDueDate: document.getElementById("acceptReplyDueDate").value,
        });

        if (!result.ok) {
          const warningText = result.warnings && result.warnings.length
            ? " / " + result.warnings.map((w) => "[" + (w.severity === "blocking" ? "停止" : "注意") + "] " + w.message).join(" / ")
            : "";
          setStatus("取込失敗: " + result.error + warningText, "error");
          if (result.warnings) showWarnings(result.warnings);
          return;
        }

        const resultMsg = [
          "課題: " + result.issueKey,
          "明細: " + result.importedCount + " 件",
          result.createdTrackingIssueCount ? "納品管理課題: " + result.createdTrackingIssueCount + " 件" : "",
          result.generated ? "発注書生成: 完了" : "",
        ].filter(Boolean).join("  |  ");

        setStatus("取込完了！", "success");
        document.getElementById("importResultPanel").style.display = "block";
        document.getElementById("importResultContent").innerHTML = \`<strong>\${escapeHtml(resultMsg)}</strong>\`;
      } catch (error) {
        setStatus("取込失敗: " + getErrorMessage(error), "error");
      }
    });

    // Vendor仮登録
    document.getElementById("bootstrapVendorsBtn").addEventListener("click", async () => {
      setStatus("Vendor仮登録を実行中...");
      const result = await postJson("/admin/api/masters/vendor/bootstrap", {
        csvText: csvText.value,
        mappingProfileId: mappingProfileId.value,
        sourceFileName: sourceFileName.value,
      });
      if (!result.ok) { setStatus("Vendor仮登録失敗: " + result.error, "error"); return; }
      setStatus("Vendor仮登録完了: " + result.count + " 件", "success");
    });

    // ヘルパー関数
    function hideAlerts() {
      document.getElementById("vendorAlert").style.display = "none";
      document.getElementById("warningPanel").style.display = "none";
      document.getElementById("planningSummaryPanel").style.display = "none";
      previewCount.style.display = "none";
    }

    function showPlanningSummary(result) {
      const pc = result.planningContext;
      document.getElementById("planningSummaryPanel").style.display = "block";
      document.getElementById("planningSummaryContent").innerHTML = [
        "<div class='summary-box' style='margin-bottom:0;'>",
        "<strong>案件タイトル:</strong> " + escapeHtml(pc.projectTitle || ""),
        "<br><strong>Vendor数:</strong> " + escapeHtml(String((result.vendorStatuses || []).length)),
        "<br><strong>総明細数:</strong> " + escapeHtml(String(pc.rowCount || 0)),
        pc.firstDraftDeadlineLabel ? "<br><strong>初稿納期:</strong> " + escapeHtml(pc.firstDraftDeadlineLabel) : "",
        pc.paymentDateLabel ? "<br><strong>支払日:</strong> " + escapeHtml(pc.paymentDateLabel) : "",
        pc.specialTerms ? "<br><strong>特約事項:</strong> " + escapeHtml(pc.specialTerms) : "",
        "</div>",
      ].filter(Boolean).join("");
    }

    function showVendorAlert(vendorStatuses) {
      document.getElementById("vendorAlert").style.display = "block";
      document.getElementById("vendorAlertContent").innerHTML =
        "<div class='table-wrap'><table><thead><tr><th>VendorID</th><th>CSVの作家名</th><th>登録状態</th><th>操作</th></tr></thead><tbody>" +
        vendorStatuses.map((vs) => {
          const stateClass = !vs.exists ? "vendor-err" : vs.nameMatchType === "exact" ? "vendor-ok" : vs.nameMatchType === "alias" ? "vendor-ok" : "vendor-warn";
          const stateLabel = !vs.exists ? "❌ 未登録" : vs.nameMatchType === "exact" ? "✅ 一致" : vs.nameMatchType === "alias" ? "✅ alias一致" : "⚠️ 名前差分";
          const link = "/admin/masters?vendorCode=" + encodeURIComponent(vs.vendorCode || "") + "&vendorName=" + encodeURIComponent(vs.lookupName || "");
          return \`<tr>
            <td><code>\${escapeHtml(vs.vendorCode || "")}</code></td>
            <td>\${escapeHtml(vs.lookupName || vs.vendorName || "")}</td>
            <td class="\${stateClass}">\${stateLabel}</td>
            <td><a class="link-button" href="\${link}" style="font-size:11px;padding:4px 8px;">\${!vs.exists ? "登録" : "確認"}</a></td>
          </tr>\`;
        }).join("") +
        "</tbody></table></div>";
    }

    function showWarnings(warnings) {
      const blocking = warnings.filter((w) => w.severity === "blocking");
      const warn = warnings.filter((w) => w.severity !== "blocking");
      document.getElementById("warningPanel").style.display = "block";
      document.getElementById("warningContent").innerHTML =
        blocking.map((w) => \`<div class="warning-summary warning-stop">🛑 \${escapeHtml(w.message)}</div>\`).join("") +
        warn.map((w) => \`<div class="warning-summary warning-warn">⚠️ \${escapeHtml(w.message)}</div>\`).join("");
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (parseError) {
        if (!response.ok) {
          throw new Error(text || ("HTTP " + response.status));
        }
        throw new Error("JSONレスポンスの解析に失敗しました。");
      }
    }

    async function toBase64(file) {
      const buffer = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[char]));
    }

    function getErrorMessage(error) {
      if (error && typeof error === "object" && "message" in error) {
        return String(error.message);
      }
      return String(error ?? "不明なエラー");
    }
  </script>
</body>
</html>`;
}


function buildMappingAdminHtml(): string {
  const settings = getPlanningImportSettings();
  const profiles = getPlanningImportProfiles();
  const activeProfileId = getActivePlanningImportProfileId();
  const profileOptions = profiles.map((profile) =>
    `<option value="${escapeHtmlAttr(profile.id)}"${profile.id === activeProfileId ? " selected" : ""}>${escapeHtmlText(profile.label)}</option>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>マッピング設定</title>
  <style>${sharedAdminCss()}</style>
</head>
<body>
  <div class="wrap">
    ${buildAdminNav("mapping")}
    ${buildCategorySwitchHtml("Settings", "マスタ・設定の関連画面", "マッピングは発注管理の前提設定です。取込がうまくいかないときはここから調整します。", [
      { href: "/admin/settings", label: "マスタ・設定トップ", description: "前提データと運用設定の入口", active: false },
      { href: "/admin/masters", label: "マスタ管理", description: "Vendor / Staff の整備", active: false },
      { href: "/admin/settings/mapping", label: "マッピング設定", description: "企画用・出版用の取込プロファイルを編集", active: true },
      { href: "/admin/orders/csv", label: "CSV / Excel 一括作成", description: "実際の取り込み画面へ戻る", active: false },
    ])}
    <h1>一括発注マッピング設定</h1>
    <p class="sub">CSVの列名と、一括発注書に渡す固定値をここで変更できます。企画発注書 / 出版一括発注書を切り替えて管理し、保存後はプレビューと取込の両方に即時反映されます。</p>
    <section class="panel" style="margin-bottom:20px;">
      <div class="row">
        <label for="profileId">編集中のマッピング</label>
        <select id="profileId">
          ${profileOptions}
        </select>
      </div>
      <div class="helper">ここで選んだ種別の設定を編集します。CSV取込画面でも同じ種別を選ぶと、その設定が使われます。</div>
      <div id="profileStatus" class="status"></div>
    </section>
    <div class="grid two-col">
      <section class="panel">
        <h2>列マッピング</h2>
        <div class="row">
          <label for="mappingCsvFile">列候補を読むCSV</label>
          <input id="mappingCsvFile" type="file" accept=".csv,text/csv" />
        </div>
        <div class="row">
          <label for="mappingCsvText">またはCSVヘッダー/内容を貼り付け</label>
          <textarea id="mappingCsvText" placeholder="カードNo.,カード名,色,カード種類,キャラ備考,特徴,画角,イラスト指定,作家名,完成,B〆"></textarea>
        </div>
        <div class="actions">
          <button id="loadHeadersBtn" type="button">列候補を読み込む</button>
        </div>
        <div class="helper">列候補をクリックすると、最後に選択していた入力欄へその列名を入れられます。</div>
        <div id="headerStatus" class="status"></div>
        <div id="headerChips" class="chip-list"></div>

        <div class="row"><label for="projectTitleSource">案件タイトルの取得元</label>
          <select id="projectTitleSource">
            <option value="filename"${settings.projectTitleSource === "filename" ? " selected" : ""}>元ファイル名</option>
            <option value="manual"${settings.projectTitleSource === "manual" ? " selected" : ""}>固定値</option>
          </select>
        </div>
        <div class="row"><label for="projectTitleManualValue">固定タイトル</label><input id="projectTitleManualValue" type="text" value="${escapeHtmlAttr(settings.projectTitleManualValue)}" /></div>
        <div class="row"><label for="requesterSlackUserIdColumn">担当者Slack ID列</label><input id="requesterSlackUserIdColumn" type="text" value="${escapeHtmlAttr(settings.requesterSlackUserIdColumn)}" /></div>
        <div class="row"><label for="orderDateColumn">発注日列</label><input id="orderDateColumn" type="text" value="${escapeHtmlAttr(settings.orderDateColumn)}" /></div>
        <div class="row"><label for="vendorLookupColumn">相手方参照列</label><input id="vendorLookupColumn" type="text" value="${escapeHtmlAttr(settings.vendorLookupColumn)}" /></div>
        <div class="row"><label for="vendorCodeColumn">Vendor Code列</label><input id="vendorCodeColumn" type="text" value="${escapeHtmlAttr(settings.vendorCodeColumn)}" /></div>
        <div class="row"><label for="itemNameColumn">ITEM_NAME列</label><input id="itemNameColumn" type="text" value="${escapeHtmlAttr(settings.itemNameColumn)}" /></div>
        <div class="row"><label for="completionDateColumn">完成日列</label><input id="completionDateColumn" type="text" value="${escapeHtmlAttr(settings.completionDateColumn)}" /></div>
        <div class="row"><label for="completionDateFallbackColumn">完成日列（代替）</label><input id="completionDateFallbackColumn" type="text" value="${escapeHtmlAttr(settings.completionDateFallbackColumn)}" /></div>
        <div class="row"><label for="finalDeadlineColumn">B〆列</label><input id="finalDeadlineColumn" type="text" value="${escapeHtmlAttr(settings.finalDeadlineColumn)}" /></div>
        <div class="row"><label for="quantityColumn">数量列</label><input id="quantityColumn" type="text" value="${escapeHtmlAttr(settings.quantityColumn)}" /></div>
        <div class="row"><label for="unitPriceColumn">単価列</label><input id="unitPriceColumn" type="text" value="${escapeHtmlAttr(settings.unitPriceColumn)}" /></div>
        <div class="row"><label for="paymentDateColumn">支払日列</label><input id="paymentDateColumn" type="text" value="${escapeHtmlAttr(settings.paymentDateColumn)}" /></div>
        <div class="row"><label for="amountColumn">金額列（優先）</label><input id="amountColumn" type="text" value="${escapeHtmlAttr(settings.amountColumn)}" /></div>
        <div class="row"><label for="amountFallbackColumn">金額列（代替）</label><input id="amountFallbackColumn" type="text" value="${escapeHtmlAttr(settings.amountFallbackColumn)}" /></div>
        <div class="row"><label for="detailColumns">detailTextに連結する列</label><textarea id="detailColumns">${escapeHtmlText(settings.detailColumns.join("\n"))}</textarea></div>
      </section>

      <section class="panel">
        <h2>固定値</h2>
        <div class="row"><label for="category">category</label><input id="category" type="text" value="${escapeHtmlAttr(settings.constants.category)}" /></div>
        <div class="row"><label for="payMethod">payMethod</label><input id="payMethod" type="text" value="${escapeHtmlAttr(settings.constants.payMethod)}" /></div>
        <div class="row"><label for="rightsLabel">rightsLabel</label><input id="rightsLabel" type="text" value="${escapeHtmlAttr(settings.constants.rightsLabel)}" /></div>
        <div class="row"><label for="transferFee">transfer_fee</label><input id="transferFee" type="text" value="${escapeHtmlAttr(settings.constants.transferFee)}" /></div>
        <div class="row"><label for="transferFeePayer">TRANSFER_FEE_PAYER</label><input id="transferFeePayer" type="text" value="${escapeHtmlAttr(settings.constants.transferFeePayer)}" /></div>
        <div class="row"><label for="deliveryDateLabel">FIRST_DRAFT_DEADLINE / deliveryDateStr 表示</label><input id="deliveryDateLabel" type="text" value="${escapeHtmlAttr(settings.constants.deliveryDateLabel)}" /></div>
        <div class="row"><label for="paymentDateLabel">items[].payment_date 表示</label><input id="paymentDateLabel" type="text" value="${escapeHtmlAttr(settings.constants.paymentDateLabel)}" /></div>
        <div class="row"><label for="finalDeadlineFallback">B〆空欄時の表示</label><input id="finalDeadlineFallback" type="text" value="${escapeHtmlAttr(settings.constants.finalDeadlineFallback)}" /></div>
        <div class="row"><label for="defaultSpecialTerms">特約事項 初期値</label><textarea id="defaultSpecialTerms">${escapeHtmlText(settings.defaults.specialTerms)}</textarea></div>
        <div class="row"><label for="defaultRemarks">備考 初期値</label><textarea id="defaultRemarks">${escapeHtmlText(settings.defaults.remarks)}</textarea></div>
        <div class="row"><label for="defaultAcceptMethod">承諾方法 初期値</label><input id="defaultAcceptMethod" type="text" value="${escapeHtmlAttr(settings.defaults.acceptMethod)}" /></div>
        <div class="row"><label for="defaultAcceptReplyDueDate">承諾期限 初期値</label><input id="defaultAcceptReplyDueDate" type="text" value="${escapeHtmlAttr(settings.defaults.acceptReplyDueDate)}" /></div>
        <div class="actions">
          <button id="saveBtn" type="button">設定を保存</button>
          <a class="link-button" href="/admin/orders/csv">CSV画面へ戻る</a>
        </div>
        <div id="status" class="status"></div>
      </section>
    </div>
  </div>
  <script>
    let activeTargetId = "";
    const profileId = document.getElementById("profileId");

    document.querySelectorAll("input[type='text'], textarea, select").forEach((element) => {
      element.addEventListener("focus", () => {
        activeTargetId = element.id;
      });
    });

    profileId.addEventListener("change", async () => {
      const result = await postJson("/admin/api/settings/mapping/active", {
        profileId: profileId.value,
      });
      const status = document.getElementById("profileStatus");
      if (!result.ok) {
        status.textContent = "プロファイル切替失敗: " + result.error;
        return;
      }
      window.location.reload();
    });

    document.getElementById("mappingCsvFile").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      document.getElementById("mappingCsvText").value = await file.text();
      document.getElementById("headerStatus").textContent = "CSVを読み込みました。列候補を読み込めます。";
    });

    document.getElementById("loadHeadersBtn").addEventListener("click", async () => {
      const result = await postJson("/admin/api/orders/csv/headers", {
        csvText: value("mappingCsvText"),
      });
      const chipBox = document.getElementById("headerChips");
      chipBox.innerHTML = "";
      if (!result.ok) {
        document.getElementById("headerStatus").textContent = "列候補の取得失敗: " + result.error;
        return;
      }
      document.getElementById("headerStatus").textContent = "列候補を " + result.headers.length + " 件読み込みました。";
      result.headers.forEach((header) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chip";
        button.textContent = header;
        button.addEventListener("click", () => {
          if (!activeTargetId) {
            document.getElementById("headerStatus").textContent = "先に入力欄を選んでから列候補を押してください。";
            return;
          }
          const target = document.getElementById(activeTargetId);
          if (!target) return;
          if (activeTargetId === "detailColumns") {
            target.value = target.value ? target.value + "\\n" + header : header;
          } else {
            target.value = header;
          }
          document.getElementById("headerStatus").textContent = activeTargetId + " に '" + header + "' を入れました。";
        });
        chipBox.appendChild(button);
      });
    });

    document.getElementById("saveBtn").addEventListener("click", async () => {
      const result = await postJson("/admin/api/settings/mapping", {
        profileId: value("profileId"),
        projectTitleSource: value("projectTitleSource"),
        projectTitleManualValue: value("projectTitleManualValue"),
        requesterSlackUserIdColumn: value("requesterSlackUserIdColumn"),
        orderDateColumn: value("orderDateColumn"),
        vendorLookupColumn: value("vendorLookupColumn"),
        vendorCodeColumn: value("vendorCodeColumn"),
        itemNameColumn: value("itemNameColumn"),
        completionDateColumn: value("completionDateColumn"),
        completionDateFallbackColumn: value("completionDateFallbackColumn"),
        finalDeadlineColumn: value("finalDeadlineColumn"),
        quantityColumn: value("quantityColumn"),
        unitPriceColumn: value("unitPriceColumn"),
        paymentDateColumn: value("paymentDateColumn"),
        amountColumn: value("amountColumn"),
        amountFallbackColumn: value("amountFallbackColumn"),
        detailColumns: value("detailColumns"),
        category: value("category"),
        payMethod: value("payMethod"),
        rightsLabel: value("rightsLabel"),
        transferFee: value("transferFee"),
        transferFeePayer: value("transferFeePayer"),
        deliveryDateLabel: value("deliveryDateLabel"),
        paymentDateLabel: value("paymentDateLabel"),
        finalDeadlineFallback: value("finalDeadlineFallback"),
        defaultSpecialTerms: value("defaultSpecialTerms"),
        defaultRemarks: value("defaultRemarks"),
        defaultAcceptMethod: value("defaultAcceptMethod"),
        defaultAcceptReplyDueDate: value("defaultAcceptReplyDueDate"),
      });
      document.getElementById("status").textContent = result.ok ? "設定を保存しました。" : "保存失敗: " + result.error;
    });

    function value(id) { return document.getElementById(id).value; }
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    }
  </script>
</body>
</html>`;
}

function buildWorkflowSettingsAdminHtml(): string {
  const settings = getWorkflowSettings();
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ワークフロー設定</title>
  <style>${sharedAdminCss()}</style>
</head>
<body>
  <div class="wrap">
    ${buildAdminNav("workflow-settings")}
    ${buildCategorySwitchHtml("Settings", "マスタ・設定の関連画面", "承認者や押印担当など、進行の前提を整える画面です。", [
      { href: "/admin/settings", label: "マスタ・設定トップ", description: "前提データと運用設定の入口", active: false },
      { href: "/admin/settings/workflow", label: "ワークフロー設定", description: "承認者、押印担当、部署別ルール", active: true },
      { href: "/admin/masters", label: "マスタ管理", description: "Staff や Vendor を整える", active: false },
      { href: "/admin/workflow/stamp", label: "押印管理", description: "設定後の実運用画面へ進む", active: false },
    ])}
    <h1>ワークフロー設定</h1>
    <p class="sub">部署ごとに、投稿チャンネル、上長ID、承認（押印）ID、実行（押印）ID を設定できます。部署ルール未設定時のみ、下の既定値にフォールバックします。</p>
    <div class="grid two-col">
      <section class="panel">
        <h2>部署未設定時の既定値</h2>
        <div class="row"><label for="intakeChannelId">投稿チャンネル ID</label><input id="intakeChannelId" type="text" placeholder="C0123456789" value="${escapeHtmlAttr(settings.intakeChannelId)}" /></div>
        <div class="row"><label for="approverSlackId">承認（押印）ID</label><input id="approverSlackId" type="text" placeholder="U0123456789" value="${escapeHtmlAttr(settings.approverSlackId)}" /></div>
        <div class="row"><label for="stampOperatorSlackId">実行（押印）ID</label><input id="stampOperatorSlackId" type="text" placeholder="U0123456789" value="${escapeHtmlAttr(settings.stampOperatorSlackId)}" /></div>
        <div class="actions">
          <button id="saveWorkflowSettingsBtn" type="button">設定を保存</button>
        </div>
        <div id="workflowSettingsStatus" class="status"></div>
      </section>
      <section class="panel">
        <h2>部署別設定</h2>
        <div class="row">
          <label for="ruleDepartment">部署名</label>
          <input id="ruleDepartment" type="text" list="departmentOptions" placeholder="営業部" />
          <datalist id="departmentOptions"></datalist>
        </div>
        <div class="row"><label for="rulePostChannelId">投稿チャンネル</label><input id="rulePostChannelId" type="text" placeholder="C0123456789" /></div>
        <div class="row"><label for="ruleManagerSlackId">上長ID</label><input id="ruleManagerSlackId" type="text" placeholder="U0123456789" /></div>
        <div class="row"><label for="ruleApproverSlackId">承認（押印）ID</label><input id="ruleApproverSlackId" type="text" placeholder="U0123456789" /></div>
        <div class="row"><label for="ruleStampOperatorSlackId">実行（押印）ID</label><input id="ruleStampOperatorSlackId" type="text" placeholder="U0123456789" /></div>
        <div class="row inline"><label><input id="ruleIsActive" type="checkbox" checked /> 有効</label></div>
        <div class="actions">
          <button id="saveWorkflowRuleBtn" type="button" class="ghost">部署設定を保存</button>
          <button id="reloadWorkflowRulesBtn" type="button" class="ghost">一覧再読込</button>
        </div>
        <div id="workflowRuleStatus" class="status"></div>
        <div class="preview">
          <table>
            <thead>
              <tr>
                <th>部署</th>
                <th>投稿チャンネル</th>
                <th>上長ID</th>
                <th>承認（押印）ID</th>
                <th>実行（押印）ID</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody id="workflowRuleTableBody"></tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <h2>ルーティング確認</h2>
        <p class="note">申請者の Slack ID を入れると、現在の設定でどの部署設定が解決されるか確認できます。</p>
        <div class="row"><label for="previewSlackUserId">申請者 Slack ID</label><input id="previewSlackUserId" type="text" placeholder="U0123456789" /></div>
        <div class="actions">
          <button id="previewWorkflowAssignmentBtn" type="button" class="ghost">解決結果を確認</button>
        </div>
        <div id="workflowPreviewStatus" class="status"></div>
      </section>
    </div>
  </div>
  <script>
    document.getElementById("saveWorkflowSettingsBtn").addEventListener("click", async () => {
      const result = await postJson("/admin/api/settings/workflow", {
        intakeChannelId: value("intakeChannelId"),
        approverSlackId: value("approverSlackId"),
        stampOperatorSlackId: value("stampOperatorSlackId"),
      });
      document.getElementById("workflowSettingsStatus").textContent = result.ok ? "ワークフロー設定を保存しました。" : "保存失敗: " + result.error;
    });

    document.getElementById("saveWorkflowRuleBtn").addEventListener("click", async () => {
      const result = await postJson("/admin/api/settings/workflow/rules", {
        department: value("ruleDepartment"),
        postChannelId: value("rulePostChannelId"),
        managerSlackId: value("ruleManagerSlackId"),
        approverSlackId: value("ruleApproverSlackId"),
        stampOperatorSlackId: value("ruleStampOperatorSlackId"),
        isActive: document.getElementById("ruleIsActive").checked,
      });
      document.getElementById("workflowRuleStatus").textContent = result.ok ? "部署設定を保存しました。" : "保存失敗: " + result.error;
      if (result.ok) loadWorkflowRules();
    });

    document.getElementById("reloadWorkflowRulesBtn").addEventListener("click", loadWorkflowRules);
    document.getElementById("previewWorkflowAssignmentBtn").addEventListener("click", previewWorkflowAssignment);
    loadWorkflowRules();

    async function loadWorkflowRules() {
      const result = await fetch("/admin/api/settings/workflow").then((response) => response.json());
      const body = document.getElementById("workflowRuleTableBody");
      const datalist = document.getElementById("departmentOptions");
      body.innerHTML = "";
      datalist.innerHTML = "";
      if (!result.ok) {
        document.getElementById("workflowRuleStatus").textContent = "一覧取得失敗: " + result.error;
        return;
      }
      (result.departments || []).forEach((department) => {
        const option = document.createElement("option");
        option.value = department;
        datalist.appendChild(option);
      });
      (result.rules || []).forEach((rule) => {
        const tr = document.createElement("tr");
        tr.innerHTML = [
          "<td><button type='button' class='chip fill-rule'>" + escapeHtml(rule.department || "") + "</button></td>",
          "<td>" + escapeHtml(rule.postChannelId || "") + "</td>",
          "<td>" + escapeHtml(rule.managerSlackId || "") + "</td>",
          "<td>" + escapeHtml(rule.approverSlackId || "") + "</td>",
          "<td>" + escapeHtml(rule.stampOperatorSlackId || "") + "</td>",
          "<td>" + escapeHtml(rule.isActive ? "有効" : "無効") + "</td>",
        ].join("");
        tr.querySelector(".fill-rule").addEventListener("click", () => {
          document.getElementById("ruleDepartment").value = rule.department || "";
          document.getElementById("rulePostChannelId").value = rule.postChannelId || "";
          document.getElementById("ruleManagerSlackId").value = rule.managerSlackId || "";
          document.getElementById("ruleApproverSlackId").value = rule.approverSlackId || "";
          document.getElementById("ruleStampOperatorSlackId").value = rule.stampOperatorSlackId || "";
          document.getElementById("ruleIsActive").checked = Boolean(rule.isActive);
        });
        body.appendChild(tr);
      });
    }

    async function previewWorkflowAssignment() {
      const slackUserId = value("previewSlackUserId");
      const result = await fetch("/admin/api/settings/workflow/resolve?slackUserId=" + encodeURIComponent(slackUserId)).then((response) => response.json());
      const status = document.getElementById("workflowPreviewStatus");
      if (!result.ok) {
        status.textContent = "確認失敗: " + result.error;
        return;
      }
      const assignment = result.assignment || {};
      status.textContent = [
        "部署: " + (assignment.department || "未設定"),
        "投稿チャンネル: " + (assignment.postChannelId || "未解決"),
        "上長ID: " + (assignment.managerSlackId || "未解決"),
        "承認（押印）ID: " + (assignment.approverSlackId || "未解決"),
        "実行（押印）ID: " + (assignment.stampOperatorSlackId || "未解決"),
        "解決元: " + (assignment.source || "不明"),
      ].join("\\n");
    }

    function value(id) { return document.getElementById(id).value; }
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>\"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }
  </script>
</body>
</html>`;
}

function buildRequestSimulatorAdminHtml(defaultType?: DocumentRequestType): string {
  const primaryDefinitions = DOCUMENT_REQUEST_DEFINITIONS.filter((definition) => definition.workflowKind === "primary");
  const followupDefinitions = DOCUMENT_REQUEST_DEFINITIONS.filter((definition) => definition.workflowKind === "followup");
  const fallbackType: DocumentRequestType = DOCUMENT_REQUEST_DEFINITIONS.some((definition) => definition.value === defaultType)
    ? (defaultType as DocumentRequestType)
    : "legal_consultation";
  const selectedDefinition = getDocumentRequestDefinition(fallbackType) ?? DOCUMENT_REQUEST_DEFINITIONS[0];
  const isOrderLanding = fallbackType === "purchase_order" || fallbackType === "planning_order" || fallbackType === "publishing_order";
  const buildOptionList = (definitions: typeof DOCUMENT_REQUEST_DEFINITIONS) => definitions.map((definition) => (
    `<option value="${escapeHtmlAttr(definition.value)}"${definition.value === fallbackType ? " selected" : ""}>${escapeHtmlText(definition.text)}</option>`
  )).join("");
  const orderPayMethodOptionsJson = JSON.stringify(ORDER_PAY_METHOD_OPTIONS);
  const orderCategoryExamplesText = ORDER_CATEGORY_EXAMPLES.join(" / ");
  const options = [
    `<optgroup label="主申請">${buildOptionList(primaryDefinitions)}</optgroup>`,
    `<optgroup label="後続申請">${buildOptionList(followupDefinitions)}</optgroup>`,
  ].join("");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>申請シミュレーター</title>
  <style>${sharedAdminCss()}</style>
</head>
<body>
  ${buildAdminNav(isOrderLanding ? "order-single" : "request-simulator")}
  <div class="wrap">
  ${buildCategorySwitchHtml(
    isOrderLanding ? "Orders" : "Tools",
    isOrderLanding ? "発注管理の関連画面" : "管理ツールの関連画面",
    isOrderLanding
      ? "単体起票に寄せた入口です。必要に応じて一括取込やマッピング設定へ戻れます。"
      : "申請条件や Slack / Backlog 連携の確認用ツールです。日常導線からは少し外した場所にまとめています。",
    isOrderLanding
      ? [
          { href: "/admin/orders", label: "発注管理トップ", description: "発注関連の入口をまとめて確認", active: false },
          { href: "/admin/workflow/orders/create", label: "発注書単体作成", description: "単票起票と明細手入力", active: true },
          { href: "/admin/orders/csv", label: "CSV / Excel 一括作成", description: "一括取込と親課題・明細課題の整備", active: false },
          { href: "/admin/settings/mapping", label: "マッピング設定", description: "列対応と既定値の調整", active: false },
        ]
      : [
          { href: "/admin/tools", label: "管理ツールトップ", description: "調査用・保守用の入口", active: false },
          { href: "/admin/workflow/request-simulator", label: "申請シミュレーター", description: "Slack モーダルと Backlog 反映の確認", active: true },
          { href: "/admin/workflow/stamp", label: "押印管理", description: "押印依頼と完了登録の運用画面", active: false },
          { href: "/admin/contracts", label: "契約管理トップ", description: "契約書生成や押印管理へ戻る", active: false },
        ],
  )}
  </div>
  <main class="shell">
    <section class="card">
      <h1>${isOrderLanding ? "発注書単体作成" : "申請シミュレーター"}</h1>
      <p class="helper">${isOrderLanding ? "発注書系を単体で起票する入口です。必要なら手入力明細または CSV / Excel 取込を使って、そのまま Backlog 起票まで進められます。" : "Slack App の設問確認に加えて、同じ入力フォームから Backlog 起票と外部文書登録まで実行できます。"}</p>
      <div class="summary-box">現在の既定種別: <strong>${escapeHtmlText(selectedDefinition.text)}</strong>${isOrderLanding ? " / ここから発注書・企画発注書・出版発注書に切り替えられます。" : ""}</div>
      <div class="row">
        <label for="requestType">文書種別</label>
        <select id="requestType">${options}</select>
      </div>
      <div class="row">
        <label for="requestSourceMode">登録モード</label>
        <select id="requestSourceMode">
          <option value="new">新規作成</option>
          <option value="signed_import">締結済取込</option>
          <option value="delivered_import">交付済取込</option>
        </select>
      </div>
      <div class="row">
        <label for="requesterSlackUserId">依頼者Slack ID</label>
        <input id="requesterSlackUserId" type="text" placeholder="U12345678" />
      </div>
      <div class="row">
        <label for="requestSummary">案件概要</label>
        <input id="requestSummary" type="text" placeholder="例: イラスト制作発注 / 基本契約締結済案件の登録" />
      </div>
      <div class="row">
        <label for="externalDocumentUrl">原本文書URL</label>
        <input id="externalDocumentUrl" type="text" placeholder="https://drive.google.com/..." />
        <div class="helper">締結済取込・交付済取込では URL またはファイルのどちらかが必要です。</div>
      </div>
      <div class="row">
        <label for="externalDocumentFile">原本文書ファイル</label>
        <input id="externalDocumentFile" type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.csv" />
      </div>
      <div class="actions">
        <button id="loadSchemaBtn" type="button">設問を読み込む</button>
        <button id="validateBtn" type="button" class="ghost">必須チェック</button>
        <button id="createRequestBtn" type="button">Backlogへ登録</button>
      </div>
      <div id="summary" class="helper"></div>
      <div id="meta" class="helper"></div>
      <div id="validationStatus" class="status"></div>
      <div id="createStatus" class="status"></div>
    </section>

    <section class="card">
      <h2>設問プレビュー</h2>
      <div id="fieldGroups"></div>
    </section>

    <section class="card" id="orderDetailsCard" style="display:none;">
      <h2>発注明細取込</h2>
      <div class="helper">発注書・企画発注書は、後続の納期管理や検収書発行のために明細取込が必須です。</div>
      <div class="actions" style="margin-top:12px;">
        <button id="addManualOrderRowBtn" type="button">明細を1行追加</button>
        <button id="fillManualOrderSampleBtn" type="button" class="ghost">手入力サンプル</button>
      </div>
      <div class="preview" style="margin-top:12px;">
        <table>
          <thead>
            <tr>
              <th>No</th>
              <th>区分</th>
              <th>支払方法</th>
              <th>分割回数</th>
              <th>初回支払日</th>
              <th>期間(月)</th>
              <th>数量</th>
              <th>単価</th>
              <th>件名</th>
              <th>仕様</th>
              <th>金額</th>
              <th>納期</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="manualOrderRows"></tbody>
        </table>
      </div>
      <div class="helper">登録番号は必須です。個人は当社の執筆登録、法人は法人登録番号を入力してください。</div>
      <div class="helper">区分は自由入力です。代表例: ${escapeHtmlText(orderCategoryExamplesText)}</div>
      <div class="helper">支払方法は固定候補から選択してください。</div>
      <div class="helper">分割は分割回数、サブスクは期間(月)と初回支払日を入れてください。初回支払日があれば各回スケジュール計算に使います。</div>
      <div class="helper">CSV/Excelを使わず、上の表に直接入力して登録することもできます。</div>
      <hr />
      <div class="row">
        <label for="orderImportMode">明細取込モード</label>
        <select id="orderImportMode">
          <option value="generic">通常CSV</option>
          <option value="planning">企画発注書マッピング</option>
        </select>
      </div>
      <div class="row">
        <label for="orderSourceFileName">元ファイル名</label>
        <input id="orderSourceFileName" type="text" placeholder="order_items.csv / planning_order.xlsx" />
      </div>
      <div class="row">
        <label for="orderXlsxFile">Excelファイル (.xlsx)</label>
        <input id="orderXlsxFile" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
      </div>
      <div class="row">
        <label for="orderSheetName">シート選択</label>
        <select id="orderSheetName">
          <option value="">Excelを選ぶとシート一覧が出ます</option>
        </select>
      </div>
      <div class="actions">
        <button id="extractOrderXlsxBtn" type="button" class="ghost">選択シートをCSV化</button>
        <button id="previewOrderCsvBtn" type="button" class="ghost">明細プレビュー</button>
      </div>
      <div class="row">
        <label for="orderCsvFile">CSVファイル</label>
        <input id="orderCsvFile" type="file" accept=".csv,text/csv" />
      </div>
      <div class="row">
        <label for="orderCsvText">明細CSV</label>
        <textarea id="orderCsvText" placeholder="no,category,pay_method,qty,unit_price,desc,spec,amount,due_date"></textarea>
      </div>
      <div id="orderCsvStatus" class="status"></div>
      <div class="preview" style="margin-top:12px;">
        <table>
          <thead>
            <tr>
              <th>No</th>
              <th>登録番号</th>
              <th>区分</th>
              <th>支払方法</th>
              <th>分割回数</th>
              <th>初回支払日</th>
              <th>期間(月)</th>
              <th>数量</th>
              <th>単価</th>
              <th>件名</th>
              <th>仕様</th>
              <th>金額</th>
              <th>納期</th>
            </tr>
          </thead>
          <tbody id="orderPreviewBody">
            <tr><td colspan="13" class="note">まだ明細をプレビューしていません。</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const orderPayMethodOptions = ${escapeHtmlText(orderPayMethodOptionsJson)};
    const requestType = document.getElementById("requestType");
    const requestSourceMode = document.getElementById("requestSourceMode");
    const loadSchemaBtn = document.getElementById("loadSchemaBtn");
    const validateBtn = document.getElementById("validateBtn");
    const createRequestBtn = document.getElementById("createRequestBtn");
    const fieldGroups = document.getElementById("fieldGroups");
    const summary = document.getElementById("summary");
    const meta = document.getElementById("meta");
    const validationStatus = document.getElementById("validationStatus");
    const createStatus = document.getElementById("createStatus");
    const orderDetailsCard = document.getElementById("orderDetailsCard");
    const orderImportMode = document.getElementById("orderImportMode");
    const orderCsvText = document.getElementById("orderCsvText");
    const orderCsvStatus = document.getElementById("orderCsvStatus");
    const orderPreviewBody = document.getElementById("orderPreviewBody");
    const orderCsvFile = document.getElementById("orderCsvFile");
    const orderXlsxFile = document.getElementById("orderXlsxFile");
    const orderSheetName = document.getElementById("orderSheetName");
    const orderSourceFileName = document.getElementById("orderSourceFileName");
    const manualOrderRows = document.getElementById("manualOrderRows");
    let currentSchema = null;
    let orderWorkbookBase64 = "";

    loadSchemaBtn.addEventListener("click", loadSchema);
    validateBtn.addEventListener("click", validateSchema);
    createRequestBtn.addEventListener("click", createRequest);
    requestSourceMode.addEventListener("change", syncSourceModeHint);
    requestType.addEventListener("change", syncOrderSection);
    document.getElementById("previewOrderCsvBtn").addEventListener("click", previewOrderCsv);
    document.getElementById("extractOrderXlsxBtn").addEventListener("click", extractOrderXlsxToCsv);
    document.getElementById("addManualOrderRowBtn").addEventListener("click", () => appendManualOrderRow());
    document.getElementById("fillManualOrderSampleBtn").addEventListener("click", fillManualOrderSample);
    orderCsvFile.addEventListener("change", onOrderCsvFileChange);
    orderXlsxFile.addEventListener("change", onOrderXlsxFileChange);
    loadSchema();
    syncSourceModeHint();
    syncOrderSection();
    appendManualOrderRow();

    async function loadSchema() {
      validationStatus.className = "status";
      validationStatus.textContent = "";
      createStatus.className = "status";
      createStatus.textContent = "";
      const response = await fetch("/admin/api/workflow/request-simulator/schema?type=" + encodeURIComponent(requestType.value));
      const result = await response.json();
      if (!result.ok) {
        summary.textContent = result.error || "設問の読み込みに失敗しました。";
        fieldGroups.innerHTML = "";
        return;
      }

      currentSchema = result;
      summary.innerHTML = [
        "Backlog課題タイプ: <strong>" + escapeHtml(result.definition.backlogIssueTypeName) + "</strong>",
        "文書生成: <strong>" + (result.definition.autoGenerate ? "起票後に自動生成" : "自動生成なし") + "</strong>",
        "データ主: <strong>" + escapeHtml(result.definition.dataOwner) + "</strong>",
        "後続ショートカット: <strong>" + escapeHtml(result.definition.followUpShortcut || "なし") + "</strong>"
      ].join(" / ");
      meta.innerHTML = [
        "種別コード: <code>" + escapeHtml(result.definition.value) + "</code>",
        "ファミリー: <code>" + escapeHtml(result.definition.family) + "</code>",
        "ワークフロー種別: <code>" + escapeHtml(result.definition.workflowKind) + "</code>"
      ].join(" / ");

      fieldGroups.innerHTML = result.groups.map((group) => {
        return [
          '<section class="card" style="margin-top:12px;">',
          '<h3>' + escapeHtml(group.title) + '</h3>',
          group.description ? '<div class="helper">' + escapeHtml(group.description) + '</div>' : '',
          ...group.fields.map((field) => renderField(field)),
          '</section>'
        ].join("");
      }).join("");
      syncOrderSection();
    }

    function renderField(field) {
      const requiredBadge = field.required ? '<span class="helper" style="color:#9b3d2f;">必須</span>' : '<span class="helper">任意</span>';
      const helperText = field.helper ? '<div class="helper">' + escapeHtml(field.helper) + '</div>' : '';
      const fieldMeta = '<div class="helper">field id: <code>' + escapeHtml(field.id) + '</code></div>';
      if (field.multiline) {
        return [
          '<div class="row">',
          '<label for="' + escapeHtml(field.id) + '">' + escapeHtml(field.label) + ' ' + requiredBadge + '</label>',
          '<textarea id="' + escapeHtml(field.id) + '" placeholder="' + escapeHtml(field.placeholder || "") + '"></textarea>',
          fieldMeta,
          helperText,
          '</div>'
        ].join("");
      }
      return [
        '<div class="row">',
        '<label for="' + escapeHtml(field.id) + '">' + escapeHtml(field.label) + ' ' + requiredBadge + '</label>',
        '<input id="' + escapeHtml(field.id) + '" type="text" placeholder="' + escapeHtml(field.placeholder || "") + '" />',
        fieldMeta,
        helperText,
        '</div>'
      ].join("");
    }

    async function validateSchema() {
      if (!currentSchema) {
        await loadSchema();
      }
      const values = collectFieldValues();
      const response = await fetch("/admin/api/workflow/request-simulator/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: requestType.value, values }),
      });
      const result = await response.json();
      if (!result.ok) {
        validationStatus.className = "status error";
        validationStatus.textContent = result.error || "必須チェックに失敗しました。";
        return;
      }
      if (!result.errors.length) {
        validationStatus.className = "status success";
        validationStatus.textContent = "必須チェックOKです。Slack承認後もこの入力構成で進められます。";
        return;
      }
      validationStatus.className = "status warning";
      validationStatus.innerHTML = [
        "<strong>未入力の必須項目</strong>",
        "<ul>" + result.errors.map((error) => "<li>" + escapeHtml(error.message) + "</li>").join("") + "</ul>"
      ].join("");
    }

    function collectFieldValues() {
      const values = {};
      Array.from(fieldGroups.querySelectorAll("input, textarea")).forEach((element) => {
        values[element.id] = element.value;
      });
      return values;
    }

    async function createRequest() {
      createStatus.className = "status";
      createStatus.textContent = "";
      const values = collectFieldValues();
      const payload = {
        type: requestType.value,
        sourceMode: requestSourceMode.value,
        requesterSlackUserId: document.getElementById("requesterSlackUserId").value,
        summary: document.getElementById("requestSummary").value,
        externalDocumentUrl: document.getElementById("externalDocumentUrl").value,
        uploadedFile: await readSelectedFile(),
        orderImportMode: orderImportMode.value,
        orderCsvText: orderCsvText.value,
        orderSourceFileName: orderSourceFileName.value,
        manualOrderItems: collectManualOrderItems(),
        values,
      };
      const response = await fetch("/admin/api/workflow/request-simulator/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!result.ok) {
        createStatus.className = "status error";
        createStatus.innerHTML = [
          "<strong>登録に失敗しました。</strong>",
          "<div>" + escapeHtml(result.error || "不明なエラー") + "</div>",
          Array.isArray(result.errors) && result.errors.length
            ? "<ul>" + result.errors.map((error) => "<li>" + escapeHtml(error.message) + "</li>").join("") + "</ul>"
            : ""
        ].join("");
        return;
      }
      createStatus.className = "status success";
      const nextActionsHtml = Array.isArray(result.nextActions) && result.nextActions.length
        ? "<div style='margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;'>"
          + result.nextActions.map((action) => {
            const target = action.external ? " target=\"_blank\" rel=\"noreferrer\"" : "";
            return "<a class=\"link-button\" href=\"" + escapeHtml(action.href || "") + "\"" + target + ">" + escapeHtml(action.label || "次へ") + "</a>";
          }).join("")
          + "</div>"
        : "";
      createStatus.innerHTML = [
        "<strong>登録しました。</strong>",
        result.type ? "<div>種別: " + escapeHtml(result.type) + "</div>" : "",
        "<div>課題キー: " + escapeHtml(result.issueKey || "") + "</div>",
        result.documentNumber ? "<div>採番: " + escapeHtml(result.documentNumber) + "</div>" : "",
        result.importedOrderItemsCount ? "<div>明細取込: " + escapeHtml(String(result.importedOrderItemsCount)) + "件</div>" : "",
        result.createdTrackingIssueCount ? "<div>納品管理課題: " + escapeHtml(String(result.createdTrackingIssueCount)) + "件を自動作成</div>" : "",
        result.issueUrl ? '<div><a href="' + escapeHtml(result.issueUrl) + '" target="_blank" rel="noreferrer">Backlogで開く</a></div>' : "",
        nextActionsHtml,
      ].join("");
    }

    async function readSelectedFile() {
      const input = document.getElementById("externalDocumentFile");
      const file = input.files && input.files[0];
      if (!file) return undefined;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました。"));
        reader.readAsDataURL(file);
      });
      const base64 = String(dataUrl).split(",")[1] || "";
      if (!base64) return undefined;
      return {
        name: file.name,
        contentBase64: base64,
      };
    }

    function syncSourceModeHint() {
      const placeholder = requestSourceMode.value === "new"
        ? "https://drive.google.com/...（任意）"
        : "https://drive.google.com/...（URLまたはファイル必須）";
      document.getElementById("externalDocumentUrl").placeholder = placeholder;
    }

    function syncOrderSection() {
      const isOrderType = requestType.value === "purchase_order" || requestType.value === "planning_order" || requestType.value === "publishing_order";
      orderDetailsCard.style.display = isOrderType ? "block" : "none";
      if (!isOrderType) return;
      if (requestType.value === "planning_order" || requestType.value === "publishing_order") {
        orderImportMode.value = "planning";
      }
      orderCsvText.placeholder = orderImportMode.value === "planning"
        ? "企画発注書 / 出版発注書の元CSVを貼り付けるか、Excelから変換してください"
        : "no,category,pay_method,qty,unit_price,desc,spec,amount,due_date";
    }

    function appendManualOrderRow(values) {
      const payMethodOptions = orderPayMethodOptions.map((option) =>
        '<option value="' + escapeHtml(option) + '"' + ((values && values.payMethod ? values.payMethod : orderPayMethodOptions[0]) === option ? " selected" : "") + '>' + escapeHtml(option) + '</option>'
      ).join("");
      const row = document.createElement("tr");
      row.innerHTML = [
        '<td><input data-key="no" type="text" value="' + escapeHtml(values && values.no ? String(values.no) : String(manualOrderRows.children.length + 1)) + '" style="width:56px;" /></td>',
        '<td><input data-key="vendorCode" type="text" value="' + escapeHtml(values && values.vendorCode ? values.vendorCode : "") + '" placeholder="執筆登録 / 法人登録番号" /></td>',
        '<td><input data-key="category" type="text" value="' + escapeHtml(values && values.category ? values.category : "") + '" /></td>',
        '<td><select data-key="payMethod">' + payMethodOptions + '</select></td>',
        '<td><input data-key="installmentCount" type="text" value="' + escapeHtml(values && values.installmentCount ? String(values.installmentCount) : "") + '" style="width:72px;" /></td>',
        '<td><input data-key="paymentStartDate" type="text" value="' + escapeHtml(values && values.paymentStartDate ? values.paymentStartDate : "") + '" placeholder="2026-05-20" /></td>',
        '<td><input data-key="subscriptionMonths" type="text" value="' + escapeHtml(values && values.subscriptionMonths ? String(values.subscriptionMonths) : "") + '" style="width:72px;" /></td>',
        '<td><input data-key="qty" type="text" value="' + escapeHtml(values && values.qty ? String(values.qty) : "1") + '" style="width:64px;" /></td>',
        '<td><input data-key="unitPrice" type="text" value="' + escapeHtml(values && values.unitPrice ? String(values.unitPrice) : "") + '" /></td>',
        '<td><input data-key="desc" type="text" value="' + escapeHtml(values && values.desc ? values.desc : "") + '" /></td>',
        '<td><input data-key="spec" type="text" value="' + escapeHtml(values && values.spec ? values.spec : "") + '" /></td>',
        '<td><input data-key="amount" type="text" value="' + escapeHtml(values && values.amount ? String(values.amount) : "") + '" /></td>',
        '<td><input data-key="dueDate" type="text" value="' + escapeHtml(values && values.dueDate ? values.dueDate : "") + '" placeholder="2026-04-30" /></td>',
        '<td><button type="button" class="ghost remove-manual-row">削除</button></td>',
      ].join("");
      row.querySelector(".remove-manual-row").addEventListener("click", () => {
        row.remove();
        renumberManualOrderRows();
      });
      manualOrderRows.appendChild(row);
    }

    function renumberManualOrderRows() {
      Array.from(manualOrderRows.querySelectorAll("tr")).forEach((row, index) => {
        const noInput = row.querySelector('input[data-key="no"]');
        if (noInput && !String(noInput.value || "").trim()) {
          noInput.value = String(index + 1);
        }
      });
    }

    function collectManualOrderItems() {
      return Array.from(manualOrderRows.querySelectorAll("tr")).map((row) => {
        const get = (key) => {
          const element = row.querySelector('[data-key="' + key + '"]');
          return element ? element.value : "";
        };
        return {
          no: get("no"),
          vendorCode: get("vendorCode"),
          category: get("category"),
          payMethod: get("payMethod"),
          installmentCount: get("installmentCount"),
          paymentStartDate: get("paymentStartDate"),
          subscriptionMonths: get("subscriptionMonths"),
          qty: get("qty"),
          unitPrice: get("unitPrice"),
          desc: get("desc"),
          spec: get("spec"),
          amount: get("amount"),
          dueDate: get("dueDate"),
        };
      }).filter((item) => Object.values(item).some((value) => String(value || "").trim()));
    }

    function fillManualOrderSample() {
      manualOrderRows.innerHTML = "";
      appendManualOrderRow({
        no: 1,
        vendorCode: "WR-001",
        category: "制作",
        payMethod: "一括",
        installmentCount: "",
        paymentStartDate: "2026-05-20",
        subscriptionMonths: "",
        qty: 1,
        unitPrice: 80000,
        desc: "イラスト制作",
        spec: "A4 / RGB / キャラクター1点",
        amount: 80000,
        dueDate: "2026-04-30",
      });
      appendManualOrderRow({
        no: 2,
        vendorCode: "T1234567890123",
        category: "デザイン",
        payMethod: "分割",
        installmentCount: 3,
        paymentStartDate: "2026-05-20",
        subscriptionMonths: "",
        qty: 1,
        unitPrice: 30000,
        desc: "ロゴデザイン",
        spec: "ロゴ3案",
        amount: 30000,
        dueDate: "2026-05-10",
      });
    }

    async function onOrderCsvFileChange(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      orderCsvText.value = await file.text();
      orderSourceFileName.value = file.name;
      orderCsvStatus.className = "status";
      orderCsvStatus.textContent = "明細CSVを読み込みました。";
    }

    async function onOrderXlsxFileChange(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      orderSourceFileName.value = file.name;
      orderWorkbookBase64 = await toBase64(file);
      orderCsvStatus.className = "status";
      orderCsvStatus.textContent = "Excelファイルを読み込み、シート一覧を取得しています...";
      const result = await postJson("/admin/api/orders/xlsx/sheets", {
        fileBase64: orderWorkbookBase64,
      });
      if (!result.ok) {
        orderCsvStatus.className = "status error";
        orderCsvStatus.textContent = "Excel読込失敗: " + result.error;
        return;
      }
      orderSheetName.innerHTML = result.sheets.map((sheet, index) =>
        "<option value='" + escapeHtml(sheet.name) + "'" + (index === 0 ? " selected" : "") + ">" +
        escapeHtml(sheet.name) + " (" + sheet.rowCount + "行 / score " + sheet.score + ")</option>"
      ).join("");
      if (result.sheets[0] && result.sheets[0].score >= 4) {
        orderImportMode.value = "planning";
        syncOrderSection();
      }
      orderCsvStatus.className = "status success";
      orderCsvStatus.textContent = "Excelファイルを読み込みました。";
    }

    async function extractOrderXlsxToCsv() {
      if (!orderWorkbookBase64 || !orderSheetName.value) {
        orderCsvStatus.className = "status warning";
        orderCsvStatus.textContent = "先に Excel ファイルとシートを選択してください。";
        return;
      }
      const result = await postJson("/admin/api/orders/xlsx/to-csv", {
        fileBase64: orderWorkbookBase64,
        sheetName: orderSheetName.value,
      });
      if (!result.ok) {
        orderCsvStatus.className = "status error";
        orderCsvStatus.textContent = "CSV変換失敗: " + result.error;
        return;
      }
      orderCsvText.value = result.csv || "";
      orderCsvStatus.className = "status success";
      orderCsvStatus.textContent = "選択シートをCSV化しました。";
    }

    async function previewOrderCsv() {
      if (!orderCsvText.value.trim()) {
        orderCsvStatus.className = "status warning";
        orderCsvStatus.textContent = "先に明細CSVを入力してください。";
        return;
      }
      const result = await postJson("/admin/api/orders/csv/preview", {
        csvText: orderCsvText.value,
        mode: orderImportMode.value,
        sourceFileName: orderSourceFileName.value,
        projectTitle: document.getElementById("project_title") ? document.getElementById("project_title").value : document.getElementById("requestSummary").value,
        remarks: document.getElementById("remarks") ? document.getElementById("remarks").value : "",
        specialTerms: document.getElementById("special_notes") ? document.getElementById("special_notes").value : "",
      });
      if (!result.ok) {
        orderCsvStatus.className = "status error";
        orderCsvStatus.textContent = "明細プレビュー失敗: " + result.error;
        orderPreviewBody.innerHTML = '<tr><td colspan="13" class="note">プレビューに失敗しました。</td></tr>';
        return;
      }
      orderCsvStatus.className = "status success";
      orderCsvStatus.textContent = "明細プレビュー: " + result.count + "件";
      orderPreviewBody.innerHTML = result.items.map((item) => [
        "<tr>",
        "<td>" + escapeHtml(String(item.no ?? "")) + "</td>",
        "<td>" + escapeHtml(item.vendorCode || "") + "</td>",
        "<td>" + escapeHtml(item.category || "") + "</td>",
        "<td>" + escapeHtml(item.payMethod || "") + "</td>",
        "<td>" + escapeHtml(String(item.installmentCount ?? "")) + "</td>",
        "<td>" + escapeHtml(item.paymentStartDate || "") + "</td>",
        "<td>" + escapeHtml(String(item.subscriptionMonths ?? "")) + "</td>",
        "<td>" + escapeHtml(String(item.qty ?? "")) + "</td>",
        "<td>" + escapeHtml(String(item.unitPrice ?? "")) + "</td>",
        "<td>" + escapeHtml(item.desc || "") + "</td>",
        "<td>" + escapeHtml(item.spec || "") + "</td>",
        "<td>" + escapeHtml(String(item.amount ?? "")) + "</td>",
        "<td>" + escapeHtml(item.dueDate || "") + "</td>",
        "</tr>",
      ].join("")).join("");
    }

    function toBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || "");
          resolve(result.includes(",") ? result.split(",")[1] : result);
        };
        reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました。"));
        reader.readAsDataURL(file);
      });
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }
  </script>
</body>
</html>`;
}

function buildStampAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>押印管理</title>
  <style>${sharedAdminCss()}</style>
</head>
<body>
  <div class="wrap">
    ${buildAdminNav("stamp")}
    ${buildCategorySwitchHtml("Tools", "契約管理・管理ツールの関連画面", "押印管理は契約運用にも保守導線にもまたがる画面です。契約書生成と行き来しやすいようにしています。", [
      { href: "/admin/contracts", label: "契約管理トップ", description: "契約書生成と押印関連の入口", active: false },
      { href: "/admin/workflow/stamp", label: "押印管理", description: "押印依頼、完了登録、差戻し", active: true },
      { href: "/admin/workflow/contracts", label: "契約書生成", description: "対象課題の本文生成へ戻る", active: false },
      { href: "/admin/tools", label: "管理ツールトップ", description: "確認用・保守用の画面へ戻る", active: false },
    ])}
    <h1>押印管理</h1>
    <p class="sub">押印申請、方式選択、完了登録、差戻し登録をここから行えます。Slackを使わないローカル運用でも回せる画面です。</p>
    <div class="grid two-col">
      <section class="panel">
        <h2>押印操作</h2>
        <div class="row"><label for="issueKey">Backlog課題キー</label><input id="issueKey" type="text" placeholder="LEGAL-123" /></div>
        <div class="row"><label for="primaryDocumentUrl">対象文書URL</label><input id="primaryDocumentUrl" type="text" placeholder="https://drive.google.com/..." /></div>
        <div class="row">
          <label for="stampType">押印方式</label>
          <select id="stampType">
            <option value="PHYSICAL">物理押印</option>
            <option value="ELECTRONIC">電子署名</option>
          </select>
        </div>
        <div class="row"><label for="documentUrl">押印済みURL</label><input id="documentUrl" type="text" placeholder="https://drive.google.com/..." /></div>
        <div class="row"><label for="completedBySlackId">実施者Slack ID</label><input id="completedBySlackId" type="text" placeholder="U0123456789" /></div>
        <div class="row"><label for="rejectedReason">差戻し理由</label><textarea id="rejectedReason" placeholder="差戻し理由を入力"></textarea></div>
        <div class="actions">
          <button id="requestStampBtn" type="button">押印申請を送る</button>
          <button id="chooseTypeBtn" type="button" class="ghost">方式だけ更新</button>
          <button id="completeStampBtn" type="button">押印完了</button>
          <button id="rejectStampBtn" type="button" class="ghost">差戻し</button>
        </div>
        <div id="stampActionStatus" class="status"></div>
      </section>

      <section class="panel">
        <h2>押印状況一覧</h2>
        <div class="actions">
          <button id="reloadStampListBtn" type="button" class="ghost">一覧を再読込</button>
        </div>
        <div id="stampListStatus" class="status"></div>
        <div class="preview">
          <table>
            <thead>
              <tr>
                <th>課題</th>
                <th>状態</th>
                <th>方式</th>
                <th>更新</th>
                <th>URL / 理由</th>
              </tr>
            </thead>
            <tbody id="stampTableBody"></tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
  <script>
    document.getElementById("requestStampBtn").addEventListener("click", async () => {
      const result = await postJson("/admin/api/workflow/stamp/request", {
        issueKey: value("issueKey"),
        primaryDocumentUrl: value("primaryDocumentUrl"),
      });
      showActionResult(result, "押印申請を送信しました。");
      if (result.ok) loadStampList();
    });

    document.getElementById("chooseTypeBtn").addEventListener("click", async () => {
      const result = await postJson("/admin/api/workflow/stamp/type", {
        issueKey: value("issueKey"),
        stampType: value("stampType"),
      });
      showActionResult(result, "押印方式を更新しました。");
      if (result.ok) loadStampList();
    });

    document.getElementById("completeStampBtn").addEventListener("click", async () => {
      const result = await postJson("/admin/api/workflow/stamp/complete", {
        issueKey: value("issueKey"),
        stampType: value("stampType"),
        documentUrl: value("documentUrl"),
        completedBySlackId: value("completedBySlackId"),
      });
      showActionResult(result, "押印完了を登録しました。");
      if (result.ok) loadStampList();
    });

    document.getElementById("rejectStampBtn").addEventListener("click", async () => {
      const result = await postJson("/admin/api/workflow/stamp/reject", {
        issueKey: value("issueKey"),
        rejectedReason: value("rejectedReason"),
        completedBySlackId: value("completedBySlackId"),
      });
      showActionResult(result, "押印差戻しを登録しました。");
      if (result.ok) loadStampList();
    });

    document.getElementById("reloadStampListBtn").addEventListener("click", loadStampList);
    loadStampList();

    async function loadStampList() {
      const result = await fetch("/admin/api/workflow/stamp").then((response) => response.json());
      const body = document.getElementById("stampTableBody");
      body.innerHTML = "";
      if (!result.ok) {
        document.getElementById("stampListStatus").textContent = "一覧取得失敗: " + result.error;
        return;
      }
      document.getElementById("stampListStatus").textContent = result.workflows.length + " 件の押印案件を表示しています。";
      result.workflows.forEach((workflow) => {
        const tr = document.createElement("tr");
        tr.innerHTML = [
          "<td><button type='button' class='chip fill-issue'>" + escapeHtml(workflow.issueKey) + "</button><div class='helper'>" + escapeHtml(workflow.summary || "") + "</div></td>",
          "<td>" + escapeHtml(resolveStampState(workflow)) + "</td>",
          "<td>" + escapeHtml(workflow.stampType || "-") + "</td>",
          "<td>" + escapeHtml(formatTimestamp(workflow.stampedAt || workflow.esignCompletedAt || workflow.stampRejectedAt || workflow.stampRequestedAt)) + "</td>",
          "<td>" + escapeHtml(workflow.stampedDriveUrl || workflow.esignDriveUrl || workflow.stampRejectedReason || "") + "</td>",
        ].join("");
        tr.querySelector(".fill-issue").addEventListener("click", () => {
          document.getElementById("issueKey").value = workflow.issueKey || "";
          document.getElementById("stampType").value = workflow.stampType || "PHYSICAL";
          document.getElementById("documentUrl").value = workflow.stampedDriveUrl || workflow.esignDriveUrl || "";
          document.getElementById("rejectedReason").value = workflow.stampRejectedReason || "";
          document.getElementById("primaryDocumentUrl").value = "";
        });
        body.appendChild(tr);
      });
    }

    function resolveStampState(workflow) {
      if (workflow.stampedAt || workflow.esignCompletedAt) return "押印完了";
      if (workflow.stampRejectedAt) return "差戻し";
      if (workflow.stampRequestedAt) return "押印申請中";
      return "未申請";
    }

    function showActionResult(result, successMessage) {
      document.getElementById("stampActionStatus").textContent = result.ok ? successMessage : "処理失敗: " + result.error;
    }

    function formatTimestamp(value) {
      if (!value) return "";
      return new Date(value).toLocaleString("ja-JP");
    }

    function value(id) { return document.getElementById(id).value; }
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>\"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }
  </script>
</body>
</html>`;
}

function buildDeliveryAdminHtml(): string {
  const profileOptions = getPlanningImportProfiles()
    .map((profile) => `<option value="${escapeHtmlText(profile.id)}">${escapeHtmlText(profile.label)}</option>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>納品帳票生成</title>
  <style>${sharedAdminCss()}</style>
</head>
<body>
  ${buildAdminNav("delivery")}
  <div class="wrap">
  ${buildCategorySwitchHtml("Delivery", "納品・検収の関連画面", "発注明細課題を起点に、納品確認、検収書生成、支払通知までをここで進めます。", [
    { href: "/admin/delivery", label: "納品・検収トップ", description: "納品・検収カテゴリの入口", active: false },
    { href: "/admin/workflow/delivery", label: "納品帳票生成", description: "明細課題更新と検収書・支払通知書生成", active: true },
    { href: "/admin/orders", label: "発注管理トップ", description: "前提となる発注明細課題の整備", active: false },
    { href: "/admin", label: "ダッシュボード", description: "要確認案件や優先対応キューを確認", active: false },
  ])}
  </div>
  <main class="shell">
    <section class="card">
      <h1>納品帳票生成</h1>
      <p class="helper">納品課題キーからの個別生成と、親課題キーからの一括処理の両方に対応しています。親発注課題または親企画発注課題の支払条件を自動参照します。</p>
      <div class="summary-box">手順: まず「条件を確認」で停止/注意を確認し、停止項目がない状態で「帳票を生成」を実行してください。</div>
      <div class="row">
        <label>要修正の納品課題</label>
        <div id="deliveryAttentionIssues" class="chip-list"><span class="helper">読み込み中...</span></div>
      </div>
      <div class="row">
        <label for="issueKey">納品課題キー</label>
        <input id="issueKey" type="text" placeholder="LEGAL-123" />
      </div>
      <div class="actions">
        <button id="previewBtn" type="button" class="ghost">条件を確認</button>
        <button id="generateBtn" type="button">帳票を生成</button>
        <a class="link-button" href="/admin/api/workflow/delivery/variables.csv">検収書 変数対応表CSVをDL</a>
      </div>
      <div id="status" class="status"></div>
      <div id="result" class="helper"></div>
    </section>
    <section class="card">
      <h2>出力見込み</h2>
      <p class="helper">条件確認時点で、今回の納品で生成される帳票の見込みを表示します。</p>
      <div id="deliveryPreviewMeta" class="sample">課題を読み込むと、出力見込みを表示します。</div>
    </section>
    <section class="card">
      <h2>生成前チェック</h2>
      <p class="helper">納品帳票生成の主な工程を段階ごとに確認します。停止項目がある場合は先に解消してください。</p>
      <div id="deliveryPreflightSummary" class="summary-box">課題を読み込むと、生成前チェックを表示します。</div>
      <div id="deliveryPreflightSteps" class="preflight-grid"></div>
    </section>
    <section class="card">
      <h2>CSV一括発注から一括起票</h2>
      <p class="helper">親発注課題キーからCSV取込済み明細を読み込み、選択した明細の納品リクエストを一括作成します。通常の発注書と企画発注書の両方に対応しています。検収書も同時生成する場合は、検収日を入れた同じCSVをもう一度読み込んでください。</p>
      <div class="summary-box">推奨運用: まず親課題を読み込む → 対象明細を選ぶ → 必要なら検収日入りCSVを読み込む → 「納品リクエストを一括作成」で起票 → 「検収書も同時生成」をONにするとその場で帳票まで進みます。企画発注書でも同じ流れで使えます。</div>
      <div class="row">
        <label for="bulkParentIssueKey">親発注課題キー / 親企画発注課題キー</label>
        <input id="bulkParentIssueKey" type="text" placeholder="LEGAL-123" />
      </div>
      <div class="row">
        <label for="bulkMappingProfileId">マッピング種別</label>
        <select id="bulkMappingProfileId">
          ${profileOptions}
        </select>
      </div>
      <div class="row">
        <label for="bulkInspectionCsvFile">検収日入りCSVファイル</label>
        <input id="bulkInspectionCsvFile" type="file" accept=".csv,text/csv" />
      </div>
      <div class="row">
        <label for="bulkInspectionCsvText">または検収日入りCSV貼り付け</label>
        <textarea id="bulkInspectionCsvText" placeholder="同じCSVに 検収日 列を追加して貼り付け"></textarea>
      </div>
      <div class="actions">
        <button id="bulkPreviewBtn" type="button" class="ghost">明細を読み込む</button>
        <label class="inline-check"><input id="bulkGenerateDocuments" type="checkbox" /> 検収書も同時生成</label>
        <button id="bulkCreateBtn" type="button">納品リクエストを一括作成</button>
      </div>
      <div id="bulkStatus" class="status"></div>
      <div id="bulkSummary" class="helper"></div>
      <div id="bulkTable" class="helper"></div>
      <div id="bulkResult" class="helper"></div>
    </section>
  </main>
  <script>
    const issueKey = document.getElementById("issueKey");
    const previewBtn = document.getElementById("previewBtn");
    const generateBtn = document.getElementById("generateBtn");
    const status = document.getElementById("status");
    const result = document.getElementById("result");
    const deliveryAttentionIssues = document.getElementById("deliveryAttentionIssues");
    const deliveryPreviewMeta = document.getElementById("deliveryPreviewMeta");
    const deliveryPreflightSummary = document.getElementById("deliveryPreflightSummary");
    const deliveryPreflightSteps = document.getElementById("deliveryPreflightSteps");
    const params = new URLSearchParams(window.location.search);
    const requestedParentIssueKey = String(params.get("parentIssueKey") || "").trim().toUpperCase();
    const requestedItemNo = parseInt(String(params.get("itemNo") || ""), 10);

    if (params.get("issueKey")) {
      issueKey.value = String(params.get("issueKey") || "").trim().toUpperCase();
    }
    const bulkParentIssueKey = document.getElementById("bulkParentIssueKey");
    const bulkMappingProfileId = document.getElementById("bulkMappingProfileId");
    const bulkInspectionCsvFile = document.getElementById("bulkInspectionCsvFile");
    const bulkInspectionCsvText = document.getElementById("bulkInspectionCsvText");
    const bulkPreviewBtn = document.getElementById("bulkPreviewBtn");
    const bulkCreateBtn = document.getElementById("bulkCreateBtn");
    const bulkGenerateDocuments = document.getElementById("bulkGenerateDocuments");
    const bulkStatus = document.getElementById("bulkStatus");
    const bulkSummary = document.getElementById("bulkSummary");
    const bulkTable = document.getElementById("bulkTable");
    const bulkResult = document.getElementById("bulkResult");
    let bulkItems = [];
    loadDeliveryAttentionIssues();
    if (requestedParentIssueKey) {
      bulkParentIssueKey.value = requestedParentIssueKey;
      bulkStatus.className = "status";
      bulkStatus.textContent = "親課題キーを受け取りました。「明細を読み込む」で一括納品候補を確認できます。";
      setTimeout(() => {
        loadBulkPreview();
      }, 0);
    }

    bulkInspectionCsvFile.addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const decoded = await readCsvFileWithEncoding(file);
      bulkInspectionCsvText.value = decoded.text;
      bulkStatus.className = "status success";
      bulkStatus.textContent = "検収日CSVを読み込みました。文字コード: " + decoded.encoding;
    });

    previewBtn.addEventListener("click", async () => {
      status.className = "status";
      status.textContent = "確認中...";
      result.innerHTML = "";
      const response = await fetch("/admin/api/workflow/delivery/preview?issueKey=" + encodeURIComponent(issueKey.value));
      const payload = await response.json();
      if (!payload.ok) {
      status.className = "status error";
      status.textContent = payload.error || "確認に失敗しました。";
      deliveryPreviewMeta.innerHTML = '<div class="warning-summary warning-stop">出力見込みを取得できませんでした。</div>';
      deliveryPreflightSummary.innerHTML = '<div class="warning-summary warning-stop">生成前チェックを取得できませんでした。</div>';
      deliveryPreflightSteps.innerHTML = "";
        if (payload.warnings?.length) {
          result.innerHTML = "<strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings);
        }
        return;
      }
      renderDeliveryPreviewMeta(payload.previewReport);
      renderDeliveryPreflight(payload.preflight);
      status.className = "status success";
      status.textContent = "条件を確認しました。";
      result.innerHTML = [
        "<strong>納品課題:</strong> " + escapeHtml(payload.issueKey),
        payload.parentIssueKey ? "<br><strong>親課題:</strong> " + escapeHtml(payload.parentIssueKey) : "",
        payload.parentIssueKey && payload.itemNo
          ? '<br><a class="inline-action" href="/admin/workflow/delivery?parentIssueKey=' + encodeURIComponent(payload.parentIssueKey) + '&itemNo=' + encodeURIComponent(String(payload.itemNo)) + '">親課題の一覧で明細 ①' + escapeHtml(String(payload.itemNo)) + ' を開く</a>'
          : "",
        "<br><strong>DeliveryEvent:</strong> " + (payload.hasDeliveryEvent ? "あり" : "未登録"),
        payload.itemNo ? "<br><strong>明細番号:</strong> " + escapeHtml(payload.itemNo) : "",
        payload.deliveredAmount ? "<br><strong>今回納品金額:</strong> " + escapeHtml(payload.deliveredAmount) : "",
        payload.deliveryNote ? "<br><strong>納品備考:</strong> " + escapeHtml(payload.deliveryNote) : "",
        payload.paymentCondition ? "<br><strong>支払条件:</strong> " + renderPaymentCondition(payload.paymentCondition) : "",
        payload.warnings?.length ? "<br><strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings) : "",
        payload.generatedDocuments?.length ? "<br><strong>生成済み文書:</strong><br>" + renderGeneratedDocuments(payload.generatedDocuments) : "",
      ].join("");
    });

    generateBtn.addEventListener("click", async () => {
      status.className = "status";
      status.textContent = "生成中...";
      result.innerHTML = "";
      const response = await fetch("/admin/api/workflow/delivery/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey: issueKey.value }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        status.className = "status error";
        status.textContent = payload.error || "生成に失敗しました。";
        if (payload.warnings?.length) {
          result.innerHTML = "<strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings);
        }
        return;
      }
      status.className = "status success";
      status.textContent = "帳票生成が完了しました。";
      result.innerHTML = [
        "<strong>納品課題:</strong> " + escapeHtml(payload.issueKey),
        payload.parentIssueKey ? "<br><strong>親課題:</strong> " + escapeHtml(payload.parentIssueKey) : "",
        payload.paymentCondition ? "<br><strong>支払条件:</strong> " + renderPaymentCondition(payload.paymentCondition) : "",
        payload.generationReport ? "<br><strong>生成サマリー:</strong><br>" + renderDeliveryGenerationReport(payload.generationReport) : "",
        payload.nextActions?.length ? "<br><strong>次に見ること:</strong><br>" + renderNextActions(payload.nextActions) : "",
        "<br><strong>検収書:</strong> " + renderLink(payload.inspectionCert),
        "<br><strong>支払通知書:</strong> " + (payload.paymentNotice ? renderLink(payload.paymentNotice) : "未発行"),
      ].join("");
      await loadDeliveryAttentionIssues();
    });

    bulkPreviewBtn.addEventListener("click", loadBulkPreview);

    bulkCreateBtn.addEventListener("click", async () => {
      const checkedRows = Array.from(document.querySelectorAll(".bulk-item-check:checked"));
      if (!checkedRows.length) {
        bulkStatus.className = "status error";
        bulkStatus.textContent = "対象明細を1件以上選択してください。";
        return;
      }
      bulkStatus.className = "status";
      bulkStatus.textContent = "一括作成中...";
      bulkResult.innerHTML = "";
      const items = checkedRows.map((checkbox) => {
        const row = checkbox.closest("[data-item-no]");
        const itemNo = row?.getAttribute("data-item-no") || "";
        return {
          itemNo,
          deliveredAmount: row?.querySelector(".bulk-amount-input")?.value || "",
          deliveryNote: row?.querySelector(".bulk-note-input")?.value || "",
        };
      });
      const response = await fetch("/admin/api/workflow/delivery/bulk/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentIssueKey: bulkParentIssueKey.value,
          mappingProfileId: bulkMappingProfileId.value,
          inspectionCsvText: bulkInspectionCsvText.value,
          generateDocuments: bulkGenerateDocuments.checked,
          items,
        }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        bulkStatus.className = "status error";
        bulkStatus.textContent = payload.error || "一括作成に失敗しました。";
        return;
      }
      bulkStatus.className = payload.failedCount > 0 ? "status error" : "status success";
      bulkStatus.textContent = payload.generateDocuments
        ? "納品リクエスト作成と帳票生成が完了しました。成功 " + String(payload.createdCount || 0) + " 件 / 要確認 " + String(payload.failedCount || 0) + " 件"
        : "納品リクエストの一括作成が完了しました。成功 " + String(payload.createdCount || 0) + " 件 / 要確認 " + String(payload.failedCount || 0) + " 件";
      bulkResult.innerHTML = [
        renderBulkResults(payload.results || []),
        renderBulkFailures(payload.failedResults || []),
      ].filter(Boolean).join("<br><br>");
      await loadBulkPreview();
    });

    async function loadBulkPreview() {
      bulkStatus.className = "status";
      bulkStatus.textContent = "明細を読み込み中...";
      bulkSummary.innerHTML = "";
      bulkTable.innerHTML = "";
      bulkResult.innerHTML = "";
      const response = await fetch("/admin/api/workflow/delivery/bulk/preview?parentIssueKey=" + encodeURIComponent(bulkParentIssueKey.value));
      const payload = await response.json();
      if (!payload.ok) {
        bulkStatus.className = "status error";
        bulkStatus.textContent = payload.error || "明細の読み込みに失敗しました。";
        return;
      }
      bulkItems = Array.isArray(payload.items) ? payload.items : [];
      bulkStatus.className = "status success";
      bulkStatus.textContent = "明細を読み込みました。";
      bulkSummary.innerHTML = [
        "<strong>親課題:</strong> " + escapeHtml(payload.parentIssueKey),
        payload.summary ? "<br><strong>案件概要:</strong> " + escapeHtml(payload.summary) : "",
        payload.counterparty ? "<br><strong>相手方:</strong> " + escapeHtml(payload.counterparty) : "",
        payload.paymentCondition ? "<br><strong>支払条件:</strong> " + renderPaymentCondition(payload.paymentCondition) : "",
        "<br><strong>明細数:</strong> " + escapeHtml(String(bulkItems.length)),
        Number.isFinite(requestedItemNo) ? "<br><strong>対象明細:</strong> ①" + escapeHtml(String(requestedItemNo)) : "",
      ].join("");
      bulkTable.innerHTML = renderBulkTable(bulkItems);
      highlightRequestedBulkItem();
    }

    function highlightRequestedBulkItem() {
      if (!Number.isFinite(requestedItemNo)) return;
      const rows = Array.from(document.querySelectorAll("tr[data-item-no]"));
      rows.forEach((row) => {
        const matches = row.getAttribute("data-item-no") === String(requestedItemNo);
        row.classList.toggle("bulk-focus-row", matches);
        const checkbox = row.querySelector(".bulk-item-check");
        if (checkbox) {
          checkbox.checked = matches;
        }
        if (matches) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }

    async function loadDeliveryAttentionIssues() {
      deliveryAttentionIssues.innerHTML = '<span class="helper">読み込み中...</span>';
      const response = await fetch("/admin/api/workflow/delivery/attention");
      const payload = await response.json();
      if (!payload.ok) {
        deliveryAttentionIssues.innerHTML = '<span class="helper">要修正の納品課題を取得できませんでした。</span>';
        return;
      }
      if (!payload.issues?.length) {
        deliveryAttentionIssues.innerHTML = '<span class="helper">要修正の納品課題はありません。</span>';
        return;
      }
      deliveryAttentionIssues.innerHTML = payload.issues.map((item) => {
        const prefix = item.severity === "stop" ? "[停止]" : "[注意]";
        const count = item.blockingCount > 0
          ? "停止 " + item.blockingCount + " 件"
          : "注意 " + item.warningCount + " 件";
        const label = prefix + " " + item.issueKey + " / " + count + " / " + (item.summary || "");
        return '<button type="button" class="chip" data-delivery-issue-key="' + escapeHtml(item.issueKey) + '">' + escapeHtml(label) + '</button>';
      }).join("");
      deliveryAttentionIssues.querySelectorAll("[data-delivery-issue-key]").forEach((button) => {
        button.addEventListener("click", () => {
          issueKey.value = button.getAttribute("data-delivery-issue-key") || "";
          previewBtn.click();
        });
      });
    }

    function renderLink(file) {
      const href = file.driveUrl || file.localPath;
      return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer">' + escapeHtml(file.filename || href) + '</a>';
    }

    async function readCsvFileWithEncoding(file) {
      const buffer = await file.arrayBuffer();
      const utf8Text = new TextDecoder("utf-8").decode(buffer);
      const shiftJisText = decodeWithEncoding(buffer, "shift_jis");
      const utf8Score = scoreDecodedText(utf8Text);
      const shiftJisScore = scoreDecodedText(shiftJisText);
      if (shiftJisText && shiftJisScore < utf8Score) {
        return { text: shiftJisText, encoding: "Shift_JIS" };
      }
      return { text: utf8Text, encoding: "UTF-8" };
    }

    function decodeWithEncoding(buffer, encoding) {
      try {
        return new TextDecoder(encoding).decode(buffer);
      } catch {
        return "";
      }
    }

    function scoreDecodedText(text) {
      if (!text) return Number.MAX_SAFE_INTEGER;
      const replacementCount = (text.match(/�/g) || []).length;
      const mojibakeCount = (text.match(/[�-�]/g) || []).length;
      return replacementCount * 10 + mojibakeCount;
    }

    function renderDeliveryPreviewMeta(report) {
      if (!report) {
        deliveryPreviewMeta.textContent = "出力見込みを表示できません。";
        return;
      }
      deliveryPreviewMeta.innerHTML = [
        report.summary ? "・" + escapeHtml(report.summary) : "",
        Array.isArray(report.expectedDocuments) && report.expectedDocuments.length
          ? "・想定帳票: " + escapeHtml(report.expectedDocuments.join(", "))
          : "",
        report.paymentNoticeExpected === null
          ? "・支払通知書: 判定不可"
          : "・支払通知書: " + escapeHtml(report.paymentNoticeExpected ? "今回生成見込み" : "最終納品時に生成見込み"),
      ].filter(Boolean).join("<br>");
    }

    function renderDeliveryPreflight(preflight) {
      if (!preflight || !Array.isArray(preflight.steps)) {
        deliveryPreflightSummary.textContent = "生成前チェックを表示できません。";
        deliveryPreflightSteps.innerHTML = "";
        return;
      }
      const summaryClass = preflight.overallStatus === "stop"
        ? "warning-summary warning-stop"
        : preflight.overallStatus === "warn"
          ? "warning-summary warning-warn"
          : "warning-summary preflight-ready";
      deliveryPreflightSummary.innerHTML = '<div class="' + summaryClass + '">' + escapeHtml(preflight.summary || "") + '</div>';
      deliveryPreflightSteps.innerHTML = preflight.steps.map((step) => {
        const badgeClass = step.status === "stop"
          ? "warning-stop"
          : step.status === "warn"
            ? "warning-warn"
            : "preflight-ready";
        const badgeLabel = step.status === "stop" ? "停止" : step.status === "warn" ? "注意" : "OK";
        return '<section class="panel preflight-step">'
          + '<div class="preflight-head">'
          + '<strong>' + escapeHtml(step.label || step.key || "check") + '</strong>'
          + '<span class="preflight-badge ' + badgeClass + '">' + badgeLabel + '</span>'
          + '</div>'
          + '<div class="helper">' + escapeHtml(step.detail || "") + '</div>'
          + '</section>';
      }).join("");
    }

    function renderDeliveryGenerationReport(report) {
      return [
        "・" + escapeHtml(report.summary || ""),
        "・Drive出力数: " + escapeHtml(String(report.driveDocumentCount || 0)),
        "・ローカル出力数: " + escapeHtml(String(report.localDocumentCount || 0)),
        report.statusUpdatedTo ? "・Backlog状態更新: " + escapeHtml(report.statusUpdatedTo) : "",
        report.statusSyncError ? "・Backlog状態更新エラー: " + escapeHtml(report.statusSyncError) : "",
      ].join("<br>");
    }

    function renderBulkTable(items) {
      if (!items.length) {
        return '<div class="helper">対象明細がありません。</div>';
      }
      const rows = items.map((item) => {
        const disabled = item.status === "INSPECTED" ? " disabled" : "";
        const checked = item.status === "INSPECTED" ? "" : " checked";
        const cert = item.latestInspectionCertUrl
          ? '<a href="' + escapeHtml(item.latestInspectionCertUrl) + '" target="_blank" rel="noreferrer">既存検収書</a>'
          : "未生成";
        const trackingIssue = item.backlogIssueKey
          ? (item.backlogIssueUrl
            ? '<a href="' + escapeHtml(item.backlogIssueUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(item.backlogIssueKey) + '</a>'
            : escapeHtml(item.backlogIssueKey))
          : '<span class="helper">未作成</span>';
      return '<tr data-item-no="' + escapeHtml(String(item.itemNo)) + '">' +
        '<td><input class="bulk-item-check" type="checkbox"' + checked + disabled + ' /></td>' +
          '<td>①' + escapeHtml(String(item.itemNo)) + '</td>' +
          '<td>' + trackingIssue + '</td>' +
          '<td>' + escapeHtml(item.description || "") + '</td>' +
          '<td>' + escapeHtml(item.status || "") + '</td>' +
          '<td>¥' + escapeHtml(formatMoney(item.latestAmount)) + '</td>' +
          '<td>' + escapeHtml(formatDate(item.latestDueDate)) + '</td>' +
          '<td><input class="bulk-amount-input" type="text" value="' + escapeHtml(String(item.latestAmount || "")) + '"' + disabled + ' /></td>' +
          '<td><input class="bulk-note-input" type="text" placeholder="納品備考" value=""' + disabled + ' /></td>' +
          '<td>' + escapeHtml(String(item.deliveryEventCount || 0)) + '</td>' +
          '<td>' + cert + '</td>' +
        '</tr>';
      }).join("");
      return [
        '<table class="table">',
        '<thead><tr><th>対象</th><th>明細</th><th>管理課題</th><th>成果物名</th><th>状態</th><th>明細金額</th><th>納期</th><th>今回納品金額</th><th>納品備考</th><th>納品回数</th><th>検収書</th></tr></thead>',
        '<tbody>' + rows + '</tbody>',
        '</table>'
      ].join("");
    }

    function renderBulkResults(results) {
      if (!results.length) {
        return "";
      }
      return results.map((item) => {
        const issue = item.issueUrl
          ? '<a href="' + escapeHtml(item.issueUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(item.issueKey) + '</a>'
          : escapeHtml(item.issueKey);
        return [
          "・課題 " + issue + " / 明細 ①" + escapeHtml(String(item.itemNo)) + " / " + escapeHtml(item.description || ""),
          " / 納品金額 ¥" + escapeHtml(formatMoney(item.deliveredAmount)),
          item.statusUpdatedTo ? " / 状態更新 " + escapeHtml(item.statusUpdatedTo) : "",
          item.inspectionCert ? " / 検収書 " + renderLink(item.inspectionCert) : "",
          item.paymentNotice ? " / 支払通知書 " + renderLink(item.paymentNotice) : "",
        ].join("");
      }).join("<br>");
    }

    function renderBulkFailures(results) {
      if (!results.length) {
        return "";
      }
      return [
        "<strong>要確認の課題</strong>",
        results.map((item) => {
          const issue = item.issueKey
            ? (item.issueUrl
              ? '<a href="' + escapeHtml(item.issueUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(item.issueKey) + '</a>'
              : escapeHtml(item.issueKey))
            : "未起票";
          return [
            "・課題 " + issue + " / 明細 " + (item.itemNo ? "①" + escapeHtml(String(item.itemNo)) : "-") + " / " + escapeHtml(item.description || ""),
            item.deliveredAmount ? " / 納品金額 ¥" + escapeHtml(formatMoney(item.deliveredAmount)) : "",
            item.inspectionCert ? " / 検収書 " + renderLink(item.inspectionCert) : "",
            item.paymentNotice ? " / 支払通知書 " + renderLink(item.paymentNotice) : "",
            " / エラー: " + escapeHtml(item.error || "不明なエラー"),
          ].join("");
        }).join("<br>"),
      ].join("<br>");
    }

    function renderPaymentCondition(condition) {
      return [
        "締め日 " + escapeHtml(condition.closingDay || "末日"),
        " / 支払月オフセット " + escapeHtml(String(condition.paymentOffset || "1")),
        " / 支払日 " + escapeHtml(condition.paymentDay || "末日"),
        " / 検収期間 " + escapeHtml(String(condition.inspectionDays || 7)) + "日",
        " / 税率 " + escapeHtml(String(condition.taxRate || 10)) + "%"
      ].join("");
    }

    function renderGeneratedDocuments(documents) {
      return documents.map((doc) => {
        const href = doc.url || doc.localPath || "";
        const label = doc.name || href;
        if (!href) {
          return "・" + escapeHtml(label);
        }
        return '・<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + '</a>';
      }).join("<br>");
    }

    function renderWarnings(warnings) {
      const hasStop = warnings.some((warning) => warning.level === "stop");
      const summary = hasStop
        ? '<div class="warning-summary warning-stop">停止項目があります。解消してから生成してください。</div>'
        : '<div class="warning-summary warning-warn">注意項目のみです。内容を確認したうえで生成できます。</div>';
      const lines = warnings.map((warning) => {
        const prefix = warning.level === "stop" ? "[停止]" : "[注意]";
        const className = warning.level === "stop" ? "warning-stop" : "warning-warn";
        return '<div class="warning-line ' + className + '">' + prefix + " " + escapeHtml(warning.message || "") + '</div>';
      }).join("");
      return summary + lines;
    }

    function formatMoney(value) {
      const numeric = Number(value || 0);
      return Number.isFinite(numeric) ? numeric.toLocaleString("ja-JP") : "0";
    }

    function formatDate(value) {
      if (!value) return "";
      return String(value).slice(0, 10);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }
  </script>
</body>
</html>`;
}

function buildContractAdminHtml(): string {
  const fieldDefinitions = JSON.stringify(CONTRACT_DRAFT_FIELDS);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>契約書生成</title>
  <style>${sharedAdminCss()}</style>
</head>
<body>
  ${buildAdminNav("contracts")}
  <div class="wrap">
  ${buildCategorySwitchHtml("Contracts", "契約管理の関連画面", "契約本文の生成、押印管理、課題キー起点の確認をこのカテゴリでまとめます。", [
    { href: "/admin/contracts", label: "契約管理トップ", description: "契約関連の入口を確認", active: false },
    { href: "/admin/workflow/contracts", label: "契約書生成", description: "本文プレビュー、保存、文書生成", active: true },
    { href: "/admin/workflow/stamp", label: "押印管理", description: "押印依頼、方式更新、完了登録", active: false },
    { href: "/admin", label: "ダッシュボード", description: "課題キーランチャーや優先案件へ戻る", active: false },
  ])}
  </div>
  <main class="shell">
    <section class="card">
      <h1>契約書編集・生成</h1>
      <p class="helper">Slack で起票された契約課題を読み込み、Backlog と DB の既定値を確認しながら下書きを保存し、指定Driveへ文書を出力します。</p>
      <div class="summary-box">運用: Slack → Backlog 起票 → この画面で確認・編集 → 文書生成 → Backlog ステータス更新 → 後続フローへ進行</div>
      <div class="sample">
        サンプル確認の順番: 1. 課題キーを入れて「条件を確認」 2. 停止項目を埋める 3. 「文面プレビュー」 4. 「下書きを保存」 5. 「文書を生成」 6. 生成サマリーと次アクションを確認
      </div>
      <div class="row">
        <label>最近の契約課題</label>
        <div id="recentIssues" class="chip-list"><span class="helper">読み込み中...</span></div>
      </div>
      <div class="row">
        <label>要修正の契約課題</label>
        <div id="attentionIssues" class="chip-list"><span class="helper">読み込み中...</span></div>
      </div>
      <div class="row">
        <label for="issueKey">契約課題キー</label>
        <input id="issueKey" type="text" placeholder="LEGAL-123" />
      </div>
      <div class="actions">
        <button id="previewBtn" type="button" class="ghost">条件を確認</button>
        <button id="preflightBtn" type="button" class="ghost">生成前チェックを再実行</button>
        <button id="renderPreviewBtn" type="button" class="ghost">文面プレビュー</button>
        <button id="saveBtn" type="button" class="ghost">下書きを保存</button>
        <button id="generateBtn" type="button">文書を生成</button>
      </div>
      <div id="status" class="status"></div>
      <div id="result" class="helper"></div>
    </section>
    <section class="card">
      <h2 id="editorTitle">文書編集データ</h2>
      <p id="editorSummary" class="helper">Backlog と DB から補完した値が初期表示されます。必要な項目だけ編集して保存してください。</p>
      <div id="editorFlow" class="summary-box">課題を読み込むと、この文書種別の手順を表示します。</div>
      <div id="editorMeta" class="sample">課題を読み込むと、編集元の情報と下書き更新日時を表示します。</div>
      <div id="editorSections"></div>
    </section>
    <section class="card">
      <h2>生成前チェック</h2>
      <p class="helper">契約書生成の主な工程を段階ごとに確認します。停止項目がある場合は生成前に解消してください。</p>
      <div id="preflightSummary" class="summary-box">課題を読み込むと、生成前チェックを表示します。</div>
      <div id="preflightSteps" class="preflight-grid"></div>
    </section>
    <section class="card">
      <h2>文面プレビュー</h2>
      <p class="helper">Drive 出力の前に、現在の下書き値で HTML レンダリングした文面を確認できます。</p>
      <div id="renderPreviewMeta" class="sample">プレビューを生成すると、想定ファイル名と保存先を表示します。</div>
      <div id="renderPreviewTabs" class="chip-list"></div>
      <iframe id="renderPreviewFrame" title="文面プレビュー" style="width:100%; min-height:900px; border:1px solid var(--line); background:#fff;"></iframe>
    </section>
  </main>
  <script>
    const fieldDefinitions = ${fieldDefinitions};
    const issueKey = document.getElementById("issueKey");
    const previewBtn = document.getElementById("previewBtn");
    const preflightBtn = document.getElementById("preflightBtn");
    const renderPreviewBtn = document.getElementById("renderPreviewBtn");
    const saveBtn = document.getElementById("saveBtn");
    const generateBtn = document.getElementById("generateBtn");
    const status = document.getElementById("status");
    const result = document.getElementById("result");
    const editorTitle = document.getElementById("editorTitle");
    const editorSummary = document.getElementById("editorSummary");
    const editorFlow = document.getElementById("editorFlow");
    const editorMeta = document.getElementById("editorMeta");
    const editorSections = document.getElementById("editorSections");
    const preflightSummary = document.getElementById("preflightSummary");
    const preflightSteps = document.getElementById("preflightSteps");
    const renderPreviewMeta = document.getElementById("renderPreviewMeta");
    const renderPreviewTabs = document.getElementById("renderPreviewTabs");
    const renderPreviewFrame = document.getElementById("renderPreviewFrame");
    const recentIssues = document.getElementById("recentIssues");
    const attentionIssues = document.getElementById("attentionIssues");
    const params = new URLSearchParams(window.location.search);
    let latestPreviewDocuments = [];

    renderEditor({}, fieldDefinitions.map((field) => field.key));
    renderPreviewTabs.innerHTML = '<span class="helper">課題を読み込んで「文面プレビュー」を押すと、ここに文書プレビューを表示します。</span>';
    renderPreviewMeta.textContent = "プレビューを生成すると、想定ファイル名と保存先を表示します。";
    renderPreviewFrame.srcdoc = "<html><body style='font-family:sans-serif;padding:24px;color:#6a6258;'>ここに文面プレビューが表示されます。</body></html>";
    loadRecentIssues();
    loadAttentionIssues();
    if (params.get("issueKey")) {
      issueKey.value = String(params.get("issueKey") || "").trim().toUpperCase();
      if (issueKey.value) {
        previewBtn.click();
      }
    }

    previewBtn.addEventListener("click", async () => {
      status.className = "status";
      status.textContent = "確認中...";
      result.innerHTML = "";
      preflightSummary.className = "summary-box";
      preflightSummary.textContent = "生成前チェックを更新しています...";
      preflightSteps.innerHTML = "";
      const response = await fetch("/admin/api/workflow/contracts/preview?issueKey=" + encodeURIComponent(issueKey.value));
      const payload = await response.json();
      if (!payload.ok) {
        status.className = "status error";
        status.textContent = payload.error || "確認に失敗しました。";
        preflightSummary.className = "summary-box";
        preflightSummary.innerHTML = '<div class="warning-summary warning-stop">生成前チェックを取得できませんでした。</div>';
        preflightSteps.innerHTML = "";
        return;
      }
      renderEditorGuide(payload.editorGuide);
      renderEditor(payload.draft || {}, payload.visibleFieldKeys || fieldDefinitions.map((field) => field.key));
      renderEditorMeta(payload);
      renderContractPreflight(payload.preflight);
      status.className = "status success";
      status.textContent = "条件を確認しました。";
      result.innerHTML = [
        "<strong>契約課題:</strong> " + escapeHtml(payload.issueKey),
        payload.issueTypeName ? "<br><strong>課題タイプ:</strong> " + escapeHtml(payload.issueTypeName) : "",
        payload.statusName ? "<br><strong>状態:</strong> " + escapeHtml(payload.statusName) : "",
        "<br><strong>件名:</strong> " + escapeHtml(payload.summary || ""),
        "<br><strong>取得カスタム属性数:</strong> " + escapeHtml(String(payload.customFieldCount || 0)),
        payload.vendorSource ? "<br><strong>Vendor補完:</strong> " + escapeHtml(payload.vendorSource.vendorCode + " / " + payload.vendorSource.vendorName) : "",
        payload.staffSource ? "<br><strong>Staff補完:</strong> " + escapeHtml(payload.staffSource.staffName + (payload.staffSource.department ? " / " + payload.staffSource.department : "")) : "",
        payload.moneyConditionSummaries?.length ? "<br><strong>金銭条件サマリー:</strong><br>" + renderMoneyConditionSummaries(payload.moneyConditionSummaries) : "",
        payload.warnings?.length ? "<br><strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings) : "",
        payload.generatedDocuments?.length ? "<br><strong>生成済み文書:</strong><br>" + renderGeneratedDocuments(payload.generatedDocuments) : "",
      ].join("");
    });

    preflightBtn.addEventListener("click", async () => {
      status.className = "status";
      status.textContent = "生成前チェックを再実行中...";
      result.innerHTML = "";
      preflightSummary.className = "summary-box";
      preflightSummary.textContent = "編集中の値で再確認しています...";
      preflightSteps.innerHTML = "";
      const response = await fetch("/admin/api/workflow/contracts/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey: issueKey.value, draft: collectDraft() }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        status.className = "status error";
        status.textContent = payload.error || "生成前チェックの再実行に失敗しました。";
        preflightSummary.className = "summary-box";
        preflightSummary.innerHTML = '<div class="warning-summary warning-stop">生成前チェックを更新できませんでした。</div>';
        preflightSteps.innerHTML = "";
        return;
      }
      renderContractPreflight(payload.preflight);
      status.className = payload.preflight?.overallStatus === "stop" ? "status error" : "status success";
      status.textContent = payload.preflight?.overallStatus === "stop"
        ? "停止項目があります。"
        : "生成前チェックを更新しました。";
      if (payload.warnings?.length) {
        result.innerHTML = "<strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings);
      }
    });

    saveBtn.addEventListener("click", async () => {
      status.className = "status";
      status.textContent = "保存中...";
      const response = await fetch("/admin/api/workflow/contracts/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey: issueKey.value, draft: collectDraft() }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        status.className = "status error";
        status.textContent = payload.error || "保存に失敗しました。";
        return;
      }
      status.className = "status success";
      status.textContent = "下書きを保存しました。";
      editorMeta.innerHTML = "下書き更新日時: <strong>" + escapeHtml(formatDateTime(payload.draftUpdatedAt)) + "</strong>";
    });

    renderPreviewBtn.addEventListener("click", async () => {
      status.className = "status";
      status.textContent = "プレビュー生成中...";
      renderPreviewMeta.textContent = "プレビュー情報を更新しています...";
      const response = await fetch("/admin/api/workflow/contracts/render-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey: issueKey.value, draft: collectDraft() }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        status.className = "status error";
        status.textContent = payload.error || "プレビュー生成に失敗しました。";
        renderPreviewMeta.innerHTML = '<div class="warning-summary warning-stop">プレビュー情報を取得できませんでした。</div>';
        if (payload.warnings?.length) {
          result.innerHTML = "<strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings);
        }
        return;
      }
      latestPreviewDocuments = payload.previews || [];
      renderDocumentPreviewTabs(latestPreviewDocuments);
      renderDocumentPreviewMeta(payload.previewReport, latestPreviewDocuments);
      status.className = "status success";
      status.textContent = "文面プレビューを更新しました。";
      if (payload.warnings?.length) {
        result.innerHTML = "<strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings);
      }
    });

    generateBtn.addEventListener("click", async () => {
      status.className = "status";
      status.textContent = "生成中...";
      result.innerHTML = "";
      const response = await fetch("/admin/api/workflow/contracts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey: issueKey.value, draft: collectDraft() }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        status.className = "status error";
        status.textContent = payload.error || "生成に失敗しました。";
        if (payload.warnings?.length) {
          result.innerHTML = "<strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings);
        }
        return;
      }
      status.className = "status success";
      status.textContent = "文書生成が完了しました。";
      result.innerHTML = [
        "<strong>契約課題:</strong> " + escapeHtml(payload.issueKey),
        payload.issueTypeName ? "<br><strong>課題タイプ:</strong> " + escapeHtml(payload.issueTypeName) : "",
        payload.generationReport ? "<br><strong>生成サマリー:</strong><br>" + renderContractGenerationReport(payload.generationReport) : "",
        payload.statusUpdatedTo ? "<br><strong>Backlog状態更新:</strong> " + escapeHtml(payload.statusUpdatedTo) : "",
        payload.nextActions?.length ? "<br><strong>次に見ること:</strong><br>" + renderNextActions(payload.nextActions) : "",
        payload.generatedDocuments?.length ? "<br><strong>生成済み文書:</strong><br>" + renderGeneratedDocuments(payload.generatedDocuments) : "<br>生成済み文書はありません。",
      ].join("");
    });

    function renderEditor(draft, visibleFieldKeys) {
      const visibleSet = new Set(visibleFieldKeys || []);
      const sections = {};
      for (const field of fieldDefinitions.filter((item) => visibleSet.has(item.key))) {
        if (!sections[field.section]) sections[field.section] = [];
        sections[field.section].push(field);
      }
      editorSections.innerHTML = Object.entries(sections).map(([section, fields]) => {
        return '<section class="panel" style="margin-top:16px;">'
          + '<h2>' + escapeHtml(section) + '</h2>'
          + fields.map((field) => renderField(field, draft[field.key] || "")).join("")
          + '</section>';
      }).join("");
    }

    function renderField(field, value) {
      const id = "draft_" + field.key;
      return '<div class="row">'
        + '<label for="' + escapeHtml(id) + '">' + escapeHtml(field.label) + '</label>'
        + (field.multiline
          ? '<textarea id="' + escapeHtml(id) + '" data-draft-key="' + escapeHtml(field.key) + '">' + escapeHtml(value) + '</textarea>'
          : '<input id="' + escapeHtml(id) + '" type="text" data-draft-key="' + escapeHtml(field.key) + '" value="' + escapeHtml(value) + '" />')
        + '</div>';
    }

    function collectDraft() {
      const draft = {};
      document.querySelectorAll("[data-draft-key]").forEach((element) => {
        draft[element.dataset.draftKey] = element.value || "";
      });
      return draft;
    }

    function renderEditorMeta(payload) {
      const rows = [
        "件名: <strong>" + escapeHtml(payload.summary || "") + "</strong>",
        payload.issueTypeName ? "課題タイプ: <strong>" + escapeHtml(payload.issueTypeName) + "</strong>" : "",
        payload.statusName ? "現在状態: <strong>" + escapeHtml(payload.statusName) + "</strong>" : "",
        payload.draftUpdatedAt ? "下書き更新日時: <strong>" + escapeHtml(formatDateTime(payload.draftUpdatedAt)) + "</strong>" : "下書き更新日時: 未保存",
      ].filter(Boolean);
      editorMeta.innerHTML = rows.join("<br>");
    }

    function renderEditorGuide(guide) {
      if (!guide) return;
      editorTitle.textContent = guide.title || "文書編集データ";
      editorSummary.textContent = guide.summary || "";
      editorFlow.textContent = guide.flow || "";
    }

    function renderContractPreflight(preflight) {
      if (!preflight || !Array.isArray(preflight.steps)) {
        preflightSummary.textContent = "生成前チェックを表示できません。";
        preflightSteps.innerHTML = "";
        return;
      }
      const summaryClass = preflight.overallStatus === "stop"
        ? "warning-summary warning-stop"
        : preflight.overallStatus === "warn"
          ? "warning-summary warning-warn"
          : "warning-summary preflight-ready";
      preflightSummary.className = "summary-box";
      preflightSummary.innerHTML = '<div class="' + summaryClass + '">' + escapeHtml(preflight.summary || "") + '</div>';
      preflightSteps.innerHTML = preflight.steps.map((step) => {
        const badgeClass = step.status === "stop"
          ? "warning-stop"
          : step.status === "warn"
            ? "warning-warn"
            : "preflight-ready";
        const badgeLabel = step.status === "stop" ? "停止" : step.status === "warn" ? "注意" : "OK";
        return '<section class="panel preflight-step">'
          + '<div class="preflight-head">'
          + '<strong>' + escapeHtml(step.label || step.key || "check") + '</strong>'
          + '<span class="preflight-badge ' + badgeClass + '">' + badgeLabel + '</span>'
          + '</div>'
          + '<div class="helper">' + escapeHtml(step.detail || "") + '</div>'
          + '</section>';
      }).join("");
    }

    function focusDraftField(fieldKey) {
      if (!fieldKey) return;
      const target = document.getElementById("draft_" + fieldKey);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => {
        target.focus();
        if (typeof target.select === "function") {
          target.select();
        }
      }, 120);
    }

    function renderGeneratedDocuments(documents) {
      return documents.map((doc) => {
        const href = doc.url || doc.localPath || "";
        const label = doc.name || href;
        if (!href) return "・" + escapeHtml(label);
        return '・<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + '</a>';
      }).join("<br>");
    }

    function renderContractGenerationReport(report) {
      const lines = [
        report.summary ? "・" + escapeHtml(report.summary) : "",
        report.driveFolderLabel ? "・保存先: " + escapeHtml(report.driveFolderLabel + " (" + report.driveFolderKey + ")") : "",
        "・Drive保存: " + escapeHtml(report.driveEnabled ? "有効" : "無効または未設定"),
        "・Drive出力数: " + escapeHtml(String(report.driveDocumentCount || 0)),
        "・ローカル出力数: " + escapeHtml(String(report.localDocumentCount || 0)),
      ].filter(Boolean);
      return lines.join("<br>");
    }

    function renderNextActions(actions) {
      return (actions || []).map((action) => "・" + escapeHtml(action)).join("<br>");
    }

    function renderMoneyConditionSummaries(items) {
      return items.map((item) => {
        const parts = [
          item.heading ? "見出し: " + escapeHtml(item.heading) : "",
          item.calcTypeLabel ? "計算: " + escapeHtml(item.calcTypeLabel) : "",
          item.parsedRate != null ? "料率: " + escapeHtml((item.parsedRate * 100).toFixed(2).replace(/\\.00$/, "") + "%") : "",
          item.parsedDistributionRate != null ? "分配率: " + escapeHtml((item.parsedDistributionRate * 100).toFixed(2).replace(/\\.00$/, "") + "%") : "",
          item.parsedFixedAmount != null ? "固定額: ¥" + escapeHtml(String(item.parsedFixedAmount)) : "",
          item.parsedMgAmount != null ? "MG/AG: ¥" + escapeHtml(String(item.parsedMgAmount)) : "",
          item.paymentTerms ? "支払条件: " + escapeHtml(item.paymentTerms) : "",
        ].filter(Boolean);
        return "・" + parts.join(" / ");
      }).join("<br>");
    }

    function renderDocumentPreviewTabs(previews) {
      if (!previews || previews.length === 0) {
        renderPreviewTabs.innerHTML = '<span class="helper">プレビュー対象の文書がありません。</span>';
        renderPreviewMeta.textContent = "プレビュー対象の文書がありません。";
        renderPreviewFrame.srcdoc = "<html><body style='font-family:sans-serif;padding:24px;color:#6a6258;'>プレビュー対象の文書がありません。</body></html>";
        return;
      }
      renderPreviewTabs.innerHTML = previews.map((preview, index) => {
        const label = preview.templateKey || ("doc_" + (index + 1));
        return '<button type="button" class="chip" data-preview-index="' + index + '">' + escapeHtml(label) + '</button>';
      }).join("");
      renderPreviewTabs.querySelectorAll("[data-preview-index]").forEach((button) => {
        button.addEventListener("click", () => {
          const index = Number(button.getAttribute("data-preview-index") || "0");
          openDocumentPreview(index);
        });
      });
      openDocumentPreview(0);
    }

    function renderDocumentPreviewMeta(report, previews) {
      const lines = [];
      if (report?.documentCount != null) {
        lines.push("想定文書数: " + escapeHtml(String(report.documentCount)));
      }
      if (Array.isArray(report?.driveFolderLabels) && report.driveFolderLabels.length) {
        lines.push("保存先候補: " + escapeHtml(report.driveFolderLabels.join(", ")));
      }
      lines.push("Drive保存: " + escapeHtml(report?.driveEnabled ? "有効" : "無効または未設定"));
      if (Array.isArray(previews) && previews.length) {
        lines.push(previews.map((preview) => {
          const destination = preview.driveFolderLabel
            ? " / " + preview.driveFolderLabel + (preview.driveFolderKey ? " (" + preview.driveFolderKey + ")" : "")
            : "";
          return "・" + (preview.outputBasename || preview.templateKey || "document") + destination;
        }).map(escapeHtml).join("<br>"));
      }
      renderPreviewMeta.innerHTML = lines.join("<br>");
    }

    async function loadRecentIssues() {
      recentIssues.innerHTML = '<span class="helper">読み込み中...</span>';
      const response = await fetch("/admin/api/workflow/contracts/recent");
      const payload = await response.json();
      if (!payload.ok) {
        recentIssues.innerHTML = '<span class="helper">最近の課題を取得できませんでした。</span>';
        return;
      }
      if (!payload.issues?.length) {
        recentIssues.innerHTML = '<span class="helper">対象の契約課題はまだありません。</span>';
        return;
      }
      recentIssues.innerHTML = payload.issues.map((item) => {
        const label = item.issueKey + " / " + (item.issueTypeName || "契約") + " / " + (item.summary || "");
        return '<button type="button" class="chip" data-issue-key="' + escapeHtml(item.issueKey) + '">' + escapeHtml(label) + '</button>';
      }).join("");
      recentIssues.querySelectorAll("[data-issue-key]").forEach((button) => {
        button.addEventListener("click", () => {
          issueKey.value = button.getAttribute("data-issue-key") || "";
          previewBtn.click();
        });
      });
    }

    async function loadAttentionIssues() {
      attentionIssues.innerHTML = '<span class="helper">読み込み中...</span>';
      const response = await fetch("/admin/api/workflow/contracts/attention");
      const payload = await response.json();
      if (!payload.ok) {
        attentionIssues.innerHTML = '<span class="helper">要修正の契約課題を取得できませんでした。</span>';
        return;
      }
      if (!payload.issues?.length) {
        attentionIssues.innerHTML = '<span class="helper">要修正の契約課題はありません。</span>';
        return;
      }
      attentionIssues.innerHTML = payload.issues.map((item) => {
        const prefix = item.severity === "stop" ? "[停止]" : "[注意]";
        const count = item.blockingCount > 0
          ? "停止 " + item.blockingCount + " 件"
          : "注意 " + item.warningCount + " 件";
        const label = prefix + " " + item.issueKey + " / " + count + " / " + (item.summary || "");
        return '<button type="button" class="chip" data-issue-key="' + escapeHtml(item.issueKey) + '">' + escapeHtml(label) + '</button>';
      }).join("");
      attentionIssues.querySelectorAll("[data-issue-key]").forEach((button) => {
        button.addEventListener("click", () => {
          issueKey.value = button.getAttribute("data-issue-key") || "";
          previewBtn.click();
        });
      });
    }

    function openDocumentPreview(index) {
      const preview = latestPreviewDocuments[index];
      if (!preview) return;
      renderPreviewFrame.srcdoc = preview.html || "<html><body>Preview unavailable</body></html>";
    }

    function renderWarnings(warnings) {
      const hasStop = warnings.some((warning) => warning.level === "stop");
      const summary = hasStop
        ? '<div class="warning-summary warning-stop">停止項目があります。内容を確認してください。</div>'
        : '<div class="warning-summary warning-warn">注意項目のみです。内容を確認したうえで生成できます。</div>';
      const lines = warnings.map((warning) => {
        const prefix = warning.level === "stop" ? "[停止]" : "[注意]";
        const className = warning.level === "stop" ? "warning-stop" : "warning-warn";
        const action = warning.fieldKey
          ? ' <button type="button" class="link-button inline-action" data-warning-field="' + escapeHtml(warning.fieldKey) + '">該当欄へ移動</button>'
          : "";
        return '<div class="warning-line ' + className + '">' + prefix + " " + escapeHtml(warning.message || "") + action + '</div>';
      }).join("");
      return summary + lines;
    }

    function formatDateTime(value) {
      if (!value) return "未保存";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString("ja-JP");
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    document.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-warning-field]");
      if (!trigger) return;
      focusDraftField(trigger.getAttribute("data-warning-field"));
    });
  </script>
</body>
</html>`;
}

function buildRoyaltyAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>利用許諾料計算</title>
  <style>${sharedAdminCss()}</style>
</head>
<body>
  ${buildAdminNav("royalty")}
  <div class="wrap">
  ${buildCategorySwitchHtml("Royalty", "利用許諾料の関連画面", "製造ベースと売上報告ベースの計算、計算書出力、支払通知をこのカテゴリで扱います。", [
    { href: "/admin/royalty", label: "利用許諾料トップ", description: "計算カテゴリの入口", active: false },
    { href: "/admin/workflow/royalty", label: "利用許諾料計算", description: "計算プレビューと帳票生成", active: true },
    { href: "/admin", label: "ダッシュボード", description: "Backlog 期限や要修正案件の全体確認", active: false },
  ])}
  </div>
  <main class="shell">
    <section class="card">
      <h1>利用許諾料計算</h1>
      <p class="helper">製造ベースまたは売上報告ベースの課題キーから、利用許諾料計算書と支払通知書をローカル生成します。DBに保存済みのロイヤリティ計算結果・ライセンス情報も確認できます。</p>
      <div class="summary-box">手順: まず「条件を確認」で停止/注意を確認し、支払先情報と計算条件に問題がなければ「帳票を生成」を実行してください。</div>
      <div class="row">
        <label>要修正のロイヤリティ課題</label>
        <div id="royaltyAttentionIssues" class="chip-list"><span class="helper">読み込み中...</span></div>
      </div>
      <div class="row">
        <label for="issueKey">ロイヤリティ対象課題キー</label>
        <input id="issueKey" type="text" placeholder="LEGAL-456" />
      </div>
      <div class="actions">
        <button id="previewBtn" type="button" class="ghost">条件を確認</button>
        <button id="generateBtn" type="button">帳票を生成</button>
      </div>
      <div id="status" class="status"></div>
      <div id="result" class="helper"></div>
    </section>
    <section class="card">
      <h2>生成前チェック</h2>
      <p class="helper">利用許諾料計算の主な工程を段階ごとに確認します。停止項目がある場合は先に解消してください。</p>
      <div id="royaltyPreflightSummary" class="summary-box">課題を読み込むと、生成前チェックを表示します。</div>
      <div id="royaltyPreflightSteps" class="preflight-grid"></div>
    </section>
  </main>
  <script>
    const issueKey = document.getElementById("issueKey");
    const previewBtn = document.getElementById("previewBtn");
    const generateBtn = document.getElementById("generateBtn");
    const status = document.getElementById("status");
    const result = document.getElementById("result");
    const royaltyAttentionIssues = document.getElementById("royaltyAttentionIssues");
    const royaltyPreflightSummary = document.getElementById("royaltyPreflightSummary");
    const royaltyPreflightSteps = document.getElementById("royaltyPreflightSteps");
    const params = new URLSearchParams(window.location.search);
    loadRoyaltyAttentionIssues();

    if (params.get("issueKey")) {
      issueKey.value = String(params.get("issueKey") || "").trim().toUpperCase();
    }

    previewBtn.addEventListener("click", async () => {
      status.className = "status";
      status.textContent = "確認中...";
      result.innerHTML = "";
      const response = await fetch("/admin/api/workflow/royalty/preview?issueKey=" + encodeURIComponent(issueKey.value));
      const payload = await response.json();
      if (!payload.ok) {
        status.className = "status error";
        status.textContent = payload.error || "確認に失敗しました。";
        royaltyPreflightSummary.innerHTML = '<div class="warning-summary warning-stop">生成前チェックを取得できませんでした。</div>';
        royaltyPreflightSteps.innerHTML = "";
        if (payload.warnings?.length) {
          result.innerHTML = "<strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings);
        }
        return;
      }
      renderRoyaltyPreflight(payload.preflight);
      status.className = "status success";
      status.textContent = "条件を確認しました。";
      result.innerHTML = [
        "<strong>製造案件:</strong> " + escapeHtml(payload.issueKey),
        payload.licenseIssueKey ? "<br><strong>紐付けライセンス課題:</strong> " + escapeHtml(payload.licenseIssueKey) : "",
        payload.productName ? "<br><strong>製品名:</strong> " + escapeHtml(payload.productName) : "",
        payload.edition ? "<br><strong>版:</strong> " + escapeHtml(payload.edition) : "",
        payload.completionDate ? "<br><strong>製造完了日:</strong> " + escapeHtml(payload.completionDate) : "",
        payload.quantity ? "<br><strong>製造数量:</strong> " + escapeHtml(payload.quantity) : "",
        payload.sampleQuantity ? "<br><strong>サンプル数:</strong> " + escapeHtml(payload.sampleQuantity) : "",
        payload.msrp ? "<br><strong>MSRP:</strong> " + escapeHtml(payload.msrp) : "",
        payload.notes ? "<br><strong>備考:</strong> " + escapeHtml(payload.notes) : "",
        payload.resolvedLicenseCondition ? "<br><strong>解釈した計算条件:</strong> " + renderResolvedRoyaltyCondition(payload.resolvedLicenseCondition) : "",
        "<br><strong>DB製造案件:</strong> " + (payload.hasManufacturingEvent ? "あり" : "未登録"),
        payload.manufacturingEvent ? "<br><strong>DB要約:</strong> " + renderManufacturingEvent(payload.manufacturingEvent) : "",
        payload.manufacturingEvent ? "<br><strong>支払先情報:</strong> " + renderPaymentRecipient(payload.manufacturingEvent) : "",
        payload.warnings?.length ? "<br><strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings) : "",
        payload.generatedDocuments?.length ? "<br><strong>生成済み文書:</strong><br>" + renderGeneratedDocuments(payload.generatedDocuments) : "",
      ].join("");
    });

    generateBtn.addEventListener("click", async () => {
      status.className = "status";
      status.textContent = "生成中...";
      result.innerHTML = "";
      const response = await fetch("/admin/api/workflow/royalty/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey: issueKey.value }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        status.className = "status error";
        status.textContent = payload.error || "生成に失敗しました。";
        if (payload.warnings?.length) {
          result.innerHTML = "<strong>事前チェック:</strong><br>" + renderWarnings(payload.warnings);
        }
        return;
      }
      status.className = "status success";
      status.textContent = "帳票生成が完了しました。";
      result.innerHTML = [
        "<strong>製造案件:</strong> " + escapeHtml(payload.issueKey),
        payload.licenseIssueKey ? "<br><strong>紐付けライセンス課題:</strong> " + escapeHtml(payload.licenseIssueKey) : "",
        payload.generationReport ? "<br><strong>生成サマリー:</strong> " + renderRoyaltyGenerationReport(payload.generationReport) : "",
        payload.nextActions?.length ? "<br><strong>次に見ること:</strong><br>" + renderNextActions(payload.nextActions) : "",
        payload.result ? "<br><strong>計算結果:</strong> " + renderRoyaltyResult(payload.result) : "",
        "<br><strong>利用許諾料計算書:</strong> " + renderLink(payload.royaltyReport),
        "<br><strong>支払通知書:</strong> " + (payload.paymentNotice ? renderLink(payload.paymentNotice) : "未発行"),
      ].join("");
      await loadRoyaltyAttentionIssues();
    });

    if (issueKey.value) {
      previewBtn.click();
    }

    async function loadRoyaltyAttentionIssues() {
      royaltyAttentionIssues.innerHTML = '<span class="helper">読み込み中...</span>';
      const response = await fetch("/admin/api/workflow/royalty/attention");
      const payload = await response.json();
      if (!payload.ok) {
        royaltyAttentionIssues.innerHTML = '<span class="helper">要修正のロイヤリティ課題を取得できませんでした。</span>';
        return;
      }
      if (!payload.issues?.length) {
        royaltyAttentionIssues.innerHTML = '<span class="helper">要修正のロイヤリティ課題はありません。</span>';
        return;
      }
      royaltyAttentionIssues.innerHTML = payload.issues.map((item) => {
        const prefix = item.severity === "stop" ? "[停止]" : "[注意]";
        const count = item.blockingCount > 0
          ? "停止 " + item.blockingCount + " 件"
          : "注意 " + item.warningCount + " 件";
        const label = prefix + " " + item.issueKey + " / " + count + " / " + (item.summary || "");
        return '<button type="button" class="chip" data-royalty-issue-key="' + escapeHtml(item.issueKey) + '">' + escapeHtml(label) + '</button>';
      }).join("");
      royaltyAttentionIssues.querySelectorAll("[data-royalty-issue-key]").forEach((button) => {
        button.addEventListener("click", () => {
          issueKey.value = button.getAttribute("data-royalty-issue-key") || "";
          previewBtn.click();
        });
      });
    }

    function renderLink(file) {
      const href = file.driveUrl || file.localPath;
      return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer">' + escapeHtml(file.filename || href) + '</a>';
    }

    function renderGeneratedDocuments(documents) {
      return documents.map((doc) => {
        const href = doc.url || doc.localPath || "";
        const label = doc.name || href;
        if (!href) {
          return "・" + escapeHtml(label);
        }
        return '・<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + '</a>';
      }).join("<br>");
    }

    function renderManufacturingEvent(event) {
      return [
        event.licensor ? "ライセンサー " + escapeHtml(event.licensor) : "",
        event.ledgerId ? " / 台帳ID " + escapeHtml(event.ledgerId) : "",
        event.originalWork ? " / 原著作物 " + escapeHtml(event.originalWork) : "",
        event.grossRoyalty != null ? " / グロス " + escapeHtml(String(event.grossRoyalty)) : "",
        event.actualRoyalty != null ? " / 税抜支払 " + escapeHtml(String(event.actualRoyalty)) : "",
        event.totalPayment != null ? " / 税込支払 " + escapeHtml(String(event.totalPayment)) : "",
        event.paymentStatus ? " / 支払状態 " + escapeHtml(String(event.paymentStatus)) : "",
        event.paymentDueDate ? " / 支払期限 " + escapeHtml(new Date(event.paymentDueDate).toLocaleDateString("ja-JP")) : "",
      ].join("");
    }

    function renderPaymentRecipient(event) {
      return [
        event.licensorInvoiceNum ? "登録番号 " + escapeHtml(event.licensorInvoiceNum) : "登録番号 未設定",
        event.bankName ? " / " + escapeHtml(event.bankName) : "",
        event.branchName ? " " + escapeHtml(event.branchName) : "",
        event.accountType ? " " + escapeHtml(event.accountType) : "",
        event.accountNo ? " " + escapeHtml(event.accountNo) : "",
        event.accountName ? " " + escapeHtml(event.accountName) : "",
      ].join("");
    }

    function renderRoyaltyResult(result) {
      return [
        "グロス " + escapeHtml(result.grossRoyaltyStr || ""),
        " / 税抜支払 " + escapeHtml(result.actualRoyaltyStr || ""),
        " / 税込支払 " + escapeHtml(result.totalPaymentStr || ""),
        result.calculationBaseDateRaw ? " / 計算起点 " + escapeHtml(new Date(result.calculationBaseDateRaw).toLocaleDateString("ja-JP")) : "",
        result.reportingDeadlineRaw ? " / 報告期限 " + escapeHtml(new Date(result.reportingDeadlineRaw).toLocaleDateString("ja-JP")) : "",
        result.paymentDueDateRaw ? " / 支払期限 " + escapeHtml(new Date(result.paymentDueDateRaw).toLocaleDateString("ja-JP")) : "",
      ].join("");
    }

    function renderResolvedRoyaltyCondition(condition) {
      return [
        "要求条件 " + escapeHtml(String(condition.requestedConditionNo || 1)),
        " / 採用条件 " + escapeHtml(String(condition.resolvedConditionNo || 1)),
        condition.conditionHeading ? " / 見出し " + escapeHtml(condition.conditionHeading) : "",
        "方式 " + escapeHtml(condition.calcType || ""),
        " / 料率 " + escapeHtml(String(condition.royaltyRate ?? "")),
        condition.distributionRate != null ? " / 分配率 " + escapeHtml(String(condition.distributionRate)) : "",
        " / MG " + escapeHtml(String(condition.mgAmount ?? 0)),
        " / 元データ " + escapeHtml(condition.source === "license_condition1_fallback" ? ("個別利用許諾条件の金銭条件" + String(condition.resolvedConditionNo || 1)) : "専用ロイヤリティ項目"),
      ].join("");
    }

    function renderRoyaltyPreflight(preflight) {
      if (!preflight || !Array.isArray(preflight.steps)) {
        royaltyPreflightSummary.textContent = "生成前チェックを表示できません。";
        royaltyPreflightSteps.innerHTML = "";
        return;
      }
      const summaryClass = preflight.overallStatus === "stop"
        ? "warning-summary warning-stop"
        : preflight.overallStatus === "warn"
          ? "warning-summary warning-warn"
          : "warning-summary preflight-ready";
      royaltyPreflightSummary.innerHTML = '<div class="' + summaryClass + '">' + escapeHtml(preflight.summary || "") + '</div>';
      royaltyPreflightSteps.innerHTML = preflight.steps.map((step) => {
        const badgeClass = step.status === "stop"
          ? "warning-stop"
          : step.status === "warn"
            ? "warning-warn"
            : "preflight-ready";
        const badgeLabel = step.status === "stop" ? "停止" : step.status === "warn" ? "注意" : "OK";
        return '<section class="panel preflight-step">'
          + '<div class="preflight-head">'
          + '<strong>' + escapeHtml(step.label || step.key || "check") + '</strong>'
          + '<span class="preflight-badge ' + badgeClass + '">' + badgeLabel + '</span>'
          + '</div>'
          + '<div class="helper">' + escapeHtml(step.detail || "") + '</div>'
          + '</section>';
      }).join("");
    }

    function renderRoyaltyGenerationReport(report) {
      return [
        "・" + escapeHtml(report.summary || ""),
        "・Drive出力数: " + escapeHtml(String(report.driveDocumentCount || 0)),
        "・ローカル出力数: " + escapeHtml(String(report.localDocumentCount || 0)),
      ].join("<br>");
    }

    function renderWarnings(warnings) {
      const hasStop = warnings.some((warning) => warning.level === "stop");
      const summary = hasStop
        ? '<div class="warning-summary warning-stop">停止項目があります。解消してから生成してください。</div>'
        : '<div class="warning-summary warning-warn">注意項目のみです。内容を確認したうえで生成できます。</div>';
      const lines = warnings.map((warning) => {
        const prefix = warning.level === "stop" ? "[停止]" : "[注意]";
        const className = warning.level === "stop" ? "warning-stop" : "warning-warn";
        return '<div class="warning-line ' + className + '">' + prefix + " " + escapeHtml(warning.message || "") + '</div>';
      }).join("");
      return summary + lines;
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>\"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }
  </script>
</body>
</html>`;
}

type AdminNavKey =
  | "home"
  | "orders"
  | "contracts-hub"
  | "delivery-hub"
  | "royalty-hub"
  | "settings-hub"
  | "tools"
  | "masters"
  | "csv"
  | "mapping"
  | "stamp"
  | "workflow-settings"
  | "request-simulator"
  | "order-single"
  | "contracts"
  | "delivery"
  | "royalty";

function buildAdminNav(_current: AdminNavKey): string {
  const groups = [
    {
      label: "Home",
      title: "ホーム",
      items: [
        { key: "home", href: "/admin", label: "ダッシュボード", description: "全体状況と優先対応を見る", activeKeys: ["home"] },
      ],
    },
    {
      label: "Orders",
      title: "発注管理",
      items: [
        { key: "orders", href: "/admin/orders", label: "発注管理トップ", description: "単体作成と一括取込の入口", activeKeys: ["orders", "csv", "order-single"] },
      ],
    },
    {
      label: "Contracts",
      title: "契約管理",
      items: [
        { key: "contracts-hub", href: "/admin/contracts", label: "契約管理トップ", description: "契約書生成と押印関連の入口", activeKeys: ["contracts-hub", "contracts"] },
      ],
    },
    {
      label: "Delivery",
      title: "納品・検収",
      items: [
        { key: "delivery-hub", href: "/admin/delivery", label: "納品・検収トップ", description: "明細課題更新と検収書作成の入口", activeKeys: ["delivery-hub", "delivery"] },
      ],
    },
    {
      label: "Royalty",
      title: "利用許諾料",
      items: [
        { key: "royalty-hub", href: "/admin/royalty", label: "利用許諾料トップ", description: "計算と支払通知の入口", activeKeys: ["royalty-hub", "royalty"] },
      ],
    },
    {
      label: "Setup",
      title: "マスタ・設定",
      items: [
        { key: "settings-hub", href: "/admin/settings", label: "マスタ・設定トップ", description: "Vendor / Staff と運用設定", activeKeys: ["settings-hub", "masters", "mapping", "workflow-settings"] },
      ],
    },
    {
      label: "Tools",
      title: "管理ツール",
      items: [
        { key: "tools", href: "/admin/tools", label: "管理ツールトップ", description: "申請確認や保守用の画面", activeKeys: ["tools", "request-simulator", "stamp"] },
      ],
    },
  ];

  const navItems = groups.flatMap((group) => group.items.map((item) => ({
    ...item,
    groupLabel: group.label,
    groupTitle: group.title,
  })));

  return `<nav class="sidebar-nav">
    <div class="sidebar-logo">
      <span class="sidebar-logo-icon">⚖️</span>
      <span class="sidebar-logo-text">LegalBridge</span>
    </div>
    <div class="sidebar-nav-items">
      ${groups.map((group) => `
        <div class="sidebar-group">
          <div class="sidebar-group-label">${group.label}</div>
          ${group.items.map((item) => {
            const active = (item.activeKeys ?? [item.key]).includes(_current) ? " sidebar-active" : "";
            return `<a class="sidebar-link${active}" href="${item.href}" title="${item.description}">
              <span class="sidebar-link-icon">${getSidebarIcon(item.key)}</span>
              <span class="sidebar-link-text">${item.label}</span>
            </a>`;
          }).join("")}
        </div>
      `).join("")}
    </div>
  </nav>`;
}

function getSidebarIcon(key: string): string {
  const icons: Record<string, string> = {
    home: "🏠",
    orders: "📋",
    "contracts-hub": "📝",
    "delivery-hub": "📦",
    "royalty-hub": "💰",
    "settings-hub": "⚙️",
    tools: "🔧",
  };
  return icons[key] ?? "📄";
}

function sharedAdminCss(): string {
  return `
    /* =====================================================
       LegalBridge Admin UI - Redesigned CSS
       ===================================================== */
    :root {
      --bg: #f4f6f9;
      --sidebar-bg: #1e2433;
      --sidebar-width: 220px;
      --sidebar-text: rgba(255,255,255,0.72);
      --sidebar-text-active: #fff;
      --sidebar-accent: #4f9b90;
      --panel: #ffffff;
      --panel-border: #e2e8f0;
      --ink: #1a202c;
      --muted: #718096;
      --accent: #2f7f73;
      --accent-hover: #236b61;
      --accent-soft: rgba(47,127,115,0.1);
      --accent-warm: #d98f70;
      --danger: #e53e3e;
      --warning: #dd6b20;
      --success: #38a169;
      --radius-lg: 12px;
      --radius-md: 8px;
      --radius-sm: 6px;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif;
      background: var(--bg);
      color: var(--ink);
      font-size: 14px;
      line-height: 1.6;
      display: flex;
      min-height: 100vh;
    }
    a { color: inherit; }

    /* ===== Sidebar Navigation ===== */
    .sidebar-nav {
      width: var(--sidebar-width);
      min-width: var(--sidebar-width);
      background: var(--sidebar-bg);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      position: fixed;
      top: 0;
      left: 0;
      height: 100vh;
      overflow-y: auto;
      z-index: 100;
    }
    .sidebar-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 20px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      color: white;
      font-weight: 700;
      font-size: 16px;
    }
    .sidebar-logo-icon { font-size: 20px; }
    .sidebar-nav-items {
      flex: 1;
      padding: 12px 0;
      overflow-y: auto;
    }
    .sidebar-group {
      padding: 4px 0;
      margin-bottom: 4px;
    }
    .sidebar-group-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.36);
      padding: 8px 16px 4px;
    }
    .sidebar-link {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 16px;
      color: var(--sidebar-text);
      text-decoration: none;
      border-radius: 0;
      transition: background 0.15s ease, color 0.15s ease;
      font-size: 13.5px;
      white-space: nowrap;
      overflow: hidden;
    }
    .sidebar-link:hover {
      background: rgba(255,255,255,0.08);
      color: #fff;
    }
    .sidebar-link.sidebar-active {
      background: var(--sidebar-accent);
      color: white;
      font-weight: 600;
    }
    .sidebar-link-icon { font-size: 16px; flex-shrink: 0; }
    .sidebar-link-text { overflow: hidden; text-overflow: ellipsis; }

    /* ===== Main Content Area ===== */
    .main-content {
      margin-left: var(--sidebar-width);
      flex: 1;
      min-width: 0;
      padding: 28px;
      max-width: 1200px;
    }
    .wrap {
      margin-left: var(--sidebar-width);
      flex: 1;
      min-width: 0;
      padding: 28px;
    }
    .shell {
      margin-left: var(--sidebar-width);
      flex: 1;
      min-width: 0;
      padding: 28px;
    }

    /* ===== Page Header ===== */
    h1 {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.01em;
      margin-bottom: 6px;
      color: var(--ink);
    }
    h2 {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 12px;
      color: var(--ink);
    }
    h3 {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 10px;
      color: var(--ink);
    }
    .sub, .note { color: var(--muted); line-height: 1.7; }
    .helper { font-size: 13px; color: var(--muted); line-height: 1.6; margin-top: 4px; }
    p.sub { margin-bottom: 20px; }

    /* ===== Category Switch (Breadcrumb-style tabs) ===== */
    .category-switch {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 24px;
      padding: 4px;
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-md);
    }
    .category-switch-link {
      display: inline-flex;
      align-items: center;
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      color: var(--muted);
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .category-switch-link:hover {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .category-switch-link.active-panel-link {
      background: var(--accent);
      color: white;
    }

    /* ===== Status ===== */
    .status {
      margin-top: 12px;
      padding: 10px 14px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      min-height: 20px;
      white-space: pre-wrap;
      color: var(--muted);
    }
    .status.success {
      background: rgba(56, 161, 105, 0.1);
      color: #276749;
      border: 1px solid rgba(56, 161, 105, 0.2);
    }
    .status.error {
      background: rgba(229, 62, 62, 0.08);
      color: #c53030;
      border: 1px solid rgba(229, 62, 62, 0.18);
    }

    /* ===== Grid ===== */
    .grid { display: grid; gap: 20px; align-items: start; }
    .two-col { grid-template-columns: 1fr 1fr; }
    .dashboard-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }

    /* ===== Panel / Card ===== */
    .panel, .card {
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-lg);
      padding: 22px;
      box-shadow: var(--shadow-sm);
    }
    .panel + .panel, .card + .card { margin-top: 20px; }
    .section-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .section-copy {
      margin: 0;
      color: var(--muted);
      line-height: 1.7;
      font-size: 13px;
    }

    /* ===== Form Elements ===== */
    .row { margin-bottom: 16px; }
    label {
      display: block;
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 5px;
      color: #4a5568;
    }
    input[type="text"],
    input[type="email"],
    input[type="date"],
    input[type="file"],
    textarea,
    select {
      width: 100%;
      padding: 9px 12px;
      border: 1px solid #d1d5db;
      border-radius: var(--radius-sm);
      font: inherit;
      font-size: 13.5px;
      background: #fff;
      color: var(--ink);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
      outline: none;
    }
    input[type="text"]:focus,
    input[type="email"]:focus,
    input[type="date"]:focus,
    textarea:focus,
    select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(47,127,115,0.1);
    }
    textarea { min-height: 100px; resize: vertical; line-height: 1.5; }
    .inline { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 10px; }
    .inline-check {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid var(--panel-border);
      border-radius: 999px;
      background: var(--panel);
      font-size: 13px;
      cursor: pointer;
    }
    .inline-check input[type="checkbox"] { margin: 0; accent-color: var(--accent); }

    /* ===== Buttons ===== */
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 16px; }
    button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 9px 18px;
      font: inherit;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      color: white;
      background: var(--accent);
      border-radius: var(--radius-sm);
      transition: background 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
      box-shadow: 0 2px 6px rgba(47,127,115,0.22);
    }
    button:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(47,127,115,0.28);
    }
    button:active { transform: translateY(0); }
    button.ghost {
      background: #f1f5f9;
      color: #4a5568;
      box-shadow: none;
      border: 1px solid #e2e8f0;
    }
    button.ghost:hover {
      background: #e2e8f0;
      transform: translateY(-1px);
    }
    button.danger {
      background: var(--danger);
      box-shadow: 0 2px 6px rgba(229,62,62,0.22);
    }
    button.danger:hover { background: #c53030; }
    .link-button {
      display: inline-flex;
      align-items: center;
      padding: 8px 14px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      color: var(--accent);
      background: var(--accent-soft);
      border-radius: var(--radius-sm);
      border: 1px solid rgba(47,127,115,0.2);
      transition: all 0.15s ease;
    }
    .link-button:hover {
      background: rgba(47,127,115,0.18);
      transform: translateY(-1px);
    }
    .inline-action {
      display: inline-flex;
      align-items: center;
      padding: 8px 14px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      color: var(--accent);
      background: var(--accent-soft);
      border-radius: var(--radius-sm);
      transition: all 0.15s ease;
    }

    /* ===== Table ===== */
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-md);
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td {
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid #f0f4f8;
    }
    th {
      position: sticky;
      top: 0;
      background: #f8fafc;
      font-weight: 600;
      font-size: 12px;
      color: #64748b;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    tbody tr:hover { background: #f8fafc; }
    tbody tr:last-child td { border-bottom: none; }
    td input[type="text"] { min-width: 100px; padding: 6px 10px; }

    /* ===== Preview ===== */
    .preview {
      overflow: auto;
      max-height: 480px;
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-md);
      background: white;
    }

    /* ===== Summary / Sample boxes ===== */
    .sample, .summary-box {
      padding: 14px 16px;
      background: #fafafa;
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-md);
      font-size: 13px;
      white-space: pre-wrap;
      line-height: 1.6;
      color: var(--muted);
    }
    .summary-box { white-space: normal; color: var(--ink); }

    /* ===== Warning / Alert boxes ===== */
    .warning-summary, .warning-line {
      padding: 10px 14px;
      margin-top: 8px;
      border-left: 3px solid #e2e8f0;
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      font-size: 13px;
      background: #fafafa;
    }
    .warning-summary { font-weight: 700; }
    .warning-stop {
      border-left-color: var(--danger);
      background: #fff5f5;
      color: #c53030;
    }
    .warning-warn {
      border-left-color: var(--warning);
      background: #fffaf0;
      color: #9c4221;
    }
    .preflight-ready {
      border-left-color: var(--success);
      background: #f0fff4;
      color: #276749;
    }

    /* ===== Preflight ===== */
    .preflight-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      margin-top: 14px;
    }
    .preflight-step { display: grid; gap: 8px; }
    .preflight-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .preflight-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }

    /* ===== Chips ===== */
    .chip-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .chip {
      border: 1px solid var(--panel-border);
      background: var(--panel);
      padding: 5px 12px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      color: var(--ink);
      border-radius: 999px;
      transition: all 0.15s ease;
    }
    .chip:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
    .filter-chip {
      border: 1px solid var(--panel-border);
      background: var(--panel);
      padding: 7px 14px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      color: var(--muted);
      border-radius: 999px;
      transition: all 0.15s ease;
    }
    .filter-chip:hover { border-color: var(--accent); color: var(--accent); }
    .active-filter-chip { background: var(--accent); color: white; border-color: var(--accent); }
    .bulk-focus-row { background: var(--accent-soft) !important; }

    /* ===== Tags ===== */
    .tag {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
    }

    /* ===== Dashboard ===== */
    .dashboard-card {
      display: block;
      padding: 18px;
      color: var(--ink);
      text-decoration: none;
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      transition: all 0.15s ease;
    }
    .dashboard-card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }
    .card-topline {
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .dashboard-card strong { font-size: 16px; display: block; margin-bottom: 6px; }
    .dashboard-card span { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .card-link { margin-top: 10px; color: var(--accent); font-size: 13px; font-weight: 600; display: block; }

    /* ===== Timeline ===== */
    .timeline-list { display: grid; gap: 10px; }
    .timeline-item {
      padding: 14px 16px;
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-md);
      background: var(--panel);
    }
    .timeline-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
    }
    .timeline-badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 999px;
      background: rgba(217,143,112,0.12);
      color: #a85b39;
      font-weight: 600;
      font-size: 12px;
    }
    .timeline-summary { line-height: 1.5; }
    .timeline-helper { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .timeline-helper span {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 11px;
    }
    .timeline-item strong a { color: inherit; text-decoration: none; }
    .timeline-item strong a:hover { text-decoration: underline; }

    /* ===== Status Chips Row ===== */
    .status-chip-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .status-chip {
      min-width: 100px;
      display: grid;
      gap: 2px;
      padding: 10px 14px;
      border-radius: var(--radius-md);
      background: var(--panel);
      border: 1px solid var(--panel-border);
    }
    .status-chip strong { font-size: 13px; }
    .status-chip span { color: var(--muted); font-size: 11px; }

    /* ===== Hero ===== */
    .hero { margin-bottom: 24px; }
    .hero-panel, .hero {
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-lg);
      padding: 24px;
      box-shadow: var(--shadow-sm);
      margin-bottom: 20px;
    }
    .hero-layout {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 20px;
      align-items: start;
    }
    .hero-kicker { font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 8px; }
    .hero-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 16px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
      color: var(--accent);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .hero-side {
      padding: 16px;
      background: #f8fafc;
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-md);
    }

    /* ===== Quick Grid ===== */
    .quick-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
    .quick-card {
      display: grid;
      gap: 6px;
      padding: 16px;
      border-radius: var(--radius-md);
      border: 1px solid var(--panel-border);
      text-decoration: none;
      background: var(--panel);
      box-shadow: var(--shadow-sm);
      transition: all 0.15s ease;
    }
    .quick-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow-md); }
    .quick-card strong { font-size: 14px; }
    .quick-card span { color: var(--muted); font-size: 12px; line-height: 1.5; }

    /* ===== Flow ===== */
    .flow-list { display: grid; gap: 8px; }
    .flow-step {
      display: grid;
      gap: 3px;
      padding: 10px 14px;
      border-radius: var(--radius-md);
      background: #f8fafc;
      border: 1px solid var(--panel-border);
    }
    .flow-step strong { font-size: 13px; }
    .flow-step span { color: var(--muted); font-size: 12px; }

    /* ===== Tag Row ===== */
    .tag-row { display: flex; gap: 8px; flex-wrap: wrap; }

    /* ===== Runtime ===== */
    .runtime-alert { background: rgba(229,62,62,0.08); color: #c53030; }
    .runtime-summary { margin-bottom: 14px; }

    /* ===== Section Stack ===== */
    .section-stack { display: grid; gap: 20px; }

    /* ===== Empty State ===== */
    .empty-state {
      padding: 24px;
      border: 1.5px dashed var(--panel-border);
      border-radius: var(--radius-lg);
      color: var(--muted);
      background: #fafafa;
      text-align: center;
    }

    /* ===== Responsive ===== */
    @media (max-width: 960px) {
      :root { --sidebar-width: 64px; }
      .sidebar-logo-text { display: none; }
      .sidebar-group-label { display: none; }
      .sidebar-link-text { display: none; }
      .sidebar-link { padding: 12px; justify-content: center; }
      .hero-layout { grid-template-columns: 1fr; }
      .two-col { grid-template-columns: 1fr; }
      .dashboard-detail-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 680px) {
      .wrap, .shell { padding: 16px; }
      .panel, .card { padding: 16px; }
      textarea#csvText { min-height: 200px; }
    }
  `;
}


function formatAdminDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });
}

function escapeHtmlAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getVendorNameMatchType(lookupName?: string, vendorName?: string, aliases: string[] = []): "exact" | "alias" | "mismatch" | "missing" {
  const normalizedLookup = String(lookupName ?? "").trim();
  if (!normalizedLookup) return "missing";
  if (normalizedLookup === String(vendorName ?? "").trim()) return "exact";
  if (aliases.map((alias) => alias.trim()).includes(normalizedLookup)) return "alias";
  return "mismatch";
}

function resolveAdminLauncherForIssueType(issueTypeName: string): {
  path: string;
  label: string;
  workflowKind: "contracts" | "delivery" | "royalty";
} | null {
  const normalized = String(issueTypeName ?? "").trim();
  if (!normalized) return null;

  const contractIssueTypes = new Set([
    "NDA",
    "業務委託基本契約",
    "ライセンス契約",
    "個別利用許諾条件",
    "法務相談",
    "売買契約（当社買手）",
    "売買契約（当社売手・標準）",
    "売買契約（当社売手・保証金掛け売り）",
    "発注書",
    "企画発注書",
  ]);

  if (contractIssueTypes.has(normalized)) {
    return {
      path: "/admin/workflow/contracts",
      label: "契約書編集",
      workflowKind: "contracts",
    };
  }

  if (normalized === "納品リクエスト") {
    return {
      path: "/admin/workflow/delivery",
      label: "納品帳票生成",
      workflowKind: "delivery",
    };
  }

  if (normalized === "製造案件" || normalized === "売上報告案件") {
    return {
      path: "/admin/workflow/royalty",
      label: "利用許諾料計算",
      workflowKind: "royalty",
    };
  }

  return null;
}

function buildLocalWorkflowDiagnostics(runtimeStatus: ReturnType<typeof getLocalRuntimeStatus>): Array<{
  key: string;
  label: string;
  severity: "ok" | "warning" | "error";
  detail: string;
  hint: string;
  actionHref: string;
  actionLabel: string;
}> {
  const componentMap = new Map(runtimeStatus.components.map((component) => [component.key, component]));
  const dbReady = isComponentOperational(componentMap.get("db")?.severity);
  const backlogReady = isComponentOperational(componentMap.get("backlogConfig")?.severity);
  const checks = [
    {
      key: "csv",
      label: "CSV取込",
      requires: [dbReady],
      envs: [] as string[],
      detail: "DB が使えれば CSV / XLSX 取込と明細保存に進めます。",
      hint: "/admin/orders/csv から開始",
      actionHref: "/admin/orders/csv",
      actionLabel: "CSV取込を開く",
    },
    {
      key: "contracts",
      label: "契約書生成",
      requires: [dbReady, backlogReady],
      envs: [],
      detail: "Backlog 課題と下書き保存が使えれば契約書編集・プレビューへ進めます。",
      hint: "/admin/workflow/contracts を利用",
      actionHref: "/admin/workflow/contracts",
      actionLabel: "契約書生成を開く",
    },
    {
      key: "delivery",
      label: "納品帳票生成",
      requires: [dbReady, backlogReady],
      envs: ["BACKLOG_FIELD_PARENT_ISSUE_KEY", "BACKLOG_FIELD_ITEM_NO", "BACKLOG_FIELD_DELIVERED_AMOUNT"],
      detail: "納品課題の親課題キーと明細情報が引ける状態が必要です。",
      hint: "/admin/workflow/delivery を利用",
      actionHref: "/admin/workflow/delivery",
      actionLabel: "納品帳票生成を開く",
    },
    {
      key: "royalty",
      label: "利用許諾料計算",
      requires: [dbReady, backlogReady],
      envs: ["BACKLOG_FIELD_LICENSE_KEY", "BACKLOG_FIELD_COMPLETION_DATE"],
      detail: "ライセンス紐付けと製造/報告情報、DB 保存が使えれば進めます。",
      hint: "/admin/workflow/royalty を利用",
      actionHref: "/admin/workflow/royalty",
      actionLabel: "利用許諾料計算を開く",
    },
  ];

  return checks.map((check) => {
    const missingEnvs = check.envs.filter((envKey) => !String(process.env[envKey] ?? "").trim());
    const hasRuntimeGap = check.requires.some((ready) => !ready);
    const severity = missingEnvs.length > 0 || hasRuntimeGap
      ? (dbReady || backlogReady ? "warning" : "error")
      : "ok";
    const reasons = [
      hasRuntimeGap ? describeRuntimeGap(componentMap, check.key) : "",
      missingEnvs.length > 0 ? `未設定: ${missingEnvs.join(", ")}` : "",
    ].filter(Boolean);
    return {
      key: check.key,
      label: check.label,
      severity,
      detail: reasons.length > 0 ? `${check.detail} ${reasons.join(" ")}` : check.detail,
      hint: check.hint,
      actionHref: check.actionHref,
      actionLabel: check.actionLabel,
    };
  });
}

function isComponentOperational(severity?: string): boolean {
  return severity === "ok" || severity === "warning" || severity === "disabled";
}

function describeRuntimeGap(
  componentMap: Map<string, ReturnType<typeof getLocalRuntimeStatus>["components"][number]>,
  checkKey: string,
): string {
  const db = componentMap.get("db");
  const backlogConfig = componentMap.get("backlogConfig");

  if (checkKey === "csv" && !isComponentOperational(db?.severity)) {
    return "DB が未接続のため、取込後の保存に進めません。";
  }
  if ((checkKey === "contracts" || checkKey === "delivery") && !isComponentOperational(backlogConfig?.severity)) {
    return "Backlog 設定差分があり、課題情報の解決に支障が出る可能性があります。";
  }
  if (checkKey === "royalty") {
    if (!isComponentOperational(backlogConfig?.severity)) {
      return "Backlog 設定差分があり、ライセンス紐付けに支障が出る可能性があります。";
    }
  }
  return "依存コンポーネントに未準備があります。";
}

async function buildVendorStatuses(parsed: ReturnType<typeof parseOrderCsv>) {
  const groups = parsed.planningContext?.groups ?? [];
  const statuses = await Promise.all(groups.map(async (group) => {
    const vendorRecord = group.vendorCode ? await findVendorByCode(group.vendorCode) : null;
    return {
      vendorCode: group.vendorCode,
      exists: Boolean(vendorRecord),
      vendorName: vendorRecord?.vendorName,
      aliases: vendorRecord?.aliases ?? [],
      lookupName: group.vendorLookupValue,
      rowCount: group.rowCount,
      nameMatchType: vendorRecord
        ? getVendorNameMatchType(group.vendorLookupValue, vendorRecord.vendorName, vendorRecord.aliases ?? [])
        : "missing" as const,
    };
  }));
  return statuses;
}

function collectPreviewWarnings(
  parsed: ReturnType<typeof parseOrderCsv>,
  vendorStatuses: Array<{
    vendorCode?: string;
    exists?: boolean;
    nameMatchType?: "exact" | "alias" | "mismatch" | "missing";
    lookupName?: string;
    vendorName?: string;
    rowCount?: number;
  }> = []
): Array<{ severity: "blocking" | "warning"; message: string }> {
  const warnings: Array<{ severity: "blocking" | "warning"; message: string }> = [];

  if (parsed.mode === "planning") {
    for (const vendorStatus of vendorStatuses) {
      if (vendorStatus?.vendorCode && !vendorStatus.exists) {
        warnings.push({ severity: "blocking", message: `vendorID ${vendorStatus.vendorCode} がVendorマスタ未登録です。` });
      }
      if (vendorStatus?.exists && vendorStatus.nameMatchType === "mismatch") {
        warnings.push({ severity: "warning", message: `vendorID ${vendorStatus.vendorCode}: CSVの作家名 '${vendorStatus.lookupName ?? ""}' とVendor名 '${vendorStatus.vendorName ?? ""}' に差分があります。` });
      }
    }
  }

  const zeroAmountItems = parsed.items.filter((item) => !item.amount || item.amount <= 0);
  if (zeroAmountItems.length > 0) {
    warnings.push({ severity: "blocking", message: `金額が 0 円の明細があります: ${zeroAmountItems.map((item) => `No.${item.no}`).join(", ")}` });
  }

  const fallbackAmountItems = parsed.items.filter((item) => item.amountSource === "fallback");
  if (fallbackAmountItems.length > 0) {
    warnings.push({
      severity: "warning",
      message: `代替金額列を使用した明細があります: ${fallbackAmountItems.map((item) => `No.${item.no}(${item.amountSourceLabel ?? ""})`).join(", ")}`
    });
  }

  const missingAmountSourceItems = parsed.items.filter((item) => item.amountSource === "missing");
  if (missingAmountSourceItems.length > 0) {
    warnings.push({
      severity: "blocking",
      message: `金額の参照元列が見つからない明細があります: ${missingAmountSourceItems.map((item) => `No.${item.no}`).join(", ")}`
    });
  }

  const missingDueDateItems = parsed.items.filter((item) => !item.dueDate);
  if (missingDueDateItems.length > 0) {
    warnings.push({ severity: "blocking", message: `完成日または納期が空の明細があります: ${missingDueDateItems.map((item) => `No.${item.no}`).join(", ")}` });
  }

  const missingSpecItems = parsed.items.filter((item) => !String(item.spec ?? "").trim());
  if (missingSpecItems.length > 0 && parsed.mode === "planning") {
    warnings.push({ severity: "warning", message: `detailText が空の明細があります: ${missingSpecItems.map((item) => `No.${item.no}`).join(", ")}` });
  }

  return warnings;
}
