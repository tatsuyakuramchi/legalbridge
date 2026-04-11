ALTER TABLE "IssueWorkflow"
ADD COLUMN "documentDraft" JSONB,
ADD COLUMN "documentDraftUpdatedAt" TIMESTAMP(3);

