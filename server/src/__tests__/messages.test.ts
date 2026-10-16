import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { signAccessToken, hashSessionToken } from '../lib/auth.js';
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
    const roles: Record<string, string> = { creator: 'OWNER', admin: 'MODERATOR', member: 'MEMBER', newcomer: 'MEMBER' };

    vi.spyOn(prisma.session, 'findFirst').mockResolvedValue({ id: 'database-session' } as never);
    vi.spyOn(prisma.user, 'findUnique').mockImplementation((args) => {
      const userId = (args as unknown as { where: { id: string } }).where.id;
      return Promise.resolve({ id: userId, email: `${userId}@example.com`, name: userId, role: 'USER', status: 'ACTIVE' }) as never;
    });
    vi.spyOn(prisma.user, 'findMany').mockImplementation((args) => {
      const ids = ((args as unknown as { where: { id: { in: string[] } } }).where.id).in;
      return Promise.resolve(ids.map((id) => ({ id }))) as never;
    });
    vi.spyOn(prisma.conversation, 'findUnique').mockResolvedValue({ id: 'database-group', isGroup: true, isChannel: false } as never);
    vi.spyOn(prisma.conversationParticipant, 'findFirst').mockImplementation((args) => {
      const userId = (args as unknown as { where: { userId: string } }).where.userId;
      if (userId === 'former-admin') return Promise.resolve(null) as never;
      return Promise.resolve({ id: `participant-${userId}`, conversationId: 'database-group', userId, role: roles[userId], leftAt: null }) as never;
    });
    vi.spyOn(prisma.conversationParticipant, 'findMany').mockResolvedValue([] as never);
    vi.spyOn(prisma.conversationParticipant, 'createMany').mockResolvedValue({ count: 1 } as never);
    vi.spyOn(prisma.conversationParticipant, 'update').mockImplementation((args) => {
      const updateArgs = args as unknown as { where: { conversationId_userId: { userId: string } }; data: { role: string } };
      const userId = updateArgs.where.conversationId_userId.userId;
      return Promise.resolve({ id: `participant-${userId}`, conversationId: 'database-group', userId, role: updateArgs.data.role }) as never;
    });
    vi.spyOn(prisma.block, 'findUnique').mockResolvedValue(null as never);

    const participantsPath = '/api/conversations/database-group/participants';
    expect((await request(app).post(participantsPath).set(authFor('creator')).send({ participantIds: ['newcomer'] })).status).toBe(201);
    expect((await request(app).post(participantsPath).set(authFor('admin')).send({ participantIds: ['newcomer'] })).status).toBe(201);
    expect((await request(app).post(participantsPath).set(authFor('member')).send({ participantIds: ['newcomer'] })).status).toBe(403);
    expect((await request(app).post(participantsPath).set(authFor('former-admin')).send({ participantIds: ['newcomer'] })).status).toBe(404);

    const rolePath = '/api/conversations/database-group/participants/member';
    expect((await request(app).patch(rolePath).set(authFor('creator')).send({ role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).patch(rolePath).set(authFor('admin')).send({ role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).patch(rolePath).set(authFor('member')).send({ role: 'MEMBER' })).status).toBe(403);
    expect((await request(app).patch('/api/conversations/database-group/participants/newcomer').set(authFor('former-admin')).send({ role: 'MODERATOR' })).status).toBe(404);
    expect(prisma.conversationParticipant.findFirst).toHaveBeenCalledWith({
      where: { conversationId: 'database-group', userId: 'former-admin', leftAt: null },
      select: { role: true },
    });
    expect(prisma.conversationParticipant.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.conversationParticipant.update).toHaveBeenCalledTimes(2);
  });
});
