import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { commerceStore } from '../lib/commerceStore.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { paymentWebhookSignature } from '../lib/paymentProviders.js';
import { socialStore } from '../lib/socialStore.js';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function register(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  const registered = await request(app).post('/api/auth/register').send({ name, email, password: 'Password123', communityRulesAccepted: true });
  expect(registered.status).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123' });
  return { user: registered.body.user, auth: cookie(login) };
}

describe('creator monetization and internal advertising', () => {
  beforeEach(() => { fallbackStore.clear(); socialStore.clear(); commerceStore.clear(); });

  it('records qualified watch-time only when the configured threshold is met and rejects duplicate submissions', async () => {
    const creator = await register('MeasuredCreator');
    const viewer = await register('MeasuredViewer');
    const admin = await register('MeasuredAdmin');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });

    const post = await request(app).post('/api/posts').set('Cookie', creator.auth).send({ content: 'Great video', imageUrl: 'https://cdn.example.test/video.mp4', visibility: 'PUBLIC' });
    expect(post.status).toBe(201);

    await request(app).patch('/api/admin/monetization/settings').set('Cookie', admin.auth).send({ minimumQualifiedViews: 1, qualifiedViewWindowDays: 30, minimumWatchTimeSeconds: 1, minimumFollowers: 0, minimumEngagementRate: 0, minimumAccountAgeDays: 0, minimumPublicPosts: 0 });

    const first = await request(app).post('/api/monetization/video-views/start').set('Cookie', viewer.auth).send({
      postId: post.body.post.id,
      sessionId: 'session-qualified-1',
      durationSeconds: 90,
      source: 'feed',
    });
    expect(first.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const heartbeat = await request(app).post('/api/monetization/video-views/heartbeat').set('Cookie', viewer.auth).send({ postId: post.body.post.id, sessionId: 'session-qualified-1', currentTimeSeconds: 2 });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.creditedSeconds).toBeGreaterThanOrEqual(1);
    const finished = await request(app).post('/api/monetization/video-views/finish').set('Cookie', viewer.auth).send({ postId: post.body.post.id, sessionId: 'session-qualified-1' });
    expect(finished.body.qualified).toBe(true);
    expect((await request(app).get('/api/creators/me/monetization').set('Cookie', creator.auth)).body.metrics.qualifiedViews).toBe(1);
    expect((await request(app).get('/api/creators/me/monetization').set('Cookie', creator.auth)).body.metrics.watchTimeSeconds).toBeGreaterThanOrEqual(1);

    const duplicate = await request(app).post('/api/monetization/video-views/start').set('Cookie', viewer.auth).send({ postId: post.body.post.id, sessionId: 'session-qualified-1', durationSeconds: 90, source: 'feed' });
    expect(duplicate.status).toBe(409);

    await request(app).post('/api/monetization/video-views/start').set('Cookie', viewer.auth).send({ postId: post.body.post.id, sessionId: 'session-paused-1', durationSeconds: 90, source: 'feed' });
    const paused = await request(app).post('/api/monetization/video-views/finish').set('Cookie', viewer.auth).send({ postId: post.body.post.id, sessionId: 'session-paused-1' });
    expect(paused.status).toBe(200);
    expect(paused.body.qualified).toBe(false);

    await request(app).post('/api/monetization/video-views/start').set('Cookie', viewer.auth).send({
      postId: post.body.post.id,
      sessionId: 'session-slow-playback-1',
      durationSeconds: 90,
      source: 'feed',
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const slowHeartbeat = await request(app).post('/api/monetization/video-views/heartbeat').set('Cookie', viewer.auth).send({
      postId: post.body.post.id,
      sessionId: 'session-slow-playback-1',
      currentTimeSeconds: 0.5,
    });
    expect(slowHeartbeat.status).toBe(200);
    expect(slowHeartbeat.body.creditedSeconds).toBe(0);
    const slowFinish = await request(app).post('/api/monetization/video-views/finish').set('Cookie', viewer.auth).send({
      postId: post.body.post.id,
      sessionId: 'session-slow-playback-1',
    });
    expect(slowFinish.body.qualified).toBe(false);

    await request(app).post('/api/monetization/video-views/start').set('Cookie', viewer.auth).send({
      postId: post.body.post.id,
      sessionId: 'session-resumed-playback-1',
      durationSeconds: 90,
      startPositionSeconds: 20,
      source: 'feed',
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const resumedHeartbeat = await request(app).post('/api/monetization/video-views/heartbeat').set('Cookie', viewer.auth).send({
      postId: post.body.post.id,
      sessionId: 'session-resumed-playback-1',
      currentTimeSeconds: 21.5,
    });
    expect(resumedHeartbeat.status).toBe(200);
    expect(resumedHeartbeat.body.creditedSeconds).toBeGreaterThanOrEqual(1);
    const resumedFinish = await request(app).post('/api/monetization/video-views/finish').set('Cookie', viewer.auth).send({
      postId: post.body.post.id,
      sessionId: 'session-resumed-playback-1',
    });
    expect(resumedFinish.body.qualified).toBe(true);
  }, 15000);

  it('blocks unauthorized, impossible, private, and expired playback submissions', async () => {
    const creator = await register('RestrictedCreator');
    const viewer = await register('RestrictedViewer');
    const privateViewer = await register('PrivateViewer');
    const admin = await register('RestrictedAdmin');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });

    const privatePost = await request(app).post('/api/posts').set('Cookie', creator.auth).send({ content: 'Private clip', imageUrl: 'https://cdn.example.test/private.mp4', visibility: 'FOLLOWERS' });
    expect(privatePost.status).toBe(201);

    const invalid = await request(app).post('/api/monetization/video-views/start').set('Cookie', viewer.auth).send({
      postId: privatePost.body.post.id,
      sessionId: 'session-invalid-1',
      durationSeconds: 0,
    });
    expect(invalid.status).toBe(400);

    const unauthorized = await request(app).post('/api/monetization/video-views/start').set('Cookie', privateViewer.auth).send({
      postId: privatePost.body.post.id,
      sessionId: 'session-unauthorized-1',
      durationSeconds: 90,
      source: 'feed',
    });
    expect(unauthorized.status).toBe(403);

    const publicPost = await request(app).post('/api/posts').set('Cookie', creator.auth).send({ content: 'Public clip', imageUrl: 'https://cdn.example.test/public.mp4', visibility: 'PUBLIC' });
    const forged = await request(app).post('/api/monetization/video-views/heartbeat').set('Cookie', viewer.auth).send({
      postId: publicPost.body.post.id,
      sessionId: 'session-forged-1',
      currentTimeSeconds: 20,
    });
    expect(forged.status).toBe(409);
    const overrunStart = await request(app).post('/api/monetization/video-views/start').set('Cookie', viewer.auth).send({
      postId: publicPost.body.post.id,
      sessionId: 'session-overrun-1',
      durationSeconds: 1,
    });
    expect(overrunStart.status).toBe(201);
    const impossiblePosition = await request(app).post('/api/monetization/video-views/heartbeat').set('Cookie', viewer.auth).send({
      postId: publicPost.body.post.id,
      sessionId: 'session-overrun-1',
      currentTimeSeconds: 2,
    });
    expect(impossiblePosition.status).toBe(400);
  }, 15000);

  it('uses the rolling qualified-view window and creator eligibility thresholds from validated records only', async () => {
    const creator = await register('WindowCreator');
    const viewer = await register('WindowViewer');
    const admin = await register('WindowAdmin');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });

    const post = await request(app).post('/api/posts').set('Cookie', creator.auth).send({ content: 'Windowed clip', imageUrl: 'https://cdn.example.test/window.mp4', visibility: 'PUBLIC' });
    expect(post.status).toBe(201);

    await request(app).patch('/api/admin/monetization/settings').set('Cookie', admin.auth).send({
      minimumQualifiedViews: 1,
      qualifiedViewWindowDays: 7,
      minimumWatchTimeSeconds: 10,
      minimumFollowers: 0,
      minimumEngagementRate: 0,
      minimumAccountAgeDays: 0,
      minimumPublicPosts: 0,
    });

    socialStore.state.videoMeasurements.push({
      id: 'window-current',
      postId: post.body.post.id,
      viewerId: viewer.user.id,
      sessionId: 'window-current',
      source: 'videos',
      watchSeconds: 25,
      durationSeconds: 120,
      lastPositionSeconds: 25,
      lastHeartbeatAt: new Date().toISOString(),
      active: false,
      startedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date().toISOString(),
      qualified: true,
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    }, {
      id: 'window-old',
      postId: post.body.post.id,
      viewerId: viewer.user.id,
      sessionId: 'window-old',
      source: 'videos',
      watchSeconds: 25,
      durationSeconds: 120,
      lastPositionSeconds: 25,
      lastHeartbeatAt: null,
      active: false,
      startedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      qualified: true,
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const eligibility = await request(app).get('/api/creators/me/monetization').set('Cookie', creator.auth);
    expect(eligibility.body.metrics.qualifiedViews).toBe(1);
    expect(eligibility.body.requirements.find((item: { key: string }) => item.key === 'qualifiedViews').met).toBe(true);
  });

  it('keeps credentialed admin + creator checks in place for monetization settings and readiness warnings', async () => {
    const creator = await register('RulesCreator');
    const admin = await register('RulesAdmin');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });
    const settings = await request(app).get('/api/admin/monetization/settings').set('Cookie', admin.auth);
    expect(settings.status).toBe(200);
    expect(settings.body.measurementReady).toBe(false);
    expect((await request(app).patch('/api/admin/monetization/settings').set('Cookie', creator.auth).send({ minimumQualifiedViews: 1 })).status).toBe(403);
    expect((await request(app).get('/api/creators/me/monetization').set('Cookie', creator.auth)).body.requirements.some((item: { key: string }) => item.key === 'qualifiedViews')).toBe(true);
  });

  it('enforces configurable eligibility and reviews creator applications with admin-only approval', async () => {
    const creator = await register('Applicant');
    const admin = await register('ReviewAdmin');
    const outsider = await register('RegularUser');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });

    const locked = await request(app).get('/api/creators/me/monetization').set('Cookie', creator.auth);
    expect(locked.status).toBe(200);
    expect(locked.body.metrics.qualifiedViews).toBe(0);
    expect(locked.body.eligible).toBe(false);
    expect((await request(app).post('/api/creators/me/monetization/applications').set('Cookie', creator.auth).send({})).status).toBe(409);

    const settings = {
      enabled: true,
      minimumFollowers: 0,
      minimumQualifiedViews: 1,
      qualifiedViewWindowDays: 7,
      minimumWatchTimeSeconds: 0,
      minimumEngagementRate: 0,
      minimumAccountAgeDays: 0,
      minimumPublicPosts: 0,
      revenueSharePercent: 75,
      minimumPayoutCents: 100,
    };
    expect((await request(app).patch('/api/admin/monetization/settings').set('Cookie', outsider.auth).send(settings)).status).toBe(403);
    expect((await request(app).patch('/api/admin/monetization/settings').set('Cookie', admin.auth).send(settings)).status).toBe(200);
    const unavailableViews = await request(app).get('/api/creators/me/monetization').set('Cookie', creator.auth);
    expect(unavailableViews.body.requirements.find((item: { key: string }) => item.key === 'qualifiedViews').met).toBe(false);

    expect((await request(app).patch('/api/admin/monetization/settings').set('Cookie', admin.auth).send({ minimumQualifiedViews: 0 })).status).toBe(200);
    const application = await request(app).post('/api/creators/me/monetization/applications').set('Cookie', creator.auth).send({ reason: 'I create original public posts.' });
    expect(application.status).toBe(201);
    expect((await request(app).post('/api/creators/me/monetization/applications').set('Cookie', creator.auth).send({})).status).toBe(409);
    expect((await request(app).get('/api/admin/monetization/applications').set('Cookie', outsider.auth)).status).toBe(403);

    const selfReview = await request(app).patch(`/api/admin/monetization/applications/${application.body.application.id}`).set('Cookie', creator.auth).send({ status: 'APPROVED', reason: 'Attempted self approval' });
    expect(selfReview.status).toBe(403);
    const approved = await request(app).patch(`/api/admin/monetization/applications/${application.body.application.id}`).set('Cookie', admin.auth).send({ status: 'APPROVED', reason: 'Eligibility verified.' });
    expect(approved.status).toBe(200);
    expect((await request(app).get('/api/creators/me/monetization').set('Cookie', creator.auth)).body.active).toBe(true);
    expect(fallbackStore.listAdminActions().some((entry) => entry.actionType === 'CREATOR_APPLICATION_APPROVED')).toBe(true);
    expect((await request(app).patch(`/api/admin/monetization/creators/${creator.user.id}/status`).set('Cookie', admin.auth).send({ status: 'SUSPENDED', reason: 'Policy review.' })).status).toBe(200);
    await request(app).put('/api/creators/me/profile').set('Cookie', creator.auth).send({ isEnabled: true });
    expect((await request(app).get('/api/creators/me/monetization').set('Cookie', creator.auth)).body.active).toBe(false);
    expect((await request(app).patch(`/api/admin/monetization/creators/${creator.user.id}/status`).set('Cookie', creator.auth).send({ status: 'ACTIVE', reason: 'Self reactivation' })).status).toBe(403);
    expect((await request(app).patch(`/api/admin/monetization/creators/${creator.user.id}/status`).set('Cookie', admin.auth).send({ status: 'ACTIVE', reason: 'Review completed.' })).status).toBe(200);
    await request(app).put('/api/creators/me/profile').set('Cookie', creator.auth).send({ subscriptionPriceCents: 1000 });
    const subscription = await request(app).post(`/api/creators/${creator.user.id}/subscribe`).set('Cookie', outsider.auth);
    const event = { eventId: 'monetization-share-event', reference: subscription.body.paymentIntent.reference, status: 'SUCCESS' as const, providerReference: 'provider-share-ref' };
    const webhook = () => request(app).post('/api/payments/webhooks/manual').set('x-payment-signature', paymentWebhookSignature('manual', event)).send(event);
    expect((await webhook()).status).toBe(200);
    expect((await webhook()).status).toBe(200);
    expect((await request(app).get('/api/creators/me/earnings').set('Cookie', creator.auth)).body.balanceCents).toBe(750);
  });

  it('requires consent, validates campaign events once, enforces transitions, and keeps ads out of private placements', async () => {
    const admin = await register('AdsAdmin');
    const advertiser = await register('Advertiser');
    const viewer = await register('AdViewer');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });

    expect((await request(app).put('/api/admin/ads/placements/private-messages').set('Cookie', admin.auth).send({ enabled: true, dailyBudgetCents: 10 })).status).toBe(400);
    expect((await request(app).put('/api/admin/ads/placements/feed').set('Cookie', admin.auth).send({ enabled: true, dailyBudgetCents: 1000 })).status).toBe(200);
    expect((await request(app).patch('/api/admin/ads/settings').set('Cookie', admin.auth).send({ enabled: true })).status).toBe(200);

    const startsAt = new Date(Date.now() - 1000).toISOString();
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    const created = await request(app).post('/api/ads/campaigns').set('Cookie', advertiser.auth).send({
      name: 'Feed campaign',
      placement: 'feed',
      creativeUrl: 'https://cdn.example.test/creative.png',
      destinationUrl: 'https://advertiser.example.test/offer',
      startsAt,
      endsAt,
      totalBudgetCents: 100,
      dailyBudgetCents: 50,
      costPerImpressionCents: 1,
      costPerClickCents: 2,
    });
    expect(created.status).toBe(201);
    expect(created.body.campaign.status).toBe('DRAFT');
    expect((await request(app).post(`/api/ads/campaigns/${created.body.campaign.id}/submit`).set('Cookie', advertiser.auth)).status).toBe(200);
    expect((await request(app).patch(`/api/admin/ads/campaigns/${created.body.campaign.id}`).set('Cookie', advertiser.auth).send({ status: 'APPROVED', reason: 'No self review' })).status).toBe(403);
    expect((await request(app).patch(`/api/admin/ads/campaigns/${created.body.campaign.id}`).set('Cookie', admin.auth).send({ status: 'APPROVED', reason: 'Creative checked.' })).body.campaign.status).toBe('ACTIVE');

    expect((await request(app).get('/api/ads/placements/feed').set('Cookie', viewer.auth)).body.campaign).toBeNull();
    await request(app).put('/api/ads/consent').set('Cookie', viewer.auth).send({ consented: true });
    const firstDelivery = await request(app).get('/api/ads/placements/feed').set('Cookie', viewer.auth);
    expect(firstDelivery.body.campaign.impressionId).toBeTruthy();
    const repeatedDelivery = await request(app).get('/api/ads/placements/feed').set('Cookie', viewer.auth);
    expect(repeatedDelivery.body.campaign.impressionId).toBe(firstDelivery.body.campaign.impressionId);
    expect(commerceStore.state.adEvents.filter((event) => event.eventType === 'IMPRESSION')).toHaveLength(1);

    const invalidClick = await request(app).post(`/api/ads/campaigns/${created.body.campaign.id}/events`).set('Cookie', viewer.auth).send({ eventType: 'CLICK', impressionId: 'forged' });
    expect(invalidClick.status).toBe(409);
    const validClick = await request(app).post(`/api/ads/campaigns/${created.body.campaign.id}/events`).set('Cookie', viewer.auth).send({ eventType: 'CLICK', impressionId: firstDelivery.body.campaign.impressionId });
    expect(validClick.status).toBe(201);
    const duplicateClick = await request(app).post(`/api/ads/campaigns/${created.body.campaign.id}/events`).set('Cookie', viewer.auth).send({ eventType: 'CLICK', impressionId: firstDelivery.body.campaign.impressionId });
    expect(duplicateClick.status).toBe(200);
    expect(commerceStore.state.adEvents.filter((event) => event.eventType === 'CLICK')).toHaveLength(1);

    expect((await request(app).patch(`/api/admin/ads/campaigns/${created.body.campaign.id}`).set('Cookie', admin.auth).send({ status: 'PAUSED', reason: 'Review requested.' })).body.campaign.status).toBe('PAUSED');
    expect((await request(app).get('/api/ads/placements/feed').set('Cookie', viewer.auth)).body.campaign).toBeNull();
    expect((await request(app).patch(`/api/admin/ads/campaigns/${created.body.campaign.id}`).set('Cookie', admin.auth).send({ status: 'RESUMED', reason: 'Review complete.' })).body.campaign.status).toBe('ACTIVE');
    expect((await request(app).get('/api/admin/ads/analytics').set('Cookie', viewer.auth)).status).toBe(403);
    expect((await request(app).get('/api/admin/ads/analytics').set('Cookie', admin.auth)).body.analytics).toEqual({ impressions: 1, clicks: 1, spendCents: 3 });
  });

  it('keeps payouts idempotent, enforces the configured minimum, and blocks unverified paid transitions', async () => {
    const creator = await register('PayoutCreator');
    const admin = await register('PayoutAdmin');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });
    await request(app).put('/api/creators/me/profile').set('Cookie', creator.auth).send({ subscriptionPriceCents: 1000 });
    commerceStore.state.creatorLedger.push({ id: 'seeded-ledger-test', creatorId: creator.user.id, type: 'SUBSCRIPTION', amountCents: 1000, currency: 'USD', createdAt: new Date() });
    await request(app).patch('/api/admin/monetization/settings').set('Cookie', admin.auth).send({ minimumPayoutCents: 500 });
    const tooSmall = await request(app).post('/api/creators/me/payouts').set('Cookie', creator.auth).set('Idempotency-Key', 'payout-too-small-1').send({ amountCents: 499 });
    expect(tooSmall.status).toBe(400);

    const payout = await request(app).post('/api/creators/me/payouts').set('Cookie', creator.auth).set('Idempotency-Key', 'payout-test-key-1').send({ amountCents: 500 });
    expect(payout.status).toBe(201);
    expect((await request(app).post('/api/creators/me/payouts').set('Cookie', creator.auth).set('Idempotency-Key', 'payout-test-key-1').send({ amountCents: 500 })).status).toBe(200);
    expect((await request(app).patch(`/api/admin/finance/payouts/${payout.body.payout.id}`).set('Cookie', admin.auth).send({ status: 'FAILED', reason: 'Invalid transition' })).status).toBe(409);
    expect((await request(app).patch(`/api/admin/finance/payouts/${payout.body.payout.id}`).set('Cookie', admin.auth).send({ status: 'APPROVED', reason: 'Validated request' })).status).toBe(200);
    expect((await request(app).patch(`/api/admin/finance/payouts/${payout.body.payout.id}`).set('Cookie', admin.auth).send({ status: 'PROCESSING', reason: 'Manual review started' })).status).toBe(200);
    const paid = await request(app).patch(`/api/admin/finance/payouts/${payout.body.payout.id}`).set('Cookie', admin.auth).send({ status: 'PAID', providerReference: 'unverified-reference', reason: 'Attempted manual completion' });
    expect(paid.status).toBe(409);
    expect(commerceStore.state.creatorPayouts.find((entry) => entry.id === payout.body.payout.id)?.status).toBe('PROCESSING');
  });

  it('reports persisted playback sessions separately from qualified views and protects analytics with admin RBAC', async () => {
    const creator = await register('AnalyticsCreator');
    const viewer = await register('AnalyticsViewer');
    const admin = await register('AnalyticsAdmin');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });
    const post = await request(app).post('/api/posts').set('Cookie', creator.auth).send({
      content: 'Analytics video',
      imageUrl: 'https://cdn.example.test/analytics.mp4',
      visibility: 'PUBLIC',
    });
    expect(post.status).toBe(201);

    const now = new Date().toISOString();
    for (const [sessionId, watchSeconds, qualified] of [
      ['analytics-qualified', 45, true],
      ['analytics-unqualified', 12, false],
    ] as const) {
      socialStore.state.videoMeasurements.push({
        id: `measurement-${sessionId}`,
        postId: post.body.post.id,
        viewerId: viewer.user.id,
        sessionId,
        source: 'videos',
        watchSeconds,
        durationSeconds: 120,
        lastPositionSeconds: watchSeconds,
        lastHeartbeatAt: now,
        active: false,
        startedAt: now,
        endedAt: now,
        qualified,
        createdAt: now,
      });
    }

    expect((await request(app).get('/api/admin/creator-analytics')).status).toBe(401);
    expect((await request(app).get('/api/admin/creator-analytics').set('Cookie', viewer.auth)).status).toBe(403);
    const response = await request(app).get('/api/admin/creator-analytics').set('Cookie', admin.auth);
    expect(response.status).toBe(200);
    expect(response.body.analytics.metrics).toMatchObject({
      totalVideoViews: 2,
      qualifiedViews: 1,
      totalWatchTimeSeconds: 57,
      pendingCreators: 0,
    });
    expect(response.body.analytics.creators).toContainEqual(expect.objectContaining({
      creatorId: creator.user.id,
      totalViews: 2,
      qualifiedViews: 1,
      watchTimeSeconds: 57,
    }));
  });
});
