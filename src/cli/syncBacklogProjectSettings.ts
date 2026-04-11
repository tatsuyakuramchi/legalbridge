import dotenv from "dotenv";
dotenv.config();

import { backlog } from "../backlog/client";
import { WORKFLOW_STATUS } from "../workflow/statusConfig";

type DesiredFieldUpdate = {
  envKey: string;
  expectedName?: string;
  expectedDescription?: string;
};

const FIELD_UPDATES: DesiredFieldUpdate[] = [
  {
    envKey: "BACKLOG_FIELD_CONTRACT_TYPE",
    expectedDescription: "Slack受付の依頼種別（レビュー依頼 / 法務相談 / 秘密保持契約（NDA） / 業務委託基本契約 / ライセンス契約 / 海外IP契約 / 売買契約 / 発注書 / 企画発注書）",
  },
  {
    envKey: "BACKLOG_FIELD_COUNTERPARTY",
    expectedDescription: "相手方名",
  },
  {
    envKey: "BACKLOG_FIELD_DEADLINE",
    expectedDescription: "文書作成希望完了日",
  },
  {
    envKey: "BACKLOG_FIELD_COUNTERPARTY_ADDRESS",
    expectedDescription: "相手方所在地（住所）",
  },
  {
    envKey: "BACKLOG_FIELD_ITEM_NO",
    expectedDescription: "対象明細No",
  },
  {
    envKey: "BACKLOG_FIELD_MSRP",
    expectedName: "base_price",
    expectedDescription: "基準価格",
  },
];

const CLOUDSIGN_STATUS_COLOR = "#868cb7";
const LEGACY_REVIEW_STATUS_NAME = "レビュー中";

async function syncCustomFields() {
  const customFields = await backlog.listCustomFields();
  const fieldMap = new Map(customFields.map((field) => [field.id, field]));
  const changes: Array<Record<string, unknown>> = [];

  for (const update of FIELD_UPDATES) {
    const fieldIdRaw = process.env[update.envKey];
    if (!fieldIdRaw || !/^\d+$/.test(fieldIdRaw)) {
      changes.push({
        envKey: update.envKey,
        status: "skipped",
        reason: "field id not configured",
      });
      continue;
    }

    const fieldId = Number(fieldIdRaw);
    const current = fieldMap.get(fieldId);
    if (!current) {
      changes.push({
        envKey: update.envKey,
        fieldId,
        status: "skipped",
        reason: "field not found in Backlog",
      });
      continue;
    }

    const nextName = update.expectedName ?? current.name;
    const nextDescription = update.expectedDescription ?? current.description ?? "";
    const nameChanged = current.name !== nextName;
    const descriptionChanged = (current.description ?? "") !== nextDescription;

    if (!nameChanged && !descriptionChanged) {
      changes.push({
        envKey: update.envKey,
        fieldId,
        status: "unchanged",
        name: current.name,
        description: current.description ?? "",
      });
      continue;
    }

    const updated = await backlog.updateCustomFieldDefinition(fieldId, {
      name: nextName,
      description: nextDescription,
    });

    changes.push({
      envKey: update.envKey,
      fieldId,
      status: "updated",
      before: {
        name: current.name,
        description: current.description ?? "",
      },
      after: {
        name: updated.name,
        description: updated.description ?? "",
      },
    });
  }

  return changes;
}

async function syncStatuses() {
  let statuses = await backlog.listStatuses();
  let cloudSignStatus = statuses.find((status) => status.name === WORKFLOW_STATUS.cloudSignPreparing);
  const changes: Array<Record<string, unknown>> = [];
  const defaultStatusNames = new Set(["未対応", "処理中", "処理済み", "完了"]);
  const customStatusCount = statuses.filter((status) => !defaultStatusNames.has(status.name)).length;
  const mergedReviewIntoDraft = WORKFLOW_STATUS.review === WORKFLOW_STATUS.draft;
  const legacyReviewStatus = statuses.find((status) => status.name === LEGACY_REVIEW_STATUS_NAME);

  if (!cloudSignStatus && mergedReviewIntoDraft && legacyReviewStatus) {
    cloudSignStatus = await backlog.updateStatusDefinition(legacyReviewStatus.id, {
      name: WORKFLOW_STATUS.cloudSignPreparing,
      color: CLOUDSIGN_STATUS_COLOR,
    });
    changes.push({
      status: "repurposed",
      from: LEGACY_REVIEW_STATUS_NAME,
      to: WORKFLOW_STATUS.cloudSignPreparing,
      id: cloudSignStatus.id,
    });
    statuses = await backlog.listStatuses();
  }

  if (!cloudSignStatus) {
    if (customStatusCount >= 8) {
      changes.push({
        status: "blocked",
        reason: "custom status limit reached",
        existingCustomStatusCount: customStatusCount,
        targetName: WORKFLOW_STATUS.cloudSignPreparing,
      });
      return changes;
    }

    try {
      cloudSignStatus = await backlog.addStatus({
        name: WORKFLOW_STATUS.cloudSignPreparing,
        color: CLOUDSIGN_STATUS_COLOR,
      });
      changes.push({
        status: "created",
        name: cloudSignStatus.name,
        id: cloudSignStatus.id,
      });
      statuses = await backlog.listStatuses();
    } catch (error: unknown) {
      const responseData = typeof error === "object" && error !== null && "response" in error
        ? (error as { response?: { data?: unknown } }).response?.data
        : undefined;
      changes.push({
        status: "failed",
        targetName: WORKFLOW_STATUS.cloudSignPreparing,
        response: responseData ?? null,
      });
      return changes;
    }
  } else {
    changes.push({
      status: "exists",
      name: cloudSignStatus.name,
      id: cloudSignStatus.id,
    });
  }

  const currentIds = statuses.map((status) => status.id);
  const counterpartyId = statuses.find((status) => status.name === WORKFLOW_STATUS.counterpartyPending)?.id;
  const stampPendingId = statuses.find((status) => status.name === WORKFLOW_STATUS.stampPending)?.id;
  const cloudSignId = statuses.find((status) => status.name === WORKFLOW_STATUS.cloudSignPreparing)?.id;

  if (!cloudSignId) {
    return changes;
  }

  const reordered = currentIds.filter((id) => id !== cloudSignId);
  const insertAfterId = counterpartyId ?? stampPendingId;
  const insertIndex = insertAfterId ? reordered.indexOf(insertAfterId) + 1 : -1;

  if (insertIndex >= 0) {
    reordered.splice(insertIndex, 0, cloudSignId);
  } else if (!reordered.includes(cloudSignId)) {
    reordered.push(cloudSignId);
  }

  const orderChanged = reordered.length === currentIds.length
    && reordered.some((id, index) => id !== currentIds[index]);

  if (orderChanged) {
    await backlog.updateStatusDisplayOrder(reordered);
    changes.push({
      status: "reordered",
      orderedStatusIds: reordered,
    });
  } else {
    changes.push({
      status: "order-unchanged",
      orderedStatusIds: currentIds,
    });
  }

  return changes;
}

async function main() {
  const customFields = await syncCustomFields();
  const statuses = await syncStatuses();

  console.log(JSON.stringify({
    projectKey: process.env.BACKLOG_PROJECT_KEY ?? "",
    customFields,
    statuses,
  }, null, 2));
}

main().catch((error) => {
  console.error("[Backlog] プロジェクト設定同期失敗");
  console.error(error);
  process.exit(1);
});
