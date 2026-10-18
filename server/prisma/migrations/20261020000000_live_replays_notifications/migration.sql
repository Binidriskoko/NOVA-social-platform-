ALTER TABLE "Notification"
  ADD COLUMN "link" TEXT,
  ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "Notification_dedupeKey_key"
  ON "Notification"("dedupeKey");

ALTER TABLE "Post"
  ADD COLUMN "sourceLiveReplayId" TEXT;

CREATE UNIQUE INDEX "Post_sourceLiveReplayId_key"
  ON "Post"("sourceLiveReplayId");

CREATE TABLE "LiveReplay" (
  "id" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "mediaUrl" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'READY',
  "publishedPostId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveReplay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LiveReplay_durationSeconds_check" CHECK ("durationSeconds" >= 0)
);

CREATE UNIQUE INDEX "LiveReplay_publishedPostId_key"
  ON "LiveReplay"("publishedPostId");
CREATE INDEX "LiveReplay_hostId_status_createdAt_idx"
  ON "LiveReplay"("hostId", "status", "createdAt");

ALTER TABLE "LiveReplay" ADD CONSTRAINT "LiveReplay_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveReplay" ADD CONSTRAINT "LiveReplay_publishedPostId_fkey"
  FOREIGN KEY ("publishedPostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_sourceLiveReplayId_fkey"
  FOREIGN KEY ("sourceLiveReplayId") REFERENCES "LiveReplay"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LiveBroadcastComment" (
  "id" TEXT NOT NULL,
  "liveId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveBroadcastComment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveBroadcastReaction" (
  "id" TEXT NOT NULL,
  "liveId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveBroadcastReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LiveBroadcastReaction_liveId_userId_type_key"
  ON "LiveBroadcastReaction"("liveId", "userId", "type");
CREATE INDEX "LiveBroadcastComment_liveId_createdAt_idx"
  ON "LiveBroadcastComment"("liveId", "createdAt");
CREATE INDEX "LiveBroadcastReaction_liveId_createdAt_idx"
  ON "LiveBroadcastReaction"("liveId", "createdAt");

ALTER TABLE "LiveBroadcastComment" ADD CONSTRAINT "LiveBroadcastComment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveBroadcastReaction" ADD CONSTRAINT "LiveBroadcastReaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
