import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { clearCommand2AStores } from '../lib/platform.js';
import { socialStore } from '../lib/socialStore.js';

function getCookieHeader(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : (value ?? '');
}

describe('command 2a foundation', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
    clearCommand2AStores();
  });

  it('creates and reads notification state and unread counts', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    await request(app).post('/api/auth/register').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { email: string }) => user.email === 'bob@example.com');
    const postResponse = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ content: 'Test notification' });

    await request(app)
      .post(`/api/posts/${postResponse.body.post.id}/react`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ type: 'LIKE' });

    const bobLogin = await request(app).post('/api/auth/login').send({
      email: 'bob@example.com',
      password: 'Password123',
    });

    const followResponse = await request(app)
      .post(`/api/users/${bobUser.id}/follow`)
      .set('Cookie', getCookieHeader(aliceLogin));

    expect(followResponse.status).toBe(200);

    const notifications = await request(app)
      .get('/api/notifications')
      .set('Cookie', getCookieHeader(bobLogin));

    expect(notifications.status).toBe(200);
    expect(notifications.body.unreadCount).toBeGreaterThanOrEqual(1);
    expect(notifications.body.notifications.length).toBeGreaterThan(0);
  });

  it('persists notification category preferences through the API', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    const login = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'Password123' });
    const auth = getCookieHeader(login);

    const initial = await request(app).get('/api/notifications/preferences').set('Cookie', auth);
    expect(initial.status).toBe(200);
    expect(initial.body.preferences.find((item: { key: string }) => item.key === 'messages').enabled).toBe(true);

    const updated = await request(app).put('/api/notifications/preferences').set('Cookie', auth).send({ key: 'messages', enabled: false });
    expect(updated.status).toBe(200);
    expect(updated.body.preferences.find((item: { key: string }) => item.key === 'messages').enabled).toBe(false);

    const refreshed = await request(app).get('/api/notifications/preferences').set('Cookie', auth);
    expect(refreshed.body.preferences.find((item: { key: string }) => item.key === 'messages').enabled).toBe(false);

    await request(app).put('/api/notifications/preferences').set('Cookie', auth).send({ key: 'calls', enabled: false });
    await request(app).post('/api/auth/register').send({ name: 'Bob', email: 'bob@example.com', password: 'Password123', communityRulesAccepted: true });
    const bobLogin = await request(app).post('/api/auth/login').send({ email: 'bob@example.com', password: 'Password123' });
    const alice = login.body.user as { id: string };
    await request(app).post('/api/calls/start').set('Cookie', getCookieHeader(bobLogin)).send({ targetUserId: alice.id, type: 'voice' });
    const notifications = await request(app).get('/api/notifications').set('Cookie', auth);
    expect(notifications.body.notifications.some((item: { type: string }) => item.type === 'call')).toBe(false);
    await request(app).put('/api/notifications/preferences').set('Cookie', auth).send({ key: 'calls', enabled: true });
  });

  it('updates presence and typing authorization for conversation participants', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    await request(app).post('/api/auth/register').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { email: string }) => user.email === 'bob@example.com');

    const convo = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantId: bobUser.id });

    const presence = await request(app)
      .post('/api/presence')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ online: true, status: 'available' });

    expect(presence.status).toBe(200);
    expect(presence.body.presence.online).toBe(true);

    const typingResponse = await request(app)
      .post(`/api/conversations/${convo.body.conversation.id}/typing`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ isTyping: true });

    expect(typingResponse.status).toBe(200);
    expect(typingResponse.body.typing.isTyping).toBe(true);

    const unauthorized = await request(app)
      .post(`/api/conversations/unknown/typing`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ isTyping: true });

    expect(unauthorized.status).toBe(404);
  });

  it('creates configured LiveKit calls and still applies existing block controls', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    await request(app).post('/api/auth/register').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { email: string }) => user.email === 'bob@example.com');

    const started = await request(app)
      .post('/api/calls/start')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ targetUserId: bobUser.id, type: 'voice' });

    expect(started.status).toBe(201);
    expect(started.body.call.provider).toBe('livekit');

    await request(app)
      .post(`/api/users/${bobUser.id}/block`)
      .set('Cookie', getCookieHeader(aliceLogin));

    const blocked = await request(app)
      .post('/api/calls/start')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ targetUserId: bobUser.id, type: 'video' });

    expect(blocked.status).toBe(403);
    expect((await request(app).get('/api/calls/history').set('Cookie', getCookieHeader(aliceLogin))).body.calls).toHaveLength(1);
  });

  it('creates LiveKit live sessions in the existing paused lifecycle state', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    await request(app).post('/api/auth/register').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const live = await request(app)
      .post('/api/live/create')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ title: 'Launch stream', visibility: 'public' });

    expect(live.status).toBe(201);
    expect(live.body.live.provider).toBe('livekit');
    expect(live.body.live.status).toBe('paused');
    expect((await request(app).get('/api/live').set('Cookie', getCookieHeader(aliceLogin))).body.lives).toHaveLength(1);
  });

  it('reports AI assistance unavailable instead of returning fabricated generated content', async () => {
    const response = await request(app)
      .post('/api/ai/summarize')
      .send({ content: 'This should summarize cleanly.' });

    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/no AI provider is configured/i);
    expect(response.body.summary).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toMatch(/sk-|api[_-]?key|secret/i);
  });
});
