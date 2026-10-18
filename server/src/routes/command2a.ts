import { Router, type Request, type Response } from 'express';
import { TrackSource } from 'livekit-server-sdk';
import { z } from 'zod';
import { requireAuth, requireActiveAccountIfAuthenticated } from '../middleware/auth.js';
import { createCallSession, createLiveSession, createNotification, getCallSession, getLiveSession, getNotificationPreferences, listCallHistory, listLiveSessions, markAllNotificationsRead, markNotificationRead, setNotificationPreferences, setPresence, setTypingState, updateCallSession, updateLiveSession } from '../lib/platform.js';
import { socialStore } from '../lib/socialStore.js';
import { findUserById } from '../lib/fallbackStore.js';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { reviewContentForSafety } from '../lib/moderation.js';
import { callRoomName, createLiveKitToken, getLiveKitParticipants, isLiveKitConfigured, liveKitUrl, liveRoomName } from '../lib/livekit.js';
import { getMediaStorage, uploadedVideoBelongsTo, videoMediaKeyFromUrl } from '../lib/mediaStorage.js';
import { reviewContentForSafety as reviewPostContentForSafety } from '../lib/moderation.js';

const command2aRouter = Router();
command2aRouter.use(requireActiveAccountIfAuthenticated);
const startingLiveIds = new Set<string>();

const notificationPreferenceSchema = z.object({
  key: z.enum(['social', 'messages', 'security', 'live', 'calls', 'mentions']),
  enabled: z.boolean().optional(),
  channel: z.enum(['in_app', 'email', 'push']).optional(),
});

const updatePresenceSchema = z.object({
  online: z.boolean().optional(),
  status: z.string().trim().min(1).max(64).optional(),
  lastSeen: z.string().datetime().nullable().optional(),
});

const typingSchema = z.object({
  isTyping: z.boolean(),
});

const callSchema = z.object({
  targetUserId: z.string().min(1).optional(),
  targetUserIds: z.array(z.string().min(1)).min(1).max(7).optional(),
  conversationId: z.string().min(1).optional(),
  type: z.enum(['voice', 'video']).default('voice'),
}).refine((payload) => Boolean(payload.targetUserId || payload.targetUserIds || payload.conversationId), {
  message: 'Choose at least one call participant or a group conversation.',
});
const callControlSchema = z.object({ muted: z.boolean().optional(), cameraOn: z.boolean().optional(), speakerOn: z.boolean().optional() });
const liveCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  visibility: z.enum(['public', 'private']).default('public'),
});

const liveCommentSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

const liveReactionSchema = z.object({
  type: z.enum(['LIKE', 'LOVE', 'CLAP', 'CHEER']),
});
const liveReportSchema = z.object({
  category: z.enum(['SPAM', 'HARASSMENT', 'SEXUAL_CONTENT', 'HATE', 'VIOLENCE', 'SCAM', 'OTHER']),
  reason: z.string().trim().min(4).max(500),
});
const liveGuestSchema = z.object({ role: z.enum(['GUEST', 'COHOST']).default('GUEST') });
const liveViewerControlSchema = z.object({ isMuted: z.boolean() });

async function canViewConversation(conversationId: string, userId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const participant = await prisma.conversationParticipant.findFirst({ where: { conversationId, userId, leftAt: null }, select: { id: true } });
    return Boolean(participant);
  }
  return socialStore.state.conversationParticipants.some((participant) => participant.conversationId === conversationId && participant.userId === userId && !participant.leftAt);
}

async function isBlocked(userId: string, targetUserId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const [left, right] = await Promise.all([
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: userId, blockedId: targetUserId } }, select: { id: true } }),
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: targetUserId, blockedId: userId } }, select: { id: true } }),
    ]);
    return Boolean(left || right);
  }
  return socialStore.state.blocks.some((block) => (block.blockerId === userId && block.blockedId === targetUserId) || (block.blockerId === targetUserId && block.blockedId === userId));
}

function isCallParticipant(call: NonNullable<ReturnType<typeof getCallSession>>, userId: string) {
  return call.participants.some((participant) => participant.userId === userId);
}

function canManageLive(live: NonNullable<ReturnType<typeof getLiveSession>>, userId: string) {
  return live.hostId === userId || live.moderators.includes(userId);
}

async function canInteractWithLive(live: NonNullable<ReturnType<typeof getLiveSession>>, userId: string) {
  if (canManageLive(live, userId)) return !(await isBlocked(userId, live.hostId));
  if (live.visibility === 'private' || !live.viewers.some((viewer) => viewer.userId === userId && !viewer.isBlocked)) return false;
  return !(await isBlocked(userId, live.hostId));
}

