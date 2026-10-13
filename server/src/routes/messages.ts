import { Router } from 'express';
import { z } from 'zod';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { socialStore, type MessageRecord } from '../lib/socialStore.js';
import { requireAuth, requireActiveAccountIfAuthenticated } from '../middleware/auth.js';
import { attachmentMediaKeyFromUrl, mediaKeyFromUrl, uploadedMediaBelongsTo, getMediaStorage } from '../lib/mediaStorage.js';
import { reviewContentForSafety } from '../lib/moderation.js';
import { emitConversationEvent, subscribeToUserEvents } from '../lib/realtime.js';
import { findUserById } from '../lib/fallbackStore.js';
import type { Prisma } from '@prisma/client';

const createConversationSchema = z.object({
  participantId: z.string().min(1).optional(),
  participantIds: z.array(z.string().min(1)).min(1).max(49).optional(),
  name: z.string().trim().max(120).optional(),
  isChannel: z.boolean().optional(),
}).refine((payload) => Boolean(payload.participantId) !== Boolean(payload.participantIds), {
  message: 'Provide either participantId or participantIds.',
}).refine((payload) => !payload.participantIds || new Set(payload.participantIds).size === payload.participantIds.length, {
  message: 'Group participants must be unique.',
});

function isAllowedMessageMediaUrl(value: string) {
  if (mediaKeyFromUrl(value) || attachmentMediaKeyFromUrl(value)) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const messageSchema = z.object({
  contentType: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE', 'CONTACT', 'LOCATION']).default('TEXT'),
  text: z.string().trim().max(2000).optional(),
  mediaUrl: z.string().trim().max(2000).refine(isAllowedMessageMediaUrl, 'Use an HTTPS URL or an uploaded NOVAKOKO image.').optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  replyToId: z.string().min(1).optional(),
  status: z.enum(['SENT', 'DELIVERED', 'READ', 'FAILED']).optional(),
}).refine((payload) => payload.contentType !== 'TEXT' || Boolean(payload.text?.trim()), { message: 'Text messages need content.' })
  .refine((payload) => !['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE'].includes(payload.contentType) || Boolean(payload.mediaUrl), { message: 'Media messages need a media URL.' })
  .refine((payload) => !['CONTACT', 'LOCATION'].includes(payload.contentType) || Boolean(payload.metadata), { message: 'Contact and location messages need metadata.' });

const messageEditSchema = z.object({ text: z.string().trim().min(1).max(2000) });
const reactionSchema = z.object({ type: z.string().trim().min(1).max(24) });
const conversationPreferenceSchema = z.object({
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  starred: z.boolean().optional(),
  mutedUntil: z.string().datetime().nullable().optional(),
  disappearingAfterSeconds: z.number().int().min(0).max(90 * 24 * 60 * 60).optional(),
});
const addParticipantSchema = z.object({ participantIds: z.array(z.string().min(1)).min(1).max(49) });
const roleSchema = z.object({ role: z.enum(['MEMBER', 'MODERATOR']) });
const reportSchema = z.object({
  category: z.enum(['SPAM', 'HARASSMENT', 'SEXUAL_CONTENT', 'HATE', 'VIOLENCE', 'SCAM', 'OTHER']),
  reason: z.string().trim().min(4).max(500),
});

const canViewConversation = async (conversationId: string, userId: string) => {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const participant = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId },
      select: { id: true },
    });
    return Boolean(participant);
  }

  return socialStore.state.conversationParticipants.some(
    (participant) => participant.conversationId === conversationId && participant.userId === userId,
  );
};

const listConversationParticipantIds = async (conversationId: string) => {
  if (await isDatabaseAvailable()) {
    return (await prisma.conversationParticipant.findMany({ where: { conversationId }, select: { userId: true } })).map((participant) => participant.userId);
  }
  return socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversationId).map((participant) => participant.userId);
};

const isBlocked = async (userId: string, targetUserId: string) => {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const [userBlocked, targetBlocked] = await Promise.all([
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: userId, blockedId: targetUserId } }, select: { id: true } }),
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: targetUserId, blockedId: userId } }, select: { id: true } }),
    ]);
    return Boolean(userBlocked || targetBlocked);
  }

  return socialStore.state.blocks.some(
    (block) => (block.blockerId === userId && block.blockedId === targetUserId) || (block.blockerId === targetUserId && block.blockedId === userId),
  );
};

const messageToPublicShape = (message: any) => ({
  id: message.id,
  conversationId: message.conversationId,
  senderId: message.senderId,
  text: message.deletedAt ? '[deleted]' : message.text,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
  readAt: message.readAt,
  deletedAt: message.deletedAt,
  status: message.status,
  contentType: message.contentType ?? 'TEXT',
  mediaUrl: message.deletedAt ? null : message.mediaUrl ?? null,
  metadata: message.deletedAt ? null : message.metadata ?? null,
  replyToId: message.replyToId ?? null,
  forwardedFromId: message.forwardedFromId ?? null,
  editedAt: message.editedAt ?? null,
  expiresAt: message.expiresAt ?? null,
  reactions: message.reactions ?? [],
});

