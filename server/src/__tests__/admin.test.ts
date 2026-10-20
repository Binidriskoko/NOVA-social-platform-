import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
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

  it('Appeal cannot be approved by the appealing user', async () => {
    const user = await makeUser({ email: 'appealer@example.com', name: 'Appealer', role: 'USER', status: 'SUSPENDED' });
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
    expect(response.body.message).toMatch(/cannot.*approve/i);
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

  it('Revenue calculations are correct', async () => {
    const { login } = await makeUser({ email: 'admin@example.com', name: 'Admin User', role: 'ADMIN' });
    const user = await makeUser({ email: 'creator@example.com', name: 'Creator', role: 'USER' });

    socialStore.state.subscriptions.push({
      id: 'sub_2',
      userId: user.user.id,
      planId: 'plan_2',
      status: 'ACTIVE',
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    socialStore.state.payments.push({
      id: 'pay_2',
      subscriptionId: 'sub_2',
      userId: user.user.id,
      provider: 'stripe',
      providerReference: 'pi_456',
      amountCents: 2000,
      currency: 'USD',
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    } as any);

    const response = await request(app)
      .get('/api/admin/revenue')
      .set('Cookie', getCookieHeader(login));

    expect(response.status).toBe(200);
    expect(response.body.metrics.grossRevenue).toBe(2000);
    expect(response.body.metrics.platformRevenue).toBeGreaterThanOrEqual(0);
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
