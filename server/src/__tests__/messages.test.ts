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
});
