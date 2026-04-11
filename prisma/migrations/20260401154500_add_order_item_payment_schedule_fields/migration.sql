ALTER TABLE "OrderItem"
ADD COLUMN "installmentCount" INTEGER,
ADD COLUMN "paymentStartDate" TIMESTAMP(3),
ADD COLUMN "paymentIntervalMonths" INTEGER,
ADD COLUMN "subscriptionMonths" INTEGER;