export const messagesRouter = Router();

messagesRouter.use(requireActiveAccountIfAuthenticated);

messagesRouter.post('/conversations', requireAuth, async (req, res) => {
  const payload = createConversationSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  const participantIds = payload.participantIds ?? [payload.participantId!];
  const conversationParticipantIds = [userId, ...participantIds];

  if (participantIds.includes(userId)) {
    return res.status(400).json({ message: 'You cannot create a conversation with yourself.' });
  }

  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const targetUsers = await prisma.user.findMany({ where: { id: { in: participantIds } }, select: { id: true } });
    if (targetUsers.length !== participantIds.length) {
      return res.status(404).json({ message: 'User not found.' });
    }

    for (const participantId of participantIds) {
      if (await isBlocked(userId, participantId)) {
        return res.status(403).json({ message: 'You cannot message a user who has blocked you or who you have blocked.' });
      }
    }

    if (participantIds.length === 1 && !payload.isChannel) {
      const existing = await prisma.conversation.findFirst({
        where: {
          AND: conversationParticipantIds.map((participantId) => ({ participants: { some: { userId: participantId } } })),
          participants: { every: { userId: { in: conversationParticipantIds } } },
        },
      });

      if (existing) {
        return res.status(200).json({ conversation: {
          id: existing.id,
          name: existing.name,
          updatedAt: existing.updatedAt,
          lastMessageAt: existing.lastMessageAt,
          lastMessagePreview: existing.lastMessagePreview,
        } });
      }
    }

    const conversation = await prisma.conversation.create({
      data: {
        name: payload.name ?? null,
        ownerId: userId,
        isChannel: payload.isChannel ?? false,
        participants: {
          create: conversationParticipantIds.map((participantId, index) => ({
            userId: participantId,
            role: index === 0 ? 'OWNER' : 'MEMBER',
          })),
        },
      },
      include: { participants: true },
    });

    return res.status(201).json({ conversation: {
      id: conversation.id,
      name: conversation.name,
      updatedAt: conversation.updatedAt,
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.lastMessagePreview,
    } });
  }

  if (participantIds.some((participantId) => !findUserById(participantId))) {
    return res.status(404).json({ message: 'User not found.' });
  }

  for (const participantId of participantIds) {
    if (await isBlocked(userId, participantId)) {
      return res.status(403).json({ message: 'You cannot message a user who has blocked you or who you have blocked.' });
    }
  }

  const existing = participantIds.length === 1 && !payload.isChannel ? socialStore.state.conversations.find((conversation) => {
    const existingParticipantIds = socialStore.state.conversationParticipants
      .filter((participant) => participant.conversationId === conversation.id)
      .map((participant) => participant.userId);
    return existingParticipantIds.length === 2 && conversationParticipantIds.every((participantId) => existingParticipantIds.includes(participantId));
  }) : undefined;

  if (existing) {
    return res.status(200).json({ conversation: existing });
  }

  const conversation = {
    id: `conversation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: payload.name ?? null,
    isChannel: payload.isChannel ?? false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMessageAt: null,
    lastMessagePreview: null,
    disappearingAfterSeconds: 0,
  };

  socialStore.state.conversations.push(conversation);
  conversationParticipantIds.forEach((participantId, index) => {
    socialStore.state.conversationParticipants.push({
      id: `participant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: conversation.id,
      userId: participantId,
      role: index === 0 ? 'OWNER' : 'MEMBER',
      joinedAt: new Date().toISOString(),
      lastReadAt: index === 0 ? new Date().toISOString() : null,
      leftAt: null,
    });
  });

  return res.status(201).json({ conversation });
});

