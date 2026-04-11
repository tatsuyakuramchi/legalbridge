CREATE TABLE "OrderDueReminderLog" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "reminderType" TEXT NOT NULL,
    "reminderDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDueReminderLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderDueReminderLog_reminderDate_idx" ON "OrderDueReminderLog"("reminderDate");

CREATE UNIQUE INDEX "OrderDueReminderLog_orderItemId_reminderType_reminderDate_key"
ON "OrderDueReminderLog"("orderItemId", "reminderType", "reminderDate");

ALTER TABLE "OrderDueReminderLog"
ADD CONSTRAINT "OrderDueReminderLog_orderItemId_fkey"
FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
