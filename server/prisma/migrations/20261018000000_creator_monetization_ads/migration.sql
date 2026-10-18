CREATE TABLE "MonetizationSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "minimumFollowers" INTEGER NOT NULL DEFAULT 1000,
  "minimumQualifiedViews" INTEGER NOT NULL DEFAULT 0,
  "qualifiedViewWindowDays" INTEGER NOT NULL DEFAULT 30,
  "minimumWatchTimeSeconds" INTEGER NOT NULL DEFAULT 0,
  "minimumEngagementRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "minimumAccountAgeDays" INTEGER NOT NULL DEFAULT 30,
  "minimumPublicPosts" INTEGER NOT NULL DEFAULT 0,
  "revenueSharePercent" INTEGER NOT NULL DEFAULT 90,
  "minimumPayoutCents" INTEGER NOT NULL DEFAULT 0,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonetizationSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonetizationSettings_thresholds_check" CHECK (
    "minimumFollowers" >= 0 AND "minimumQualifiedViews" >= 0 AND
    "qualifiedViewWindowDays" BETWEEN 1 AND 365 AND
    "minimumWatchTimeSeconds" >= 0 AND "minimumEngagementRate" BETWEEN 0 AND 1 AND
    "minimumAccountAgeDays" >= 0 AND "minimumPublicPosts" >= 0 AND
    "revenueSharePercent" BETWEEN 0 AND 100 AND "minimumPayoutCents" >= 0
  )
);

CREATE TABLE "CreatorApplication" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "reviewNote" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorApplication_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CreatorApplication_creatorId_createdAt_idx" ON "CreatorApplication"("creatorId", "createdAt");
CREATE INDEX "CreatorApplication_status_createdAt_idx" ON "CreatorApplication"("status", "createdAt");
ALTER TABLE "CreatorApplication" ADD CONSTRAINT "CreatorApplication_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorApplication" ADD CONSTRAINT "CreatorApplication_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AdNetworkSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdNetworkSettings_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AdConsent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "consentedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdConsent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdConsent_userId_key" ON "AdConsent"("userId");
ALTER TABLE "AdConsent" ADD CONSTRAINT "AdConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "AdPlacement" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "dailyBudgetCents" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdPlacement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdPlacement_dailyBudgetCents_check" CHECK ("dailyBudgetCents" >= 0)
);
CREATE UNIQUE INDEX "AdPlacement_key_key" ON "AdPlacement"("key");
CREATE TABLE "AdCampaign" (
  "id" TEXT NOT NULL,
  "advertiserId" TEXT NOT NULL,
  "placementId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "creativeUrl" TEXT NOT NULL,
  "destinationUrl" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "totalBudgetCents" INTEGER NOT NULL,
  "dailyBudgetCents" INTEGER NOT NULL,
  "costPerImpressionCents" INTEGER NOT NULL DEFAULT 0,
  "costPerClickCents" INTEGER NOT NULL DEFAULT 0,
  "spendCents" INTEGER NOT NULL DEFAULT 0,
  "reviewNote" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdCampaign_budgets_check" CHECK (
    "totalBudgetCents" > 0 AND "dailyBudgetCents" > 0 AND
    "dailyBudgetCents" <= "totalBudgetCents" AND
    "costPerImpressionCents" >= 0 AND "costPerClickCents" >= 0 AND
    "spendCents" >= 0 AND "spendCents" <= "totalBudgetCents" AND "endsAt" > "startsAt"
  )
);
CREATE INDEX "AdCampaign_status_startsAt_endsAt_idx" ON "AdCampaign"("status", "startsAt", "endsAt");
CREATE INDEX "AdCampaign_advertiserId_createdAt_idx" ON "AdCampaign"("advertiserId", "createdAt");
CREATE INDEX "AdCampaign_placementId_status_idx" ON "AdCampaign"("placementId", "status");
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "AdPlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AdEvent" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "dayKey" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdEvent_eventType_check" CHECK ("eventType" IN ('IMPRESSION', 'CLICK')),
  CONSTRAINT "AdEvent_amountCents_check" CHECK ("amountCents" >= 0)
);
CREATE UNIQUE INDEX "AdEvent_eventKey_key" ON "AdEvent"("eventKey");
CREATE UNIQUE INDEX "AdEvent_campaignId_viewerId_eventType_dayKey_key" ON "AdEvent"("campaignId", "viewerId", "eventType", "dayKey");
CREATE INDEX "AdEvent_campaignId_eventType_createdAt_idx" ON "AdEvent"("campaignId", "eventType", "createdAt");
ALTER TABLE "AdEvent" ADD CONSTRAINT "AdEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdEvent" ADD CONSTRAINT "AdEvent_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
