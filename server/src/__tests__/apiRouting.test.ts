import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';

describe('messaging, calling, and live API routing', () => {
  it('rewrites API paths to Render before applying the SPA fallback', () => {
    const vercelConfig = JSON.parse(
      readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'),
    ) as { rewrites: Array<{ source: string; destination: string }> };

    expect(vercelConfig.rewrites[0]).toEqual({
      source: '/api/:path*',
      destination: 'https://nova-social-platform-api.onrender.com/api/:path*',
    });
    expect(vercelConfig.rewrites[1]).toEqual({
      source: '/(.*)',
      destination: '/index.html',
    });
  });

  it('registers messaging, call, live-session, and LiveKit endpoints at their client paths', async () => {
    const responses = await Promise.all([
      request(app).get('/api/conversations'),
      request(app).get('/api/conversations/example/messages'),
      request(app).post('/api/conversations').send({}),
      request(app).post('/api/conversations/example/messages').send({}),
      request(app).post('/api/conversations/example/read').send({}),
      request(app).post('/api/conversations/example/participants').send({}),
      request(app).patch('/api/conversations/example/participants/user').send({}),
      request(app).delete('/api/conversations/example/participants/user'),
      request(app).get('/api/messages/search'),
      request(app).post('/api/messages/example/reactions').send({}),
      request(app).get('/api/conversations/example/media'),
      request(app).patch('/api/conversations/example/preferences').send({}),
      request(app).get('/api/realtime'),
      request(app).post('/api/calls/start').send({}),
      request(app).get('/api/calls/history'),
      request(app).post('/api/calls/example/token').send({}),
      request(app).post('/api/calls/example/connected').send({}),
      request(app).post('/api/calls/example/accept').send({}),
      request(app).post('/api/calls/example/leave').send({}),
      request(app).post('/api/calls/example/mute').send({}),
      request(app).post('/api/calls/example/camera').send({}),
      request(app).get('/api/live'),
      request(app).post('/api/live/create').send({}),
      request(app).get('/api/live/example'),
      request(app).post('/api/live/example/start').send({}),
      request(app).post('/api/live/example/end').send({}),
      request(app).post('/api/live/example/token').send({}),
      request(app).post('/api/live/example/viewers/join').send({}),
      request(app).post('/api/live/example/viewers/leave').send({}),
      request(app).post('/api/live/example/comment').send({}),
      request(app).post('/api/live/example/react').send({}),
    ]);

    expect(responses.map(({ status }) => status)).toEqual(Array(responses.length).fill(401));
    expect(responses.map(({ body }) => body.message)).not.toContain('Route not found.');
  });
});
