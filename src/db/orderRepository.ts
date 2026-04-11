/**
 * db/orderRepository.ts
 * 業務明細（OrderItem）・納品イベント（DeliveryEvent）・変更履歴（ChangeLog）のDB操作
 */

import prisma from "./client";
import { Prisma } from "@prisma/client";

// ================================================================
// 業務明細（OrderItem）
// ================================================================

/** Backlogカスタムフィールドの「業務明細JSON」を解析してDBに登録 */
export interface RawOrderItem {
  no: number;          // 明細番号
  vendorCode?: string; // vendorID
  category?: string;   // 区分
  payMethod?: string;  // 支払方法
  installmentCount?: number; // 分割回数
  paymentStartDate?: string; // 初回支払日 (YYYY-MM-DD)
  paymentIntervalMonths?: number; // 支払間隔（月）
  subscriptionMonths?: number; // サブスク期間（月）
  qty?: number;        // 数量
  unitPrice?: number;  // 単価
  desc: string;        // 業務内容・成果物名
  spec?: string;       // 仕様
  amount: number;      // 金額（税抜・円）
  dueDate: string;     // 納期 (YYYY-MM-DD)
}

/**
 * 業務明細JSONをパースしてOrderItemを一括upsert
 * Backlogの「業務明細JSON」カスタムフィールドから呼ぶ
 *
 * JSON形式例（カスタムフィールドに入力する文字列）:
 * [
 *   {"no":1,"category":"制作","payMethod":"一括払い","qty":1,"unitPrice":100000,"desc":"イラスト原稿A","amount":100000,"dueDate":"2026-04-30"},
 *   {"no":2,"category":"デザイン","qty":2,"unitPrice":40000,"desc":"イラスト原稿B","spec":"B5/300dpi/CMYK","amount":80000,"dueDate":"2026-05-15"},
 *   {"no":3,"desc":"DTPデータ","amount":50000,"dueDate":"2026-05-31"}
 * ]
 */
export async function upsertOrderItems(
  legalRequestId: string,
  rawJson: string
): Promise<void> {
  let items: RawOrderItem[];
  try {
    items = JSON.parse(rawJson);
  } catch {
    throw new Error(`業務明細JSONのパースに失敗しました: ${rawJson.slice(0, 100)}`);
  }

  for (const item of items) {
    const dueDate = new Date(item.dueDate);
    const paymentStartDate = item.paymentStartDate ? new Date(item.paymentStartDate) : undefined;
    await prisma.orderItem.upsert({
      where: {
        legalRequestId_itemNo: {
          legalRequestId,
          itemNo: item.no,
        },
      },
      create: {
        legalRequestId,
        backlogIssueKey: undefined,
        itemNo: item.no,
        vendorCode: item.vendorCode,
        category: item.category,
        payMethod: item.payMethod,
        installmentCount: item.installmentCount,
        paymentStartDate,
        paymentIntervalMonths: item.paymentIntervalMonths,
        subscriptionMonths: item.subscriptionMonths,
        quantity: item.qty ?? 1,
        unitPrice: item.unitPrice ?? item.amount,
        description: item.desc,
        spec: item.spec,
        amount: item.amount,
        latestAmount: item.amount,
        dueDate,
        latestDueDate: dueDate,
      },
      update: {
        vendorCode: item.vendorCode,
        category: item.category,
        payMethod: item.payMethod,
        installmentCount: item.installmentCount,
        paymentStartDate,
        paymentIntervalMonths: item.paymentIntervalMonths,
        subscriptionMonths: item.subscriptionMonths,
        quantity: item.qty ?? 1,
        unitPrice: item.unitPrice ?? item.amount,
        description: item.desc,
        spec: item.spec,
        amount: item.amount,
        latestAmount: item.amount,
        dueDate,
        latestDueDate: dueDate,
      },
    });
  }
}

/**
 * 発注課題に紐付く業務明細一覧を取得
 */
export async function getOrderItems(legalRequestId: string) {
  return prisma.orderItem.findMany({
    where: { legalRequestId },
    orderBy: { itemNo: "asc" },
    include: {
      deliveryEvents: { orderBy: { deliveryNo: "asc" } },
      changeLogs: { orderBy: { changedAt: "desc" } },
    },
  });
}