async function presentLive(live: NonNullable<ReturnType<typeof getLiveSession>>) {
  const databaseAvailable = await isDatabaseAvailable();
  const host = await (databaseAvailable
    ? prisma.user.findUnique({ where: { id: live.hostId }, select: { name: true, profile: { select: { avatarUrl: true } } } })
    : Promise.resolve(findUserById(live.hostId)));
  const comments = databaseAvailable
    ? (await prisma.liveBroadcastComment.findMany({
      where: { liveId: live.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })).reverse().map((comment) => ({ id: comment.id, userId: comment.userId, text: comment.text, createdAt: comment.createdAt.toISOString() }))
    : live.comments;
  return {
    ...live,
    comments,
    host: host ? { name: host.name, avatar: 'profile' in host ? host.profile?.avatarUrl ?? null : null } : null,
  };
}

async function notifyLiveAudience(liveId: string, hostId: string, hostName: string, title: string) {
  const audienceIds = new Set<string>();
  if (await isDatabaseAvailable()) {
    const follows = await prisma.follow.findMany({
      where: { OR: [{ followingId: hostId }, { followerId: hostId }] },
      select: { followerId: true, followingId: true },
    });
    for (const follow of follows) {
      const userId = follow.followerId === hostId ? follow.followingId : follow.followerId;
      if (userId !== hostId) audienceIds.add(userId);
    }
    if (!audienceIds.size) return;
    const recipients = await prisma.user.findMany({
      where: { id: { in: [...audienceIds] }, status: 'ACTIVE' },
      select: { id: true },
    });
    const eligibleIds = new Set(recipients.map((recipient) => recipient.id));
    const blocks = await prisma.block.findMany({
      where: {
        OR: [
          { blockerId: hostId, blockedId: { in: [...eligibleIds] } },
          { blockerId: { in: [...eligibleIds] }, blockedId: hostId },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    for (const block of blocks) eligibleIds.delete(block.blockerId === hostId ? block.blockedId : block.blockerId);
    await Promise.all([...eligibleIds].map((recipientId) => createNotification(
      recipientId,
      hostId,
      'live_started',
      `${hostName} is live now: ${title}`,
      { link: `/live?live=${encodeURIComponent(liveId)}`, dedupeKey: `live_started:${liveId}:${recipientId}` },
    )));
    return;
  }

  for (const follow of socialStore.state.follows) {
    if (follow.followerId === hostId) audienceIds.add(follow.followingId);
    if (follow.followingId === hostId) audienceIds.add(follow.followerId);
  }
  await Promise.all([...audienceIds].filter((recipientId) => {
    const recipient = findUserById(recipientId);
    return recipient && recipientId !== hostId && recipient.status !== 'SUSPENDED' && recipient.status !== 'BANNED'
      && !socialStore.state.blocks.some((block) =>
        (block.blockerId === hostId && block.blockedId === recipientId)
        || (block.blockerId === recipientId && block.blockedId === hostId),
      );
  }).map((recipientId) => createNotification(
    recipientId,
    hostId,
    'live_started',
    `${hostName} is live now: ${title}`,
    { link: `/live?live=${encodeURIComponent(liveId)}`, dedupeKey: `live_started:${liveId}:${recipientId}` },
  )));
}

command2aRouter.get('/notifications', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const { notifications, unreadCount } = await (await import('../lib/platform.js')).listNotificationsForUser(userId, limit);
  return res.json({ notifications, unreadCount, totalCount: notifications.length });
});

command2aRouter.post('/notifications/:id/read', requireAuth, async (req, res) => {
  const item = await markNotificationRead(String(req.params.id), req.user!.id);
  if (!item) {
    return res.status(404).json({ message: 'Notification not found.' });
  }
  return res.json({ notification: item, message: 'Notification marked as read.' });
});

command2aRouter.post('/notifications/read-all', requireAuth, async (req, res) => {
  const count = await markAllNotificationsRead(req.user!.id);
  return res.json({ message: 'All notifications marked as read.', count });
});

command2aRouter.get('/notifications/preferences', requireAuth, async (req, res) => {
  return res.json({ preferences: await getNotificationPreferences(req.user!.id) });
});

command2aRouter.put('/notifications/preferences', requireAuth, async (req, res) => {
  const payload = notificationPreferenceSchema.parse(req.body ?? {});
  const next = await setNotificationPreferences(req.user!.id, { [payload.key]: { enabled: payload.enabled, channel: payload.channel } });
  return res.json({ preferences: next });
});

command2aRouter.post('/presence', requireAuth, async (req, res) => {
  const payload = updatePresenceSchema.parse(req.body ?? {});
  const state = setPresence(req.user!.id, payload);
  return res.json({ presence: state });
});

command2aRouter.get('/presence/:userId', requireAuth, async (req, res) => {
  const userId = String(req.params.userId);
  const target = findUserById(userId);
  if (!target) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const presence = (await import('../lib/platform.js')).getPresenceState(userId);
  return res.json({ userId, presence });
});

command2aRouter.post('/conversations/:id/typing', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const userId = req.user!.id;
  const payload = typingSchema.parse(req.body ?? {});

  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(404).json({ message: 'Conversation not found.' });
  }

  const typing = setTypingState(conversationId, userId, payload.isTyping);
  return res.json({ typing });
});

command2aRouter.post('/calls/start', requireAuth, async (req, res) => {
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'Calls are unavailable because LiveKit is not configured.' });
  const payload = callSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  let targetUserIds = payload.targetUserIds ?? (payload.targetUserId ? [payload.targetUserId] : []);

  if (payload.conversationId) {
    if (!(await canViewConversation(payload.conversationId, userId))) return res.status(404).json({ message: 'Group conversation not found.' });
    const members = await isDatabaseAvailable()
      ? (await prisma.conversationParticipant.findMany({ where: { conversationId: payload.conversationId, leftAt: null }, select: { userId: true } })).map((member) => member.userId)
      : socialStore.state.conversationParticipants.filter((member) => member.conversationId === payload.conversationId && !member.leftAt).map((member) => member.userId);
    const conversationTargets = members.filter((memberId) => memberId !== userId);
    if (targetUserIds.length && targetUserIds.some((memberId) => !conversationTargets.includes(memberId))) {
      return res.status(403).json({ message: 'Every call participant must belong to the selected conversation.' });
    }
    if (!targetUserIds.length) targetUserIds = conversationTargets;
  }

  if (!targetUserIds.length || targetUserIds.length > 7) return res.status(400).json({ message: 'Calls support one to seven other participants.' });
  if (new Set(targetUserIds).size !== targetUserIds.length || targetUserIds.includes(userId)) {
    return res.status(400).json({ message: 'Call participants must be unique and cannot include you.' });
  }

  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const found = await prisma.user.findMany({ where: { id: { in: targetUserIds } }, select: { id: true } });
    if (found.length !== targetUserIds.length) return res.status(404).json({ message: 'Call participant not found.' });
  } else if (targetUserIds.some((targetId) => !findUserById(targetId))) {
    return res.status(404).json({ message: 'Call participant not found.' });
  }
  for (const targetId of targetUserIds) {
    if (await isBlocked(userId, targetId)) return res.status(403).json({ message: 'You cannot call a user who has blocked you or who you have blocked.' });
  }

  const call = createCallSession(userId, targetUserIds, payload.type, payload.conversationId);
  return res.status(201).json({ call, message: 'Call started. Connecting to LiveKit.' });
});