messagesRouter.get('/conversations', requireAuth, async (_req, res) => {
  const userId = _req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const conversations = await prisma.conversation.findMany({
      where: { participants: { some: { userId } } },
      include: {
        participants: { include: { user: { select: { id: true, name: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { messages: { where: { senderId: { not: userId }, readAt: null, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } } } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return res.json({ conversations: conversations.map((conversation) => {
      const currentParticipant = conversation.participants.find((participant) => participant.userId === userId);
      return {
        id: conversation.id,
        name: conversation.name,
        updatedAt: conversation.updatedAt,
        lastMessageAt: conversation.lastMessageAt,
        lastMessagePreview: conversation.lastMessagePreview,
        pinnedAt: currentParticipant?.pinnedAt ?? null,
        archivedAt: currentParticipant?.archivedAt ?? null,
        starredAt: currentParticipant?.starredAt ?? null,
        mutedUntil: currentParticipant?.mutedUntil ?? null,
        unreadCount: conversation._count.messages,
        participants: conversation.participants.map((participant) => ({ id: participant.id, userId: participant.userId, role: participant.role, user: participant.user })),
        lastMessage: conversation.messages[0] ? messageToPublicShape(conversation.messages[0]) : null,
      };
    }) });
  }

  const conversations = socialStore.state.conversations.filter((conversation) => {
    const participants = socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversation.id);
    return participants.some((participant) => participant.userId === userId);
  });

  return res.json({ conversations: conversations.map((conversation) => {
    const participants = socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversation.id);
    const currentParticipant = participants.find((participant) => participant.userId === userId);
    return {
      ...conversation,
      pinnedAt: currentParticipant?.pinnedAt ?? null,
      archivedAt: currentParticipant?.archivedAt ?? null,
      starredAt: currentParticipant?.starredAt ?? null,
      mutedUntil: currentParticipant?.mutedUntil ?? null,
      unreadCount: socialStore.state.messages.filter((message) => message.conversationId === conversation.id && message.senderId !== userId && !message.readAt && !message.deletedAt && (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now())).length,
      participants: participants.map((participant) => ({
        ...participant,
        user: findUserById(participant.userId) ? { id: participant.userId, name: findUserById(participant.userId)!.name } : undefined,
      })),
      lastMessage: socialStore.state.messages
        .filter((message) => message.conversationId === conversation.id)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null,
    };
  }) });
});

messagesRouter.get('/conversations/:id', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const conversationId = String(req.params.id);

  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this conversation.' });
  }
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: { include: { user: { select: { id: true, name: true } } } },
        messages: { where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, include: { reactions: true }, orderBy: { createdAt: 'asc' } },
      },
    });

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    return res.json({ conversation: {
      id: conversation.id,
      name: conversation.name,
      updatedAt: conversation.updatedAt,
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.lastMessagePreview,
      isChannel: conversation.isChannel,
      disappearingAfterSeconds: conversation.disappearingAfterSeconds,
      participants: conversation.participants.map((participant) => ({ id: participant.id, userId: participant.userId, role: participant.role, user: participant.user })),
      messages: conversation.messages.filter((message) => !message.deletedAt).map(messageToPublicShape),
    } });
  }

  const conversation = socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (!conversation) {
    return res.status(404).json({ message: 'Conversation not found.' });
  }

  return res.json({
    conversation: {
      ...conversation,
      participants: socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversationId),
      messages: socialStore.state.messages
        .filter((message) => message.conversationId === conversationId && !message.deletedAt && (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now()))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map(messageToPublicShape),
    },
  });
});

