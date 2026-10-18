CREATE TABLE "LiveBroadcast" (
  "id" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "visibility" TEXT NOT NULL DEFAULT 'private',
  "status" TEXT NOT NULL DEFAULT 'paused',
  "recordingStatus" TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  "replayUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "LiveBroadcast_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LiveBroadcast_hostId_status_createdAt_idx"
  ON "LiveBroadcast"("hostId", "status", "createdAt");
CREATE INDEX "LiveBroadcast_visibility_status_createdAt_idx"
  ON "LiveBroadcast"("visibility", "status", "createdAt");

ALTER TABLE "LiveBroadcast" ADD CONSTRAINT "LiveBroadcast_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "LiveBroadcast" (
  "id", "hostId", "title", "visibility", "status", "recordingStatus", "replayUrl", "createdAt", "updatedAt", "endedAt"
)
SELECT
  "id", "hostId", "title", 'private', 'ended',
  CASE WHEN "status" IN ('READY', 'PUBLISHED') THEN 'READY' ELSE 'UNAVAILABLE' END,
  CASE WHEN "status" IN ('READY', 'PUBLISHED') THEN "mediaUrl" ELSE NULL END,
  "createdAt", "updatedAt", "createdAt"
FROM "LiveReplay"
ON CONFLICT ("id") DO NOTHING;