command2aRouter.get('/calls/history', requireAuth, async (req, res) => {
  const history = listCallHistory(req.user!.id);
  return res.json({ calls: history });
});

command2aRouter.get('/calls/:id', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }

  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }

  return res.json({ call });
});

command2aRouter.post('/calls/:id/token', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) return res.status(404).json({ message: 'Call not found.' });
  const userId = req.user!.id;
  if (!isCallParticipant(call, userId)) return res.status(403).json({ message: 'You do not have access to this call.' });
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'Calls are unavailable because LiveKit is not configured.' });
  if (!['ringing', 'outgoing', 'connected'].includes(call.status)) return res.status(409).json({ message: 'This call is no longer active.' });
  const participant = call.participants.find((entry) => entry.userId === userId)!;
  for (const other of call.participants) {
    if (other.userId !== userId && other.status !== 'left' && await isBlocked(userId, other.userId)) {
      return res.status(403).json({ message: 'Blocked users cannot join this call.' });
    }
  }
  const mayJoin = userId === call.callerId
    ? participant.status !== 'left'
    : participant.status === 'accepted' || participant.status === 'connected';
  if (!mayJoin) return res.status(403).json({ message: 'Accept the incoming call before joining its media room.' });
  const room = callRoomName(call.id);
  const canPublishSources = call.type === 'video'
    ? [TrackSource.MICROPHONE, TrackSource.CAMERA]
    : [TrackSource.MICROPHONE];
  const token = await createLiveKitToken({ identity: userId, name: req.user!.name, room, canPublish: true, canPublishSources });
  return res.set('Cache-Control', 'no-store').json({ token, url: liveKitUrl(), room });
});

command2aRouter.post('/calls/:id/connected', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) return res.status(404).json({ message: 'Call not found.' });
  const userId = req.user!.id;
  if (!isCallParticipant(call, userId)) return res.status(403).json({ message: 'You do not have access to this call.' });
  if (['ended', 'cancelled', 'rejected', 'missed'].includes(call.status)) return res.status(409).json({ message: 'This call is no longer active.' });
  if (call.participants.find((participant) => participant.userId === userId)?.status === 'left') {
    return res.status(403).json({ message: 'You have left this call.' });
  }
  let roomParticipants: Awaited<ReturnType<typeof getLiveKitParticipants>>;
  try {
    roomParticipants = await getLiveKitParticipants(callRoomName(call.id));
  } catch {
    return res.status(503).json({ message: 'LiveKit could not verify the call media connection.' });
  }
  const connectedUserIds = new Set(roomParticipants.map((participant) => participant.identity));
  const requiredSources = call.type === 'video'
    ? [TrackSource.MICROPHONE, TrackSource.CAMERA]
    : [TrackSource.MICROPHONE];
  const connectedParticipantIds = call.participants
    .filter((participant) => participant.status !== 'left' && connectedUserIds.has(participant.userId))
    .filter((participant) => {
      const roomParticipant = roomParticipants.find((entry) => entry.identity === participant.userId);
      const publishedSources = new Set(roomParticipant?.tracks.filter((track) => !track.muted).map((track) => track.source) ?? []);
      return requiredSources.every((source) => publishedSources.has(source));
    })
    .map((participant) => participant.userId);
  if (!connectedParticipantIds.includes(userId)) {
    return res.status(409).json({ message: 'Your LiveKit media has not connected to this call.' });
  }
  if (connectedParticipantIds.length < 2) {
    return res.status(409).json({ message: 'A second call participant has not connected to LiveKit yet.' });
  }
  const participantPatch = connectedParticipantIds.map((connectedUserId) => ({ userId: connectedUserId, status: 'connected' as const }));
  const next = updateCallSession(call.id, { status: 'connected' }, participantPatch);
  return res.json({ call: next });
});

command2aRouter.post('/calls/:id/accept', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }
  if (!call.providerConfigured) {
    return res.status(503).json({ message: 'This call cannot connect because LiveKit is not configured.' });
  }

  if (call.status !== 'ringing') return res.status(409).json({ message: 'This call is no longer waiting for an answer.' });
  if (call.callerId === req.user!.id || call.participants.find((participant) => participant.userId === req.user!.id)?.status !== 'pending') {
    return res.status(409).json({ message: 'Only a pending invitee can accept this call.' });
  }
  const next = updateCallSession(call.id, {}, [{ userId: req.user!.id, status: 'accepted' }]);
  return res.json({ call: next, message: 'Call accepted. Establishing the encrypted media connection.' });
});

