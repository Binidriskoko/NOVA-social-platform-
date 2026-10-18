import { prisma, isDatabaseAvailable } from './prisma.js';
import { socialStore } from './socialStore.js';
import { realtimeHub } from './realtime.js';
import { isLiveKitConfigured } from './livekit.js';

export type NotificationPreference = {
  key: 'social' | 'messages' | 'security' | 'live' | 'calls' | 'mentions';
  enabled: boolean;
  channel: 'in_app' | 'email' | 'push';
};

export type PresenceState = {
  userId: string;
  online: boolean;
  status: string;
  lastSeen: string | null;
  updatedAt: string;
};

export type TypingState = {
  conversationId: string;
  userId: string;
  isTyping: boolean;
  updatedAt: string;
};

export type CallType = 'voice' | 'video';
export type CallStatus = 'ringing' | 'outgoing' | 'connected' | 'ended' | 'missed' | 'rejected' | 'cancelled';

export type CallParticipantState = {
  userId: string;
  status: 'pending' | 'accepted' | 'connected' | 'left';
  muted: boolean;
  cameraOn: boolean;
  speakerOn: boolean;
};

export type CallSession = {
  id: string;
  callerId: string;
  targetUserId?: string | null;
  type: CallType;
  status: CallStatus;
  participants: CallParticipantState[];
  provider: 'livekit';
  providerConfigured: boolean;
  conversationId?: string | null;
  connectedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LiveVisibility = 'public' | 'private';
export type LiveStatus = 'live' | 'paused' | 'ended';

export type LiveViewer = {
  userId: string;
  isMuted: boolean;
  isBlocked: boolean;
  joinedAt: string;
};

export type LiveComment = {
  id: string;
  userId: string;
  text: string;
  createdAt: string;
};

export type LiveReaction = {
  id: string;
  userId: string;
  type: 'LIKE' | 'LOVE' | 'CLAP' | 'CHEER';
  createdAt: string;
};

export type LiveGuest = {
  userId: string;
  role: 'GUEST' | 'COHOST';
  status: 'REQUESTED' | 'LIVE' | 'REMOVED';
  requestedAt: string;
};

export type LiveSession = {
  id: string;
  hostId: string;
  title: string;
  description?: string | null;
  visibility: LiveVisibility;
  status: LiveStatus;
  viewerCount: number;
  moderators: string[];
  viewers: LiveViewer[];
  guests: LiveGuest[];
  comments: LiveComment[];
  reactions: LiveReaction[];
  replayUrl?: string | null;
  recordingUrl?: string | null;
  recordingStatus: 'UNAVAILABLE' | 'RECORDING' | 'READY';
  analyticsHook: string | null;
  provider: 'livekit';
  providerConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

const globalStore = globalThis as typeof globalThis & {
  __novaPlatformStore?: {
    presence: PresenceState[];
    typing: TypingState[];
    callSessions: CallSession[];
    liveSessions: LiveSession[];
    notificationPreferences: Record<string, NotificationPreference[]>;
  };
};

if (!globalStore.__novaPlatformStore) {
  globalStore.__novaPlatformStore = {
    presence: [],
    typing: [],
    callSessions: [],
    liveSessions: [],
    notificationPreferences: {},
  };
}

function getStore() {
  return globalStore.__novaPlatformStore!;
}

function buildNotificationId() {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const defaultNotificationPreferences: NotificationPreference[] = [
    { key: 'social', enabled: true, channel: 'in_app' },
    { key: 'messages', enabled: true, channel: 'in_app' },
    { key: 'security', enabled: true, channel: 'in_app' },
    { key: 'live', enabled: true, channel: 'in_app' },
    { key: 'calls', enabled: true, channel: 'in_app' },
    { key: 'mentions', enabled: true, channel: 'in_app' },
];

export async function getNotificationPreferences(userId: string): Promise<NotificationPreference[]> {
  if (await isDatabaseAvailable()) {
    const stored = await prisma.notificationPreference.findMany({ where: { userId } });
    return defaultNotificationPreferences.map((preference) => {
      const saved = stored.find((entry) => entry.key === preference.key);
      return saved ? { key: preference.key, enabled: saved.enabled, channel: saved.channel as NotificationPreference['channel'] } : preference;
    });
  }

  const preferences = getStore().notificationPreferences[userId] ?? defaultNotificationPreferences;

  getStore().notificationPreferences[userId] = preferences;
  return [...preferences];
}

export async function setNotificationPreferences(userId: string, updates: Partial<Record<NotificationPreference['key'], Partial<Pick<NotificationPreference, 'enabled' | 'channel'>>>>): Promise<NotificationPreference[]> {
  const current = await getNotificationPreferences(userId);
  const next = current.map((pref) => {
    const patch = updates[pref.key];
    if (!patch) {
      return pref;
    }
    return {
      ...pref,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.channel ? { channel: patch.channel } : {}),
    };
  });

  if (await isDatabaseAvailable()) {
    await Promise.all(next.map((preference) => prisma.notificationPreference.upsert({
      where: { userId_key: { userId, key: preference.key } },
      create: { userId, ...preference },
      update: { enabled: preference.enabled, channel: preference.channel },
    })));
    return next;
  }

  getStore().notificationPreferences[userId] = next;
  return [...next];
}

export async function isNotificationEnabled(userId: string, type: string) {
  const key: NotificationPreference['key'] = type.includes('mention') ? 'mentions'
    : type.includes('message') ? 'messages'
      : type.includes('security') ? 'security'
        : type.includes('call') ? 'calls'
          : type.includes('live') ? 'live'
            : 'social';
  if (await isDatabaseAvailable()) {
    const preference = await prisma.notificationPreference.findUnique({ where: { userId_key: { userId, key } }, select: { enabled: true } });
    return preference?.enabled ?? true;
  }
  return (await getNotificationPreferences(userId)).find((preference) => preference.key === key)?.enabled ?? true;
}

export async function createNotification(
  recipientId: string,
  actorId: string | null,
  type: string,
  message: string,
  options: { link?: string; dedupeKey?: string } = {},
) {
  if (!(await isNotificationEnabled(recipientId, type))) return null;
  if (options.dedupeKey) {
    const livePreference = (await getNotificationPreferences(recipientId)).find((preference) => preference.key === 'live');
    if (livePreference?.channel !== 'in_app') return null;
  }
  const dbAvailable = await isDatabaseAvailable();
  const base = {
    id: buildNotificationId(),
    recipientId,
    actorId,
    type,
    message,
    ...(options.link ? { link: options.link } : {}),
    ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    createdAt: new Date().toISOString(),
    readAt: null,
  };

  if (dbAvailable) {
    let record;
    try {
      record = await prisma.notification.create({
        data: {
          recipientId,
          actorId,
          type,
          message,
          ...options,
        },
      });
    } catch (error) {
      if (options.dedupeKey && typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        return prisma.notification.findUnique({ where: { dedupeKey: options.dedupeKey } });
      }
      throw error;
    }

    realtimeHub.emit('notification:new', { notification: record, allowedUserIds: [recipientId] });
    return record;
  }

  if (options.dedupeKey && socialStore.state.notifications.some((notification) => notification.dedupeKey === options.dedupeKey)) {
    return socialStore.state.notifications.find((notification) => notification.dedupeKey === options.dedupeKey) ?? null;
  }
  socialStore.state.notifications.push(base);
  realtimeHub.emit('notification:new', { notification: base, allowedUserIds: [recipientId] });
  return base;
}

export async function listNotificationsForUser(userId: string, limit = 50) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const notifications = await prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const unreadCount = await prisma.notification.count({ where: { recipientId: userId, readAt: null } });
    return { notifications, unreadCount };
  }

  const notifications = socialStore.state.notifications
    .filter((notification) => notification.recipientId === userId)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit);

  const unreadCount = socialStore.state.notifications.filter((notification) => notification.recipientId === userId && !notification.readAt).length;
  return { notifications, unreadCount };
}

