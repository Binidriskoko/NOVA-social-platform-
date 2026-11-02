ALTER TABLE "Post"
  ADD COLUMN "moderationHiddenAt" TIMESTAMP(3),
  ADD COLUMN "moderationHiddenById" TEXT,
  ADD COLUMN "moderationReason" TEXT;

ALTER TABLE "Comment"
  ADD COLUMN "moderationHiddenAt" TIMESTAMP(3),
  ADD COLUMN "moderationHiddenById" TEXT,
  ADD COLUMN "moderationReason" TEXT;

ALTER TABLE "Message"
  ADD COLUMN "moderationHiddenAt" TIMESTAMP(3),
  ADD COLUMN "moderationHiddenById" TEXT,
  ADD COLUMN "moderationReason" TEXT;

ALTER TABLE "Report" ADD COLUMN "messageId" TEXT;
CREATE INDEX "Report_messageId_idx" ON "Report"("messageId");
ALTER TABLE "Report"
  ADD CONSTRAINT "Report_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