command2aRouter.post('/calls/:id/reject', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }
  if (call.callerId === req.user!.id || call.participants.find((participant) => participant.userId === req.user!.id)?.status !== 'pending') {
    return res.status(409).json({ message: 'Only a pending invitee can decline this call.' });
  }
  const allTargetsRejected = call.participants.filter((participant) => participant.userId !== call.callerId)
    .every((participant) => participant.userId === req.user!.id || participant.status === 'left');
  const next = updateCallSession(call.id, allTargetsRejected ? { status: 'rejected' } : {}, [{ userId: req.user!.id, status: 'left' }]);
  return res.json({ call: next, message: allTargetsRejected ? 'Call rejected.' : 'Call declined.' });
});

command2aRouter.post('/calls/:id/cancel', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (call.callerId !== req.user!.id) {
    return res.status(403).json({ message: 'Only the caller can cancel this call.' });
  }

  const next = updateCallSession(call.id, { status: 'cancelled' });
  return res.json({ call: next, message: 'Call cancelled.' });
});

command2aRouter.post('/calls/:id/end', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }

  const next = updateCallSession(call.id, { status: 'ended' });
  return res.json({ call: next, message: 'Call ended.' });
});

command2aRouter.post('/calls/:id/leave', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) return res.status(404).json({ message: 'Call not found.' });
  if (!isCallParticipant(call, req.user!.id)) return res.status(403).json({ message: 'You do not have access to this call.' });
  const allTargetsRejected = call.participants.every((participant) => participant.userId === req.user!.id || participant.status === 'left');
  const next = updateCallSession(call.id, allTargetsRejected ? { status: 'ended' } : {}, [{ userId: req.user!.id, status: 'left' }]);
  return res.json({ call: next, message: allTargetsRejected ? 'Call ended.' : 'You left the call.' });
});

command2aRouter.post('/calls/:id/mute', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) return res.status(403).json({ message: 'You do not have access to this call.' });
  const payload = callControlSchema.parse(req.body ?? {});
  if (payload.muted === undefined) return res.status(400).json({ message: 'muted is required.' });
  const muted = payload.muted;
  const next = updateCallSession(call.id, {}, [{ userId: req.user!.id, muted }]);
  return res.json({ call: next });
});

command2aRouter.post('/calls/:id/camera', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) return res.status(403).json({ message: 'You do not have access to this call.' });
  const payload = callControlSchema.parse(req.body ?? {});
  if (payload.cameraOn === undefined) return res.status(400).json({ message: 'cameraOn is required.' });
  const cameraOn = payload.cameraOn;
  const next = updateCallSession(call.id, {}, [{ userId: req.user!.id, cameraOn }]);
  return res.json({ call: next });
});

command2aRouter.post('/calls/:id/speaker', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) return res.status(404).json({ message: 'Call not found.' });
  if (!isCallParticipant(call, req.user!.id)) return res.status(403).json({ message: 'You do not have access to this call.' });
  const payload = callControlSchema.parse(req.body ?? {});
  if (payload.speakerOn === undefined) return res.status(400).json({ message: 'speakerOn is required.' });
  const next = updateCallSession(call.id, {}, [{ userId: req.user!.id, speakerOn: payload.speakerOn }]);
  return res.json({ call: next });
});

command2aRouter.post('/live/create', requireAuth, async (req, res) => {
  const payload = liveCreateSchema.parse(req.body ?? {});
  const live = createLiveSession(req.user!.id, payload);
  return res.status(201).json({ live, message: 'Live session created. Start broadcasting to publish through LiveKit.' });
});

command2aRouter.get('/live', requireAuth, async (req, res) => {
  const cutoff = Date.now() - 60_000;
  const lives = listLiveSessions().map((live) => {
    if (live.status !== 'live') return live;
    const viewers = live.viewers.filter((viewer) => new Date(viewer.joinedAt).getTime() >= cutoff);
    if (viewers.length === live.viewers.length) return live;
    return updateLiveSession(live.id, (session) => ({ ...session, viewers, viewerCount: viewers.length })) ?? live;
  }).filter((live) => live.visibility === 'public' || canManageLive(live, req.user!.id) || live.viewers.some((viewer) => viewer.userId === req.user!.id));
  return res.json({ lives: await Promise.all(lives.map(presentLive)) });
});

command2aRouter.get('/live/replays', requireAuth, async (req, res) => {
  if (!(await isDatabaseAvailable())) return res.status(503).json({ message: 'Persistent replay storage is unavailable.' });
  const replays = await prisma.liveReplay.findMany({
    where: { hostId: req.user!.id, status: { in: ['READY', 'PUBLISHED'] } },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ replays });
});

command2aRouter.get('/live/:id', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) {
    return res.status(404).json({ message: 'Live session not found.' });
  }
  if (live.visibility === 'private' && !canManageLive(live, req.user!.id) && !live.viewers.some((viewer) => viewer.userId === req.user!.id)) {
    return res.status(404).json({ message: 'Live session not found.' });
  }
  return res.json({ live: await presentLive(live) });
});

