-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "vendorCode" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "vendorSuffix" TEXT NOT NULL DEFAULT '御中',
    "aliases" TEXT[],
    "address" TEXT,
    "email" TEXT,
    "contactDepartment" TEXT,
    "contactName" TEXT,
    "bankInfo" TEXT,
    "bankName" TEXT,
    "branchName" TEXT,
    "accountType" TEXT,
    "accountNumber" TEXT,
    "accountHolderKana" TEXT,
    "invoiceRegistrationNumber" TEXT,
    "masterContractRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "staffName" TEXT NOT NULL,
    "department" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "partyAName" TEXT NOT NULL DEFAULT '株式会社アークライト',
    "partyAAddress" TEXT NOT NULL DEFAULT '〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階',
    "partyARep" TEXT NOT NULL DEFAULT '代表取締役 青柳昌行',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_vendorCode_key" ON "Vendor"("vendorCode");

-- CreateIndex
CREATE INDEX "Vendor_vendorName_idx" ON "Vendor"("vendorName");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_slackUserId_key" ON "Staff"("slackUserId");

-- CreateIndex
CREATE INDEX "Staff_staffName_idx" ON "Staff"("staffName");

