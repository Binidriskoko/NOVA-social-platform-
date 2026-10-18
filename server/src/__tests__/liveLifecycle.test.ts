import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const liveKitMocks = vi.hoisted(() => ({ endLiveKitRoom: vi.fn() }));

vi.mock('../lib/livekit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/livekit.js')>();
  return { ...actual, endLiveKitRoom: liveKitMocks.endLiveKitRoom };
});

import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { clearCommand2AStores, updateLiveSession } from '../lib/platform.js';
import { isLiveReplayOwner } from '../lib/liveReplayPolicy.js';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function register(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  await request(app).post('/api/auth/register').send({ name, email, password: 'Password123', communityRulesAccepted: true });
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123' });
  const users = await request(app).get('/api/users');
  return { auth: cookie(login), user: users.body.users.find((entry: { email: string }) => entry.email === email) };
}

describe('live broadcast lifecycle', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
    clearCommand2AStores();
    liveKitMocks.endLiveKitRoom.mockReset().mockResolvedValue(undefined);
  });

  it('stops the LiveKit room and ends a live session with zero viewers', async () => {
    const host = await register('LifecycleHost');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Session to end' });
    const liveId = created.body.live.id;
    updateLiveSession(liveId, (live) => ({
      ...live,
      status: 'live',
      recordingStatus: 'RECORDING',
      viewerCount: 2,
      viewers: [
        { userId: 'viewer-1', isMuted: false, isBlocked: false, joinedAt: new Date().toISOString() },
        { userId: 'viewer-2', isMuted: false, isBlocked: false, joinedAt: new Date().toISOString() },
      ],
    }));

    const response = await request(app).post(`/api/live/${liveId}/end`).set('Cookie', host.auth);

    expect(response.status).toBe(200);
    expect(liveKitMocks.endLiveKitRoom).toHaveBeenCalledWith(`nova-live-${liveId}`);
    expect(response.body.live).toMatchObject({ status: 'ended', viewerCount: 0, viewers: [] });
    expect((await request(app).get('/api/live').set('Cookie', host.auth)).body.lives[0]).toMatchObject({
      id: liveId,
      status: 'ended',
      recordingStatus: 'RECORDING',
    });
  });

  it('does not allow another account to end a broadcast', async () => {
    const host = await register('LifecycleOwner');
    const other = await register('LifecycleOther');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Owned session' });
    updateLiveSession(created.body.live.id, (live) => ({ ...live, status: 'live' }));

    const response = await request(app).post(`/api/live/${created.body.live.id}/end`).set('Cookie', other.auth);

    expect(response.status).toBe(403);
    expect(liveKitMocks.endLiveKitRoom).not.toHaveBeenCalled();
  });

  it('keeps the session active and returns a retryable error when LiveKit cannot be stopped', async () => {
    const host = await register('LifecycleRetryHost');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Retry end' });
    const liveId = created.body.live.id;
    updateLiveSession(liveId, (live) => ({ ...live, status: 'live' }));
    liveKitMocks.endLiveKitRoom.mockRejectedValueOnce(new Error('LiveKit unavailable'));

    const response = await request(app).post(`/api/live/${liveId}/end`).set('Cookie', host.auth);

    expect(response.status).toBe(503);
    expect(response.body.message).toContain('retry ending it');
    expect((await request(app).get(`/api/live/${liveId}`).set('Cookie', host.auth)).body.live.status).toBe('live');
  });

  it('reports the exact persistent replay server setup required when unavailable', async () => {
    const host = await register('ReplayInfraOwner');

    const response = await request(app).get('/api/live/replays').set('Cookie', host.auth);

    expect(response.status).toBe(503);
    expect(response.body.message).toContain('DATABASE_URL');
    expect(response.body.message).toContain('apply Prisma migrations');
  });

  it('restricts replay publishing and deletion to the recording owner', () => {
    const replay = { hostId: 'creator-1' };
    expect(isLiveReplayOwner(replay, 'creator-1')).toBe(true);
    expect(isLiveReplayOwner(replay, 'another-user')).toBe(false);
  });
});