command2aRouter.post('/live/:id/start', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can start this live session.' });
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'Live broadcasts are unavailable because LiveKit is not configured.' });
  if (live.status === 'live') {
    let notificationWarning = false;
    if (live.visibility === 'public') {
      try {
        await notifyLiveAudience(live.id, live.hostId, req.user!.name, live.title);
      } catch {
        notificationWarning = true;
      }
    }
    return res.json({ live, message: 'Live session is already running.', notificationWarning });
  }
  if (live.status !== 'paused' || startingLiveIds.has(live.id)) return res.status(409).json({ message: 'This live session cannot be started in its current state.' });
  startingLiveIds.add(live.id);
  try {
    let participants;
    try {
      participants = await getLiveKitParticipants(liveRoomName(live.id));
    } catch {
      return res.status(503).json({ message: 'LiveKit could not verify the host broadcast.' });
    }
    const host = participants.find((participant) => participant.identity === live.hostId);
    const publishedSources = new Set(host?.tracks.filter((track) => !track.muted).map((track) => track.source) ?? []);
    if (!publishedSources.has(TrackSource.CAMERA) || !publishedSources.has(TrackSource.MICROPHONE)) {
      return res.status(409).json({ message: 'The host camera and microphone must be published before starting the live session.' });
    }
    const latest = getLiveSession(live.id);
    if (!latest || latest.status !== 'paused') return res.status(409).json({ message: 'This live session cannot be started in its current state.' });
    const next = updateLiveSession(live.id, (session) => ({ ...session, status: 'live', viewerCount: Math.max(0, session.viewerCount) }));
    let notificationWarning = false;
    if (next?.visibility === 'public') {
      try {
        await notifyLiveAudience(next.id, next.hostId, req.user!.name, next.title);
      } catch {
        notificationWarning = true;
      }
    }
    return res.json({ live: next, message: 'Live session started.', notificationWarning });
  } finally {
    startingLiveIds.delete(live.id);
  }
});

command2aRouter.post('/live/:id/token', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'Live broadcasts are unavailable because LiveKit is not configured.' });
  const userId = req.user!.id;
  const isHost = live.hostId === userId;
  if (isHost) {
    if (live.status !== 'paused' && live.status !== 'live') return res.status(409).json({ message: 'This live session is no longer active.' });
  } else {
    const viewer = live.viewers.find((entry) => entry.userId === userId && !entry.isBlocked);
    if (live.status !== 'live' || !viewer) return res.status(403).json({ message: 'Join this live session before requesting media access.' });
    if (live.visibility === 'private' && !canManageLive(live, userId)) {
      return res.status(403).json({ message: 'This live session is private.' });
    }
    if (await isBlocked(userId, live.hostId)) return res.status(403).json({ message: 'You cannot join this live session.' });
  }
  const room = liveRoomName(live.id);
  const token = await createLiveKitToken({
    identity: userId,
    name: req.user!.name,
    room,
    canPublish: isHost,
    ...(isHost ? { canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA] } : {}),
  });
  return res.set('Cache-Control', 'no-store').json({ token, url: liveKitUrl(), room, role: isHost ? 'host' : 'viewer' });
});

command2aRouter.post('/live/:id/end', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can end this live session.' });
  if (live.status === 'ended') return res.json({ live, message: 'Live session already ended.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, status: 'ended' }));
  return res.json({ live: next, message: 'Live session ended.' });
});

const liveReplaySchema = z.object({
  mediaUrl: z.string().trim().min(1).max(1000),
  contentType: z.enum(['video/mp4', 'video/webm', 'video/ogg']),
  durationSeconds: z.number().int().min(1).max(86_400),
}).strict();

command2aRouter.post('/live/:id/replay', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can save a live replay.' });
  if (live.status !== 'live' || live.recordingStatus !== 'RECORDING') return res.status(409).json({ message: 'A recording must be active before its replay can be saved.' });
  const parsed = liveReplaySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid live replay upload.', errors: parsed.error.flatten() });
  if (!(await uploadedVideoBelongsTo(parsed.data.mediaUrl, req.user!.id, process.env.NODE_ENV ?? 'development'))) {
    return res.status(400).json({ message: 'The replay must be a video uploaded by this account.' });
  }
  if (!(await isDatabaseAvailable())) return res.status(503).json({ message: 'Persistent replay storage is unavailable; this recording cannot be marked ready.' });
  const existing = await prisma.liveReplay.findUnique({ where: { id: live.id } });
  if (existing && existing.status !== 'DELETED') return res.status(409).json({ message: 'A replay has already been saved for this broadcast.' });
  const replay = await prisma.liveReplay.upsert({
    where: { id: live.id },
    create: {
      id: live.id,
      hostId: req.user!.id,
      title: live.title,
      mediaUrl: parsed.data.mediaUrl,
      contentType: parsed.data.contentType,
      durationSeconds: parsed.data.durationSeconds,
    },
    update: {
      mediaUrl: parsed.data.mediaUrl,
      contentType: parsed.data.contentType,
      durationSeconds: parsed.data.durationSeconds,
      status: 'READY',
      publishedPostId: null,
    },
  });
  const next = updateLiveSession(live.id, (session) => ({ ...session, recordingStatus: 'READY', replayUrl: replay.mediaUrl, recordingUrl: replay.mediaUrl }));
  return res.status(201).json({ replay, live: next });
});

const publishLiveReplaySchema = z.object({
  content: z.string().trim().max(2500).optional(),
  visibility: z.enum(['PUBLIC', 'FOLLOWERS', 'PRIVATE']).default('PUBLIC'),
}).strict();