export async function markNotificationRead(notificationId: string, userId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const notification = await prisma.notification.findFirst({ where: { id: notificationId, recipientId: userId }, select: { id: true, recipientId: true } });
    if (!notification) {
      return null;
    }
    const updated = await prisma.notification.update({ where: { id: notification.id }, data: { readAt: new Date() } });
    realtimeHub.emit('notification:read', { notificationId: updated.id, recipientId: updated.recipientId, allowedUserIds: [userId] });
    return updated;
  }

  const index = socialStore.state.notifications.findIndex((notification) => notification.id === notificationId && notification.recipientId === userId);
  if (index === -1) {
    return null;
  }
  socialStore.state.notifications[index].readAt = new Date().toISOString();
  realtimeHub.emit('notification:read', { notificationId, recipientId: userId, allowedUserIds: [userId] });
  return socialStore.state.notifications[index];
}

export async function markAllNotificationsRead(userId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const affected = await prisma.notification.updateMany({ where: { recipientId: userId, readAt: null }, data: { readAt: new Date() } });
    realtimeHub.emit('notification:read', { recipientId: userId, all: true, allowedUserIds: [userId] });
    return affected.count;
  }

  const affected = socialStore.state.notifications.filter((notification) => notification.recipientId === userId && !notification.readAt);
  for (const notification of affected) {
    notification.readAt = new Date().toISOString();
  }
  realtimeHub.emit('notification:read', { recipientId: userId, all: true, allowedUserIds: [userId] });
  return affected.length;
}

