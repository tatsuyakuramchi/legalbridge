CREATE TABLE "DepartmentWorkflowRule" (
    "id" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "approverSlackId" TEXT,
    "stampOperatorSlackId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepartmentWorkflowRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DepartmentWorkflowRule_department_key" ON "DepartmentWorkflowRule"("department");
CREATE INDEX "DepartmentWorkflowRule_department_idx" ON "DepartmentWorkflowRule"("department");
CREATE INDEX "DepartmentWorkflowRule_isActive_idx" ON "DepartmentWorkflowRule"("isActive");
