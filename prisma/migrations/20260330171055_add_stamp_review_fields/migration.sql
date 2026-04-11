ALTER TABLE "IssueWorkflow"
ADD COLUMN "stampRejectedAt" TIMESTAMP(3),
ADD COLUMN "stampRejectedReason" TEXT,
ADD COLUMN "stampCompletedBySlackId" TEXT;
