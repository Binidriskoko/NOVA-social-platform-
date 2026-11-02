CREATE TYPE "AppealStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED');

CREATE TABLE "Appeal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "openAppealUserId" TEXT,
  "originalAction" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'OPEN',
  "reviewerId" TEXT,
  "reviewerNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Appeal_userId_status_idx" ON "Appeal"("userId", "status");
CREATE INDEX "Appeal_status_createdAt_idx" ON "Appeal"("status", "createdAt");
CREATE UNIQUE INDEX "Appeal_openAppealUserId_key" ON "Appeal"("openAppealUserId");
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
