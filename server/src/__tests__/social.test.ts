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
    isDatabaseAvailable: vi.fn().mockResolvedValue(false),
  };
});

function getCookieHeader(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];

  if (Array.isArray(value)) {
    return value.join('; ');
  }

  return value ?? '';
}

describe('social platform features', () => {
  beforeEach(() => {
    vi.mocked(isDatabaseAvailable).mockReset().mockResolvedValue(false);
    fallbackStore.clear();
    socialStore.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('authenticated user can create a post', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const loginResponse = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const response = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(loginResponse))
      .send({
        content: 'Hello NOVA!',
        imageUrl: 'https://example.com/post.jpg',
      });

    expect(response.status).toBe(201);
    expect(response.body.post.content).toBe('Hello NOVA!');
    expect(response.body.post.author.name).toBe('Alice');
  });

  it('does not publish content that requires moderator review', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    const login = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const response = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(login))
      .send({ content: 'sexual '.repeat(37) });

    expect(response.status).toBe(422);
  });

  it('unauthenticated user cannot create a post', async () => {
    const response = await request(app).post('/api/posts').send({ content: 'Nope' });

    expect(response.status).toBe(401);
  });

  it('user can follow another user', async () => {
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
    const bobLogin = await request(app).post('/api/auth/login').send({
      email: 'bob@example.com',
      password: 'Password123',
    });
    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');
    const post = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(bobLogin))
      .send({ content: 'Bob post for Alice feed' });

    const target = await request(app)
      .post(`/api/users/${bobUser.id}/follow`)
      .set('Cookie', getCookieHeader(aliceLogin));

    expect(target.status).toBe(200);
    expect(target.body.following).toBe(true);
    const feed = await request(app).get('/api/posts').set('Cookie', getCookieHeader(aliceLogin));
    expect(feed.body.posts.find((entry: { id: string }) => entry.id === post.body.post.id).authorFollowing).toBe(true);
  });

  it('duplicate follow is prevented', async () => {
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

    const targetUser = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');

    const first = await request(app)
      .post(`/api/users/${targetUser.id}/follow`)
      .set('Cookie', getCookieHeader(aliceLogin));

    const second = await request(app)
      .post(`/api/users/${targetUser.id}/follow`)
      .set('Cookie', getCookieHeader(aliceLogin));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it('returns follow state and prevents following across a block', async () => {
    for (const user of [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ]) {
      await request(app).post('/api/auth/register').send({
        ...user,
        password: 'Password123',
        communityRulesAccepted: true,
      });
    }

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const bobLogin = await request(app).post('/api/auth/login').send({
      email: 'bob@example.com',
      password: 'Password123',
    });
    const bob = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');

    const followed = await request(app)
      .post(`/api/users/${bob.id}/follow`)
      .set('Cookie', getCookieHeader(aliceLogin));
    const profile = await request(app)
      .get(`/api/users/${bob.id}`)
      .set('Cookie', getCookieHeader(aliceLogin));
    const notifications = await request(app)
      .get('/api/notifications')
      .set('Cookie', getCookieHeader(bobLogin));

    expect(followed.status).toBe(200);
    expect(profile.body.user.relationship.isFollowing).toBe(true);
    expect(profile.body.user.followerCount).toBe(1);
    expect(notifications.body.notifications.some((item: { type: string }) => item.type === 'follow')).toBe(true);

    await request(app)
      .post(`/api/users/${aliceLogin.body.user.id}/block`)
      .set('Cookie', getCookieHeader(bobLogin));
    const blockedFollow = await request(app)
      .post(`/api/users/${aliceLogin.body.user.id}/follow`)
      .set('Cookie', getCookieHeader(bobLogin));

    expect(blockedFollow.status).toBe(403);
  });

  it('user can react to a post', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const loginResponse = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const createdPost = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ content: 'Hello world' });

    const response = await request(app)
      .post(`/api/posts/${createdPost.body.post.id}/react`)
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ type: 'LIKE' });

    expect(response.status).toBe(200);
    expect(response.body.reaction.type).toBe('LIKE');
    expect(response.body.reactionCounts.LIKE).toBe(1);
  });

  it('duplicate reaction is prevented or updated', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const loginResponse = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const createdPost = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ content: 'Hello world' });

    await request(app)
      .post(`/api/posts/${createdPost.body.post.id}/react`)
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ type: 'LIKE' });

    const updated = await request(app)
      .post(`/api/posts/${createdPost.body.post.id}/react`)
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ type: 'LOVE' });

    expect(updated.status).toBe(200);
    expect(updated.body.reaction.type).toBe('LOVE');
    expect(updated.body.reactionCounts.LIKE).toBe(0);
    expect(updated.body.reactionCounts.LOVE).toBe(1);
  });

  it('user can comment', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const loginResponse = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const createdPost = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ content: 'The first post' });

    const response = await request(app)
      .post(`/api/posts/${createdPost.body.post.id}/comments`)
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ content: 'Nice post!' });

    expect(response.status).toBe(201);
    expect(response.body.comment.content).toBe('Nice post!');
  });

  it('supports post replies, editing, saving, privacy, and tracked shares', async () => {
    for (const user of [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ]) {
      await request(app).post('/api/auth/register').send({
        ...user,
        password: 'Password123',
        communityRulesAccepted: true,
      });
    }
    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const bobLogin = await request(app).post('/api/auth/login').send({
      email: 'bob@example.com',
      password: 'Password123',
    });
    const aliceId = aliceLogin.body.user.id;
    const created = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ content: 'Original post' });
    const postId = created.body.post.id;
    const root = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ content: 'Top-level comment' });
    const reply = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Cookie', getCookieHeader(bobLogin))
      .send({ content: 'A reply', parentId: root.body.comment.id });
    const comments = await request(app).get(`/api/posts/${postId}/comments`).set('Cookie', getCookieHeader(aliceLogin));

    expect(reply.status).toBe(201);
    expect(reply.body.comment.parentId).toBe(root.body.comment.id);
    expect(comments.body.comments.find((comment: { id: string }) => comment.id === reply.body.comment.id).parentId).toBe(root.body.comment.id);

    const forbiddenEdit = await request(app)
      .patch(`/api/posts/${postId}`)
      .set('Cookie', getCookieHeader(bobLogin))
      .send({ content: 'Changed by Bob' });
    expect(forbiddenEdit.status).toBe(403);

    await request(app).post(`/api/posts/${postId}/save`).set('Cookie', getCookieHeader(bobLogin));
    const duplicateSave = await request(app).post(`/api/posts/${postId}/save`).set('Cookie', getCookieHeader(bobLogin));
    expect(duplicateSave.body.savedCount).toBe(1);
    const firstShare = await request(app).post(`/api/posts/${postId}/share`).set('Cookie', getCookieHeader(bobLogin));
    const secondShare = await request(app).post(`/api/posts/${postId}/share`).set('Cookie', getCookieHeader(bobLogin));
    expect(firstShare.body.shares).toBe(1);
    expect(secondShare.body.shares).toBe(2);

    const updated = await request(app)
      .patch(`/api/posts/${postId}`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ content: 'Edited post', visibility: 'FOLLOWERS' });
    expect(updated.status).toBe(200);
    expect(updated.body.post.content).toBe('Edited post');
    expect(updated.body.post.visibility).toBe('FOLLOWERS');

    const hiddenPost = await request(app).get(`/api/posts/${postId}`).set('Cookie', getCookieHeader(bobLogin));
    expect(hiddenPost.status).toBe(404);
    await request(app)
      .post(`/api/users/${aliceId}/follow`)
      .set('Cookie', getCookieHeader(bobLogin));
    const visiblePost = await request(app).get(`/api/posts/${postId}`).set('Cookie', getCookieHeader(bobLogin));
    expect(visiblePost.body.post.savedByCurrentUser).toBe(true);
    expect(visiblePost.body.post.shares).toBe(2);
  });

  it('user cannot delete another user post', async () => {
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

    const bobLogin = await request(app).post('/api/auth/login').send({
      email: 'bob@example.com',
      password: 'Password123',
    });

    const createdPost = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ content: 'Alice post' });

    const forbidden = await request(app)
      .delete(`/api/posts/${createdPost.body.post.id}`)
      .set('Cookie', getCookieHeader(bobLogin));

    expect(forbidden.status).toBe(403);
  });

  it('creates a private conversation and sends a message', async () => {
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

    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');

    const conversation = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantId: bobUser.id });

    const message = await request(app)
      .post(`/api/conversations/${conversation.body.conversation.id}/messages`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ text: 'Hello Bob, can we coordinate the volunteer plan?' });

    expect(conversation.status).toBe(201);
    expect(message.status).toBe(201);
    expect(message.body.message.text).toContain('volunteer plan');
    const refreshed = await request(app)
      .get(`/api/conversations/${conversation.body.conversation.id}/messages`)
      .set('Cookie', getCookieHeader(aliceLogin));
    expect(refreshed.body.messages.some((entry: { id: string }) => entry.id === message.body.message.id)).toBe(true);
  });

  it('reports the actual unread message count and clears it when the conversation is read', async () => {
    for (const user of [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ]) {
      await request(app).post('/api/auth/register').send({ ...user, password: 'Password123', communityRulesAccepted: true });
    }
    const aliceLogin = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'Password123' });
    const bobLogin = await request(app).post('/api/auth/login').send({ email: 'bob@example.com', password: 'Password123' });
    const bob = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');
    const conversation = await request(app).post('/api/conversations').set('Cookie', getCookieHeader(aliceLogin)).send({ participantId: bob.id });

    for (const text of ['First unread message', 'Second unread message']) {
      const sent = await request(app)
        .post(`/api/conversations/${conversation.body.conversation.id}/messages`)
        .set('Cookie', getCookieHeader(bobLogin))
        .send({ text });
      expect(sent.status).toBe(201);
    }

    const unreadList = await request(app).get('/api/conversations').set('Cookie', getCookieHeader(aliceLogin));
    expect(unreadList.body.conversations.find((item: { id: string }) => item.id === conversation.body.conversation.id).unreadCount).toBe(2);

    await request(app).post(`/api/conversations/${conversation.body.conversation.id}/read`).set('Cookie', getCookieHeader(aliceLogin));
    const readList = await request(app).get('/api/conversations').set('Cookie', getCookieHeader(aliceLogin));
    expect(readList.body.conversations.find((item: { id: string }) => item.id === conversation.body.conversation.id).unreadCount).toBe(0);
  });

  it('limits stories to followed users and tracks each viewer once', async () => {
    for (const user of [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
      { name: 'Cara', email: 'cara@example.com' },
    ]) {
      await request(app).post('/api/auth/register').send({ ...user, password: 'Password123', communityRulesAccepted: true });
    }
    const aliceLogin = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'Password123' });
    const bobLogin = await request(app).post('/api/auth/login').send({ email: 'bob@example.com', password: 'Password123' });
    const caraLogin = await request(app).post('/api/auth/login').send({ email: 'cara@example.com', password: 'Password123' });
    const users = (await request(app).get('/api/users')).body.users as { id: string; name: string }[];
    const bob = users.find((user) => user.name === 'Bob')!;

    await request(app).post(`/api/users/${bob.id}/follow`).set('Cookie', getCookieHeader(aliceLogin));
    const bobStory = await request(app).post('/api/stories').set('Cookie', getCookieHeader(bobLogin)).send({ text: 'A real status update' });
    const caraStory = await request(app).post('/api/stories').set('Cookie', getCookieHeader(caraLogin)).send({ text: 'Only my followers should see this' });
    expect(bobStory.status).toBe(201);
    expect(new Date(bobStory.body.story.expiresAt).getTime() - new Date(bobStory.body.story.createdAt).getTime()).toBe(24 * 60 * 60 * 1000);

    const bobStatus = await request(app).post('/api/statuses').set('Cookie', getCookieHeader(bobLogin)).send({ text: 'A distinct text status' });
    const caraStatus = await request(app).post('/api/statuses').set('Cookie', getCookieHeader(caraLogin)).send({ text: 'Only followers can see this status' });
    const videoUpload = await request(app)
      .post('/api/media/videos')
      .set('Cookie', getCookieHeader(bobLogin))
      .attach('file', Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), 'status.mp4');
    const bobVideoStatus = await request(app).post('/api/statuses').set('Cookie', getCookieHeader(bobLogin))
      .send({ text: 'A media status', mediaUrl: videoUpload.body.mediaUrl });
    expect(bobStatus.status).toBe(201);
    expect(bobStatus.body.status.mediaUrl).toBeNull();
    expect(new Date(bobStatus.body.status.expiresAt).getTime() - new Date(bobStatus.body.status.createdAt).getTime()).toBe(24 * 60 * 60 * 1000);
    expect(videoUpload.status).toBe(201);
    expect(bobVideoStatus.status).toBe(201);
    expect(bobVideoStatus.body.status.mediaUrl).toBe(videoUpload.body.mediaUrl);

    const aliceStories = await request(app).get('/api/stories').set('Cookie', getCookieHeader(aliceLogin));
    expect(aliceStories.body.stories.map((story: { id: string }) => story.id)).toContain(bobStory.body.story.id);
    expect(aliceStories.body.stories.map((story: { id: string }) => story.id)).not.toContain(caraStory.body.story.id);
    expect(aliceStories.body.stories.map((story: { id: string }) => story.id)).not.toContain(bobStatus.body.status.id);
    expect((await request(app).post(`/api/stories/${caraStory.body.story.id}/view`).set('Cookie', getCookieHeader(aliceLogin))).status).toBe(404);

    const aliceStatuses = await request(app).get('/api/statuses').set('Cookie', getCookieHeader(aliceLogin));
    expect(aliceStatuses.body.statuses.map((status: { id: string }) => status.id)).toContain(bobStatus.body.status.id);
    expect(aliceStatuses.body.statuses.map((status: { id: string }) => status.id)).toContain(bobVideoStatus.body.status.id);
    expect(aliceStatuses.body.statuses.map((status: { id: string }) => status.id)).not.toContain(caraStatus.body.status.id);
    expect((await request(app).post(`/api/statuses/${caraStatus.body.status.id}/view`).set('Cookie', getCookieHeader(aliceLogin))).status).toBe(404);
    expect((await request(app).post(`/api/statuses/${bobVideoStatus.body.status.id}/view`).set('Cookie', getCookieHeader(aliceLogin))).body.viewCount).toBe(1);

    const firstView = await request(app).post(`/api/stories/${bobStory.body.story.id}/view`).set('Cookie', getCookieHeader(aliceLogin));
    const duplicateView = await request(app).post(`/api/stories/${bobStory.body.story.id}/view`).set('Cookie', getCookieHeader(aliceLogin));
    expect(firstView.body.viewCount).toBe(1);
    expect(duplicateView.body.viewCount).toBe(1);
    expect((await request(app).delete(`/api/stories/${bobStory.body.story.id}`).set('Cookie', getCookieHeader(aliceLogin))).status).toBe(404);
    expect((await request(app).delete(`/api/stories/${bobStory.body.story.id}`).set('Cookie', getCookieHeader(bobLogin))).status).toBe(200);
  });

  it('uses database profiles and records story views without accessing in-memory storage', async () => {
    const viewerId = 'database-viewer';
    const authorId = 'database-author';
    const storyId = 'database-story';
    const token = signAccessToken({ sub: viewerId, email: 'viewer@example.com', role: 'USER' });

    vi.mocked(isDatabaseAvailable).mockResolvedValue(true);
    vi.spyOn(prisma.session, 'findFirst').mockResolvedValue({ id: 'database-session' } as never);
    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: viewerId,
      email: 'viewer@example.com',
      name: 'Viewer',
      role: 'USER',
      status: 'ACTIVE',
    } as never);
    vi.spyOn(prisma.follow, 'findMany').mockResolvedValue([{ followingId: authorId }] as never);
    vi.spyOn(prisma.follow, 'findUnique').mockResolvedValue({ id: 'database-follow' } as never);
    vi.spyOn(prisma.block, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.story, 'findMany').mockResolvedValue([{
      id: storyId,
      authorId,
      text: 'A database-backed story',
      mediaUrl: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      author: {
        id: authorId,
        name: 'Author',
        email: 'author@example.com',
        profile: null,
      },
      views: [],
      _count: { views: 0 },
    }] as never);
    vi.spyOn(prisma.story, 'findFirst').mockResolvedValue({ id: storyId, authorId } as never);
    const upsertView = vi.spyOn(prisma.storyView, 'upsert').mockResolvedValue({} as never);
    vi.spyOn(prisma.storyView, 'count').mockResolvedValue(1);
    vi.spyOn(socialStore, 'state', 'get').mockImplementation(() => {
      throw new Error('In-memory fallback storage is disabled in production.');
    });

    const stories = await request(app)
      .get('/api/stories')
      .set('Authorization', `Bearer ${token}`);

    expect(stories.status).toBe(200);
    expect(stories.body.stories[0]).toMatchObject({
      id: storyId,
      viewCount: 0,
      viewedByMe: false,
      author: {
        id: authorId,
        handle: 'author',
        profile: {
          displayName: 'Author',
          username: 'author',
          avatarUrl: null,
        },
      },
    });

    const firstView = await request(app)
      .post(`/api/stories/${storyId}/view`)
      .set('Authorization', `Bearer ${token}`);
    const duplicateView = await request(app)
      .post(`/api/stories/${storyId}/view`)
      .set('Authorization', `Bearer ${token}`);

    expect(firstView.status).toBe(200);
    expect(duplicateView.status).toBe(200);
    expect(firstView.body).toEqual({ viewed: true, viewCount: 1 });
    expect(duplicateView.body).toEqual({ viewed: true, viewCount: 1 });
    expect(upsertView).toHaveBeenCalledTimes(2);
    expect(upsertView).toHaveBeenCalledWith(expect.objectContaining({
      where: { storyId_viewerId: { storyId, viewerId } },
      create: { storyId, viewerId },
    }));
    expect(prisma.session.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tokenHash: hashSessionToken(token) }),
    }));
  });

  it('does not create a conversation with a missing user', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const response = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantId: 'missing-user' });

    expect(response.status).toBe(404);
  });

  it('creates a group conversation with all requested participants', async () => {
    for (const user of [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
      { name: 'Cara', email: 'cara@example.com' },
    ]) {
      await request(app).post('/api/auth/register').send({
        ...user,
        password: 'Password123',
        communityRulesAccepted: true,
      });
    }

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const users = (await request(app).get('/api/users')).body.users as { id: string; name: string }[];
    const bob = users.find((user) => user.name === 'Bob')!;
    const cara = users.find((user) => user.name === 'Cara')!;

    const created = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantIds: [bob.id, cara.id], name: 'Volunteer Team' });
    const details = await request(app)
      .get(`/api/conversations/${created.body.conversation.id}`)
      .set('Cookie', getCookieHeader(aliceLogin));

    expect(created.status).toBe(201);
    expect(details.body.conversation.participants.map((participant: { userId: string }) => participant.userId).sort())
      .toEqual([aliceLogin.body.user.id, bob.id, cara.id].sort());
  });

  it('returns persisted conversation preferences in the conversation list', async () => {
    for (const user of [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ]) {
      await request(app).post('/api/auth/register').send({
        ...user,
        password: 'Password123',
        communityRulesAccepted: true,
      });
    }
    const aliceLogin = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'Password123' });
    const bob = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');
    const conversation = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantId: bob.id });

    await request(app)
      .patch(`/api/conversations/${conversation.body.conversation.id}/preferences`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ pinned: true, starred: true });
    const list = await request(app)
      .get('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin));
    const listed = list.body.conversations.find((item: { id: string }) => item.id === conversation.body.conversation.id);

    expect(listed.pinnedAt).toBeTruthy();
    expect(listed.starredAt).toBeTruthy();
  });

  it('prevents sending to a group member who has blocked the sender', async () => {
    for (const user of [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
      { name: 'Cara', email: 'cara@example.com' },
    ]) {
      await request(app).post('/api/auth/register').send({
        ...user,
        password: 'Password123',
        communityRulesAccepted: true,
      });
    }

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const caraLogin = await request(app).post('/api/auth/login').send({
      email: 'cara@example.com',
      password: 'Password123',
    });
    const users = (await request(app).get('/api/users')).body.users as { id: string; name: string }[];
    const bob = users.find((user) => user.name === 'Bob')!;
    const cara = users.find((user) => user.name === 'Cara')!;
    const created = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantIds: [bob.id, cara.id] });

    await request(app)
      .post(`/api/users/${aliceLogin.body.user.id}/block`)
      .set('Cookie', getCookieHeader(caraLogin));
    const response = await request(app)
      .post(`/api/conversations/${created.body.conversation.id}/messages`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ text: 'A group update' });

    expect(response.status).toBe(403);
  });

  it('report requires authentication', async () => {
    const response = await request(app).post('/api/reports').send({
      targetType: 'post',
      targetId: 'missing',
      category: 'SPAM',
      reason: 'This is spam',
    });

    expect(response.status).toBe(401);
  });
});
