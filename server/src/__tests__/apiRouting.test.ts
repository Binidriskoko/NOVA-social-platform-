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

  it('registers the authenticated messaging, call, realtime, and LiveKit endpoints at their client paths', async () => {
    const responses = await Promise.all([
      request(app).get('/api/conversations'),
      request(app).get('/api/conversations/example/messages'),
      request(app).get('/api/realtime'),
      request(app).get('/api/calls/history'),
      request(app).post('/api/calls/start').send({}),
      request(app).post('/api/calls/example/token').send({}),
      request(app).get('/api/live'),
      request(app).post('/api/live/example/token').send({}),
      request(app).post('/api/live/example/viewers/join').send({}),
    ]);

    expect(responses.map(({ status }) => status)).toEqual(Array(responses.length).fill(401));
    expect(responses.map(({ body }) => body.message)).not.toContain('Route not found.');
  });
});
