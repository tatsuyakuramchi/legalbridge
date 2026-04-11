-- AlterTable
ALTER TABLE "DepartmentWorkflowRule" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "departmentCode" TEXT;
