import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { decryptPrivateAddress, encryptPrivateAddress } from '../lib/privateProfile.js';
import sharp from 'sharp';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function register(name: string) {
  const registration = await request(app).post('/api/auth/register').send({
    name,
    username: name.toLowerCase(),
    password: 'Password123',
    communityRulesAccepted: true,
  });
  return { user: registration.body.user, auth: cookie(registration) };
}

describe('private profile completion', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
  });

  it('encrypts addresses at rest and can decrypt them for the authenticated profile', () => {
    const encrypted = encryptPrivateAddress('Private street 10');
    expect(encrypted.addressCiphertext).not.toContain('Private street 10');
    expect(decryptPrivateAddress(encrypted)).toBe('Private street 10');
  });

  it('keeps Stage 1 signup and login compatible before profile completion', async () => {
    const registration = await register('StageOneUser');
    expect(registration.user.id).toBeTruthy();
    expect((await request(app).get('/api/auth/me').set('Cookie', registration.auth)).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ identifier: 'stageoneuser', password: 'Password123' })).status).toBe(200);
  });

  it('saves private profile fields for the authenticated user and never returns them publicly', async () => {
    const owner = await register('ProfileOwner');
    const other = await register('ProfileOther');
    const saved = await request(app).put('/api/users/me/private-profile').set('Cookie', owner.auth).send({
      dateOfBirth: '1990-05-20',
      address: '42 Example Street, Kano',
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ dateOfBirth: '1990-05-20', address: '42 Example Street, Kano' });

    const ownDetails = await request(app).get('/api/users/me/private-profile').set('Cookie', owner.auth);
    expect(ownDetails.body).toMatchObject(saved.body);
    const otherDetails = await request(app).get('/api/users/me/private-profile').set('Cookie', other.auth);
    expect(otherDetails.body).toMatchObject({ dateOfBirth: '', address: '' });
    const publicProfile = await request(app).get(`/api/users/${owner.user.id}/profile`).set('Cookie', other.auth);
    expect(JSON.stringify(publicProfile.body)).not.toContain('Example Street');
    expect(JSON.stringify(publicProfile.body)).not.toContain('1990-05-20');
    expect((await request(app).put(`/api/users/${other.user.id}/private-profile`).set('Cookie', owner.auth).send({ address: 'Not mine' })).status).toBe(404);
  });

  it('rejects invalid or future birth dates and unauthenticated updates', async () => {
    const owner = await register('ProfileValidation');
    expect((await request(app).put('/api/users/me/private-profile').set('Cookie', owner.auth).send({ dateOfBirth: '2035-02-30' })).status).toBe(400);
    expect((await request(app).put('/api/users/me/private-profile').set('Cookie', owner.auth).send({ dateOfBirth: '2999-01-01' })).status).toBe(400);
    expect((await request(app).put('/api/users/me/private-profile').send({ address: 'Private address' })).status).toBe(401);
  });

  it('accepts the secure image upload and saves its URL to the owner profile', async () => {
    const owner = await register('ProfilePictureOwner');
    const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#087b43' } }).png().toBuffer();
    const rejected = await request(app).post('/api/media/uploads').set('Cookie', owner.auth)
      .attach('file', image, { filename: 'profile.svg', contentType: 'image/svg+xml' });
    expect(rejected.status).toBe(400);

    const uploaded = await request(app).post('/api/media/uploads').set('Cookie', owner.auth)
      .attach('file', image, { filename: 'profile.png', contentType: 'image/png' });
    expect(uploaded.status).toBe(201);
    const saved = await request(app).put('/api/users/me/profile').set('Cookie', owner.auth).send({ avatarUrl: uploaded.body.mediaUrl });
    expect(saved.status).toBe(200);
    const publicProfile = await request(app).get(`/api/users/${owner.user.id}/profile`);
    expect(publicProfile.body.profile.avatarUrl).toBe(uploaded.body.mediaUrl);
  });
});