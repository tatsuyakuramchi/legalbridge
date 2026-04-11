-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "category" TEXT,
ADD COLUMN     "payMethod" TEXT,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unitPrice" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_legalRequestId_itemNo_key" ON "OrderItem"("legalRequestId", "itemNo");

