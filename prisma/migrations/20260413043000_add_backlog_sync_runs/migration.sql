CREATE TABLE "BacklogSyncRun" (
  "id" TEXT NOT NULL,
  "triggerSource" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "issueCount" INTEGER NOT NULL DEFAULT 0,
  "changedCount" INTEGER NOT NULL DEFAULT 0,
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "bootstrapped" BOOLEAN NOT NULL DEFAULT false,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BacklogSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BacklogSyncRun_createdAt_idx" ON "BacklogSyncRun"("createdAt");
CREATE INDEX "BacklogSyncRun_status_idx" ON "BacklogSyncRun"("status");