messagesRouter.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const userId = req.user!.id;
  const payload = messageSchema.parse(req.body ?? {});

  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this conversation.' });
  }
  if (payload.mediaUrl && !(await uploadedMediaBelongsTo(payload.mediaUrl, userId, process.env.NODE_ENV ?? 'development'))) {
    return res.status(403).json({ message: 'You can only attach media that you uploaded.' });
  }
  const attachmentKey = payload.mediaUrl ? attachmentMediaKeyFromUrl(payload.mediaUrl) : null;
  if (attachmentKey) {
    const attachment = await getMediaStorage(process.env.NODE_ENV ?? 'development').get(attachmentKey);
    const supportedForType = payload.contentType === 'VOICE'
      ? attachment?.contentType.startsWith('audio/')
      : payload.contentType === 'VIDEO'
        ? attachment?.contentType.startsWith('video/')
        : payload.contentType === 'DOCUMENT'
          ? ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(attachment?.contentType ?? '')
          : false;
    if (!supportedForType) return res.status(400).json({ message: 'This attachment type does not match the message type.' });
  }
  const imageKey = payload.mediaUrl ? mediaKeyFromUrl(payload.mediaUrl) : null;
  if (imageKey) {
    const image = await getMediaStorage(process.env.NODE_ENV ?? 'development').get(imageKey);
    if (payload.contentType !== 'IMAGE' || image?.contentType !== 'image/webp') {
      return res.status(400).json({ message: 'This attachment type does not match the message type.' });
    }
  }

  const dbAvailable = await isDatabaseAvailable();
  const conversation = dbAvailable
    ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { isChannel: true, disappearingAfterSeconds: true } })
    : socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });
  if (conversation.isChannel) {
    const participant = dbAvailable
      ? await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } }, select: { role: true } })
      : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
    if (!participant || !['OWNER', 'MODERATOR'].includes(participant.role)) {
      return res.status(403).json({ message: 'Only channel admins and moderators can post.' });
    }
  }

  if (payload.replyToId) {
    const parent = dbAvailable
      ? await prisma.message.findFirst({ where: { id: payload.replyToId, conversationId, deletedAt: null }, select: { id: true } })
      : socialStore.state.messages.find((message) => message.id === payload.replyToId && message.conversationId === conversationId && !message.deletedAt);
    if (!parent) return res.status(404).json({ message: 'Reply target not found in this conversation.' });
  }

  const recipients = await (async () => {
    const dbAvailable = await isDatabaseAvailable();

    if (dbAvailable) {
      const participants = await prisma.conversationParticipant.findMany({
        where: { conversationId },
        select: { userId: true },
      });
      return participants.filter((participant) => participant.userId !== userId).map((participant) => participant.userId);
    }

    const participants = socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversationId);
    return participants.filter((participant) => participant.userId !== userId).map((participant) => participant.userId);
  })();

  for (const recipientId of recipients) {
    if (await isBlocked(userId, recipientId)) {
      return res.status(403).json({ message: 'You cannot send messages to a blocked user.' });
    }
  }

  const moderation = reviewContentForSafety({ type: 'message', text: payload.text ?? '', userId });
  if (moderation === 'REMOVE') {
    return res.status(400).json({ message: 'This message violates NOVA Community & Safety Rules.' });
  }
  if (moderation === 'REVIEW') {
    return res.status(422).json({ message: 'This content requires moderator review before publication.' });
  }

  if (dbAvailable) {
    const disappearingAfterSeconds = conversation.disappearingAfterSeconds ?? 0;
    const expiresAt = disappearingAfterSeconds > 0
      ? new Date(Date.now() + disappearingAfterSeconds * 1000)
      : undefined;
    const created = await prisma.message.create({
      data: {
        conversationId,
        senderId: userId,
        text: payload.text ?? '',
        status: (payload.status ?? 'SENT') as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
        contentType: payload.contentType,
        mediaUrl: payload.mediaUrl,
        metadata: payload.metadata as Prisma.InputJsonValue | undefined,
        replyToId: payload.replyToId,
        expiresAt,
      },
    });

    const preview = payload.text || `[${payload.contentType.toLowerCase()}]`;

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: created.createdAt,
        lastMessagePreview: preview,
        updatedAt: created.updatedAt,
      },
    });

    emitConversationEvent('message:new', conversationId, { message: messageToPublicShape(created), senderId: userId }, [userId, ...recipients]);

    return res.status(201).json({ message: messageToPublicShape(created) });
  }

  const created = {
    id: `message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    senderId: userId,
    text: payload.text ?? '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    readAt: null,
    deletedAt: null,
    status: payload.status ?? 'SENT',
    contentType: payload.contentType,
    mediaUrl: payload.mediaUrl ?? null,
    metadata: payload.metadata ?? null,
    replyToId: payload.replyToId ?? null,
    forwardedFromId: null,
    editedAt: null,
    expiresAt: conversation.disappearingAfterSeconds && conversation.disappearingAfterSeconds > 0
      ? new Date(Date.now() + conversation.disappearingAfterSeconds * 1000).toISOString()
      : null,
  };

  socialStore.state.messages.push(created);

  const fallbackConversation = socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (fallbackConversation) {
    fallbackConversation.updatedAt = new Date().toISOString();
    fallbackConversation.lastMessageAt = new Date().toISOString();
    fallbackConversation.lastMessagePreview = payload.text || `[${payload.contentType.toLowerCase()}]`;
  }

  emitConversationEvent('message:new', conversationId, { message: messageToPublicShape(created), senderId: userId }, [userId, ...recipients]);

  return res.status(201).json({ message: messageToPublicShape(created) });
});

messagesRouter.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const userId = req.user!.id;

  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this conversation.' });
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const messages = await prisma.message.findMany({
      where: { conversationId, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}) },
      include: { reactions: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return res.json({ messages: messages.reverse().map(messageToPublicShape), hasMore: messages.length === limit });
  }

  const messages = socialStore.state.messages
    .filter((message) => message.conversationId === conversationId && !message.deletedAt && (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now()))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((message) => !before || new Date(message.createdAt) < before)
    .slice(0, limit)
    .reverse();

  return res.json({ messages: messages.map(messageToPublicShape), hasMore: messages.length === limit });
});

messagesRouter.post('/conversations/:id/read', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const userId = req.user!.id;
  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this conversation.' });
  }

  const readAt = new Date();
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: readAt },
    });
    const unreadMessages = await prisma.message.findMany({
      where: { conversationId, senderId: { not: userId }, readAt: null },
      select: { id: true, senderId: true },
    });
    if (unreadMessages.length) {
      await prisma.message.updateMany({ where: { id: { in: unreadMessages.map((message) => message.id) } }, data: { readAt, status: 'READ' } });
      for (const message of unreadMessages) {
        emitConversationEvent('message:read', conversationId, { messageId: message.id, readAt }, [message.senderId]);
      }
    }
  } else {
    const participant = socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
    if (participant) participant.lastReadAt = readAt.toISOString();
    socialStore.state.messages.filter((message) => message.conversationId === conversationId && message.senderId !== userId && !message.readAt).forEach((message) => {
      message.readAt = readAt.toISOString();
      message.status = 'READ';
      emitConversationEvent('message:read', conversationId, { messageId: message.id, readAt: message.readAt }, [message.senderId]);
    });
  }
  return res.json({ readAt });
});

messagesRouter.get('/realtime', requireAuth, (req, res) => {
  const userId = req.user!.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ userId })}\n\n`);
  const unsubscribe = subscribeToUserEvents(userId, (payload) => {
    const event = typeof payload === 'object' && payload !== null && 'event' in payload ? String((payload as { event: string }).event) : 'update';
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

messagesRouter.post('/messages/:id/read', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, conversationId: true, senderId: true },
    });

    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    if (!(await canViewConversation(message.conversationId, userId))) {
      return res.status(403).json({ message: 'You do not have access to this message.' });
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { readAt: new Date(), status: 'READ' },
    });

    emitConversationEvent('message:read', message.conversationId, { messageId: updated.id, readAt: updated.readAt }, [userId]);
    return res.json({ message: messageToPublicShape(updated) });
  }

  const message = socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message) {
    return res.status(404).json({ message: 'Message not found.' });
  }

  if (!(await canViewConversation(message.conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this message.' });
  }

  message.readAt = new Date().toISOString();
  message.status = 'READ';

  emitConversationEvent('message:read', message.conversationId, { messageId: message.id, readAt: message.readAt }, [userId]);
  return res.json({ message: messageToPublicShape(message) });
});

