export function isLiveReplayOwner(replay: { hostId: string }, userId: string) {
  return replay.hostId === userId;
}
