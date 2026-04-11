-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('PENDING', 'PARTIAL', 'DELIVERED', 'INSPECTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PASSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('PASSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChangeTargetType" AS ENUM ('ORDER_ITEM', 'DELIVERY');

-- CreateEnum
CREATE TYPE "RoyaltyCalcType" AS ENUM ('MANUFACTURING', 'SALES', 'SUBLICENSE', 'FIXED');

-- CreateEnum
CREATE TYPE "PaymentCycle" AS ENUM ('EVENT', 'MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'TERMINATED', 'PENDING');

-- CreateEnum
CREATE TYPE "ManufacturingStatus" AS ENUM ('PENDING', 'CALCULATED', 'REPORTED', 'PAID');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'OVERDUE', 'PAID', 'ZERO');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StampType" AS ENUM ('PHYSICAL', 'ELECTRONIC');

-- CreateTable
CREATE TABLE "LicenseContract" (
    "id" TEXT NOT NULL,
    "backlogIssueKey" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "licensor" TEXT NOT NULL,
    "licensee" TEXT NOT NULL DEFAULT '株式会社アークライト',
    "originalWork" TEXT NOT NULL,
    "calcType" "RoyaltyCalcType" NOT NULL DEFAULT 'MANUFACTURING',
    "royaltyRate" DECIMAL(5,4) NOT NULL,
    "distributionRate" DECIMAL(5,4),
    "fixedAmount" INTEGER,
    "mgAmount" INTEGER NOT NULL DEFAULT 0,
    "mgConsumedToDate" INTEGER NOT NULL DEFAULT 0,
    "paymentCycle" "PaymentCycle" NOT NULL DEFAULT 'EVENT',
    "reportingDays" INTEGER NOT NULL DEFAULT 30,
    "paymentDays" INTEGER NOT NULL DEFAULT 30,
    "currency" TEXT NOT NULL DEFAULT 'JPY',
    "licenseStartDate" TIMESTAMP(3),
    "licenseEndDate" TIMESTAMP(3),
    "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LicenseContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingEvent" (
    "id" TEXT NOT NULL,
    "backlogIssueKey" TEXT NOT NULL,
    "licenseContractId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "edition" TEXT NOT NULL,
    "completionDate" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sampleQuantity" INTEGER NOT NULL DEFAULT 0,
    "billableQuantity" INTEGER NOT NULL,
    "msrp" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'JPY',
    "royaltyRate" DECIMAL(5,4) NOT NULL,
    "grossRoyalty" INTEGER NOT NULL,
    "mgConsumedThisTime" INTEGER NOT NULL DEFAULT 0,
    "actualRoyalty" INTEGER NOT NULL,
    "taxRate" INTEGER NOT NULL DEFAULT 10,
    "taxAmount" INTEGER NOT NULL,
    "totalPayment" INTEGER NOT NULL,
    "reportingDeadline" TIMESTAMP(3) NOT NULL,
    "paymentDueDate" TIMESTAMP(3) NOT NULL,
    "royaltyReportUrl" TEXT,
    "paymentNoticeUrl" TEXT,
    "notes" TEXT,
    "status" "ManufacturingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManufacturingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoyaltyPayment" (
    "id" TEXT NOT NULL,
    "manufacturingEventId" TEXT NOT NULL,
    "licenseContractId" TEXT NOT NULL,
    "paymentDueDate" TIMESTAMP(3) NOT NULL,
    "reportingDeadline" TIMESTAMP(3) NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'JPY',
    "status" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paidAt" TIMESTAMP(3),
    "paidAmount" INTEGER,
    "transferRef" TEXT,
    "reportedAt" TIMESTAMP(3),
    "reportDocumentUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoyaltyPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalRequest" (
    "id" TEXT NOT NULL,
    "backlogIssueKey" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "slackChannelId" TEXT,
    "contractType" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "deadline" TIMESTAMP(3),
    "notes" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'RECEIVED',
    "inspectionCertUrl" TEXT,
    "paymentNoticeUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacklogSyncState" (
    "id" TEXT NOT NULL,
    "backlogIssueId" INTEGER NOT NULL,
    "backlogIssueKey" TEXT NOT NULL,
    "issueTypeName" TEXT,
    "statusId" INTEGER NOT NULL,
    "statusName" TEXT NOT NULL,
    "lastBacklogUpdatedAt" TIMESTAMP(3) NOT NULL,
    "lastPolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastProcessedAt" TIMESTAMP(3),
    "lastProcessingError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BacklogSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueWorkflow" (
    "id" TEXT NOT NULL,
    "backlogIssueKey" TEXT NOT NULL,
    "backlogIssueId" INTEGER,
    "issueTypeName" TEXT,
    "currentStatusId" INTEGER,
    "currentStatusName" TEXT,
    "currentSummary" TEXT,
    "generatedDocuments" JSONB,
    "primaryDocumentUrl" TEXT,
    "approvalRequestedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBySlackId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "approvalSlackChannel" TEXT,
    "approvalSlackTs" TEXT,
    "approverSlackId" TEXT,
    "stampRequestedAt" TIMESTAMP(3),
    "stampType" "StampType",
    "stampedAt" TIMESTAMP(3),
    "stampedDriveUrl" TEXT,
    "stampSlackChannel" TEXT,
    "stampSlackTs" TEXT,
    "stampOperatorSlackId" TEXT,
    "esignRequestedAt" TIMESTAMP(3),
    "esignCompletedAt" TIMESTAMP(3),
    "esignDriveUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "legalRequestId" TEXT NOT NULL,
    "itemNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "spec" TEXT,
    "amount" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'PENDING',
    "latestAmount" INTEGER NOT NULL,
    "latestDueDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryEvent" (
    "id" TEXT NOT NULL,
    "backlogIssueKey" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "deliveryNo" INTEGER NOT NULL DEFAULT 1,
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "deliveredAmount" INTEGER,
    "note" TEXT,
    "inspectionDeadline" TIMESTAMP(3) NOT NULL,
    "inspectedAt" TIMESTAMP(3),
    "inspectionResult" "InspectionResult",
    "rejectionReason" TEXT,
    "inspectionCertUrl" TEXT,
    "paymentNoticeUrl" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeLog" (
    "id" TEXT NOT NULL,
    "targetType" "ChangeTargetType" NOT NULL,
    "orderItemId" TEXT,
    "fieldName" TEXT NOT NULL,
    "beforeValue" TEXT NOT NULL,
    "afterValue" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "changedByName" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LicenseContract_backlogIssueKey_key" ON "LicenseContract"("backlogIssueKey");

-- CreateIndex
CREATE UNIQUE INDEX "LicenseContract_ledgerId_key" ON "LicenseContract"("ledgerId");

-- CreateIndex
CREATE INDEX "LicenseContract_ledgerId_idx" ON "LicenseContract"("ledgerId");

-- CreateIndex
CREATE INDEX "LicenseContract_licensor_idx" ON "LicenseContract"("licensor");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingEvent_backlogIssueKey_key" ON "ManufacturingEvent"("backlogIssueKey");

-- CreateIndex
CREATE INDEX "ManufacturingEvent_licenseContractId_idx" ON "ManufacturingEvent"("licenseContractId");

-- CreateIndex
CREATE INDEX "ManufacturingEvent_completionDate_idx" ON "ManufacturingEvent"("completionDate");

-- CreateIndex
CREATE INDEX "ManufacturingEvent_paymentDueDate_idx" ON "ManufacturingEvent"("paymentDueDate");

-- CreateIndex
CREATE UNIQUE INDEX "RoyaltyPayment_manufacturingEventId_key" ON "RoyaltyPayment"("manufacturingEventId");

-- CreateIndex
CREATE INDEX "RoyaltyPayment_paymentDueDate_idx" ON "RoyaltyPayment"("paymentDueDate");

-- CreateIndex
CREATE INDEX "RoyaltyPayment_status_idx" ON "RoyaltyPayment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LegalRequest_backlogIssueKey_key" ON "LegalRequest"("backlogIssueKey");

-- CreateIndex
CREATE INDEX "LegalRequest_slackUserId_idx" ON "LegalRequest"("slackUserId");

-- CreateIndex
CREATE INDEX "LegalRequest_status_idx" ON "LegalRequest"("status");

-- CreateIndex
CREATE INDEX "LegalRequest_deadline_idx" ON "LegalRequest"("deadline");

-- CreateIndex
CREATE UNIQUE INDEX "BacklogSyncState_backlogIssueId_key" ON "BacklogSyncState"("backlogIssueId");

-- CreateIndex
CREATE UNIQUE INDEX "BacklogSyncState_backlogIssueKey_key" ON "BacklogSyncState"("backlogIssueKey");

-- CreateIndex
CREATE INDEX "BacklogSyncState_statusName_idx" ON "BacklogSyncState"("statusName");

-- CreateIndex
CREATE INDEX "BacklogSyncState_lastBacklogUpdatedAt_idx" ON "BacklogSyncState"("lastBacklogUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IssueWorkflow_backlogIssueKey_key" ON "IssueWorkflow"("backlogIssueKey");

-- CreateIndex
CREATE UNIQUE INDEX "IssueWorkflow_backlogIssueId_key" ON "IssueWorkflow"("backlogIssueId");

-- CreateIndex
CREATE INDEX "IssueWorkflow_currentStatusName_idx" ON "IssueWorkflow"("currentStatusName");

-- CreateIndex
CREATE INDEX "IssueWorkflow_approvalRequestedAt_idx" ON "IssueWorkflow"("approvalRequestedAt");

-- CreateIndex
CREATE INDEX "IssueWorkflow_stampRequestedAt_idx" ON "IssueWorkflow"("stampRequestedAt");

-- CreateIndex
CREATE INDEX "OrderItem_legalRequestId_idx" ON "OrderItem"("legalRequestId");

-- CreateIndex
CREATE INDEX "OrderItem_dueDate_idx" ON "OrderItem"("dueDate");

-- CreateIndex
CREATE INDEX "OrderItem_status_idx" ON "OrderItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryEvent_backlogIssueKey_key" ON "DeliveryEvent"("backlogIssueKey");

-- CreateIndex
CREATE INDEX "DeliveryEvent_orderItemId_idx" ON "DeliveryEvent"("orderItemId");

-- CreateIndex
CREATE INDEX "DeliveryEvent_inspectionDeadline_idx" ON "DeliveryEvent"("inspectionDeadline");

-- CreateIndex
CREATE INDEX "DeliveryEvent_status_idx" ON "DeliveryEvent"("status");

-- CreateIndex
CREATE INDEX "ChangeLog_orderItemId_idx" ON "ChangeLog"("orderItemId");

-- CreateIndex
CREATE INDEX "ChangeLog_changedAt_idx" ON "ChangeLog"("changedAt");

-- AddForeignKey
ALTER TABLE "ManufacturingEvent" ADD CONSTRAINT "ManufacturingEvent_licenseContractId_fkey" FOREIGN KEY ("licenseContractId") REFERENCES "LicenseContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyPayment" ADD CONSTRAINT "RoyaltyPayment_manufacturingEventId_fkey" FOREIGN KEY ("manufacturingEventId") REFERENCES "ManufacturingEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyPayment" ADD CONSTRAINT "RoyaltyPayment_licenseContractId_fkey" FOREIGN KEY ("licenseContractId") REFERENCES "LicenseContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_legalRequestId_fkey" FOREIGN KEY ("legalRequestId") REFERENCES "LegalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