/**
 * 明細番号から特定の OrderItem を取得
 */
export async function getOrderItemByNo(legalRequestId: string, itemNo: number) {
  return prisma.orderItem.findFirst({
    where: { legalRequestId, itemNo },
    include: {
      deliveryEvents: { orderBy: { deliveryNo: "asc" } },
      changeLogs: { orderBy: { changedAt: "desc" } },
    },
  });
}

export async function assignOrderItemBacklogIssueKey(orderItemId: string, backlogIssueKey: string) {
  return prisma.orderItem.update({
    where: { id: orderItemId },
    data: { backlogIssueKey },
  });
}

export async function findOrderItemByBacklogIssueKey(backlogIssueKey: string) {
  return prisma.orderItem.findFirst({
    where: { backlogIssueKey },
    include: {
      legalRequest: true,
      deliveryEvents: { orderBy: { deliveryNo: "asc" } },
      changeLogs: { orderBy: { changedAt: "desc" } },
    },
  });
}

// ================================================================
// 変更履歴（ChangeLog）
// ================================================================

export interface ChangeInput {
  orderItemId: string;
  fieldName: "amount" | "dueDate" | "description" | "spec";
  beforeValue: string;
  afterValue: string;
  reason: string;
  changedBy: string;        // Slack userId
  changedByName?: string;
}

/**
 * 変更を記録してOrderItemの現行値を更新する（トランザクション）
 */
export async function recordChange(input: ChangeInput) {
  return prisma.$transaction(async (tx) => {
    // 1. ChangeLogに記録
    await tx.changeLog.create({
      data: {
        targetType: "ORDER_ITEM",
        orderItemId: input.orderItemId,
        fieldName: input.fieldName,
        beforeValue: input.beforeValue,
        afterValue: input.afterValue,
        reason: input.reason,
        changedBy: input.changedBy,
        changedByName: input.changedByName,
      },
    });

    // 2. OrderItemの現行値を更新
    const updateData: Prisma.OrderItemUpdateInput = {};
    if (input.fieldName === "amount") {
      updateData.latestAmount = parseInt(input.afterValue, 10);
    } else if (input.fieldName === "dueDate") {
      updateData.latestDueDate = new Date(input.afterValue);
    } else if (input.fieldName === "description") {
      updateData.description = input.afterValue;
    } else if (input.fieldName === "spec") {
      updateData.spec = input.afterValue;
    }

    return tx.orderItem.update({
      where: { id: input.orderItemId },
      data: updateData,
    });
  });
}

// ================================================================
// 納品イベント（DeliveryEvent）
// ================================================================

export interface CreateDeliveryEventInput {
  backlogIssueKey: string;       // 納品報告課題のキー
  orderItemId: string;
  deliveredAt: Date;
  deliveredAmount?: number;      // 分割納品の場合の今回分金額
  inspectionDays?: number;       // 検収期間（日数、デフォルト7日）
  note?: string;
}

/**
 * 納品イベントを作成
 * 同一 orderItem への再納品は deliveryNo を自動インクリメント
 */
export async function createDeliveryEvent(input: CreateDeliveryEventInput) {
  // 既存の納品回数を確認
  const maxDelivery = await prisma.deliveryEvent.findFirst({
    where: { orderItemId: input.orderItemId },
    orderBy: { deliveryNo: "desc" },
    select: { deliveryNo: true },
  });
  const deliveryNo = (maxDelivery?.deliveryNo ?? 0) + 1;

  // 検収期限を計算
  const inspectionDays = input.inspectionDays ?? 7;
  const inspectionDeadline = new Date(input.deliveredAt);
  inspectionDeadline.setDate(inspectionDeadline.getDate() + inspectionDays);

  const event = await prisma.deliveryEvent.create({
    data: {
      backlogIssueKey: input.backlogIssueKey,
      orderItemId: input.orderItemId,
      deliveryNo,
      deliveredAt: input.deliveredAt,
      deliveredAmount: input.deliveredAmount,
      inspectionDeadline,
      note: input.note,
    },
    include: { orderItem: { include: { legalRequest: true, changeLogs: true } } },
  });

  // OrderItemのステータスを更新
  await prisma.orderItem.update({
    where: { id: input.orderItemId },
    data: { status: "DELIVERED" },
  });

  return event;
}