command2aRouter.post('/live/:id/replay/publish', requireAuth, async (req, res) => {
  if (!(await isDatabaseAvailable())) return res.status(503).json({ message: 'Persistent replay publishing is unavailable.' });
  const parsed = publishLiveReplaySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid replay post details.', errors: parsed.error.flatten() });
  const replay = await prisma.liveReplay.findUnique({ where: { id: String(req.params.id) } });
  if (!replay) return res.status(404).json({ message: 'Live replay not found.' });
  if (replay.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can publish this replay.' });
  if (replay.status === 'PUBLISHED' && replay.publishedPostId) {
    const post = await prisma.post.findUnique({ where: { id: replay.publishedPostId } });
    if (post) return res.json({ replay, post, duplicate: true });
  }
  if (replay.status !== 'READY') return res.status(409).json({ message: 'This replay is not available for publishing.' });
  if (!(await uploadedVideoBelongsTo(replay.mediaUrl, req.user!.id, process.env.NODE_ENV ?? 'development'))) {
    return res.status(409).json({ message: 'The stored replay media is no longer available to this account.' });
  }
  const content = parsed.data.content || replay.title;
  const moderation = reviewPostContentForSafety({ type: 'post', text: content, userId: req.user!.id });
  if (moderation === 'REMOVE') return res.status(400).json({ message: 'This replay post violates NOVA Community & Safety Rules.' });
  if (moderation === 'REVIEW') return res.status(422).json({ message: 'This replay post requires moderator review.' });
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const current = await transaction.liveReplay.findUnique({ where: { id: replay.id } });
      if (!current || current.status !== 'READY' || current.hostId !== req.user!.id) {
        throw new Error('Replay is no longer available for publishing.');
      }
      const post = await transaction.post.create({
        data: {
          authorId: req.user!.id,
          content,
          imageUrl: current.mediaUrl,
          visibility: parsed.data.visibility,
          sourceLiveReplayId: current.id,
        },
      });
      const published = await transaction.liveReplay.update({
        where: { id: current.id },
        data: { status: 'PUBLISHED', publishedPostId: post.id },
      });
      return { replay: published, post };
    });
    return res.status(201).json({ ...result, duplicate: false });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      const published = await prisma.liveReplay.findUnique({ where: { id: replay.id } });
      if (published?.publishedPostId) {
        const post = await prisma.post.findUnique({ where: { id: published.publishedPostId } });
        if (post) return res.json({ replay: published, post, duplicate: true });
      }
    }
    throw error;
  }
});

command2aRouter.delete('/live/:id/replay', requireAuth, async (req, res) => {
  if (!(await isDatabaseAvailable())) return res.status(503).json({ message: 'Persistent replay storage is unavailable.' });
  const replay = await prisma.liveReplay.findUnique({ where: { id: String(req.params.id) } });
  if (!replay) return res.status(404).json({ message: 'Live replay not found.' });
  if (replay.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can delete this replay.' });
  if (!['READY', 'DELETING'].includes(replay.status)) return res.status(409).json({ message: 'Only an unpublished replay can be deleted.' });
  const key = videoMediaKeyFromUrl(replay.mediaUrl);
  if (!key || !(await uploadedVideoBelongsTo(replay.mediaUrl, req.user!.id, process.env.NODE_ENV ?? 'development'))) {
    return res.status(409).json({ message: 'The replay media could not be verified for safe deletion.' });
  }
  await prisma.liveReplay.update({ where: { id: replay.id }, data: { status: 'DELETING' } });
  await getMediaStorage(process.env.NODE_ENV ?? 'development').delete(key);
  const deleted = await prisma.liveReplay.update({ where: { id: replay.id }, data: { status: 'DELETED' } });
  return res.json({ deleted: true, replay: deleted });
});

command2aRouter.post('/live/:id/comment', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Comments are available while the live session is running.' });
  if (!(await canInteractWithLive(live, req.user!.id))) return res.status(403).json({ message: 'Join this live session and meet its audience permissions to comment.' });
  const payload = liveCommentSchema.parse(req.body ?? {});
  const moderation = reviewContentForSafety({ type: 'comment', text: payload.text, userId: req.user!.id });
  if (moderation === 'REMOVE') return res.status(400).json({ message: 'This comment violates NOVA Community & Safety Rules.' });
  if (moderation === 'REVIEW') return res.status(422).json({ message: 'This comment requires moderator review.' });
  const comment = await (await isDatabaseAvailable()
    ? prisma.liveBroadcastComment.create({ data: { liveId: live.id, userId: req.user!.id, text: payload.text } })
    : Promise.resolve({ id: `live_comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, liveId: live.id, userId: req.user!.id, text: payload.text, createdAt: new Date() }));
  const liveComment = { id: comment.id, userId: comment.userId, text: comment.text, createdAt: comment.createdAt.toISOString() };
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    comments: [...session.comments, liveComment],
  }));
  return res.status(201).json({ comment: liveComment, live: next && await presentLive(next) });
});

command2aRouter.post('/live/:id/react', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Reactions are available while the live session is running.' });
  if (!(await canInteractWithLive(live, req.user!.id))) return res.status(403).json({ message: 'Join this live session and meet its audience permissions to react.' });
  const payload = liveReactionSchema.parse(req.body ?? {});
  if (await isDatabaseAvailable()) {
    const where = { liveId_userId_type: { liveId: live.id, userId: req.user!.id, type: payload.type } };
    const existingInDatabase = await prisma.liveBroadcastReaction.findUnique({ where });
    if (existingInDatabase) return res.json({ reaction: existingInDatabase, duplicate: true });
    try {
      const reaction = await prisma.liveBroadcastReaction.create({ data: { liveId: live.id, userId: req.user!.id, type: payload.type } });
      updateLiveSession(live.id, (session) => ({
        ...session,
        reactions: session.reactions.some((entry) => entry.userId === req.user!.id && entry.type === payload.type)
          ? session.reactions
          : [...session.reactions, { id: reaction.id, userId: req.user!.id, type: payload.type, createdAt: reaction.createdAt.toISOString() }],
      }));
      return res.status(201).json({ reaction, duplicate: false });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        const duplicate = await prisma.liveBroadcastReaction.findUnique({ where });
        if (duplicate) return res.json({ reaction: duplicate, duplicate: true });
      }
      throw error;
    }
  }
  const existing = live.reactions.find((reaction) => reaction.userId === req.user!.id && reaction.type === payload.type);
  if (existing) return res.json({ reaction: existing, duplicate: true });
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    reactions: [...session.reactions, { id: `live_reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, userId: req.user!.id, type: payload.type, createdAt: new Date().toISOString() }],
  }));
  return res.status(201).json({ reaction: next!.reactions[next!.reactions.length - 1], duplicate: false });
});

