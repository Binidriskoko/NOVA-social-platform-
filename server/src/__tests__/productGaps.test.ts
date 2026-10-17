import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { TokenVerifier } from 'livekit-server-sdk';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { clearCommand2AStores, updateLiveSession } from '../lib/platform.js';

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

describe('product area gaps', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
    clearCommand2AStores();
  });

  it('supports structured messages, replies, edits, reactions, search, gallery, and chat controls', async () => {
    const alice = await register('GapAlice');
    const bob = await register('GapBob');
    const conversation = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: bob.user.id });
    const conversationId = conversation.body.conversation.id;

    const image = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth).send({ contentType: 'IMAGE', mediaUrl: 'https://example.com/photo.jpg', text: 'garden' });
    expect(image.status).toBe(201);
    expect(image.body.message.contentType).toBe('IMAGE');
    const reply = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', bob.auth).send({ text: 'Nice photo', replyToId: image.body.message.id });
    expect(reply.body.message.replyToId).toBe(image.body.message.id);

    const edited = await request(app).patch(`/api/messages/${reply.body.message.id}`).set('Cookie', bob.auth).send({ text: 'Really nice photo' });
    expect(edited.body.message.text).toBe('Really nice photo');
    expect(edited.body.message.editedAt).toBeTruthy();
    const reacted = await request(app).post(`/api/messages/${image.body.message.id}/reactions`).set('Cookie', bob.auth).send({ type: '❤️' });
    expect(reacted.body.reactions).toHaveLength(1);
    expect((await request(app).get('/api/messages/search?q=Really%20nice').set('Cookie', alice.auth)).body.messages).toHaveLength(1);
    expect((await request(app).get(`/api/conversations/${conversationId}/media`).set('Cookie', bob.auth)).body.media).toHaveLength(1);

    const preferences = await request(app).patch(`/api/conversations/${conversationId}/preferences`).set('Cookie', alice.auth).send({ pinned: true, archived: true, starred: true, disappearingAfterSeconds: 3600 });
    expect(preferences.status).toBe(200);
    const expiring = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth).send({ text: 'This will disappear' });
    expect(Date.parse(expiring.body.message.expiresAt)).toBeGreaterThan(Date.now());

    const charlie = await register('GapCharlie');
    const destination = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: charlie.user.id });
    const forwarded = await request(app).post(`/api/messages/${image.body.message.id}/forward`).set('Cookie', alice.auth).send({ conversationId: destination.body.conversation.id });
    expect(forwarded.status).toBe(201);
    expect(forwarded.body.message.forwardedFromId).toBe(image.body.message.id);
    expect((await request(app).post(`/api/messages/${image.body.message.id}/report`).set('Cookie', bob.auth).send({ category: 'SPAM', reason: 'Unwanted promotional content.' })).status).toBe(201);
  });

  it('enforces channel posting and group member administration', async () => {
    const owner = await register('GapOwner');
    const moderator = await register('GapModerator');
    const guest = await register('GapGuest');
    const created = await request(app).post('/api/conversations').set('Cookie', owner.auth).send({ participantIds: [moderator.user.id], isChannel: true, name: 'Updates' });
    const channelId = created.body.conversation.id;
    expect((await request(app).post(`/api/conversations/${channelId}/messages`).set('Cookie', moderator.auth).send({ text: 'Unauthorized update' })).status).toBe(403);
    expect((await request(app).post(`/api/conversations/${channelId}/participants`).set('Cookie', owner.auth).send({ participantIds: [guest.user.id] })).status).toBe(201);
    expect((await request(app).patch(`/api/conversations/${channelId}/participants/${moderator.user.id}`).set('Cookie', owner.auth).send({ role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).patch(`/api/conversations/${channelId}/participants/${guest.user.id}`).set('Cookie', moderator.auth).send({ role: 'MODERATOR' })).status).toBe(403);
    expect((await request(app).post(`/api/conversations/${channelId}/participants`).set('Cookie', moderator.auth).send({ participantIds: [guest.user.id] })).status).toBe(403);
    expect((await request(app).post(`/api/conversations/${channelId}/messages`).set('Cookie', moderator.auth).send({ text: 'Official update' })).status).toBe(201);
    expect((await request(app).delete(`/api/conversations/${channelId}/participants/${guest.user.id}`).set('Cookie', moderator.auth)).status).toBe(200);
  });

  it('lets group owners and moderators add new members but prevents direct-chat expansion', async () => {
    const owner = await register('AddGroupOwner');
    const moderator = await register('AddGroupModerator');
    const member = await register('AddGroupMember');
    const guest = await register('AddGroupGuest');
    const outsider = await register('AddGroupOutsider');
    const created = await request(app).post('/api/conversations').set('Cookie', owner.auth).send({
      participantIds: [moderator.user.id, member.user.id],
      name: 'Small group',
    });
    const groupId = created.body.conversation.id;

    expect((await request(app).get('/api/conversations').set('Cookie', owner.auth)).body.conversations.find((entry: { id: string }) => entry.id === groupId).isGroup).toBe(true);
    expect((await request(app).get(`/api/conversations/${groupId}`).set('Cookie', owner.auth)).body.conversation.participants.find((entry: { userId: string }) => entry.userId === owner.user.id).role).toBe('OWNER');
    expect((await request(app).patch(`/api/conversations/${groupId}/group`).set('Cookie', member.auth).send({ name: 'Unauthorized rename' })).status).toBe(403);
    const updatedGroup = await request(app).patch(`/api/conversations/${groupId}/group`).set('Cookie', owner.auth).send({
      name: 'Small group profile',
      description: 'Group information managed by admins.',
    });
    expect(updatedGroup.status).toBe(200);
    expect(updatedGroup.body.group).toMatchObject({ name: 'Small group profile', description: 'Group information managed by admins.', imageUrl: null });
    expect((await request(app).post(`/api/conversations/${groupId}/participants`).set('Cookie', outsider.auth).send({ participantIds: [guest.user.id] })).status).toBe(404);
    expect((await request(app).post(`/api/conversations/${groupId}/participants`).set('Cookie', member.auth).send({ participantIds: [guest.user.id] })).status).toBe(403);
    expect((await request(app).patch(`/api/conversations/${groupId}/participants/${moderator.user.id}`).set('Cookie', member.auth).send({ role: 'MODERATOR' })).status).toBe(403);
    expect((await request(app).post(`/api/conversations/${groupId}/participants`).set('Cookie', owner.auth).send({ participantIds: [guest.user.id, guest.user.id] })).status).toBe(400);
    expect((await request(app).post(`/api/conversations/${groupId}/participants`).set('Cookie', owner.auth).send({ participantIds: [guest.user.id] })).body.added).toEqual([guest.user.id]);
    const duplicateAdd = await request(app).post(`/api/conversations/${groupId}/participants`).set('Cookie', owner.auth).send({ participantIds: [guest.user.id] });
    expect(duplicateAdd.status).toBe(201);
    expect(duplicateAdd.body.added).toEqual([]);
    expect((await request(app).get(`/api/conversations/${groupId}`).set('Cookie', owner.auth)).body.conversation.participants.filter((participant: { userId: string }) => participant.userId === guest.user.id)).toHaveLength(1);
    expect((await request(app).get('/api/conversations').set('Cookie', guest.auth)).body.conversations.some((entry: { id: string }) => entry.id === groupId)).toBe(true);

    const promoted = await request(app).patch(`/api/conversations/${groupId}/participants/${moderator.user.id}`).set('Cookie', owner.auth).send({ role: 'MODERATOR' });
    expect(promoted.status).toBe(200);
    expect((await request(app).patch(`/api/conversations/${groupId}/group`).set('Cookie', moderator.auth).send({ description: 'Admin-maintained description.' })).status).toBe(200);
    expect((await request(app).patch(`/api/conversations/${groupId}/participants/${member.user.id}`).set('Cookie', moderator.auth).send({ role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).post(`/api/conversations/${groupId}/participants`).set('Cookie', moderator.auth).send({ participantIds: [outsider.user.id] })).body.added).toEqual([outsider.user.id]);
    expect((await request(app).delete(`/api/conversations/${groupId}/participants/${member.user.id}`).set('Cookie', moderator.auth)).status).toBe(200);
    expect((await request(app).patch(`/api/conversations/${groupId}/participants/${moderator.user.id}`).set('Cookie', moderator.auth).send({ role: 'MEMBER' })).status).toBe(200);
    expect((await request(app).patch(`/api/conversations/${groupId}/participants/${moderator.user.id}`).set('Cookie', owner.auth).send({ role: 'MEMBER' })).status).toBe(200);
    expect((await request(app).patch(`/api/conversations/${groupId}/participants/${owner.user.id}`).set('Cookie', owner.auth).send({ role: 'MEMBER' })).status).toBe(409);
    expect((await request(app).delete(`/api/conversations/${groupId}/participants/${owner.user.id}`).set('Cookie', owner.auth)).status).toBe(409);
    expect((await request(app).patch(`/api/conversations/${groupId}/participants/${moderator.user.id}`).set('Cookie', outsider.auth).send({ role: 'MEMBER' })).status).toBe(403);
    expect((await request(app).patch(`/api/conversations/${groupId}/participants/missing-group-member`).set('Cookie', owner.auth).send({ role: 'MODERATOR' })).status).toBe(404);

    const direct = await request(app).post('/api/conversations').set('Cookie', owner.auth).send({ participantId: outsider.user.id });
    expect((await request(app).post(`/api/conversations/${direct.body.conversation.id}/participants`).set('Cookie', owner.auth).send({ participantIds: [guest.user.id] })).status).toBe(400);
  });

  it('persists poll votes and event responses for conversation members only', async () => {
    const alice = await register('InteractiveAlice');
    const bob = await register('InteractiveBob');
    const outsider = await register('InteractiveOutsider');
    const conversation = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: bob.user.id });
    const conversationId = conversation.body.conversation.id;
    const poll = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth).send({
      contentType: 'POLL',
      metadata: { question: 'Which day?', options: [{ id: 'sat', text: 'Saturday' }, { id: 'sun', text: 'Sunday' }], votes: {} },
    });
    expect(poll.status).toBe(201);
    expect((await request(app).post(`/api/messages/${poll.body.message.id}/interactive-response`).set('Cookie', bob.auth).send({ optionId: 'missing' })).status).toBe(400);
    expect((await request(app).post(`/api/messages/${poll.body.message.id}/interactive-response`).set('Cookie', outsider.auth).send({ optionId: 'sat' })).status).toBe(403);
    const vote = await request(app).post(`/api/messages/${poll.body.message.id}/interactive-response`).set('Cookie', bob.auth).send({ optionId: 'sat' });
    expect(vote.body.message.metadata.votes[bob.user.id]).toBe('sat');

    const event = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth).send({
      contentType: 'EVENT',
      metadata: { title: 'Community meetup', startsAt: '2026-10-20T17:00:00.000Z', responses: {} },
    });
    const rsvp = await request(app).post(`/api/messages/${event.body.message.id}/interactive-response`).set('Cookie', bob.auth).send({ response: 'GOING' });
    expect(rsvp.body.message.metadata.responses[bob.user.id]).toBe('GOING');
    const history = await request(app).get(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth);
    expect(history.body.messages.map((message: { contentType: string }) => message.contentType)).toContain('EVENT');
  });

  it('supports private community channels through invitation-only membership', async () => {
    const owner = await register('PrivateSpaceOwner');
    const member = await register('PrivateSpaceMember');
    const created = await request(app).post('/api/communities').set('Cookie', owner.auth).send({ name: 'Private Updates', type: 'CHANNEL', isPrivate: true });
    expect(created.body.community.type).toBe('CHANNEL');
    expect(created.body.community.isPrivate).toBe(true);
    expect((await request(app).get('/api/communities').set('Cookie', member.auth)).body.communities).toHaveLength(0);
    expect((await request(app).post(`/api/communities/${created.body.community.id}/join`).set('Cookie', member.auth)).status).toBe(403);
    expect((await request(app).post(`/api/communities/${created.body.community.id}/invites`).set('Cookie', owner.auth).send({ userId: member.user.id })).status).toBe(201);
    const detail = await request(app).get(`/api/communities/${created.body.community.id}`).set('Cookie', member.auth);
    expect(detail.body.community.joined).toBe(true);
    expect((await request(app).delete(`/api/communities/${created.body.community.id}/members/${member.user.id}`).set('Cookie', owner.auth)).status).toBe(200);
  });

  it('issues LiveKit call tokens only to eligible participants and confirms real room membership', async () => {
    const caller = await register('CallCaller');
    const one = await register('CallOne');
    const outsider = await register('CallOutsider');
    const started = await request(app).post('/api/calls/start').set('Cookie', caller.auth).send({ targetUserId: one.user.id, type: 'video' });
    expect(started.status).toBe(201);
    expect(started.body.call.providerConfigured).toBe(true);
    expect(started.body.call.provider).toBe('livekit');
    expect(started.body.call.status).toBe('ringing');
    expect(started.body.call.participants.map((participant: { userId: string }) => participant.userId)).toContain(one.user.id);
    const tokenPath = `/api/calls/${started.body.call.id}/token`;
    expect((await request(app).post(tokenPath).set('Cookie', outsider.auth)).status).toBe(403);
    expect((await request(app).post(tokenPath).set('Cookie', one.auth)).status).toBe(403);
    const callerToken = await request(app).post(tokenPath).set('Cookie', caller.auth);
    expect(callerToken.status).toBe(200);
    expect(callerToken.headers['cache-control']).toBe('no-store');
    const callerClaims = await new TokenVerifier('test-livekit-key', 'test-livekit-secret-that-is-only-used-in-tests').verify(callerToken.body.token);
    expect(callerClaims.video).toMatchObject({
      roomJoin: true,
      room: `nova-call-${started.body.call.id}`,
      canPublish: true,
      canPublishSources: ['microphone', 'camera'],
      canSubscribe: true,
    });

    const accepted = await request(app).post(`/api/calls/${started.body.call.id}/accept`).set('Cookie', one.auth);
    expect(accepted.body.call.status).toBe('ringing');
    const targetToken = await request(app).post(tokenPath).set('Cookie', one.auth);
    expect(targetToken.status).toBe(200);
    expect((await new TokenVerifier('test-livekit-key', 'test-livekit-secret-that-is-only-used-in-tests').verify(targetToken.body.token)).video)
      .toMatchObject({ roomJoin: true, room: `nova-call-${started.body.call.id}`, canPublish: true, canSubscribe: true });
    const falseConnection = await request(app).post(`/api/calls/${started.body.call.id}/connected`).set('Cookie', caller.auth);
    expect(falseConnection.status).toBe(503);
    expect((await request(app).get('/api/calls/history').set('Cookie', caller.auth)).body.calls[0].status).toBe('ringing');
  });

  it('grants publishers only to live hosts and subscribe-only access to joined viewers', async () => {
    const host = await register('LiveHost');
    const viewer = await register('LiveGuest');
    const outsider = await register('LiveOutsider');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Community stream' });
    expect(created.status).toBe(201);
    expect(created.body.live.providerConfigured).toBe(true);
    expect(created.body.live.provider).toBe('livekit');
    const liveId = created.body.live.id;
    const tokenPath = `/api/live/${liveId}/token`;
    const hostToken = await request(app).post(tokenPath).set('Cookie', host.auth);
    expect(hostToken.status).toBe(200);
    expect((await new TokenVerifier('test-livekit-key', 'test-livekit-secret-that-is-only-used-in-tests').verify(hostToken.body.token)).video)
      .toMatchObject({
        roomJoin: true,
        room: `nova-live-${liveId}`,
        canPublish: true,
        canPublishSources: ['microphone', 'camera'],
        canSubscribe: true,
      });
    expect((await request(app).post(tokenPath).set('Cookie', viewer.auth)).status).toBe(403);

    const failedStart = await request(app).post(`/api/live/${liveId}/start`).set('Cookie', host.auth);
    expect(failedStart.status).toBe(503);
    expect((await request(app).get('/api/live').set('Cookie', host.auth)).body.lives[0].status).toBe('paused');

    updateLiveSession(liveId, (current) => ({
      ...current,
      status: 'live',
      viewers: [{ userId: viewer.user.id, isMuted: false, isBlocked: false, joinedAt: new Date().toISOString() }],
      viewerCount: 1,
    }));
    const viewerToken = await request(app).post(tokenPath).set('Cookie', viewer.auth);
    expect(viewerToken.status).toBe(200);
    expect((await new TokenVerifier('test-livekit-key', 'test-livekit-secret-that-is-only-used-in-tests').verify(viewerToken.body.token)).video)
      .toMatchObject({ roomJoin: true, room: `nova-live-${liveId}`, canPublish: false, canSubscribe: true });
    expect((await request(app).post(tokenPath).set('Cookie', outsider.auth)).status).toBe(403);
  });
});
