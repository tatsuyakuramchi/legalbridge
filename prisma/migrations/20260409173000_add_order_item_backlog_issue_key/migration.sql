ALTER TABLE "OrderItem"
ADD COLUMN "backlogIssueKey" TEXT;

CREATE UNIQUE INDEX "OrderItem_backlogIssueKey_key" ON "OrderItem"("backlogIssueKey");