export function setPresence(userId: string, next: { online?: boolean; status?: string; lastSeen?: string | null }) {
  const existing = getStore().presence.find((entry) => entry.userId === userId) ?? {
    userId,
    online: false,
    status: 'offline',
    lastSeen: null,
    updatedAt: new Date().toISOString(),
  };

  const record: PresenceState = {
    userId,
    online: next.online ?? existing.online,
    status: next.status ?? existing.status,
    lastSeen: next.lastSeen ?? (next.online === false ? new Date().toISOString() : existing.lastSeen),
    updatedAt: new Date().toISOString(),
  };

  const index = getStore().presence.findIndex((entry) => entry.userId === userId);
  if (index >= 0) {
    getStore().presence[index] = record;
  } else {
    getStore().presence.push(record);
  }

  realtimeHub.emit('presence:change', { ...record, allowedUserIds: [userId] });
  return { ...record };
}

export function getPresenceState(userId: string) {
  return getStore().presence.find((entry) => entry.userId === userId) ?? {
    userId,
    online: false,
    status: 'offline',
    lastSeen: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function setTypingState(conversationId: string, userId: string, isTyping: boolean) {
  const existing = getStore().typing.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
  const record: TypingState = {
    conversationId,
    userId,
    isTyping,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    Object.assign(existing, record);
  } else {
    getStore().typing.push(record);
  }

  const eventName = isTyping ? 'typing:start' : 'typing:stop';
  realtimeHub.emit(eventName, { conversationId, userId, isTyping, allowedUserIds: [userId] });
  return { ...record };
}

export function listCallHistory(userId: string) {
  return getStore().callSessions.filter((call) => call.participants.some((participant) => participant.userId === userId) && call.status !== 'cancelled');
}

export function createCallSession(callerId: string, targetUserIds: string[], type: CallType, conversationId?: string) {
  const now = new Date().toISOString();
  const call: CallSession = {
    id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    callerId,
    targetUserId: targetUserIds.length === 1 ? targetUserIds[0] : null,
    conversationId: conversationId ?? null,
    type,
    status: 'ringing',
    participants: [
      { userId: callerId, status: 'pending', muted: false, cameraOn: type === 'video', speakerOn: true },
      ...targetUserIds.map((userId) => ({ userId, status: 'pending' as const, muted: false, cameraOn: type === 'video', speakerOn: true })),
    ],
    provider: 'livekit',
    providerConfigured: isLiveKitConfigured(),
    createdAt: now,
    updatedAt: now,
  };
  getStore().callSessions.unshift(call);
  realtimeHub.emit('call:update', { call, allowedUserIds: call.participants.map((participant) => participant.userId) });
  return call;
}

export function getCallSession(callId: string) {
  return getStore().callSessions.find((call) => call.id === callId) ?? null;
}

export function updateCallSession(callId: string, changes: Partial<Pick<CallSession, 'status' | 'targetUserId' | 'type'>>, participantPatch?: Array<{ userId: string; muted?: boolean; cameraOn?: boolean; speakerOn?: boolean; status?: CallParticipantState['status'] }>) {
  const session = getStore().callSessions.find((entry) => entry.id === callId);
  if (!session) {
    return null;
  }

  if (changes.status) {
    session.status = changes.status;
    if (changes.status === 'connected') session.connectedAt ??= new Date().toISOString();
  }
  if (changes.targetUserId !== undefined) session.targetUserId = changes.targetUserId;
  if (changes.type) session.type = changes.type;

  if (participantPatch) {
    for (const patch of participantPatch) {
      const participant = session.participants.find((entry) => entry.userId === patch.userId);
      if (!participant) {
        continue;
      }
      if (patch.status) participant.status = patch.status;
      if (patch.muted !== undefined) participant.muted = patch.muted;
      if (patch.cameraOn !== undefined) participant.cameraOn = patch.cameraOn;
      if (patch.speakerOn !== undefined) participant.speakerOn = patch.speakerOn;
    }
  }

  session.updatedAt = new Date().toISOString();
  realtimeHub.emit('call:update', { call: session, allowedUserIds: session.participants.map((participant) => participant.userId) });
  return session;
}

export function getLiveSession(liveId: string) {
  return getStore().liveSessions.find((session) => session.id === liveId) ?? null;
}

export function listLiveSessions() {
  return [...getStore().liveSessions].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function createLiveSession(hostId: string, input: { title: string; description?: string; visibility: LiveVisibility }) {
  const now = new Date().toISOString();
  const live: LiveSession = {
    id: `live_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    hostId,
    title: input.title,
    description: input.description ?? null,
    visibility: input.visibility,
    status: 'paused',
    viewerCount: 0,
    moderators: [],
    viewers: [],
    guests: [],
    comments: [],
    reactions: [],
    replayUrl: null,
    recordingUrl: null,
    recordingStatus: 'UNAVAILABLE',
    analyticsHook: null,
    provider: 'livekit',
    providerConfigured: isLiveKitConfigured(),
    createdAt: now,
    updatedAt: now,
  };
  getStore().liveSessions.unshift(live);
  realtimeHub.emit('live:update', { live, allowedUserIds: [hostId] });
  return live;
}

export function updateLiveSession(liveId: string, updater: (session: LiveSession) => LiveSession) {
  const session = getStore().liveSessions.find((entry) => entry.id === liveId);
  if (!session) {
    return null;
  }

  const next = updater(session);
  next.updatedAt = new Date().toISOString();
  const index = getStore().liveSessions.findIndex((entry) => entry.id === liveId);
  getStore().liveSessions[index] = next;
  realtimeHub.emit('live:update', { live: next, allowedUserIds: [next.hostId, ...next.moderators, ...next.viewers.map((viewer) => viewer.userId)] });
  return next;
}

export function clearCommand2AStores() {
  getStore().presence = [];
  getStore().typing = [];
  getStore().callSessions = [];
  getStore().liveSessions = [];
  getStore().notificationPreferences = {};
}
