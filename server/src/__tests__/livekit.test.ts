import { describe, expect, it } from 'vitest';
import { envSchema } from '../config/env.js';

describe('LiveKit environment configuration', () => {
  const completeConfig = {
    NODE_ENV: 'test',
    LIVEKIT_URL: 'wss://media.example.test',
    LIVEKIT_API_KEY: 'livekit-test-key',
    LIVEKIT_API_SECRET: 'livekit-test-secret-with-adequate-length',
  };

  it('accepts a complete secure LiveKit configuration', () => {
    expect(envSchema.safeParse(completeConfig).success).toBe(true);
  });

  it('rejects incomplete credentials, non-WebSocket URLs, embedded credentials, and short secrets', () => {
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_API_SECRET: undefined }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_URL: 'https://media.example.test' }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_URL: 'wss://user:password@media.example.test' }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_API_SECRET: 'too-short' }).success).toBe(false);
  });
});