command2aRouter.post('/live/:id/viewer/:userId/remove', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) {
    return res.status(403).json({ message: 'Only the host or moderator can remove viewers.' });
  }
  const viewerId = String(req.params.userId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: session.viewers.filter((viewer) => viewer.userId !== viewerId),
    viewerCount: session.viewers.some((viewer) => viewer.userId === viewerId) ? Math.max(0, session.viewerCount - 1) : session.viewerCount,
  }));
  return res.json({ live: next, message: 'Viewer removed.' });
});

command2aRouter.post('/live/:id/viewer/:userId/mute', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can mute viewers.' });
  const userId = String(req.params.userId);
  const payload = liveViewerControlSchema.parse(req.body ?? {});
  if (!live.viewers.some((viewer) => viewer.userId === userId)) return res.status(404).json({ message: 'Viewer not found.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, viewers: session.viewers.map((viewer) => viewer.userId === userId ? { ...viewer, isMuted: payload.isMuted } : viewer) }));
  return res.json({ live: next, viewer: next?.viewers.find((viewer) => viewer.userId === userId) });
});

command2aRouter.post('/live/:id/comments/:commentId/remove', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can remove comments.' });
  const commentId = String(req.params.commentId);
  if (!live.comments.some((comment) => comment.id === commentId)) return res.status(404).json({ message: 'Comment not found.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, comments: session.comments.filter((comment) => comment.id !== commentId) }));
  return res.json({ live: next, removed: commentId });
});

command2aRouter.post('/live/:id/moderators/:userId/add', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can assign moderators.' });
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    moderators: Array.from(new Set([...session.moderators, String(req.params.userId)])),
  }));
  return res.json({ live: next, message: 'Moderator added.' });
});

command2aRouter.post('/live/:id/moderators/:userId/remove', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can remove moderators.' });
  const userId = String(req.params.userId);
  const next = updateLiveSession(live.id, (session) => ({ ...session, moderators: session.moderators.filter((moderatorId) => moderatorId !== userId) }));
  return res.json({ live: next, message: 'Moderator removed.' });
});

command2aRouter.post('/live/:id/viewers/join', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'This live session is not running.' });
  if (live.visibility === 'private' && !canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'This live session is private.' });
  if (await isBlocked(req.user!.id, live.hostId)) return res.status(403).json({ message: 'You cannot join this live session.' });
  const existing = live.viewers.find((viewer) => viewer.userId === req.user!.id);
  const viewer = { ...(existing ?? { userId: req.user!.id, isMuted: false, isBlocked: false }), joinedAt: new Date().toISOString() };
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: [...session.viewers.filter((entry) => entry.userId !== viewer.userId), viewer],
    viewerCount: new Set([...session.viewers.map((entry) => entry.userId), viewer.userId]).size,
  }));
  if (existing) return res.json({ viewer, live: next });
  await createNotification(live.hostId, req.user!.id, 'live_viewer', `${req.user!.name} joined your live session.`);
  return res.status(201).json({ viewer, live: next });
});

command2aRouter.post('/live/:id/viewers/heartbeat', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'This live session is not running.' });
  const viewer = live.viewers.find((entry) => entry.userId === req.user!.id && !entry.isBlocked);
  if (!viewer) return res.status(409).json({ message: 'Join this live session again to continue watching.' });
  if (await isBlocked(req.user!.id, live.hostId)) return res.status(403).json({ message: 'You cannot watch this live session.' });
  const updatedViewer = { ...viewer, joinedAt: new Date().toISOString() };
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: session.viewers.map((entry) => entry.userId === req.user!.id ? updatedViewer : entry),
    viewerCount: session.viewers.length,
  }));
  return res.json({ live: next });
});

command2aRouter.post('/live/:id/viewers/leave', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  const wasViewer = live.viewers.some((viewer) => viewer.userId === req.user!.id);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: session.viewers.filter((viewer) => viewer.userId !== req.user!.id),
    viewerCount: wasViewer ? Math.max(0, session.viewerCount - 1) : session.viewerCount,
  }));
  return res.json({ left: wasViewer, live: next });
});

command2aRouter.post('/live/:id/guests/request', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Guest requests are available while the live session is running.' });
  if (live.hostId === req.user!.id) return res.status(400).json({ message: 'The host is already on stage.' });
  if (await isBlocked(req.user!.id, live.hostId)) return res.status(403).json({ message: 'You cannot request to join this live session.' });
  const payload = liveGuestSchema.parse(req.body ?? {});
  if (live.guests.some((guest) => guest.userId === req.user!.id && guest.status !== 'REMOVED')) return res.status(409).json({ message: 'A guest request already exists.' });
  const guest = { userId: req.user!.id, role: payload.role, status: 'REQUESTED' as const, requestedAt: new Date().toISOString() };
  const next = updateLiveSession(live.id, (session) => ({ ...session, guests: [...session.guests.filter((entry) => entry.userId !== req.user!.id), guest] }));
  await createNotification(live.hostId, req.user!.id, 'live_guest_request', `${req.user!.name} requested to join your live session.`);
  return res.status(201).json({ guest, live: next });
});

