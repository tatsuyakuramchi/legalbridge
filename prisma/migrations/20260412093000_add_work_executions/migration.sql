-- CreateEnum
CREATE TYPE "WorkExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "WorkExecution" (
    "id" TEXT NOT NULL,
    "executionKey" TEXT NOT NULL,
    "workType" TEXT NOT NULL,
    "issueKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "WorkExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkExecution_executionKey_key" ON "WorkExecution"("executionKey");

-- CreateIndex
CREATE INDEX "WorkExecution_workType_idx" ON "WorkExecution"("workType");

-- CreateIndex
CREATE INDEX "WorkExecution_issueKey_idx" ON "WorkExecution"("issueKey");

-- CreateIndex
CREATE INDEX "WorkExecution_status_idx" ON "WorkExecution"("status");
