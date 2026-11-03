import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { commerceStore } from '../lib/commerceStore.js';
import { hashPassword } from '../lib/auth.js';
import { socialStore } from '../lib/socialStore.js';

function getCookieHeader(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  if (Array.isArray(value)) return value.join('; ');
  return value ?? '';
}

async function makeUser(input: {
  email: string;
  name: string;
  role?: 'USER' | 'MODERATOR' | 'ADMIN' | 'SUPER_ADMIN';
  status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED';
}) {
  const passwordHash = await hashPassword('Password123');
  const user = fallbackStore.create({
    email: input.email,
    name: input.name,
    passwordHash,
    role: input.role ?? 'USER',
    status: input.status ?? 'ACTIVE',
    communityRulesAccepted: true,
    communityRulesAcceptedAt: new Date().toISOString(),
    rulesVersion: 'nova-community-safety-v1',
  });

  const login = await request(app).post('/api/auth/login').send({
    email: user.email,
    password: 'Password123',
  });

  return { user, login };
}

describe('admin and moderation routes', () => {
  beforeEach(() => {
    fallbackStore.clear();
    commerceStore.clear();
    socialStore.clear();
  });

  it('USER cannot access admin dashboard', async () => {
    const { login } = await makeUser({ email: 'user@example.com', name: 'Regular User', role: 'USER' });

    const response = await request(app)
      .get('/api/admin/dashboard')
      .set('Cookie', getCookieHeader(login));

    expect(response.status).toBe(403);
  });

  it('suspended administrator cannot access admin APIs', async () => {
    const { login } = await makeUser({
      email: 'suspended-admin@example.com',
      name: 'Suspended Admin',
      role: 'ADMIN',
      status: 'SUSPENDED',
    });

    const response = await request(app)
      .get('/api/admin/dashboard')
      .set('Cookie', getCookieHeader(login));

    expect(response.status).toBe(403);
  });

  it('MODERATOR cannot perform ADMIN-only action', async () => {
    const { user, login } = await makeUser({ email: 'mod@example.com', name: 'Moderator', role: 'MODERATOR' });
    const target = await makeUser({ email: 'target@example.com', name: 'Target', role: 'USER' });

    const response = await request(app)
      .post(`/api/admin/users/${target.user.id}/ban`)
      .set('Cookie', getCookieHeader(login))
      .send({ reason: 'Policy breach.' });

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/administrator|admin/i);
    expect(user.role).toBe('MODERATOR');
  });

  it('ADMIN can access allowed dashboard data', async () => {
    const { login } = await makeUser({ email: 'admin@example.com', name: 'Admin User', role: 'ADMIN' });
    const user = fallbackStore.create({
      email: 'other@example.com',
      name: 'Other User',
      passwordHash: await hashPassword('Password123'),
      role: 'USER',
      status: 'ACTIVE',
      communityRulesAccepted: true,
      communityRulesAcceptedAt: new Date().toISOString(),
      rulesVersion: 'nova-community-safety-v1',
    });
    socialStore.state.reports.push({
      id: 'report_1',
      reporterId: user.id,
      targetType: 'post',
      targetId: 'post_1',
      category: 'HARASSMENT',
      reason: 'Needs review',
      details: 'example',
      createdAt: new Date().toISOString(),
    });

    const response = await request(app)
      .get('/api/admin/dashboard')
      .set('Cookie', getCookieHeader(login));

    expect(response.status).toBe(200);
    expect(response.body.metrics).toHaveProperty('totalUsers');
    expect(response.body.metrics.totalUsers).toBeGreaterThanOrEqual(2);
    expect(response.body.metrics.totalReports).toBeGreaterThanOrEqual(1);
  });

  it('unauthorized admin request returns 401/403 appropriately', async () => {
    const response = await request(app).get('/api/admin/users');
    expect(response.status).toBe(401);
  });

  it('restricts earnings and revenue APIs to administrators', async () => {
    const user = await makeUser({ email: 'revenue-user@example.com', name: 'Regular User' });
    const moderator = await makeUser({ email: 'revenue-mod@example.com', name: 'Moderator', role: 'MODERATOR' });

    for (const endpoint of ['/api/admin/earnings', '/api/admin/revenue']) {
      expect((await request(app).get(endpoint)).status).toBe(401);
      expect((await request(app).get(endpoint).set('Cookie', getCookieHeader(user.login))).status).toBe(403);
      expect((await request(app).get(endpoint).set('Cookie', getCookieHeader(moderator.login))).status).toBe(403);
    }

    const { login } = await makeUser({ email: 'regular@example.com', name: 'Regular', role: 'USER' });
    const forbidden = await request(app)
      .get('/api/admin/users')
      .set('Cookie', getCookieHeader(login));
    expect(forbidden.status).toBe(403);
  });

  it('ADMIN can suspend a user', async () => {
    const { login } = await makeUser({ email: 'admin@example.com', name: 'Admin User', role: 'ADMIN' });
    const target = await makeUser({ email: 'user-to-suspend@example.com', name: 'Target User', role: 'USER' });

    const response = await request(app)
      .post(`/api/admin/users/${target.user.id}/suspend`)
      .set('Cookie', getCookieHeader(login))
      .send({ reason: 'Violation of community rules.' });

    expect(response.status).toBe(200);
    expect(response.body.user.status).toBe('SUSPENDED');
    expect(response.body.message).toContain('suspended');
  });

  it('Admin suspension creates an audit record', async () => {
    const { login } = await makeUser({ email: 'admin@example.com', name: 'Admin User', role: 'ADMIN' });
    const target = await makeUser({ email: 'audit-target@example.com', name: 'Audit Target', role: 'USER' });

    await request(app)
      .post(`/api/admin/users/${target.user.id}/suspend`)
      .set('Cookie', getCookieHeader(login))
      .send({ reason: 'Policy review required.' });

    const logs = fallbackStore.listAdminActions();
    expect(logs.some((item) => item.actionType === 'USER_SUSPENDED')).toBe(true);
    expect(logs[0]?.details).toContain('Policy review');
  });

  it('ADMIN can resolve a report', async () => {
    const { login } = await makeUser({ email: 'admin@example.com', name: 'Admin User', role: 'ADMIN' });
    const reporter = await makeUser({ email: 'reporter@example.com', name: 'Reporter', role: 'USER' });

    const report = {
      id: 'report_2',
      reporterId: reporter.user.id,
      targetType: 'post' as const,
      targetId: 'post_2',
      category: 'SPAM' as const,
      reason: 'Spam content',
      details: 'It was spam',
      createdAt: new Date().toISOString(),
    };
    socialStore.state.reports.push(report);

    const response = await request(app)
      .post('/api/admin/reports/report_2/resolve')
      .set('Cookie', getCookieHeader(login))
      .send({ note: 'Confirmed spam content.' });

    expect(response.status).toBe(200);
    expect(response.body.report.status).toBe('RESOLVED');

    const queue = await request(app)
      .get('/api/admin/moderation/queue')
      .set('Cookie', getCookieHeader(login));

    expect(queue.status).toBe(200);
    expect(queue.body.items.some((item: { id: string }) => item.id === report.id)).toBe(false);
  });

  it('moderators soft-hide reported content, retain evidence, and can restore it', async () => {
    const moderator = await makeUser({ email: 'content-moderator@example.com', name: 'Content Moderator', role: 'MODERATOR' });
    const author = await makeUser({ email: 'content-author@example.com', name: 'Content Author' });
    const reporter = await makeUser({ email: 'content-reporter@example.com', name: 'Content Reporter' });
    const createdPost = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(author.login))
      .send({ content: 'Reported content remains available as moderation evidence.' });
    expect(createdPost.status).toBe(201);
    const postId = createdPost.body.post.id as string;
    const createdComment = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Cookie', getCookieHeader(author.login))
      .send({ content: 'A reported comment remains in the audit history.' });
    expect(createdComment.status).toBe(201);
    const reports = await Promise.all([
      request(app).post('/api/reports').set('Cookie', getCookieHeader(reporter.login)).send({
        targetType: 'post',
        targetId: postId,
        category: 'SPAM',
        reason: 'This post needs moderator review.',
      }),
      request(app).post('/api/reports').set('Cookie', getCookieHeader(reporter.login)).send({
        targetType: 'comment',
        targetId: createdComment.body.comment.id,
        category: 'SPAM',
        reason: 'This comment needs moderator review.',
      }),
    ]);
    expect(reports.map((response) => response.status)).toEqual([201, 201]);

    const postReport = reports[0].body.report;
    const commentReport = reports[1].body.report;
    const removed = await request(app)
      .post(`/api/admin/moderation/${postReport.id}/remove`)
      .set('Cookie', getCookieHeader(moderator.login))
      .send({ reason: 'Confirmed policy violation.' });
    expect(removed.status).toBe(200);
    expect(await request(app).get(`/api/posts/${postId}`)).toHaveProperty('status', 404);
    expect(socialStore.state.posts.find((post) => post.id === postId)).toMatchObject({
      moderationHiddenById: moderator.user.id,
      moderationReason: 'Confirmed policy violation.',
    });
    expect(socialStore.state.posts.find((post) => post.id === postId)?.moderationHiddenAt).toBeTruthy();
    const restored = await request(app)
      .post(`/api/admin/moderation/${postReport.id}/approve`)
      .set('Cookie', getCookieHeader(moderator.login))
      .send({ note: 'Reviewed and restored.' });
    expect(restored.status).toBe(200);
    expect((await request(app).get(`/api/posts/${postId}`)).status).toBe(200);

    const removedComment = await request(app)
      .post(`/api/admin/moderation/${commentReport.id}/remove`)
      .set('Cookie', getCookieHeader(moderator.login))
      .send({ note: 'Confirmed comment violation.' });
    expect(removedComment.status).toBe(200);
    const comments = await request(app).get(`/api/posts/${postId}/comments`);
    expect(comments.body.comments).toHaveLength(0);
    expect(socialStore.state.comments.find((comment) => comment.id === createdComment.body.comment.id)).toMatchObject({
      moderationHiddenById: moderator.user.id,
      moderationReason: 'Confirmed comment violation.',
    });

    const audit = fallbackStore.listAdminActions();
    expect(audit.some((action) => action.actionType === 'MODERATION_REMOVED' && action.actorId === moderator.user.id)).toBe(true);
    expect(audit.some((action) => action.actionType === 'MODERATION_APPROVED' && action.actorId === moderator.user.id)).toBe(true);
    expect(audit.some((action) => action.actionType === 'MODERATION_REMOVED' && action.details?.includes('Confirmed policy violation.'))).toBe(true);
  });

  it('blocked users cannot retrieve each other’s public posts', async () => {
    const author = await makeUser({ email: 'blocked-content-author@example.com', name: 'Author' });
    const viewer = await makeUser({ email: 'blocked-content-viewer@example.com', name: 'Viewer' });
    const post = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(author.login))
      .send({ content: 'This public post should be hidden across the block relationship.' });
    expect(post.status).toBe(201);
    await request(app).post(`/api/users/${author.user.id}/block`).set('Cookie', getCookieHeader(viewer.login));

    const feed = await request(app).get('/api/posts').set('Cookie', getCookieHeader(viewer.login));
    expect(feed.body.posts.some((entry: { id: string }) => entry.id === post.body.post.id)).toBe(false);
    const direct = await request(app).get(`/api/posts/${post.body.post.id}`).set('Cookie', getCookieHeader(viewer.login));
    expect(direct.status).toBe(404);
  });

  it('moderators cannot claim removal of reports without a removable content target', async () => {
    const moderator = await makeUser({ email: 'targetless-moderator@example.com', name: 'Moderator', role: 'MODERATOR' });
    const reporter = await makeUser({ email: 'targetless-reporter@example.com', name: 'Reporter' });
    const target = await makeUser({ email: 'targetless-target@example.com', name: 'Target' });
    const report = {
      id: 'targetless_report',
      reporterId: reporter.user.id,
      targetType: 'user' as const,
      targetId: target.user.id,
      category: 'OTHER' as const,
      reason: 'Review this user account.',
      createdAt: new Date().toISOString(),
    };
    socialStore.state.reports.push(report);

    const response = await request(app)
      .post(`/api/admin/moderation/${report.id}/remove`)
      .set('Cookie', getCookieHeader(moderator.login))
      .send({ reason: 'No content was identified.' });

    expect(response.status).toBe(400);
    expect(socialStore.state.reports[0].status).toBeUndefined();
  });

  it('moderation hides reported direct messages while retaining evidence and allows restoration', async () => {
    const moderator = await makeUser({ email: 'message-moderator@example.com', name: 'Moderator', role: 'MODERATOR' });
    const admin = await makeUser({ email: 'message-admin@example.com', name: 'Admin', role: 'ADMIN' });
    const sender = await makeUser({ email: 'message-sender@example.com', name: 'Sender' });
    const reporter = await makeUser({ email: 'message-reporter@example.com', name: 'Reporter' });
    const conversation = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(reporter.login))
      .send({ participantId: sender.user.id });
    const message = await request(app)
      .post(`/api/conversations/${conversation.body.conversation.id}/messages`)
      .set('Cookie', getCookieHeader(sender.login))
      .send({ text: 'Reported private message evidence.' });
    const submitted = await request(app)
      .post(`/api/messages/${message.body.message.id}/report`)
      .set('Cookie', getCookieHeader(reporter.login))
      .send({ category: 'HARASSMENT', reason: 'This message needs a moderator review.' });
    expect(submitted.status).toBe(201);
    expect(submitted.body.report.messageId).toBe(message.body.message.id);

    const removed = await request(app)
      .post(`/api/admin/moderation/${submitted.body.report.id}/remove`)
      .set('Cookie', getCookieHeader(moderator.login))
      .send({ reason: 'Confirmed private-message policy violation.' });
    expect(removed.status).toBe(200);
    const history = await request(app)
      .get(`/api/conversations/${conversation.body.conversation.id}`)
      .set('Cookie', getCookieHeader(reporter.login));
    expect(history.body.conversation.messages[0].text).toBe('[removed by moderators]');
    expect(history.body.conversation.lastMessagePreview).toBe('[removed by moderators]');
    expect(JSON.stringify(history.body)).not.toContain('Reported private message evidence.');
    expect(socialStore.state.messages[0]).toMatchObject({
      moderationHiddenById: moderator.user.id,
      moderationReason: 'Confirmed private-message policy violation.',
    });

    const queue = await request(app)
      .get('/api/admin/moderation/queue')
      .set('Cookie', getCookieHeader(moderator.login));
    expect(queue.body.items).toHaveLength(0);
    const reportHistory = await request(app)
      .get(`/api/admin/reports/${submitted.body.report.id}`)
      .set('Cookie', getCookieHeader(admin.login));
    expect(reportHistory.body.report.message.text).toBe('Reported private message evidence.');

    const restored = await request(app)
      .post(`/api/admin/moderation/${submitted.body.report.id}/approve`)
      .set('Cookie', getCookieHeader(moderator.login))
      .send({ note: 'Message was reviewed and restored.' });
    expect(restored.status).toBe(200);
    const restoredHistory = await request(app)
      .get(`/api/conversations/${conversation.body.conversation.id}`)
      .set('Cookie', getCookieHeader(reporter.login));
    expect(restoredHistory.body.conversation.messages[0].text).toBe('Reported private message evidence.');
  });

  it('Appeal cannot be approved by the appealing user', async () => {
    const user = await makeUser({ email: 'appealer@example.com', name: 'Appealer', role: 'ADMIN' });
    const appeal = {
      id: 'appeal_1',
      userId: user.user.id,
      originalAction: 'USER_SUSPENDED',
      reason: 'I was wrongfully suspended',
      status: 'OPEN',
      reviewerId: null,
      reviewerNote: null,
      createdAt: new Date().toISOString(),
      reviewedAt: null,
    };
    fallbackStore.createAppeal(appeal as any);

    const response = await request(app)
      .post('/api/admin/appeals/appeal_1/approve')
      .set('Cookie', getCookieHeader(user.login))
      .send({ note: 'I approve my own appeal.' });

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/cannot.*review/i);
  });

  it('administrator approval restores the restricted account and records a single audited decision', async () => {
    const admin = await makeUser({ email: 'appeal-admin@example.com', name: 'Appeal Admin', role: 'ADMIN' });
    const appellant = await makeUser({
      email: 'appeal-user@example.com',
      name: 'Appeal User',
      role: 'USER',
      status: 'SUSPENDED',
    });
    const appeal = fallbackStore.createAppeal({
      userId: appellant.user.id,
      originalAction: 'USER_SUSPENDED',
      reason: 'The restriction was applied to my account by mistake.',
      status: 'OPEN',
      reviewerId: null,
      reviewerNote: null,
      reviewedAt: null,
    });

    const response = await request(app)
      .post(`/api/admin/appeals/${appeal.id}/approve`)
      .set('Cookie', getCookieHeader(admin.login))
      .send({ note: 'Reviewed the appeal and restored account access.' });

    expect(response.status).toBe(200);
    expect(response.body.appeal.status).toBe('APPROVED');
    expect(fallbackStore.findById(appellant.user.id)?.status).toBe('ACTIVE');
    expect(fallbackStore.listAdminActions().some((action) => action.actionType === 'APPEAL_APPROVED')).toBe(true);

    const secondDecision = await request(app)
      .post(`/api/admin/appeals/${appeal.id}/reject`)
      .set('Cookie', getCookieHeader(admin.login))
      .send({ note: 'This must not replace the first decision.' });
    expect(secondDecision.status).toBe(409);
  });

  it('Subscription admin data comes from real records', async () => {
    const { login } = await makeUser({ email: 'admin@example.com', name: 'Admin User', role: 'ADMIN' });
    const user = await makeUser({ email: 'subscriber@example.com', name: 'Subscriber', role: 'USER' });

    const plan: any = {
      id: 'plan_1',
      slug: 'premium',
      name: 'Premium',
      priceCents: 1999,
      currency: 'USD',
      interval: 'month' as const,
      description: 'Premium access',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    socialStore.state.subscriptionPlans.push(plan);
    socialStore.state.subscriptions.push({
      id: 'sub_1',
      userId: user.user.id,
      planId: plan.id,
      status: 'ACTIVE',
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const response = await request(app)
      .get('/api/admin/subscriptions')
      .set('Cookie', getCookieHeader(login));

    expect(response.status).toBe(200);
    expect(response.body.subscriptions.some((item: any) => item.userId === user.user.id)).toBe(true);
  });

  it('Payment data does not expose raw sensitive card information', async () => {
    const { login } = await makeUser({ email: 'admin@example.com', name: 'Admin User', role: 'ADMIN' });
    const user = await makeUser({ email: 'payer@example.com', name: 'Payer', role: 'USER' });

    socialStore.state.payments.push({
      id: 'pay_1',
      subscriptionId: 'sub_1',
      userId: user.user.id,
      provider: 'stripe',
      providerReference: 'pi_123',
      amountCents: 1999,
      currency: 'USD',
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    } as any);

    const response = await request(app)
      .get('/api/admin/payments')
      .set('Cookie', getCookieHeader(login));

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('4242');
    expect(response.body.payments[0].amountCents).toBe(1999);
  });

  it('returns real earnings and revenue from successful payments and financial records', async () => {
    const { login } = await makeUser({ email: 'admin@example.com', name: 'Admin User', role: 'ADMIN' });
    const user = await makeUser({ email: 'creator@example.com', name: 'Creator', role: 'USER' });

    socialStore.state.payments.push({
      id: 'pay_legacy',
      subscriptionId: 'sub_legacy',
      userId: user.user.id,
      provider: 'stripe',
      providerReference: 'pi_shared',
      amountCents: 2000,
      currency: 'USD',
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    } as any);
    socialStore.state.payments.push({
      id: 'pay_pending',
      subscriptionId: 'sub_pending',
      userId: user.user.id,
      provider: 'stripe',
      providerReference: 'pi_pending',
      amountCents: 9000,
      currency: 'USD',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    } as any);
    commerceStore.state.paymentIntents.push(
      { id: 'intent_duplicate', provider: 'stripe', providerReference: 'pi_shared', amountCents: 2000, currency: 'USD', purpose: 'PLATFORM_SUBSCRIPTION', status: 'SUCCESS' },
      { id: 'intent_success', provider: 'stripe', providerReference: 'pi_modern', amountCents: 3000, currency: 'USD', purpose: 'CREATOR_SUBSCRIPTION', status: 'SUCCESS' },
      { id: 'intent_marketplace', provider: 'stripe', providerReference: 'pi_marketplace', amountCents: 6000, currency: 'USD', purpose: 'MARKETPLACE_ORDER', status: 'SUCCESS' },
      { id: 'intent_failed', provider: 'stripe', providerReference: 'pi_failed', amountCents: 7000, currency: 'USD', purpose: 'PLATFORM_SUBSCRIPTION', status: 'FAILED' },
    );
    commerceStore.state.creatorLedger.push(
      { id: 'creator-earning', creatorId: user.user.id, type: 'SUBSCRIPTION', amountCents: 1200, currency: 'USD' },
      { id: 'creator-payout-request', creatorId: user.user.id, type: 'PAYOUT_REQUESTED', amountCents: -300, currency: 'USD' },
    );
    commerceStore.state.creatorPayouts.push(
      { id: 'payout-pending', creatorId: user.user.id, amountCents: 300, status: 'PENDING' },
      { id: 'payout-paid', creatorId: user.user.id, amountCents: 400, status: 'PAID' },
      { id: 'payout-rejected', creatorId: user.user.id, amountCents: 700, status: 'REJECTED' },
    );
    commerceStore.state.financialLedger.push(
      { id: 'platform-credit', ownerId: 'platform', direction: 'CREDIT', amountCents: 2500 },
      { id: 'platform-debit', ownerId: 'platform', direction: 'DEBIT', amountCents: 500 },
      { id: 'creator-credit', ownerId: user.user.id, direction: 'CREDIT', amountCents: 1200 },
    );
    commerceStore.state.adEvents.push(
      { id: 'ad-impression', eventType: 'IMPRESSION', amountCents: 100 },
      { id: 'ad-click', eventType: 'CLICK', amountCents: 200 },
    );

    const earnings = await request(app)
      .get('/api/admin/earnings')
      .set('Cookie', getCookieHeader(login));
    expect(earnings.status).toBe(200);
    expect(earnings.body.metrics).toMatchObject({
      estimatedEarningsCents: null,
      confirmedEarningsCents: 1200,
      pendingPayoutCents: 300,
      paidCents: 400,
      withdrawableBalanceCents: 900,
    });
    expect(earnings.body.entries).toHaveLength(2);

    const revenue = await request(app)
      .get('/api/admin/revenue')
      .set('Cookie', getCookieHeader(login));
    expect(revenue.status).toBe(200);
    expect(revenue.body.metrics).toEqual({
      grossRevenue: 11000,
      platformRevenue: 2000,
      creatorNetEarnings: 1200,
      adSpendCents: 300,
      adImpressions: 1,
      adClicks: 1,
      pendingPayouts: 300,
    });

    const dashboard = await request(app)
      .get('/api/admin/dashboard')
      .set('Cookie', getCookieHeader(login));
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.metrics.subscriptionRevenue).toBe(5000);
  });

  it('Banned user cannot bypass the account status restriction', async () => {
    const bannedUser = await makeUser({ email: 'banned@example.com', name: 'Banned', role: 'USER', status: 'BANNED' });

    const response = await request(app)
      .get('/api/posts')
      .set('Cookie', getCookieHeader(bannedUser.login));

    expect(response.status).toBe(403);
  });

  it('community rules consent remains required during registration', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ name: 'No Rules', email: 'norules@example.com', password: 'Password123', communityRulesAccepted: false });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/community.*safety.*rules/i);
  });
});
