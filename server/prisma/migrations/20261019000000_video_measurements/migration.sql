CREATE TABLE "VideoMeasurement" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'unknown',
  "watchSeconds" INTEGER NOT NULL DEFAULT 0,
  "durationSeconds" INTEGER NOT NULL,
  "lastPositionSeconds" INTEGER NOT NULL DEFAULT 0,
  "lastHeartbeatAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3) NOT NULL,
  "qualified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoMeasurement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VideoMeasurement_watch_seconds_check" CHECK ("watchSeconds" >= 0),
  CONSTRAINT "VideoMeasurement_duration_seconds_check" CHECK ("durationSeconds" > 0),
  CONSTRAINT "VideoMeasurement_position_seconds_check" CHECK ("lastPositionSeconds" >= 0)
);

CREATE UNIQUE INDEX "VideoMeasurement_postId_viewerId_sessionId_key"
  ON "VideoMeasurement"("postId", "viewerId", "sessionId");
CREATE INDEX "VideoMeasurement_postId_createdAt_idx"
  ON "VideoMeasurement"("postId", "createdAt");
CREATE INDEX "VideoMeasurement_viewerId_createdAt_idx"
  ON "VideoMeasurement"("viewerId", "createdAt");
CREATE INDEX "VideoMeasurement_qualified_createdAt_idx"
  ON "VideoMeasurement"("qualified", "createdAt");

ALTER TABLE "VideoMeasurement" ADD CONSTRAINT "VideoMeasurement_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoMeasurement" ADD CONSTRAINT "VideoMeasurement_viewerId_fkey"
  FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
