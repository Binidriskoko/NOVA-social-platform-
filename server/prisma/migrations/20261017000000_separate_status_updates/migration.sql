ALTER TABLE "Story"
ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'STORY';

CREATE INDEX "Story_kind_expiresAt_idx" ON "Story"("kind", "expiresAt");
