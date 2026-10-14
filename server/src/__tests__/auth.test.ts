import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';

describe('auth routes', () => {
  beforeEach(() => {
    fallbackStore.clear();
  });

  it('trusts only the Render reverse-proxy hop for client IP-based rate limiting', () => {
    expect(app.get('trust proxy')).toBe(1);
  });

  it('registers a password account with a hashed password and an http-only session cookie', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Nova User',
        username: 'nova_user',
        email: 'nova@example.com',
        password: 'Password123',
        communityRulesAccepted: true,
      });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe('nova@example.com');
    expect(String(response.headers['set-cookie'])).toContain('nova_session=');
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(response.headers['set-cookie'])).toContain('Path=/');
    expect(typeof response.body.token).toBe('string');
    expect(fallbackStore.list()[0].passwordHash).not.toBe('Password123');
    expect(fallbackStore.list()[0].passwordHash).toMatch(/^\$2/);
  });

  it('registers and logs in with only a username and password', async () => {
    const registration = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Username User',
        username: 'username_only',
        password: 'Password123',
        communityRulesAccepted: true,
      });

    expect(registration.status).toBe(201);
    expect(registration.body.user.email).toBeNull();
    expect(registration.body.user.phoneE164).toBeNull();

    const login = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'username_only', password: 'Password123' });

    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(registration.body.user.id);
  });

  it('registers and logs in with only an email or phone number and a password', async () => {
    const emailOnly = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Email Only User',
        email: 'email_only@example.com',
        password: 'Password123',
        communityRulesAccepted: true,
      });

    expect(emailOnly.status).toBe(201);
    expect(emailOnly.body.user.email).toBe('email_only@example.com');

    const emailLogin = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'email_only@example.com', password: 'Password123' });

    expect(emailLogin.status).toBe(200);
    expect(emailLogin.body.user.id).toBe(emailOnly.body.user.id);

    const phoneOnly = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Phone Only User',
        phone: '+2348031234567',
        password: 'Password123',
        communityRulesAccepted: true,
      });

    expect(phoneOnly.status).toBe(201);
    expect(phoneOnly.body.user.phoneE164).toBe('+2348031234567');

    const phoneLogin = await request(app)
      .post('/api/auth/login')
      .send({ identifier: '+2348031234567', password: 'Password123' });

    expect(phoneLogin.status).toBe(200);
    expect(phoneLogin.body.user.id).toBe(phoneOnly.body.user.id);
  });

  it('supports registration, username login, authenticated session, logout, and password login again by phone', async () => {
    const registration = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Phone User',
        username: 'phone_user',
        phone: '+2348031234567',
        password: 'Password123',
        communityRulesAccepted: true,
      });

    expect(registration.status).toBe(201);
    expect(registration.body.user.phoneE164).toBe('+2348031234567');
    const directory = await request(app).get('/api/users').set('Cookie', registration.headers['set-cookie']);
    expect(directory.body.users.find((user: { id: string }) => user.id === registration.body.user.id).handle).toBe('phone_user');

    const usernameLogin = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'PHONE_USER', password: 'Password123' });
    expect(usernameLogin.status).toBe(200);

    const firstSession = usernameLogin.headers['set-cookie'];
    const currentUser = await request(app).get('/api/auth/me').set('Cookie', firstSession);
    expect(currentUser.status).toBe(200);
    expect(currentUser.body.user.id).toBe(registration.body.user.id);

    const logout = await request(app).post('/api/auth/logout').set('Cookie', firstSession);
    expect(logout.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', firstSession)).status).toBe(401);

    const phoneLogin = await request(app)
      .post('/api/auth/login')
      .send({ identifier: '+2348031234567', password: 'Password123' });
    expect(phoneLogin.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', phoneLogin.headers['set-cookie'])).status).toBe(200);
  });

  it('supports bearer-session authentication and revocation', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Bearer User',
      email: 'bearer@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'bearer@example.com', password: 'Password123' });
    const sessionCookie = login.headers['set-cookie'][0];
    const token = login.body.token;

    expect(login.status).toBe(200);
    expect(typeof token).toBe('string');
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(login.headers['set-cookie'])).toContain('Path=/');
    const tokenClaims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { exp: number };
    expect(fallbackStore.listSessions(login.body.user.id)[0].expiresAt).toBe(new Date(tokenClaims.exp * 1000).toISOString());
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', sessionCookie)).status).toBe(401);
  });

  it('allows the deployed frontend origin to call the credentialed auth API', async () => {
    const response = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://nova-social-platform-svx2.vercel.app')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://nova-social-platform-svx2.vercel.app');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('logs in an existing user by email and password', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Nova User',
        email: 'login@example.com',
        password: 'Password123',
        communityRulesAccepted: true,
      });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'login@example.com', password: 'Password123' });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('login@example.com');
    expect(String(response.headers['set-cookie'])).toContain('nova_session=');
    expect(typeof response.body.token).toBe('string');
  });

  it('requires community safety rules acceptance during registration', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Nova User',
        username: 'nova_user',
        email: 'community@example.com',
        password: 'Password123',
        communityRulesAccepted: false,
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('Community & Safety Rules');
  });

  it('does not expose OTP registration or phone-login routes', async () => {
    const endpoints = [
      request(app).post('/api/auth/register/start'),
      request(app).post('/api/auth/register/verify'),
      request(app).post('/api/auth/register/resend'),
      request(app).post('/api/auth/phone/start'),
      request(app).post('/api/auth/phone/verify'),
    ];
    const responses = await Promise.all(endpoints);
    expect(responses.every((response) => response.status === 404)).toBe(true);
  });

  it('returns an error for invalid credentials', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'missing_user', password: 'Password123' });

    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/Invalid .*password/);
  });

  it('lists sessions and supports per-device revocation and logout-all', async () => {
    const registration = await request(app).post('/api/auth/register').send({
      name: 'Session User',
      email: 'sessions@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    const login = await request(app).post('/api/auth/login').send({ identifier: 'sessions@example.com', password: 'Password123' });
    const cookie = login.headers['set-cookie'];

    const listed = await request(app).get('/api/auth/sessions').set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(2);
    expect(listed.body.sessions[0]).not.toHaveProperty('tokenHash');

    const registrationSession = listed.body.sessions.find((session: { id: string }) => session.id !== listed.body.sessions[0].id);
    const revoked = await request(app).delete(`/api/auth/sessions/${registrationSession.id}`).set('Cookie', cookie);
    expect(revoked.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', registration.headers['set-cookie'])).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    const logoutAll = await request(app).post('/api/auth/logout-all').set('Cookie', cookie);
    expect(logoutAll.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });
});
