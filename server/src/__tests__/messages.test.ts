import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { signAccessToken, hashSessionToken } from '../lib/auth.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { isDatabaseAvailable, prisma } from '../lib/prisma.js';
import { socialStore } from '../lib/socialStore.js';

vi.mock('../lib/prisma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/prisma.js')>();
  return {
    ...actual,
    isDatabaseAvailable: vi.fn().mockResolvedValue(true),
  };
});

describe('messaging database responses', () => {
  beforeEach(() => {
    vi.mocked(isDatabaseAvailable).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults missing and null reactions without accessing in-memory storage', async () => {
    const userId = 'database-user';
    const token = signAccessToken({ sub: userId, email: 'user@example.com', role: 'USER' });
    const baseMessage = {
      id: 'database-message',
      conversationId: 'database-conversation',
      senderId: 'database-user',
      text: 'Hello',
      createdAt: new Date(),
      updatedAt: new Date(),
      readAt: null,
      deletedAt: null,
      status: 'SENT',
      contentType: 'TEXT',
      mediaUrl: null,
      metadata: null,
      replyToId: null,
      forwardedFromId: null,
      editedAt: null,
      expiresAt: null,
    };

    vi.spyOn(prisma.session, 'findFirst').mockResolvedValue({ id: 'database-session' } as never);
    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      name: 'Database User',
      role: 'USER',
      status: 'ACTIVE',
    } as never);
    vi.spyOn(prisma.conversationParticipant, 'findFirst').mockResolvedValue({ id: 'database-participant' } as never);
    vi.spyOn(prisma.message, 'findMany').mockResolvedValue([
      baseMessage,
      { ...baseMessage, id: 'null-reactions-message', reactions: null },
    ] as never);
    const socialStoreState = vi.spyOn(socialStore, 'state', 'get').mockImplementation(() => {
      throw new Error('In-memory fallback storage is disabled in production.');
    });

    const response = await request(app)
      .get('/api/conversations/database-conversation/messages')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.messages.map((message: { reactions: unknown[] }) => message.reactions)).toEqual([[], []]);
    expect(socialStoreState).not.toHaveBeenCalled();
    expect(prisma.session.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tokenHash: hashSessionToken(token) }),
    }));
  });

  it('enforces group admin permissions through database-backed membership queries', async () => {
    const tokenFor = (userId: string) => signAccessToken({ sub: userId, email: `${userId}@example.com`, role: 'USER' });
    const authFor = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });
    const roles: Record<string, string> = { creator: 'OWNER', admin: 'MODERATOR', otherAdmin: 'MODERATOR', member: 'MEMBER', newcomer: 'MEMBER', storedOwner: 'MEMBER' };

    vi.spyOn(prisma.session, 'findFirst').mockResolvedValue({ id: 'database-session' } as never);
    vi.spyOn(prisma.user, 'findUnique').mockImplementation((args) => {
      const userId = (args as unknown as { where: { id: string } }).where.id;
      return Promise.resolve({ id: userId, email: `${userId}@example.com`, name: userId, role: 'USER', status: 'ACTIVE' }) as never;
    });
    vi.spyOn(prisma.user, 'findMany').mockImplementation((args) => {
      const ids = ((args as unknown as { where: { id: { in: string[] } } }).where.id).in;
      return Promise.resolve(ids.map((id) => ({ id }))) as never;
    });
    const conversationLookup = vi.spyOn(prisma.conversation, 'findUnique').mockResolvedValue({ id: 'database-group', ownerId: 'storedOwner', isGroup: true, isChannel: false } as never);
    vi.spyOn(prisma.conversationParticipant, 'findFirst').mockImplementation((args) => {
      const userId = (args as unknown as { where: { userId: string } }).where.userId;
      if (userId === 'former-admin') return Promise.resolve(null) as never;
      return Promise.resolve({ id: `participant-${userId}`, conversationId: 'database-group', userId, role: roles[userId], leftAt: null }) as never;
    });
    vi.spyOn(prisma.conversationParticipant, 'findMany').mockResolvedValue([] as never);
    vi.spyOn(prisma.conversationParticipant, 'createMany').mockResolvedValue({ count: 1 } as never);
    vi.spyOn(prisma.conversationParticipant, 'delete').mockResolvedValue({} as never);
    vi.spyOn(prisma.conversationParticipant, 'update').mockImplementation((args) => {
      const updateArgs = args as unknown as { where: { conversationId_userId: { userId: string } }; data: { role: string } };
      const userId = updateArgs.where.conversationId_userId.userId;
      return Promise.resolve({ id: `participant-${userId}`, conversationId: 'database-group', userId, role: updateArgs.data.role }) as never;
    });
    vi.spyOn(prisma.block, 'findUnique').mockResolvedValue(null as never);

    const participantsPath = '/api/conversations/database-group/participants';
    expect((await request(app).post(participantsPath).set(authFor('creator')).send({ participantIds: ['newcomer'] })).status).toBe(201);
    expect((await request(app).post(participantsPath).set(authFor('admin')).send({ participantIds: ['newcomer'] })).status).toBe(201);
    expect((await request(app).post(participantsPath).set(authFor('storedOwner')).send({ participantIds: ['newcomer'] })).status).toBe(201);
    expect((await request(app).post(participantsPath).set(authFor('member')).send({ participantIds: ['newcomer'] })).status).toBe(403);
    expect((await request(app).post(participantsPath).set(authFor('former-admin')).send({ participantIds: ['newcomer'] })).status).toBe(404);

    const rolePath = '/api/conversations/database-group/participants/member';
    expect((await request(app).patch(rolePath).set(authFor('creator')).send({ role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).patch(rolePath).set(authFor('admin')).send({ role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).patch(rolePath).set(authFor('storedOwner')).send({ role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).patch('/api/conversations/database-group/participants/admin').set(authFor('creator')).send({ role: 'MEMBER' })).status).toBe(200);
    expect((await request(app).patch('/api/conversations/database-group/participants/otherAdmin').set(authFor('admin')).send({ role: 'MEMBER' })).status).toBe(200);
    expect((await request(app).patch('/api/conversations/database-group/participants/storedOwner').set(authFor('creator')).send({ role: 'MODERATOR' })).status).toBe(409);
    expect((await request(app).patch(rolePath).set(authFor('member')).send({ role: 'MEMBER' })).status).toBe(403);
    expect((await request(app).patch('/api/conversations/database-group/participants/member').set(authFor('member')).send({ role: 'MODERATOR' })).status).toBe(403);
    expect((await request(app).patch('/api/conversations/database-group/participants/newcomer').set(authFor('former-admin')).send({ role: 'MODERATOR' })).status).toBe(404);
    expect((await request(app).delete('/api/conversations/database-group/participants/storedOwner').set(authFor('creator'))).status).toBe(409);
    expect((await request(app).delete('/api/conversations/database-group/participants/admin').set(authFor('member'))).status).toBe(403);
    expect((await request(app).delete('/api/conversations/database-group/participants/otherAdmin').set(authFor('admin'))).status).toBe(200);
    expect((await request(app).post(participantsPath).set(authFor('former-admin')).send({ participantIds: ['newcomer'] })).status).toBe(404);
    expect(prisma.conversationParticipant.findFirst).toHaveBeenCalledWith({
      where: { conversationId: 'database-group', userId: 'former-admin', leftAt: null },
      select: { role: true },
    });
    expect(prisma.conversationParticipant.createMany).toHaveBeenCalledTimes(3);
    expect(prisma.conversationParticipant.update).toHaveBeenCalledTimes(5);

    conversationLookup.mockResolvedValue({ id: 'database-group', ownerId: 'storedOwner', isGroup: true, isChannel: true } as never);
    expect((await request(app).post(participantsPath).set(authFor('admin')).send({ participantIds: ['newcomer'] })).status).toBe(403);
    expect((await request(app).post(participantsPath).set(authFor('storedOwner')).send({ participantIds: ['newcomer'] })).status).toBe(201);
  });

  it('enforces active group membership and owner permissions through fallback storage', async () => {
    vi.mocked(isDatabaseAvailable).mockResolvedValue(false);
    fallbackStore.clear();
    const userIds = ['fallbackOwner', 'fallbackAdmin', 'fallbackMember', 'fallbackFormer', 'fallbackNew'];
    const authFor = (userId: string) => {
      const token = signAccessToken({ sub: userId, email: `${userId}@example.com`, role: 'USER' });
      fallbackStore.createSession({
        userId,
        tokenHash: hashSessionToken(token),
        userAgent: null,
        deviceName: null,
        ipAddress: null,
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      return { Authorization: `Bearer ${token}` };
    };
    for (const id of userIds) fallbackStore.create({
      id,
      email: `${id}@example.com`,
      name: id,
      passwordHash: 'test',
      role: 'USER',
      status: 'ACTIVE',
      communityRulesAccepted: true,
      communityRulesAcceptedAt: new Date().toISOString(),
      rulesVersion: 'test',
    });
    const tokens = Object.fromEntries(userIds.map((id) => [id, authFor(id)]));
    const conversationId = 'fallback-group';
    socialStore.state.conversations.push({
      id: conversationId,
      name: 'Fallback group',
      ownerId: 'fallbackOwner',
      isGroup: true,
      isChannel: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
      lastMessagePreview: null,
    });
    const participant = (userId: string, role: 'MEMBER' | 'MODERATOR', leftAt: string | null = null) => ({
      id: `participant-${userId}`,
      conversationId,
      userId,
      role,
      joinedAt: new Date().toISOString(),
      lastReadAt: null,
      leftAt,
    });
    socialStore.state.conversationParticipants.push(
      participant('fallbackOwner', 'MEMBER'),
      participant('fallbackAdmin', 'MODERATOR'),
      participant('fallbackMember', 'MEMBER'),
      participant('fallbackFormer', 'MODERATOR', new Date().toISOString()),
    );

    const participantsPath = `/api/conversations/${conversationId}/participants`;
    expect((await request(app).post(participantsPath).set(tokens.fallbackOwner).send({ participantIds: ['fallbackNew'] })).status).toBe(201);
    expect((await request(app).post(participantsPath).set(tokens.fallbackOwner).send({ participantIds: ['fallbackNew'] })).body.added).toEqual([]);
    expect(socialStore.state.conversationParticipants.filter((entry) => entry.conversationId === conversationId && entry.userId === 'fallbackNew' && !entry.leftAt)).toHaveLength(1);
    expect((await request(app).patch(`${participantsPath}/fallbackMember`).set(tokens.fallbackMember).send({ role: 'MODERATOR' })).status).toBe(403);
    expect((await request(app).post(participantsPath).set(tokens.fallbackFormer).send({ participantIds: ['fallbackNew'] })).status).toBe(404);
    expect((await request(app).patch(`${participantsPath}/fallbackMember`).set(tokens.fallbackFormer).send({ role: 'MODERATOR' })).status).toBe(404);
    expect((await request(app).patch(`${participantsPath}/fallbackMember`).set(tokens.fallbackOwner).send({ role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).patch(`${participantsPath}/fallbackAdmin`).set(tokens.fallbackOwner).send({ role: 'MEMBER' })).status).toBe(200);
    expect((await request(app).patch(`${participantsPath}/fallbackOwner`).set(tokens.fallbackOwner).send({ role: 'MODERATOR' })).status).toBe(409);
    expect((await request(app).delete(`${participantsPath}/fallbackOwner`).set(tokens.fallbackOwner)).status).toBe(409);
    expect((await request(app).delete(`${participantsPath}/fallbackAdmin`).set(tokens.fallbackNew)).status).toBe(403);

    const conversation = socialStore.state.conversations.find((entry) => entry.id === conversationId)!;
    conversation.isChannel = true;
    expect((await request(app).post(participantsPath).set(tokens.fallbackAdmin).send({ participantIds: ['fallbackNew'] })).status).toBe(403);
    expect((await request(app).post(participantsPath).set(tokens.fallbackOwner).send({ participantIds: ['fallbackNew'] })).status).toBe(201);
    fallbackStore.clear();
    socialStore.state.conversationParticipants = socialStore.state.conversationParticipants.filter((entry) => entry.conversationId !== conversationId);
    socialStore.state.conversations = socialStore.state.conversations.filter((entry) => entry.id !== conversationId);
  });
});