messagesRouter.delete('/messages/:id', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, senderId: true, conversationId: true, deletedAt: true },
    });

    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    if (message.senderId !== userId) {
      return res.status(403).json({ message: 'You cannot delete this message.' });
    }

    const deleted = await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), status: 'DELETED', text: '[deleted]' },
    });
    emitConversationEvent('message:new', message.conversationId, { message: messageToPublicShape(deleted), deleted: true }, await listConversationParticipantIds(message.conversationId));
    return res.json({ message: messageToPublicShape(deleted) });
  }

  const message = socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message) {
    return res.status(404).json({ message: 'Message not found.' });
  }

  if (message.senderId !== userId) {
    return res.status(403).json({ message: 'You cannot delete this message.' });
  }

  message.deletedAt = new Date().toISOString();
  message.status = 'DELETED' as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'DELETED';
  message.text = '[deleted]';
  emitConversationEvent('message:new', message.conversationId, { message: messageToPublicShape(message), deleted: true }, await listConversationParticipantIds(message.conversationId));
  return res.json({ message: messageToPublicShape(message) });
});

messagesRouter.patch('/messages/:id', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const payload = messageEditSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const current = dbAvailable
    ? await prisma.message.findUnique({ where: { id: messageId } })
    : socialStore.state.messages.find((message) => message.id === messageId);
  if (!current || current.deletedAt) return res.status(404).json({ message: 'Message not found.' });
  if (current.senderId !== userId) return res.status(403).json({ message: 'You cannot edit this message.' });
  if ((current.contentType ?? 'TEXT') !== 'TEXT') return res.status(400).json({ message: 'Only text messages can be edited.' });
  const moderation = reviewContentForSafety({ type: 'message', text: payload.text, userId });
  if (moderation !== 'ALLOW') return res.status(moderation === 'REMOVE' ? 400 : 422).json({ message: 'This message cannot be published under NOVA Community & Safety Rules.' });
  const editedAt = new Date();
  const updated = dbAvailable
    ? await prisma.message.update({ where: { id: messageId }, data: { text: payload.text, editedAt } })
    : Object.assign(current, { text: payload.text, editedAt: editedAt.toISOString(), updatedAt: editedAt.toISOString() });
  emitConversationEvent('message:new', current.conversationId, { message: messageToPublicShape(updated), edited: true }, await listConversationParticipantIds(current.conversationId));
  return res.json({ message: messageToPublicShape(updated) });
});

