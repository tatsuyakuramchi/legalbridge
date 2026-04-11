ALTER TABLE "Vendor"
ADD COLUMN "entityType" TEXT NOT NULL DEFAULT 'corporation',
ADD COLUMN "withholdingEnabled" BOOLEAN NOT NULL DEFAULT false;