command2aRouter.post('/live/:id/guests/:userId/approve', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can approve guests.' });
  const userId = String(req.params.userId);
  const requested = live.guests.find((guest) => guest.userId === userId && guest.status === 'REQUESTED');
  if (!requested) return res.status(404).json({ message: 'Guest request not found.' });
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    guests: session.guests.map((guest) => guest.userId === userId ? { ...guest, status: 'LIVE' } : guest),
  }));
  return res.json({ guest: next!.guests.find((guest) => guest.userId === userId), live: next });
});

command2aRouter.post('/live/:id/guests/:userId/remove', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can remove guests.' });
  const userId = String(req.params.userId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    guests: session.guests.map((guest) => guest.userId === userId ? { ...guest, status: 'REMOVED' } : guest),
  }));
  return res.json({ live: next });
});

command2aRouter.post('/live/:id/follow', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId === req.user!.id) return res.status(400).json({ message: 'You already own this live session.' });
  if (await isBlocked(req.user!.id, live.hostId)) return res.status(403).json({ message: 'You cannot follow this host.' });
  if (await isDatabaseAvailable()) {
    const where = { followerId_followingId: { followerId: req.user!.id, followingId: live.hostId } };
    if (!(await prisma.follow.findUnique({ where, select: { id: true } }))) await prisma.follow.create({ data: { followerId: req.user!.id, followingId: live.hostId } });
  } else if (!socialStore.state.follows.some((follow) => follow.followerId === req.user!.id && follow.followingId === live.hostId)) {
    socialStore.state.follows.push({ id: `follow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, followerId: req.user!.id, followingId: live.hostId, createdAt: new Date().toISOString() });
  }
  await createNotification(live.hostId, req.user!.id, 'live_follow', `${req.user!.name} followed you from a live session.`);
  return res.json({ following: true, hostId: live.hostId });
});

command2aRouter.post('/live/:id/report', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  const payload = liveReportSchema.parse(req.body ?? {});
  const details = `Live report: ${live.title} (${live.id})\n\n${payload.reason}`;
  if (await isDatabaseAvailable()) {
    const report = await prisma.report.create({ data: { reporterId: req.user!.id, targetUserId: live.hostId, category: payload.category, details } });
    return res.status(201).json({ report, message: 'Report submitted.' });
  }
  const report = { id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, reporterId: req.user!.id, targetType: 'user' as const, targetId: live.hostId, category: payload.category, reason: details, createdAt: new Date().toISOString() };
  socialStore.state.reports.push(report);
  return res.status(201).json({ report, message: 'Report submitted.' });
});

command2aRouter.post('/live/:id/block/:userId', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can block viewers.' });
  const userId = String(req.params.userId);
  if (userId === live.hostId) return res.status(400).json({ message: 'The host cannot be blocked from their own session.' });
  if (await isDatabaseAvailable()) {
    const existing = await prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: req.user!.id, blockedId: userId } }, select: { id: true } });
    if (!existing) await prisma.block.create({ data: { blockerId: req.user!.id, blockedId: userId } });
  } else if (!socialStore.state.blocks.some((block) => block.blockerId === req.user!.id && block.blockedId === userId)) {
    socialStore.state.blocks.push({ id: `block_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, blockerId: req.user!.id, blockedId: userId, createdAt: new Date().toISOString() });
  }
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: session.viewers.filter((viewer) => viewer.userId !== userId),
    viewerCount: session.viewers.some((viewer) => viewer.userId === userId) ? Math.max(0, session.viewerCount - 1) : session.viewerCount,
    guests: session.guests.map((guest) => guest.userId === userId ? { ...guest, status: 'REMOVED' } : guest),
  }));
  return res.json({ blocked: true, live: next });
});

command2aRouter.post('/live/:id/recording/start', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can control recording.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Recording requires a running live session.' });
  if (live.recordingStatus === 'RECORDING') return res.status(409).json({ message: 'Recording is already active.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, recordingStatus: 'RECORDING' }));
  return res.json({ live: next, providerConfigured: live.providerConfigured });
});

command2aRouter.post('/live/:id/recording/stop', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can control recording.' });
  if (live.recordingStatus !== 'RECORDING') return res.status(409).json({ message: 'No recording is active.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, recordingStatus: session.replayUrl ? 'READY' : 'UNAVAILABLE' }));
  return res.json({ live: next, replayReady: Boolean(next?.replayUrl) });
});

command2aRouter.post('/live/:id/share', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  await createNotification(live.hostId, req.user!.id, 'live', `${req.user!.name} shared your live session.`);
  return res.json({ shared: true, live });
});

function aiUnavailable(_req: Request, res: Response) {
  return res.status(503).json({ message: 'AI assistance is unavailable because no AI provider is configured.' });
}

command2aRouter.post('/ai/summarize', aiUnavailable);
command2aRouter.post('/ai/translate', aiUnavailable);
command2aRouter.post('/ai/speech-to-text', aiUnavailable);
command2aRouter.post('/ai/smart-replies', aiUnavailable);
command2aRouter.post('/ai/captions', aiUnavailable);
command2aRouter.post('/ai/moderate', aiUnavailable);
command2aRouter.post('/ai/spam-scam-detect', aiUnavailable);

export { command2aRouter };