messagesRouter.post('/messages/:id/forward', requireAuth, async (req, res) => {
  const sourceId = String(req.params.id);
  const targetConversationId = z.object({ conversationId: z.string().min(1) }).parse(req.body ?? {}).conversationId;
  const userId = req.user!.id;
  if (!(await canViewConversation(targetConversationId, userId))) return res.status(403).json({ message: 'You do not have access to the destination conversation.' });
  const dbAvailable = await isDatabaseAvailable();
  const source = dbAvailable
    ? await prisma.message.findUnique({ where: { id: sourceId } })
    : socialStore.state.messages.find((message) => message.id === sourceId);
  if (!source || source.deletedAt) return res.status(404).json({ message: 'Message not found.' });
  if (!(await canViewConversation(source.conversationId, userId))) return res.status(403).json({ message: 'You do not have access to this message.' });
  const target = dbAvailable
    ? await prisma.conversation.findUnique({ where: { id: targetConversationId }, select: { isChannel: true, disappearingAfterSeconds: true } })
    : socialStore.state.conversations.find((entry) => entry.id === targetConversationId);
  if (!target) return res.status(404).json({ message: 'Destination conversation not found.' });
  if (target.isChannel) {
    const member = dbAvailable
      ? await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId: targetConversationId, userId } }, select: { role: true } })
      : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === targetConversationId && entry.userId === userId);
    if (!member || !['OWNER', 'MODERATOR'].includes(member.role)) return res.status(403).json({ message: 'Only channel admins and moderators can post.' });
  }
  const recipients = dbAvailable
    ? (await prisma.conversationParticipant.findMany({ where: { conversationId: targetConversationId }, select: { userId: true } })).map((entry) => entry.userId)
    : socialStore.state.conversationParticipants.filter((entry) => entry.conversationId === targetConversationId).map((entry) => entry.userId);
  for (const recipientId of recipients) {
    if (recipientId !== userId && await isBlocked(userId, recipientId)) return res.status(403).json({ message: 'You cannot forward messages to a blocked user.' });
  }
  const expiresAt = target.disappearingAfterSeconds && target.disappearingAfterSeconds > 0
    ? new Date(Date.now() + target.disappearingAfterSeconds * 1000)
    : null;
  const forwarded = dbAvailable
    ? await prisma.message.create({ data: {
      conversationId: targetConversationId,
      senderId: userId,
      text: source.text,
      contentType: source.contentType,
      mediaUrl: source.mediaUrl,
      metadata: (source.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      forwardedFromId: source.id,
      expiresAt: expiresAt ?? undefined,
    } })
    : {
      id: `message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: targetConversationId,
      senderId: userId,
      text: source.text,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      readAt: null,
      deletedAt: null,
      status: 'SENT' as const,
      contentType: source.contentType ?? 'TEXT',
      mediaUrl: source.mediaUrl ?? null,
      metadata: source.metadata ?? null,
      replyToId: null,
      forwardedFromId: source.id,
      editedAt: null,
      expiresAt: expiresAt?.toISOString() ?? null,
    };
  if (!dbAvailable) socialStore.state.messages.push(forwarded as MessageRecord);
  const preview = forwarded.text || `[${forwarded.contentType.toLowerCase()}]`;
  if (dbAvailable) await prisma.conversation.update({ where: { id: targetConversationId }, data: { lastMessageAt: forwarded.createdAt, lastMessagePreview: preview } });
  else {
    const targetConversationRecord = socialStore.state.conversations.find((entry) => entry.id === targetConversationId);
    if (targetConversationRecord) {
      targetConversationRecord.updatedAt = forwarded.updatedAt instanceof Date ? forwarded.updatedAt.toISOString() : forwarded.updatedAt;
      targetConversationRecord.lastMessageAt = forwarded.createdAt instanceof Date ? forwarded.createdAt.toISOString() : forwarded.createdAt;
      targetConversationRecord.lastMessagePreview = preview;
    }
  }
  emitConversationEvent('message:new', targetConversationId, { message: messageToPublicShape(forwarded), senderId: userId }, [userId, ...recipients]);
  return res.status(201).json({ message: messageToPublicShape(forwarded) });
});

messagesRouter.post('/messages/:id/reactions', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const { type } = reactionSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const message = dbAvailable
    ? await prisma.message.findUnique({ where: { id: messageId }, include: { reactions: true } })
    : socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message || message.deletedAt) return res.status(404).json({ message: 'Message not found.' });
  if (!(await canViewConversation(message.conversationId, userId))) return res.status(403).json({ message: 'You do not have access to this message.' });
  if (dbAvailable) {
    const existing = await prisma.messageReaction.findUnique({ where: { messageId_userId_type: { messageId, userId, type } } });
    if (existing) await prisma.messageReaction.delete({ where: { id: existing.id } });
    else await prisma.messageReaction.create({ data: { messageId, userId, type } });
    const reactions = await prisma.messageReaction.findMany({ where: { messageId } });
    emitConversationEvent('message:new', message.conversationId, { messageId, reactions }, await listConversationParticipantIds(message.conversationId));
    return res.json({ reactions, active: !existing });
  }
  const index = socialStore.state.messageReactions.findIndex((entry) => entry.messageId === messageId && entry.userId === userId && entry.type === type);
  if (index >= 0) socialStore.state.messageReactions.splice(index, 1);
  else socialStore.state.messageReactions.push({ id: `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, messageId, userId, type, createdAt: new Date().toISOString() });
  const reactions = socialStore.state.messageReactions.filter((entry) => entry.messageId === messageId);
  emitConversationEvent('message:new', message.conversationId, { messageId, reactions }, await listConversationParticipantIds(message.conversationId));
  return res.json({ reactions, active: index < 0 });
});