/**
 * 検収完了（合格）を記録
 */
export async function passInspection(
  deliveryEventId: string,
  inspectionCertUrl?: string,
  inspectedAt?: Date
) {
  const event = await prisma.deliveryEvent.update({
    where: { id: deliveryEventId },
    data: {
      inspectedAt: inspectedAt ?? new Date(),
      inspectionResult: "PASSED",
      status: "PASSED",
      inspectionCertUrl,
    },
    include: { orderItem: true },
  });

  // 全納品が完了しているか確認してOrderItemステータスを更新
  const allDeliveries = await prisma.deliveryEvent.findMany({
    where: { orderItemId: event.orderItemId },
  });
  const allPassed = allDeliveries.every((d) => d.status === "PASSED");

  if (allPassed) {
    await prisma.orderItem.update({
      where: { id: event.orderItemId },
      data: { status: "INSPECTED" },
    });
  }

  return event;
}

export async function updateDeliveryEventDocuments(
  deliveryEventId: string,
  urls: { inspectionCertUrl?: string; paymentNoticeUrl?: string }
) {
  return prisma.deliveryEvent.update({
    where: { id: deliveryEventId },
    data: urls,
  });
}

/**
 * 検収差し戻しを記録
 */
export async function rejectInspection(
  deliveryEventId: string,
  rejectionReason: string
) {
  const event = await prisma.deliveryEvent.update({
    where: { id: deliveryEventId },
    data: {
      inspectionResult: "REJECTED",
      rejectionReason,
      status: "REJECTED",
    },
    include: { orderItem: true },
  });

  await prisma.orderItem.update({
    where: { id: event.orderItemId },
    data: { status: "REJECTED" },
  });

  return event;
}

// ================================================================
// 発注書全体のサマリー（検収書生成用）
// ================================================================

/**
 * 発注課題全体の進捗サマリーを取得
 * 検収書・支払通知書の生成に渡す変数の組み立てに使う
 */
export async function getOrderSummary(legalRequestId: string) {
  const request = await prisma.legalRequest.findUnique({
    where: { id: legalRequestId },
    include: {
      orderItems: {
        orderBy: { itemNo: "asc" },
        include: {
          deliveryEvents: { orderBy: { deliveryNo: "asc" } },
          changeLogs: { orderBy: { changedAt: "asc" } },
        },
      },
    },
  });

  if (!request) throw new Error(`LegalRequest not found: ${legalRequestId}`);

  const totalAmount = request.orderItems.reduce((s, i) => s + i.latestAmount, 0);
  const inspectedAmount = request.orderItems
    .filter((i) => i.status === "INSPECTED")
    .reduce((s, i) => s + i.latestAmount, 0);
  const pendingAmount = totalAmount - inspectedAmount;
  const allInspected = request.orderItems.every((i) => i.status === "INSPECTED");

  return {
    request,
    totalAmount,
    inspectedAmount,
    pendingAmount,
    allInspected,
    itemCount: request.orderItems.length,
    inspectedCount: request.orderItems.filter((i) => i.status === "INSPECTED").length,
  };
}

/**
 * 納品イベントIDからDeliveryEventを取得（検収書生成用）
 */
export async function getDeliveryEventWithContext(deliveryEventId: string) {
  return prisma.deliveryEvent.findUnique({
    where: { id: deliveryEventId },
    include: {
      orderItem: {
        include: {
          legalRequest: true,
          deliveryEvents: { orderBy: { deliveryNo: "asc" } },
          changeLogs: { orderBy: { changedAt: "asc" } },
        },
      },
    },
  });
}

export async function findDeliveryEventByBacklogIssueKey(backlogIssueKey: string) {
  return prisma.deliveryEvent.findUnique({
    where: { backlogIssueKey },
    select: { id: true, backlogIssueKey: true, inspectionDeadline: true, deliveredAt: true },
  });
}
