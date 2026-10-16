import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { getMediaStorage, uploadedMediaBelongsTo } from '../lib/mediaStorage.js';
import { socialStore } from '../lib/socialStore.js';

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

describe('authenticated media uploads', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
  });

  it('accepts media ownership when the owner is inferred from a profile reference even before metadata is assigned', async () => {
    const alice = await register('LegacyMediaAlice');
    const bob = await register('LegacyMediaBob');
    const stored = await getMediaStorage('test').put(Buffer.from('legacy-image'), 'image/webp');

    socialStore.state.profiles.push({
      userId: alice.user.id,
      displayName: alice.user.name,
      username: alice.user.handle,
      bio: null,
      avatarUrl: stored.publicUrl,
      coverUrl: null,
      website: null,
      location: null,
      updatedAt: new Date().toISOString(),
    });

    expect(await uploadedMediaBelongsTo(stored.publicUrl, alice.user.id, 'test')).toBe(true);
    expect(await uploadedMediaBelongsTo(stored.publicUrl, bob.user.id, 'test')).toBe(false);
  });

  it('validates, stores, and serves owned images only to their owner or authorized story viewers', async () => {
    const alice = await register('MediaAlice');
    const bob = await register('MediaBob');
    const carol = await register('MediaCarol');
    const image = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#3756a8' },
    }).png().toBuffer();

    expect((await request(app).post('/api/media/uploads').attach('file', image, { filename: 'avatar.svg', contentType: 'image/svg+xml' }).set('Cookie', alice.auth)).status).toBe(400);
    expect((await request(app).post('/api/media/uploads').attach('file', image, { filename: 'image.png', contentType: 'image/png' })).status).toBe(401);
    expect((await request(app)
      .post('/api/media/uploads')
      .set('Cookie', alice.auth)
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'large.png', contentType: 'image/png' })).status).toBe(413);

    const upload = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', alice.auth)
      .attach('file', image, { filename: 'story.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.contentType).toBe('image/webp');

    const key = upload.body.mediaUrl.split('/').at(-1);
    expect((await request(app).get(upload.body.mediaUrl).set('Cookie', alice.auth)).status).toBe(200);
    expect((await request(app).get(upload.body.mediaUrl)).status).toBe(404);
    expect((await request(app).get(upload.body.mediaUrl).set('Cookie', bob.auth)).status).toBe(404);
    expect((await request(app).post('/api/stories').set('Cookie', bob.auth).send({ mediaUrl: upload.body.mediaUrl })).status).toBe(403);

    const story = await request(app).post('/api/stories').set('Cookie', alice.auth).send({ mediaUrl: upload.body.mediaUrl });
    expect(story.status).toBe(201);
    expect((await request(app).get(`/api/media/avatars/${key}`).set('Cookie', bob.auth)).status).toBe(404);

    await request(app).post(`/api/users/${alice.user.id}/follow`).set('Cookie', bob.auth);
    expect((await request(app).get(`/api/media/avatars/${key}`).set('Cookie', bob.auth)).status).toBe(200);

    const messageUpload = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', alice.auth)
      .attach('file', image, { filename: 'message.png', contentType: 'image/png' });
    expect(messageUpload.status).toBe(201);
    const conversation = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: carol.user.id });
    const sent = await request(app)
      .post(`/api/conversations/${conversation.body.conversation.id}/messages`)
      .set('Cookie', alice.auth)
      .send({ contentType: 'IMAGE', mediaUrl: messageUpload.body.mediaUrl });
    expect(sent.status).toBe(201);
    expect((await request(app).get(messageUpload.body.mediaUrl).set('Cookie', carol.auth)).status).toBe(200);
    expect((await request(app).get(messageUpload.body.mediaUrl).set('Cookie', bob.auth)).status).toBe(404);
  });

  it('uploads voice, video, PDF, and DOCX attachments and serves them only to message participants', async () => {
    const alice = await register('AttachmentAlice');
    const bob = await register('AttachmentBob');
    const outsider = await register('AttachmentOutsider');
    const samples = [
      { type: 'VOICE', name: 'voice.webm', mime: 'audio/webm', bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]) },
      { type: 'VIDEO', name: 'clip.mp4', mime: 'video/mp4', bytes: Buffer.from('0000ftypisom') },
      { type: 'DOCUMENT', name: 'notes.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7 sample') },
      { type: 'DOCUMENT', name: 'notes.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]) },
    ];
    const conversation = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: bob.user.id });

    for (const sample of samples) {
      const upload = await request(app)
        .post('/api/media/attachments')
        .set('Cookie', alice.auth)
        .attach('file', sample.bytes, { filename: sample.name, contentType: sample.mime });
      expect(upload.status).toBe(201);
      expect((await request(app).get(upload.body.mediaUrl).set('Cookie', alice.auth)).status).toBe(200);
      expect((await request(app).get(upload.body.mediaUrl).set('Cookie', bob.auth)).status).toBe(404);
      if (sample.type === 'VOICE') {
        expect((await request(app)
          .post(`/api/conversations/${conversation.body.conversation.id}/messages`)
          .set('Cookie', alice.auth)
          .send({ contentType: 'DOCUMENT', mediaUrl: upload.body.mediaUrl })).status).toBe(400);
      }
      expect((await request(app)
        .post(`/api/conversations/${conversation.body.conversation.id}/messages`)
        .set('Cookie', alice.auth)
        .send({ contentType: sample.type, mediaUrl: upload.body.mediaUrl })).status).toBe(201);
      expect((await request(app).get(upload.body.mediaUrl).set('Cookie', bob.auth)).status).toBe(200);
      expect((await request(app).get(upload.body.mediaUrl).set('Cookie', outsider.auth)).status).toBe(404);
    }

    const invalidSignature = await request(app)
      .post('/api/media/attachments')
      .set('Cookie', alice.auth)
      .attach('file', Buffer.from('not a PDF'), { filename: 'bad.pdf', contentType: 'application/pdf' });
    expect(invalidSignature.status).toBe(400);
    const wrongMime = await request(app)
      .post('/api/media/attachments')
      .set('Cookie', alice.auth)
      .attach('file', Buffer.from('%PDF-1.7'), { filename: 'bad.pdf', contentType: 'application/octet-stream' });
    expect(wrongMime.status).toBe(400);

    const voice = socialStore.state.messages.find((message) => message.contentType === 'VOICE');
    expect(voice).toBeDefined();
    await request(app).delete(`/api/messages/${voice!.id}`).set('Cookie', alice.auth);
    expect((await request(app).get(voice!.mediaUrl!).set('Cookie', bob.auth)).status).toBe(404);
  });

  it('uploads videos for posts, validates their type and signature, and serves them by post visibility', async () => {
    const owner = await register('VideoPostOwner');
    const follower = await register('VideoPostFollower');
    const outsider = await register('VideoPostOutsider');
    const videoBytes = Buffer.from('0000ftypisom');
    const videoUpload = await request(app)
      .post('/api/media/videos')
      .set('Cookie', owner.auth)
      .attach('file', videoBytes, { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(videoUpload.status).toBe(201);
    expect(videoUpload.body).toMatchObject({ contentType: 'video/mp4' });
    expect((await request(app).get(videoUpload.body.mediaUrl).set('Cookie', owner.auth)).headers['content-type']).toContain('video/mp4');
    expect((await request(app).post('/api/posts').set('Cookie', outsider.auth).send({
      content: 'Attempt to use another member video',
      imageUrl: videoUpload.body.mediaUrl,
    })).status).toBe(403);

    const post = await request(app).post('/api/posts').set('Cookie', owner.auth).send({
      content: 'A community video',
      imageUrl: videoUpload.body.mediaUrl,
    });
    expect(post.status).toBe(201);
    expect((await request(app).get(videoUpload.body.mediaUrl).set('Cookie', outsider.auth)).status).toBe(200);

    await request(app).post(`/api/users/${owner.user.id}/follow`).set('Cookie', follower.auth);
    const followerOnlyUpload = await request(app)
      .post('/api/media/videos')
      .set('Cookie', owner.auth)
      .attach('file', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]), { filename: 'followers.webm', contentType: 'video/webm' });
    expect(followerOnlyUpload.status).toBe(201);
    const followerPost = await request(app).post('/api/posts').set('Cookie', owner.auth).send({
      content: 'A followers-only clip',
      imageUrl: followerOnlyUpload.body.mediaUrl,
      visibility: 'FOLLOWERS',
    });
    expect(followerPost.status).toBe(201);
    expect((await request(app).get(followerOnlyUpload.body.mediaUrl).set('Cookie', follower.auth)).status).toBe(200);
    expect((await request(app).get(followerOnlyUpload.body.mediaUrl).set('Cookie', outsider.auth)).status).toBe(404);

    const invalidSignature = await request(app)
      .post('/api/media/videos')
      .set('Cookie', owner.auth)
      .attach('file', Buffer.from('not a video'), { filename: 'broken.mp4', contentType: 'video/mp4' });
    expect(invalidSignature.status).toBe(400);
    const wrongType = await request(app)
      .post('/api/media/videos')
      .set('Cookie', owner.auth)
      .attach('file', videoBytes, { filename: 'clip.mov', contentType: 'video/quicktime' });
    expect(wrongType.status).toBe(400);
    expect((await request(app).post('/api/media/videos').attach('file', videoBytes, { filename: 'clip.mp4', contentType: 'video/mp4' })).status).toBe(401);
  });

  it('lets group members view the saved group image and restricts group settings to admins', async () => {
    const owner = await register('GroupImageOwner');
    const member = await register('GroupImageMember');
    const outsider = await register('GroupImageOutsider');
    const created = await request(app).post('/api/conversations').set('Cookie', owner.auth).send({
      participantIds: [member.user.id],
      name: 'Photo group',
    });
    const image = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#3756a8' },
    }).png().toBuffer();
    const upload = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', owner.auth)
      .attach('file', image, { filename: 'group.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);

    const imageSave = await request(app)
      .patch(`/api/conversations/${created.body.conversation.id}/group`)
      .set('Cookie', owner.auth)
      .send({ imageUrl: upload.body.mediaUrl });
    expect(imageSave.status).toBe(200);
    expect((await request(app).get(upload.body.mediaUrl).set('Cookie', member.auth)).status).toBe(200);
    expect((await request(app).get(upload.body.mediaUrl).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await request(app)
      .patch(`/api/conversations/${created.body.conversation.id}/group`)
      .set('Cookie', outsider.auth)
      .send({ name: 'Unauthorized' })).status).toBe(404);
  });

  it('rejects attachment uploads without authentication and enforces the media size cap', async () => {
    const alice = await register('AttachmentLimitAlice');
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
    expect((await request(app).post('/api/media/attachments').attach('file', Buffer.from('%PDF-1.7'), { filename: 'notes.pdf', contentType: 'application/pdf' })).status).toBe(401);
    expect((await request(app).post('/api/media/attachments').set('Cookie', alice.auth).attach('file', bytes, { filename: 'large.pdf', contentType: 'application/pdf' })).status).toBe(413);
  });
});