messagesRouter.get('/messages/search', requireAuth, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
  if (query.length < 2 || query.length > 100) return res.status(400).json({ message: 'Search query must be 2 to 100 characters.' });
  const dbAvailable = await isDatabaseAvailable();
  if (conversationId && !(await canViewConversation(conversationId, req.user!.id))) return res.status(403).json({ message: 'You do not have access to this conversation.' });
  if (dbAvailable) {
    const messages = await prisma.message.findMany({
      where: {
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        text: { contains: query, mode: 'insensitive' },
        ...(conversationId ? { conversationId } : { conversation: { participants: { some: { userId: req.user!.id } } } }),
      },
      include: { reactions: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json({ messages: messages.map(messageToPublicShape) });
  }
  const allowedConversationIds = new Set(socialStore.state.conversationParticipants.filter((entry) => entry.userId === req.user!.id).map((entry) => entry.conversationId));
  const messages = socialStore.state.messages.filter((message) =>
    message.text.toLowerCase().includes(query.toLowerCase()) && !message.deletedAt &&
    (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now()) &&
    (conversationId ? message.conversationId === conversationId : allowedConversationIds.has(message.conversationId)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50);
  return res.json({ messages: messages.map(messageToPublicShape) });
});

messagesRouter.get('/conversations/:id/media', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  if (!(await canViewConversation(conversationId, req.user!.id))) return res.status(403).json({ message: 'You do not have access to this conversation.' });
  const dbAvailable = await isDatabaseAvailable();
  const allowedTypes = ['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE'];
  const media = dbAvailable
    ? await prisma.message.findMany({ where: { conversationId, contentType: { in: allowedTypes }, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, include: { reactions: true }, orderBy: { createdAt: 'desc' }, take: 200 })
    : socialStore.state.messages.filter((entry) => entry.conversationId === conversationId && allowedTypes.includes(entry.contentType ?? 'TEXT') && !entry.deletedAt && (!entry.expiresAt || new Date(entry.expiresAt).getTime() > Date.now())).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  return res.json({ media: media.map(messageToPublicShape) });
});

messagesRouter.post('/messages/:id/report', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const payload = reportSchema.parse(req.body ?? {});
  const dbAvailable = await isDatabaseAvailable();
  const message = dbAvailable
    ? await prisma.message.findUnique({ where: { id: messageId }, select: { id: true, conversationId: true, senderId: true } })
    : socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message) return res.status(404).json({ message: 'Message not found.' });
  if (!(await canViewConversation(message.conversationId, req.user!.id))) return res.status(403).json({ message: 'You do not have access to this message.' });
  if (message.senderId === req.user!.id) return res.status(400).json({ message: 'You cannot report your own message.' });
  const details = `Message report: ${messageId} in ${message.conversationId}\n\n${payload.reason}`;
  if (dbAvailable) {
    const report = await prisma.report.create({ data: { reporterId: req.user!.id, targetUserId: message.senderId, category: payload.category, details } });
    return res.status(201).json({ report, message: 'Report submitted.' });
  }
  const report = { id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, reporterId: req.user!.id, targetType: 'user' as const, targetId: message.senderId, category: payload.category, reason: details, createdAt: new Date().toISOString() };
  socialStore.state.reports.push(report);
  return res.status(201).json({ report, message: 'Report submitted.' });
});

messagesRouter.patch('/conversations/:id/preferences', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const payload = conversationPreferenceSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  if (!(await canViewConversation(conversationId, userId))) return res.status(403).json({ message: 'You do not have access to this conversation.' });
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const [participant, conversation] = await Promise.all([
      prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } } }),
      payload.disappearingAfterSeconds === undefined ? null : prisma.conversation.findUnique({ where: { id: conversationId }, select: { ownerId: true } }),
    ]);
    if (!participant) return res.status(404).json({ message: 'Conversation membership not found.' });
    if (conversation && conversation.ownerId !== userId && participant.role !== 'MODERATOR') return res.status(403).json({ message: 'Only group admins can change disappearing-message settings.' });
    const updated = await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: {
        ...(payload.pinned === undefined ? {} : { pinnedAt: payload.pinned ? new Date() : null }),
        ...(payload.archived === undefined ? {} : { archivedAt: payload.archived ? new Date() : null }),
        ...(payload.starred === undefined ? {} : { starredAt: payload.starred ? new Date() : null }),
        ...(payload.mutedUntil === undefined ? {} : { mutedUntil: payload.mutedUntil ? new Date(payload.mutedUntil) : null }),
      },
    });
    if (payload.disappearingAfterSeconds !== undefined) await prisma.conversation.update({ where: { id: conversationId }, data: { disappearingAfterSeconds: payload.disappearingAfterSeconds } });
    return res.json({ preferences: updated, disappearingAfterSeconds: payload.disappearingAfterSeconds });
  }
  const participant = socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
  const conversation = socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (!participant || !conversation) return res.status(404).json({ message: 'Conversation membership not found.' });
  if (payload.disappearingAfterSeconds !== undefined && participant.role !== 'OWNER' && participant.role !== 'MODERATOR') return res.status(403).json({ message: 'Only group admins can change disappearing-message settings.' });
  if (payload.pinned !== undefined) participant.pinnedAt = payload.pinned ? new Date().toISOString() : null;
  if (payload.archived !== undefined) participant.archivedAt = payload.archived ? new Date().toISOString() : null;
  if (payload.starred !== undefined) participant.starredAt = payload.starred ? new Date().toISOString() : null;
  if (payload.mutedUntil !== undefined) participant.mutedUntil = payload.mutedUntil;
  if (payload.disappearingAfterSeconds !== undefined) conversation.disappearingAfterSeconds = payload.disappearingAfterSeconds;
  return res.json({ preferences: participant, disappearingAfterSeconds: conversation.disappearingAfterSeconds });
});

messagesRouter.post('/conversations/:id/participants', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const { participantIds } = addParticipantSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const actor = await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } }, select: { role: true } });
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, ownerId: true } });
    if (!actor || !conversation) return res.status(404).json({ message: 'Conversation not found.' });
    if (conversation.ownerId !== userId && actor.role !== 'MODERATOR') return res.status(403).json({ message: 'Only group admins can add participants.' });
    const found = await prisma.user.findMany({ where: { id: { in: participantIds } }, select: { id: true } });
    if (found.length !== participantIds.length) return res.status(404).json({ message: 'User not found.' });
    for (const targetId of participantIds) if (await isBlocked(userId, targetId)) return res.status(403).json({ message: 'You cannot add a blocked user.' });
    await prisma.conversationParticipant.createMany({ data: participantIds.map((targetId) => ({ conversationId, userId: targetId, role: 'MEMBER' })), skipDuplicates: true });
    return res.status(201).json({ added: participantIds });
  }
  const actor = socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
  const conversation = socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (!actor || !conversation) return res.status(404).json({ message: 'Conversation not found.' });
  if (actor.role !== 'OWNER' && actor.role !== 'MODERATOR') return res.status(403).json({ message: 'Only group admins can add participants.' });
  for (const targetId of participantIds) {
    if (!findUserById(targetId)) return res.status(404).json({ message: 'User not found.' });
    if (await isBlocked(userId, targetId)) return res.status(403).json({ message: 'You cannot add a blocked user.' });
    if (!socialStore.state.conversationParticipants.some((entry) => entry.conversationId === conversationId && entry.userId === targetId)) socialStore.state.conversationParticipants.push({ id: `participant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, conversationId, userId: targetId, role: 'MEMBER', joinedAt: new Date().toISOString(), lastReadAt: null, leftAt: null });
  }
  return res.status(201).json({ added: participantIds });
});

messagesRouter.patch('/conversations/:id/participants/:userId', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const targetId = String(req.params.userId);
  const { role } = roleSchema.parse(req.body ?? {});
  const dbAvailable = await isDatabaseAvailable();
  const actor = dbAvailable
    ? await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId: req.user!.id } }, select: { role: true } })
    : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === req.user!.id);
  const target = dbAvailable
    ? await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId: targetId } } })
    : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === targetId);
  if (!actor || !target) return res.status(404).json({ message: 'Conversation member not found.' });
  if (actor.role !== 'OWNER') return res.status(403).json({ message: 'Only the group owner can change moderator roles.' });
  if (target.role === 'OWNER') return res.status(409).json({ message: 'The owner role cannot be changed.' });
  if (dbAvailable) return res.json({ participant: await prisma.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId: targetId } }, data: { role } }) });
  target.role = role;
  return res.json({ participant: target });
});

messagesRouter.delete('/conversations/:id/participants/:userId', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const targetId = String(req.params.userId);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const actor = dbAvailable
    ? await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } }, select: { role: true } })
    : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
  const target = dbAvailable
    ? await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId: targetId } } })
    : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === targetId);
  if (!actor || !target) return res.status(404).json({ message: 'Conversation member not found.' });
  const selfLeave = targetId === userId;
  if (!selfLeave && actor.role !== 'OWNER' && actor.role !== 'MODERATOR') return res.status(403).json({ message: 'Only group admins can remove members.' });
  if (target.role === 'OWNER') return res.status(409).json({ message: 'The owner cannot leave or be removed before transferring ownership.' });
  if (dbAvailable) await prisma.conversationParticipant.delete({ where: { conversationId_userId: { conversationId, userId: targetId } } });
  else socialStore.state.conversationParticipants.splice(socialStore.state.conversationParticipants.findIndex((participant) => participant.id === target.id), 1);
  return res.json({ removed: targetId });
});

export default messagesRouter;
