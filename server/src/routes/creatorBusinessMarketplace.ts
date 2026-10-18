import { Router } from 'express';
import { z } from 'zod';
import { commerceStore } from '../lib/commerceStore.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { manualCreatorPayoutProvider } from '../lib/creatorProviders.js';
import { createCreatorSubscriptionIntent } from './payments.js';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { socialStore } from '../lib/socialStore.js';
import { requireActiveAccountIfAuthenticated, requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireActiveAccountIfAuthenticated);

const id = () => `commerce_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const date = () => new Date().toISOString();
const moneyCurrency = z.string().trim().length(3).transform((value) => value.toUpperCase());
const creatorProfileSchema = z.object({
  headline: z.string().trim().max(120).nullable().optional(),
  category: z.string().trim().max(64).nullable().optional(),
  subscriptionPriceCents: z.number().int().min(0).max(10000000).optional(),
  currency: moneyCurrency.optional(),
});
const businessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(64),
  description: z.string().trim().max(2000).nullable().optional(),
  contactEmail: z.string().email().max(254).nullable().optional(),
  contactPhone: z.string().trim().max(32).nullable().optional(),
  website: z.string().url().max(500).nullable().optional(),
});
const businessUpdateSchema = businessSchema.partial();
const businessPostSchema = z.object({
  content: z.string().trim().min(1).max(2500),
  imageUrl: z.string().url().max(500).nullable().optional(),
});
const sellerSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  contactEmail: z.string().email().max(254).nullable().optional(),
});
const productSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().min(1).max(5000),
  category: z.string().trim().min(2).max(80),
  priceCents: z.number().int().min(0).max(100000000),
  currency: moneyCurrency.default('USD'),
  stock: z.number().int().min(0).max(1000000).default(0),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED', 'OUT_OF_STOCK']).default('DRAFT'),
  images: z.array(z.object({ url: z.string().url().max(1000), storageKey: z.string().max(500).optional(), altText: z.string().max(300).optional() })).max(12).default([]),
});
const productUpdateSchema = productSchema.partial();
const orderSchema = z.object({ items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().min(1).max(1000) })).min(1).max(50) });
const orderStatuses = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'DISPUTED'] as const;

async function audit(actorId: string, targetUserId: string | null, actionType: string, details: string) {
  if (await isDatabaseAvailable()) {
    await prisma.adminAction.create({ data: { actorId, targetUserId, actionType, details } });
  } else {
    fallbackStore.createAdminAction({ actorId, targetUserId, actionType, details });
  }
}

async function notify(recipientId: string, actorId: string, type: string, message: string) {
  if (await isDatabaseAvailable()) {
    await prisma.notification.create({ data: { recipientId, actorId, type, message } });
  } else {
    socialStore.state.notifications.push({ id: id(), recipientId, actorId, type, message, createdAt: date() });
  }
}

async function blockedEitherWay(firstUserId: string, secondUserId: string) {
  if (await isDatabaseAvailable()) {
    const blocked = await prisma.block.findFirst({
      where: { OR: [
        { blockerId: firstUserId, blockedId: secondUserId },
        { blockerId: secondUserId, blockedId: firstUserId },
      ] },
      select: { id: true },
    });
    return Boolean(blocked);
  }
  return socialStore.state.blocks.some((entry) =>
    (entry.blockerId === firstUserId && entry.blockedId === secondUserId)
    || (entry.blockerId === secondUserId && entry.blockedId === firstUserId));
}

async function getBusinessAccess(businessId: string, userId: string) {
  if (await isDatabaseAvailable()) {
    const business = await prisma.businessProfile.findUnique({ where: { id: businessId } });
    if (!business) return null;
    if (business.ownerId === userId) return { business, role: 'OWNER' };
    const membership = await prisma.businessMember.findUnique({ where: { businessId_userId: { businessId, userId } } });
    return membership ? { business, role: membership.role } : null;
  }
  const business = commerceStore.state.businesses.find((entry) => entry.id === businessId);
  if (!business) return null;
  if (business.ownerId === userId) return { business, role: 'OWNER' };
  const membership = commerceStore.state.businessMembers.find((entry) => entry.businessId === businessId && entry.userId === userId);
  return membership ? { business, role: membership.role } : null;
}

router.put('/creators/me/profile', requireAuth, async (req, res) => {
  const payload = creatorProfileSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const profile = await prisma.creatorProfile.upsert({
      where: { userId },
      create: { userId, ...payload },
      update: payload,
    });
    return res.json({ profile });
  }
  let profile = commerceStore.state.creators.find((entry) => entry.userId === userId);
  if (profile) Object.assign(profile, payload, { updatedAt: date() });
  else {
    profile = { id: id(), userId, headline: null, category: null, subscriptionPriceCents: 0, currency: 'USD', isEnabled: true, createdAt: date(), updatedAt: date(), ...payload };
    commerceStore.state.creators.push(profile);
  }
  return res.json({ profile });
});

router.get('/creators/:userId/profile', async (req, res) => {
  const userId = String(req.params.userId);
  if (await isDatabaseAvailable()) {
    const profile = await prisma.creatorProfile.findFirst({ where: { userId, isEnabled: true }, include: { _count: { select: { subscribers: true } }, user: { select: { id: true, name: true } } } });
    if (!profile) return res.status(404).json({ message: 'Creator profile not found.' });
    return res.json({ profile });
  }
  const profile = commerceStore.state.creators.find((entry) => entry.userId === userId && entry.isEnabled);
  if (!profile) return res.status(404).json({ message: 'Creator profile not found.' });
  const user = fallbackStore.findById(userId);
  return res.json({ profile: { id: profile.id, userId, name: user?.name ?? null, headline: profile.headline, category: profile.category, subscriptionPriceCents: profile.subscriptionPriceCents, currency: profile.currency, subscribers: commerceStore.state.creatorSubscriptions.filter((entry) => entry.creatorId === userId && entry.status === 'ACTIVE').length } });
});

router.get('/creators/me/dashboard', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const profile = await prisma.creatorProfile.findUnique({ where: { userId } });
    if (!profile) return res.status(404).json({ message: 'Creator profile not found.' });
    const [followers, posts, likes, subscribers, ledger, payouts] = await Promise.all([
      prisma.follow.count({ where: { followingId: userId } }),
      prisma.post.count({ where: { authorId: userId } }),
      prisma.reaction.count({ where: { post: { authorId: userId } } }),
      prisma.creatorSubscription.count({ where: { creatorId: userId, status: 'ACTIVE' } }),
      prisma.creatorLedgerEntry.findMany({ where: { creatorId: userId }, select: { amountCents: true } }),
      prisma.creatorPayoutRequest.aggregate({ where: { creatorId: userId, status: 'PENDING' }, _sum: { amountCents: true } }),
    ]);
    const balanceCents = ledger.reduce((total, entry) => total + entry.amountCents, 0);
    return res.json({ dashboard: { profile, audience: { followers, subscribers }, content: { posts, likes }, finance: { balanceCents, pendingPayoutCents: payouts._sum.amountCents ?? 0, currency: profile.currency } } });
  }
  const profile = commerceStore.state.creators.find((entry) => entry.userId === userId);
  if (!profile) return res.status(404).json({ message: 'Creator profile not found.' });
  const ledger = commerceStore.state.creatorLedger.filter((entry) => entry.creatorId === userId);
  const posts = socialStore.state.posts.filter((entry) => entry.authorId === userId);
  return res.json({ dashboard: {
    profile,
    audience: {
      followers: socialStore.state.follows.filter((entry) => entry.followingId === userId).length,
      subscribers: commerceStore.state.creatorSubscriptions.filter((entry) => entry.creatorId === userId && entry.status === 'ACTIVE').length,
    },
    content: { posts: posts.length, likes: socialStore.state.reactions.filter((reaction) => posts.some((post) => post.id === reaction.postId)).length },
    finance: { balanceCents: ledger.reduce((sum, entry) => sum + entry.amountCents, 0), pendingPayoutCents: commerceStore.state.creatorPayouts.filter((entry) => entry.creatorId === userId && entry.status === 'PENDING').reduce((sum, entry) => sum + entry.amountCents, 0), currency: profile.currency },
  } });
});

router.get('/creators/me/followers', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const followers = await isDatabaseAvailable()
    ? await prisma.follow.findMany({ where: { followingId: userId }, include: { follower: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } })
    : socialStore.state.follows.filter((entry) => entry.followingId === userId);
  return res.json({ followers });
});

router.get('/creators/me/subscribers', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const subscriptions = await isDatabaseAvailable()
    ? await prisma.creatorSubscription.findMany({ where: { creatorId: userId }, include: { subscriber: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.creatorSubscriptions.filter((entry) => entry.creatorId === userId);
  return res.json({ subscriptions });
});

router.post('/creators/:creatorId/subscribe', requireAuth, async (req, res) => {
  const creatorId = String(req.params.creatorId);
  const subscriberId = req.user!.id;
  if (creatorId === subscriberId) return res.status(400).json({ message: 'You cannot subscribe to yourself.' });
  if (await blockedEitherWay(subscriberId, creatorId)) return res.status(403).json({ message: 'Creator subscriptions are unavailable for blocked users.' });
  const idempotencyKey = req.header('Idempotency-Key') ?? `creator-${creatorId}-${subscriberId}`;
  try {
    const result = await createCreatorSubscriptionIntent(subscriberId, creatorId, idempotencyKey);
    await audit(subscriberId, creatorId, 'CREATOR_SUBSCRIPTION_PAYMENT_INTENT_CREATED', result.intent.reference);
    return res.status(201).json({ subscription: result.subscription, paymentIntent: result.intent });
  } catch (error) {
    if (error instanceof Error && error.message === 'CREATOR_NOT_FOUND') return res.status(404).json({ message: 'Creator is unavailable.' });
    if (error instanceof Error && error.message === 'CREATOR_ALREADY_SUBSCRIBED') return res.status(409).json({ message: 'You are already subscribed.' });
    if (error instanceof Error && error.message === 'PAYMENT_PENDING') return res.status(409).json({ message: 'A payment is already pending for this subscription.' });
    throw error;
  }
});

router.post('/creators/subscriptions/:id/cancel', requireAuth, async (req, res) => {
  const subscriptionId = String(req.params.id);
  const subscriberId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const subscription = await prisma.creatorSubscription.findFirst({ where: { id: subscriptionId, subscriberId } });
    if (!subscription) return res.status(404).json({ message: 'Subscription not found.' });
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.creatorSubscription.update({ where: { id: subscriptionId }, data: { status: 'CANCELLED', endsAt: new Date() } });
      await tx.paymentIntent.updateMany({ where: { purpose: 'CREATOR_SUBSCRIPTION', targetId: subscriptionId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      return result;
    });
    return res.json({ subscription: updated });
  }
  const subscription = commerceStore.state.creatorSubscriptions.find((entry) => entry.id === subscriptionId && entry.subscriberId === subscriberId);
  if (!subscription) return res.status(404).json({ message: 'Subscription not found.' });
  subscription.status = 'CANCELLED';
  subscription.endsAt = date();
  for (const intent of commerceStore.state.paymentIntents.filter((entry) => entry.purpose === 'CREATOR_SUBSCRIPTION' && entry.targetId === subscriptionId && entry.status === 'PENDING')) intent.status = 'CANCELLED';
  return res.json({ subscription });
});

router.get('/creators/me/earnings', requireAuth, async (req, res) => {
  const creatorId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const entries = await prisma.creatorLedgerEntry.findMany({ where: { creatorId }, orderBy: { createdAt: 'desc' } });
    return res.json({ entries, balanceCents: entries.reduce((total, entry) => total + entry.amountCents, 0) });
  }
  const entries = commerceStore.state.creatorLedger.filter((entry) => entry.creatorId === creatorId);
  return res.json({ entries, balanceCents: entries.reduce((total, entry) => total + entry.amountCents, 0) });
});

router.post('/creators/me/payouts', requireAuth, async (req, res) => {
  const payload = z.object({ amountCents: z.number().int().positive().max(100_000_000) }).parse(req.body ?? {});
  const idempotencyKey = z.string().trim().min(8).max(120).safeParse(req.header('Idempotency-Key'));
  if (!idempotencyKey.success) return res.status(400).json({ message: 'An Idempotency-Key header is required.' });
  const creatorId = req.user!.id;
  const monetizationSettings = await isDatabaseAvailable()
    ? await prisma.monetizationSettings.findUnique({ where: { id: 'default' } })
    : commerceStore.state.monetizationSettings;
  const minimumPayoutCents = Number(monetizationSettings?.minimumPayoutCents ?? 0);
  if (payload.amountCents < minimumPayoutCents) return res.status(400).json({ message: `Payout requests must be at least ${minimumPayoutCents} cents.` });
  if (monetizationSettings?.enabled) {
    const approved = await isDatabaseAvailable()
      ? Boolean(await prisma.creatorApplication.findFirst({ where: { creatorId, status: 'APPROVED' }, select: { id: true } }))
      : commerceStore.state.creatorApplications.some((application) => application.creatorId === creatorId && application.status === 'APPROVED');
    if (!approved) return res.status(403).json({ message: 'An approved creator monetization application is required for payouts.' });
  }
  if (await isDatabaseAvailable()) {
    const profile = await prisma.creatorProfile.findUnique({ where: { userId: creatorId } });
    if (!profile) return res.status(404).json({ message: 'Creator profile not found.' });
    const prior = await prisma.creatorPayoutRequest.findUnique({ where: { creatorId_idempotencyKey: { creatorId, idempotencyKey: idempotencyKey.data } } });
    if (prior) return prior.amountCents === payload.amountCents ? res.status(200).json({ payout: prior }) : res.status(409).json({ message: 'Idempotency key was already used for a different payout.' });
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const entries = await tx.creatorLedgerEntry.findMany({ where: { creatorId }, select: { amountCents: true } });
        const balanceCents = entries.reduce((sum, entry) => sum + entry.amountCents, 0);
        if (payload.amountCents > balanceCents) throw new Error('INSUFFICIENT_CREATOR_BALANCE');
        const provider = await manualCreatorPayoutProvider.requestPayout({ creatorId, amountCents: payload.amountCents, currency: profile.currency });
        const payout = await tx.creatorPayoutRequest.create({ data: { creatorId, idempotencyKey: idempotencyKey.data, amountCents: payload.amountCents, currency: profile.currency, provider: manualCreatorPayoutProvider.name, providerReference: provider.reference, status: provider.status } });
        await tx.creatorLedgerEntry.create({ data: { creatorId, type: 'PAYOUT_REQUESTED', amountCents: -payload.amountCents, currency: profile.currency, reference: payout.id, description: 'Payout requested' } });
        await tx.financialLedgerEntry.create({ data: { ownerId: creatorId, direction: 'DEBIT', type: 'PAYOUT_REQUESTED', amountCents: payload.amountCents, currency: profile.currency, sourceType: 'PAYOUT', sourceId: payout.id, idempotencyKey: `${payout.id}:request` } });
        return payout;
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error instanceof Error && error.message === 'INSUFFICIENT_CREATOR_BALANCE') return res.status(409).json({ message: 'Payout amount exceeds available balance.' });
      if ((error as { code?: string }).code === 'P2034') return res.status(409).json({ message: 'Payout balance changed. Retry the request.' });
      throw error;
    }
    await audit(creatorId, creatorId, 'CREATOR_PAYOUT_REQUESTED', result.id);
    return res.status(201).json({ payout: result });
  }
  const profile = commerceStore.state.creators.find((entry) => entry.userId === creatorId);
  if (!profile) return res.status(404).json({ message: 'Creator profile not found.' });
  const prior = commerceStore.state.creatorPayouts.find((entry) => entry.creatorId === creatorId && entry.idempotencyKey === idempotencyKey.data);
  if (prior) return prior.amountCents === payload.amountCents ? res.status(200).json({ payout: prior }) : res.status(409).json({ message: 'Idempotency key was already used for a different payout.' });
  const balanceCents = commerceStore.state.creatorLedger.filter((entry) => entry.creatorId === creatorId).reduce((sum, entry) => sum + entry.amountCents, 0);
  if (payload.amountCents > balanceCents) return res.status(409).json({ message: 'Payout amount exceeds available balance.' });
  const provider = await manualCreatorPayoutProvider.requestPayout({ creatorId, amountCents: payload.amountCents, currency: profile.currency });
  const payout = { id: id(), creatorId, idempotencyKey: idempotencyKey.data, amountCents: payload.amountCents, currency: profile.currency, provider: manualCreatorPayoutProvider.name, providerReference: provider.reference, status: provider.status, requestedAt: date() };
  commerceStore.state.creatorPayouts.push(payout);
  commerceStore.state.creatorLedger.push({ id: id(), creatorId, type: 'PAYOUT_REQUESTED', amountCents: -payload.amountCents, currency: profile.currency, reference: payout.id, createdAt: date() });
  commerceStore.state.financialLedger.push({ id: id(), ownerId: creatorId, direction: 'DEBIT', type: 'PAYOUT_REQUESTED', amountCents: payload.amountCents, currency: profile.currency, sourceType: 'PAYOUT', sourceId: payout.id, idempotencyKey: `${payout.id}:request`, createdAt: date() });
  return res.status(201).json({ payout });
});

router.get('/creators/me/payouts', requireAuth, async (req, res) => {
  const creatorId = req.user!.id;
  const payouts = await isDatabaseAvailable()
    ? await prisma.creatorPayoutRequest.findMany({ where: { creatorId }, orderBy: { requestedAt: 'desc' } })
    : commerceStore.state.creatorPayouts.filter((entry) => entry.creatorId === creatorId);
  return res.json({ payouts });
});

router.get('/admin/creator-payouts', requireAuth, requireRole(['ADMIN', 'SUPER_ADMIN']), async (_req, res) => {
  const payouts = await isDatabaseAvailable()
    ? await prisma.creatorPayoutRequest.findMany({ orderBy: { requestedAt: 'desc' } })
    : [...commerceStore.state.creatorPayouts].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  return res.json({ payouts });
});

router.patch(['/admin/creator-payouts/:id', '/admin/finance/payouts/:id'], requireAuth, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const reviewResult = z.object({
    status: z.enum(['APPROVED', 'REJECTED', 'PROCESSING', 'PAID', 'FAILED']),
    reason: z.string().trim().min(5).max(1000).optional(),
    providerReference: z.string().trim().max(200).optional(),
  }).strict().safeParse(req.body);
  if (!reviewResult.success) return res.status(400).json({ message: 'Invalid payout review.' });
  const payoutId = String(req.params.id);
  const { status, reason, providerReference } = reviewResult.data;
  if (status === 'REJECTED' && !reason) return res.status(400).json({ message: 'A rejection reason is required.' });
  if (status === 'PAID') return res.status(409).json({ message: 'No verified payout provider is configured; payment cannot be marked as paid.' });
  if (await isDatabaseAvailable()) {
    const payout = await prisma.creatorPayoutRequest.findUnique({ where: { id: payoutId } });
    if (!payout) return res.status(404).json({ message: 'Payout request not found.' });
    const transitions: Record<string, string[]> = { PENDING: ['APPROVED', 'REJECTED'], APPROVED: ['PROCESSING'], PROCESSING: ['PAID', 'FAILED'] };
    if (!transitions[payout.status]?.includes(status)) return res.status(409).json({ message: 'Invalid payout status transition.' });
    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.creatorPayoutRequest.updateMany({ where: { id: payoutId, status: payout.status }, data: { status, ...(providerReference ? { providerReference } : {}) } });
      if (!claimed.count) throw new Error('PAYOUT_REVIEW_CONFLICT');
      if (status === 'REJECTED' || status === 'FAILED') {
        await tx.creatorLedgerEntry.create({ data: { creatorId: payout.creatorId, type: 'PAYOUT_RELEASED', amountCents: payout.amountCents, currency: payout.currency, reference: `${payout.id}:refund`, description: reason ?? 'Payout failed; balance released.' } });
        await tx.financialLedgerEntry.create({ data: { ownerId: payout.creatorId, direction: 'CREDIT', type: 'PAYOUT_RELEASED', amountCents: payout.amountCents, currency: payout.currency, sourceType: 'PAYOUT', sourceId: payout.id, idempotencyKey: `${payout.id}:refund` } });
      }
      const result = await tx.creatorPayoutRequest.findUniqueOrThrow({ where: { id: payoutId } });
      return result;
    });
    await audit(req.user!.id, payout.creatorId, `CREATOR_PAYOUT_${status}`, `${payout.id}:${reason ?? ''}`);
    await notify(payout.creatorId, req.user!.id, 'creator_payout', `Your payout request was ${status.toLowerCase()}.`);
    return res.json({ payout: updated });
  }
  const payout = commerceStore.state.creatorPayouts.find((entry) => entry.id === payoutId);
  if (!payout) return res.status(404).json({ message: 'Payout request not found.' });
  const transitions: Record<string, string[]> = { PENDING: ['APPROVED', 'REJECTED'], APPROVED: ['PROCESSING'], PROCESSING: ['PAID', 'FAILED'] };
  if (!transitions[payout.status]?.includes(status)) return res.status(409).json({ message: 'Invalid payout status transition.' });
  payout.status = status;
  if (providerReference) payout.providerReference = providerReference;
  if (status === 'REJECTED' || status === 'FAILED') {
    commerceStore.state.creatorLedger.push({ id: id(), creatorId: payout.creatorId, type: 'PAYOUT_RELEASED', amountCents: payout.amountCents, currency: payout.currency, reference: `${payout.id}:refund`, description: reason ?? 'Payout failed; balance released.', createdAt: date() });
    commerceStore.state.financialLedger.push({ id: id(), ownerId: payout.creatorId, direction: 'CREDIT', type: 'PAYOUT_RELEASED', amountCents: payout.amountCents, currency: payout.currency, sourceType: 'PAYOUT', sourceId: payout.id, idempotencyKey: `${payout.id}:refund`, createdAt: date() });
  }
  await audit(req.user!.id, payout.creatorId, `CREATOR_PAYOUT_${status}`, `${payout.id}:${reason ?? ''}`);
  await notify(payout.creatorId, req.user!.id, 'creator_payout', `Your payout request was ${status.toLowerCase()}.`);
  return res.json({ payout });
});

router.post('/businesses', requireAuth, async (req, res) => {
  const payload = businessSchema.parse(req.body ?? {});
  const ownerId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const existing = await prisma.businessProfile.findUnique({ where: { ownerId } });
    if (existing) return res.status(409).json({ message: 'A business profile already exists for this account.' });
    const business = await prisma.businessProfile.create({ data: { ownerId, ...payload } });
    return res.status(201).json({ business });
  }
  if (commerceStore.state.businesses.some((entry) => entry.ownerId === ownerId)) return res.status(409).json({ message: 'A business profile already exists for this account.' });
  const business = { id: id(), ownerId, verificationStatus: 'UNVERIFIED', createdAt: date(), updatedAt: date(), ...payload };
  commerceStore.state.businesses.push(business);
  return res.status(201).json({ business });
});

router.get('/businesses/me', requireAuth, async (req, res) => {
  const ownerId = req.user!.id;
  const business = await isDatabaseAvailable()
    ? await prisma.businessProfile.findUnique({ where: { ownerId }, include: { members: true } })
    : commerceStore.state.businesses.find((entry) => entry.ownerId === ownerId) ?? null;
  if (!business) return res.status(404).json({ message: 'Business profile not found.' });
  return res.json({ business });
});

router.patch('/businesses/me', requireAuth, async (req, res) => {
  const payload = businessUpdateSchema.parse(req.body ?? {});
  const ownerId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const business = await prisma.businessProfile.findUnique({ where: { ownerId } });
    if (!business) return res.status(404).json({ message: 'Business profile not found.' });
    return res.json({ business: await prisma.businessProfile.update({ where: { ownerId }, data: payload }) });
  }
  const business = commerceStore.state.businesses.find((entry) => entry.ownerId === ownerId);
  if (!business) return res.status(404).json({ message: 'Business profile not found.' });
  Object.assign(business, payload, { updatedAt: date() });
  return res.json({ business });
});

router.post('/businesses/me/verification', requireAuth, async (req, res) => {
  const ownerId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const business = await prisma.businessProfile.findUnique({ where: { ownerId } });
    if (!business) return res.status(404).json({ message: 'Business profile not found.' });
    if (business.verificationStatus === 'VERIFIED') return res.status(409).json({ message: 'Business is already verified.' });
    return res.json({ business: await prisma.businessProfile.update({ where: { ownerId }, data: { verificationStatus: 'PENDING' } }) });
  }
  const business = commerceStore.state.businesses.find((entry) => entry.ownerId === ownerId);
  if (!business) return res.status(404).json({ message: 'Business profile not found.' });
  if (business.verificationStatus === 'VERIFIED') return res.status(409).json({ message: 'Business is already verified.' });
  business.verificationStatus = 'PENDING';
  business.updatedAt = date();
  return res.json({ business });
});

router.patch('/businesses/:id/verification', requireAuth, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const businessId = String(req.params.id);
  const verificationStatus = z.enum(['VERIFIED', 'REJECTED']).parse(req.body?.status);
  if (await isDatabaseAvailable()) {
    const business = await prisma.businessProfile.findUnique({ where: { id: businessId } });
    if (!business) return res.status(404).json({ message: 'Business profile not found.' });
    const updated = await prisma.businessProfile.update({ where: { id: businessId }, data: { verificationStatus } });
    await audit(req.user!.id, business.ownerId, 'BUSINESS_VERIFICATION_REVIEWED', `${businessId}:${verificationStatus}`);
    return res.json({ business: updated });
  }
  const business = commerceStore.state.businesses.find((entry) => entry.id === businessId);
  if (!business) return res.status(404).json({ message: 'Business profile not found.' });
  business.verificationStatus = verificationStatus;
  business.updatedAt = date();
  return res.json({ business });
});

router.get('/businesses/:id', async (req, res) => {
  const businessId = String(req.params.id);
  const business = await isDatabaseAvailable()
    ? await prisma.businessProfile.findUnique({ where: { id: businessId }, include: { _count: { select: { followers: true, posts: true } } } })
    : commerceStore.state.businesses.find((entry) => entry.id === businessId) ?? null;
  if (!business) return res.status(404).json({ message: 'Business profile not found.' });
  return res.json({ business });
});

router.post('/businesses/:id/follow', requireAuth, async (req, res) => {
  const businessId = String(req.params.id);
  const userId = req.user!.id;
  if (await isDatabaseAvailable()) {
    if (!(await prisma.businessProfile.findUnique({ where: { id: businessId }, select: { id: true } }))) return res.status(404).json({ message: 'Business profile not found.' });
    try {
      const follower = await prisma.businessFollower.create({ data: { businessId, userId } });
      return res.status(201).json({ follower });
    } catch {
      return res.status(409).json({ message: 'You already follow this business.' });
    }
  }
  if (!commerceStore.state.businesses.some((entry) => entry.id === businessId)) return res.status(404).json({ message: 'Business profile not found.' });
  if (commerceStore.state.businessFollowers.some((entry) => entry.businessId === businessId && entry.userId === userId)) return res.status(409).json({ message: 'You already follow this business.' });
  const follower = { id: id(), businessId, userId, createdAt: date() };
  commerceStore.state.businessFollowers.push(follower);
  return res.status(201).json({ follower });
});

router.delete('/businesses/:id/follow', requireAuth, async (req, res) => {
  const businessId = String(req.params.id);
  const userId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const follower = await prisma.businessFollower.findUnique({ where: { businessId_userId: { businessId, userId } } });
    if (!follower) return res.status(404).json({ message: 'Business follow not found.' });
    await prisma.businessFollower.delete({ where: { id: follower.id } });
    return res.json({ following: false });
  }
  const index = commerceStore.state.businessFollowers.findIndex((entry) => entry.businessId === businessId && entry.userId === userId);
  if (index < 0) return res.status(404).json({ message: 'Business follow not found.' });
  commerceStore.state.businessFollowers.splice(index, 1);
  return res.json({ following: false });
});

router.get('/businesses/:id/dashboard', requireAuth, async (req, res) => {
  const businessId = String(req.params.id);
  const access = await getBusinessAccess(businessId, req.user!.id);
  if (!access) return res.status(404).json({ message: 'Business not found.' });
  if (!['OWNER', 'ADMIN', 'ANALYST'].includes(access.role)) return res.status(403).json({ message: 'Business analytics permission required.' });
  if (await isDatabaseAvailable()) {
    const [followers, posts, members] = await Promise.all([
      prisma.businessFollower.count({ where: { businessId } }),
      prisma.businessPost.count({ where: { businessId } }),
      prisma.businessMember.count({ where: { businessId } }),
    ]);
    return res.json({ dashboard: { business: access.business, audience: { followers }, content: { posts }, team: { members } } });
  }
  return res.json({ dashboard: {
    business: access.business,
    audience: { followers: commerceStore.state.businessFollowers.filter((entry) => entry.businessId === businessId).length },
    content: { posts: commerceStore.state.businessPosts.filter((entry) => entry.businessId === businessId).length },
    team: { members: commerceStore.state.businessMembers.filter((entry) => entry.businessId === businessId).length },
  } });
});

router.put('/businesses/:id/team/:userId', requireAuth, async (req, res) => {
  const businessId = String(req.params.id);
  const memberUserId = String(req.params.userId);
  const roleResult = z.enum(['ADMIN', 'EDITOR', 'ANALYST']).safeParse(req.body?.role);
  if (!roleResult.success) return res.status(400).json({ message: 'Invalid business team role.' });
  const role = roleResult.data;
  if (memberUserId === req.user!.id) return res.status(400).json({ message: 'The business owner cannot be assigned a team role.' });
  if (await isDatabaseAvailable()) {
    const business = await prisma.businessProfile.findFirst({ where: { id: businessId, ownerId: req.user!.id } });
    if (!business) return res.status(404).json({ message: 'Business not found.' });
    if (!(await prisma.user.findUnique({ where: { id: memberUserId }, select: { id: true } }))) return res.status(404).json({ message: 'Team member not found.' });
    const member = await prisma.businessMember.upsert({ where: { businessId_userId: { businessId, userId: memberUserId } }, create: { businessId, userId: memberUserId, role }, update: { role } });
    await audit(req.user!.id, memberUserId, 'BUSINESS_TEAM_ROLE_UPDATED', `${businessId}:${role}`);
    return res.json({ member });
  }
  if (!commerceStore.state.businesses.some((entry) => entry.id === businessId && entry.ownerId === req.user!.id)) return res.status(404).json({ message: 'Business not found.' });
  const member = commerceStore.state.businessMembers.find((entry) => entry.businessId === businessId && entry.userId === memberUserId);
  if (member) member.role = role;
  else {
    const created = { id: id(), businessId, userId: memberUserId, role, createdAt: date(), updatedAt: date() };
    commerceStore.state.businessMembers.push(created);
    await audit(req.user!.id, memberUserId, 'BUSINESS_TEAM_ROLE_UPDATED', `${businessId}:${role}`);
    return res.json({ member: created });
  }
  await audit(req.user!.id, memberUserId, 'BUSINESS_TEAM_ROLE_UPDATED', `${businessId}:${role}`);
  return res.json({ member });
});

router.delete('/businesses/:id/team/:userId', requireAuth, async (req, res) => {
  const businessId = String(req.params.id);
  const memberUserId = String(req.params.userId);
  if (await isDatabaseAvailable()) {
    const business = await prisma.businessProfile.findFirst({ where: { id: businessId, ownerId: req.user!.id } });
    if (!business) return res.status(404).json({ message: 'Business not found.' });
    const member = await prisma.businessMember.findUnique({ where: { businessId_userId: { businessId, userId: memberUserId } } });
    if (!member) return res.status(404).json({ message: 'Team member not found.' });
    await prisma.businessMember.delete({ where: { id: member.id } });
    await audit(req.user!.id, memberUserId, 'BUSINESS_TEAM_MEMBER_REMOVED', businessId);
    return res.json({ removed: true });
  }
  if (!commerceStore.state.businesses.some((entry) => entry.id === businessId && entry.ownerId === req.user!.id)) return res.status(404).json({ message: 'Business not found.' });
  const index = commerceStore.state.businessMembers.findIndex((entry) => entry.businessId === businessId && entry.userId === memberUserId);
  if (index < 0) return res.status(404).json({ message: 'Team member not found.' });
  commerceStore.state.businessMembers.splice(index, 1);
  return res.json({ removed: true });
});

router.post('/businesses/:id/posts', requireAuth, async (req, res) => {
  const businessId = String(req.params.id);
  const payload = businessPostSchema.parse(req.body ?? {});
  const access = await getBusinessAccess(businessId, req.user!.id);
  if (!access) return res.status(404).json({ message: 'Business not found.' });
  if (!['OWNER', 'ADMIN', 'EDITOR'].includes(access.role)) return res.status(403).json({ message: 'Business content permission required.' });
  if (await isDatabaseAvailable()) {
    const post = await prisma.businessPost.create({ data: { businessId, authorId: req.user!.id, ...payload } });
    return res.status(201).json({ post });
  }
  const post = { id: id(), businessId, authorId: req.user!.id, ...payload, createdAt: date(), updatedAt: date() };
  commerceStore.state.businessPosts.push(post);
  return res.status(201).json({ post });
});

router.put('/sellers/me/profile', requireAuth, async (req, res) => {
  const payload = sellerSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const profile = await prisma.sellerProfile.upsert({ where: { userId }, create: { userId, ...payload }, update: payload });
    return res.json({ profile });
  }
  let profile = commerceStore.state.sellers.find((entry) => entry.userId === userId);
  if (profile) Object.assign(profile, payload, { updatedAt: date() });
  else {
    profile = { id: id(), userId, createdAt: date(), updatedAt: date(), ...payload };
    commerceStore.state.sellers.push(profile);
  }
  return res.json({ profile });
});

router.get('/sellers/me/dashboard', requireAuth, async (req, res) => {
  const sellerId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId } });
    if (!profile) return res.status(404).json({ message: 'Seller profile not found.' });
    const [products, items] = await Promise.all([
      prisma.marketplaceProduct.count({ where: { sellerId } }),
      prisma.marketplaceOrderItem.findMany({ where: { sellerId }, include: { order: true } }),
    ]);
    const revenueCents = items.filter((item) => item.order.status === 'DELIVERED').reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
    return res.json({ dashboard: { profile, products, orders: new Set(items.map((item) => item.orderId)).size, revenueCents } });
  }
  const profile = commerceStore.state.sellers.find((entry) => entry.userId === sellerId);
  if (!profile) return res.status(404).json({ message: 'Seller profile not found.' });
  const items = commerceStore.state.orderItems.filter((entry) => entry.sellerId === sellerId);
  const completed = items.filter((item) => commerceStore.state.orders.find((order) => order.id === item.orderId)?.status === 'DELIVERED');
  return res.json({ dashboard: { profile, products: commerceStore.state.products.filter((entry) => entry.sellerId === sellerId).length, orders: new Set(items.map((entry) => entry.orderId)).size, revenueCents: completed.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0) } });
});

router.post('/marketplace/products', requireAuth, async (req, res) => {
  const payload = productSchema.parse(req.body ?? {});
  const sellerId = req.user!.id;
  if (await isDatabaseAvailable()) {
    if (!(await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { id: true } }))) return res.status(409).json({ message: 'Create a seller profile first.' });
    const { images, ...productData } = payload;
    const product = await prisma.marketplaceProduct.create({ data: { sellerId, ...productData, images: { create: images } }, include: { images: true } });
    await audit(sellerId, sellerId, 'MARKETPLACE_PRODUCT_CREATED', product.id);
    return res.status(201).json({ product });
  }
  if (!commerceStore.state.sellers.some((entry) => entry.userId === sellerId)) return res.status(409).json({ message: 'Create a seller profile first.' });
  const { images, ...productData } = payload;
  const product = { id: id(), sellerId, ...productData, createdAt: date(), updatedAt: date() };
  commerceStore.state.products.push(product);
  commerceStore.state.productImages.push(...images.map((image, position) => ({ id: id(), productId: product.id, ...image, position, createdAt: date() })));
  return res.status(201).json({ product: { ...product, images } });
});

router.get('/marketplace/products', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const category = req.query.category ? String(req.query.category) : undefined;
  const currency = req.query.currency ? String(req.query.currency).toUpperCase() : undefined;
  const minPrice = req.query.minPrice === undefined ? undefined : Number(req.query.minPrice);
  const maxPrice = req.query.maxPrice === undefined ? undefined : Number(req.query.maxPrice);
  if ((minPrice !== undefined && (!Number.isInteger(minPrice) || minPrice < 0)) || (maxPrice !== undefined && (!Number.isInteger(maxPrice) || maxPrice < 0))) return res.status(400).json({ message: 'Price filters must be non-negative integer cents.' });
  const take = Math.min(Math.max(Number(req.query.limit ?? 40), 1), 100);
  if (await isDatabaseAvailable()) {
    const products = await prisma.marketplaceProduct.findMany({
      where: { status: 'ACTIVE', stock: { gt: 0 }, ...(category ? { category } : {}), ...(currency ? { currency } : {}), ...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] } : {}), ...(minPrice !== undefined || maxPrice !== undefined ? { priceCents: { ...(minPrice !== undefined ? { gte: minPrice } : {}), ...(maxPrice !== undefined ? { lte: maxPrice } : {}) } } : {}) },
      include: { images: { orderBy: { position: 'asc' } }, seller: true },
      orderBy: { createdAt: 'desc' }, take,
    });
    return res.json({ products });
  }
  const products = commerceStore.state.products.filter((product) => product.status === 'ACTIVE' && product.stock > 0
    && (!category || product.category === category) && (!currency || product.currency === currency)
    && (!q || `${product.title} ${product.description}`.toLowerCase().includes(q.toLowerCase()))
    && (minPrice === undefined || product.priceCents >= minPrice) && (maxPrice === undefined || product.priceCents <= maxPrice))
    .slice(0, take).map((product) => ({ ...product, images: commerceStore.state.productImages.filter((image) => image.productId === product.id) }));
  return res.json({ products });
});

router.patch('/marketplace/products/:id', requireAuth, async (req, res) => {
  const productId = String(req.params.id);
  const payload = productUpdateSchema.parse(req.body ?? {});
  const sellerId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const existing = await prisma.marketplaceProduct.findFirst({ where: { id: productId, sellerId } });
    if (!existing) return res.status(404).json({ message: 'Product not found.' });
    const { images, ...data } = payload;
    const product = await prisma.$transaction(async (tx) => {
      if (images) await tx.productImage.deleteMany({ where: { productId } });
      return tx.marketplaceProduct.update({ where: { id: productId }, data: { ...data, ...(images ? { images: { create: images } } : {}) }, include: { images: true } });
    });
    await audit(sellerId, sellerId, 'MARKETPLACE_PRODUCT_UPDATED', productId);
    return res.json({ product });
  }
  const product = commerceStore.state.products.find((entry) => entry.id === productId && entry.sellerId === sellerId);
  if (!product) return res.status(404).json({ message: 'Product not found.' });
  const { images, ...data } = payload;
  Object.assign(product, data, { updatedAt: date() });
  if (images) {
    commerceStore.state.productImages = commerceStore.state.productImages.filter((image) => image.productId !== productId);
    commerceStore.state.productImages.push(...images.map((image, position) => ({ id: id(), productId, ...image, position, createdAt: date() })));
  }
  return res.json({ product: { ...product, images: commerceStore.state.productImages.filter((image) => image.productId === productId) } });
});

router.post('/marketplace/products/:id/inquiries', requireAuth, async (req, res) => {
  const productId = String(req.params.id);
  const message = z.string().trim().min(1).max(2000).parse(req.body?.message);
  const buyerId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const product = await prisma.marketplaceProduct.findFirst({ where: { id: productId, status: 'ACTIVE' }, select: { sellerId: true } });
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    if (await blockedEitherWay(buyerId, product.sellerId)) return res.status(403).json({ message: 'You cannot contact this seller.' });
    const inquiry = await prisma.productInquiry.create({ data: { productId, buyerId, message } });
    await notify(product.sellerId, buyerId, 'marketplace_inquiry', 'A buyer sent a product inquiry.');
    return res.status(201).json({ inquiry });
  }
  const product = commerceStore.state.products.find((entry) => entry.id === productId && entry.status === 'ACTIVE');
  if (!product) return res.status(404).json({ message: 'Product not found.' });
  if (await blockedEitherWay(buyerId, product.sellerId)) return res.status(403).json({ message: 'You cannot contact this seller.' });
  const inquiry = { id: id(), productId, buyerId, message, createdAt: date() };
  commerceStore.state.inquiries.push(inquiry);
  await notify(product.sellerId, buyerId, 'marketplace_inquiry', 'A buyer sent a product inquiry.');
  return res.status(201).json({ inquiry });
});

router.post('/marketplace/orders', requireAuth, async (req, res) => {
  const payload = orderSchema.parse(req.body ?? {});
  const buyerId = req.user!.id;
  const quantities = new Map<string, number>();
  for (const item of payload.items) quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  const requested = [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
  if (await isDatabaseAvailable()) {
    const products = await prisma.marketplaceProduct.findMany({ where: { id: { in: requested.map((entry) => entry.productId) }, status: 'ACTIVE' } });
    if (products.length !== requested.length) return res.status(409).json({ message: 'One or more products are unavailable.' });
    if (new Set(products.map((product) => product.sellerId)).size !== 1) return res.status(400).json({ message: 'An order can contain products from one seller only.' });
    if (products.some((product) => product.stock < requested.find((entry) => entry.productId === product.id)!.quantity)) return res.status(409).json({ message: 'Insufficient product stock.' });
    const sellerId = products[0].sellerId;
    if (buyerId === sellerId || await blockedEitherWay(buyerId, sellerId)) return res.status(403).json({ message: 'You cannot purchase from this seller.' });
    if (new Set(products.map((product) => product.currency)).size !== 1) return res.status(400).json({ message: 'Products in an order must use the same currency.' });
    const totalCents = products.reduce((sum, product) => sum + product.priceCents * requested.find((entry) => entry.productId === product.id)!.quantity, 0);
    try {
      const order = await prisma.$transaction(async (tx) => {
        for (const item of requested) {
          const changed = await tx.marketplaceProduct.updateMany({ where: { id: item.productId, status: 'ACTIVE', stock: { gte: item.quantity } }, data: { stock: { decrement: item.quantity } } });
          if (!changed.count) throw new Error('STOCK_CONFLICT');
          await tx.marketplaceProduct.updateMany({ where: { id: item.productId, stock: 0 }, data: { status: 'OUT_OF_STOCK' } });
        }
        return tx.marketplaceOrder.create({ data: { buyerId, totalCents, currency: products[0].currency, items: { create: products.map((product) => ({ productId: product.id, sellerId: product.sellerId, titleSnapshot: product.title, quantity: requested.find((entry) => entry.productId === product.id)!.quantity, unitPriceCents: product.priceCents, currency: product.currency })) } }, include: { items: true } });
      });
      await notify(sellerId, buyerId, 'marketplace_order', 'A new marketplace order was placed.');
      await audit(buyerId, sellerId, 'MARKETPLACE_ORDER_CREATED', order.id);
      return res.status(201).json({ order });
    } catch (error) {
      if (error instanceof Error && error.message === 'STOCK_CONFLICT') return res.status(409).json({ message: 'Insufficient product stock.' });
      throw error;
    }
  }
  const products = requested.map((entry) => commerceStore.state.products.find((product) => product.id === entry.productId && product.status === 'ACTIVE'));
  if (products.some((product) => !product)) return res.status(409).json({ message: 'One or more products are unavailable.' });
  const available = products as NonNullable<(typeof products)[number]>[];
  if (new Set(available.map((product) => product.sellerId)).size !== 1) return res.status(400).json({ message: 'An order can contain products from one seller only.' });
  if (available.some((product) => product.stock < requested.find((entry) => entry.productId === product.id)!.quantity)) return res.status(409).json({ message: 'Insufficient product stock.' });
  const sellerId = available[0].sellerId;
  if (buyerId === sellerId || await blockedEitherWay(buyerId, sellerId)) return res.status(403).json({ message: 'You cannot purchase from this seller.' });
  if (new Set(available.map((product) => product.currency)).size !== 1) return res.status(400).json({ message: 'Products in an order must use the same currency.' });
  const totalCents = available.reduce((sum, product) => sum + product.priceCents * requested.find((entry) => entry.productId === product.id)!.quantity, 0);
  for (const product of available) {
    const quantity = requested.find((entry) => entry.productId === product.id)!.quantity;
    product.stock -= quantity;
    if (product.stock === 0) product.status = 'OUT_OF_STOCK';
  }
  const order = { id: id(), buyerId, status: 'PENDING', totalCents, currency: available[0].currency, createdAt: date(), updatedAt: date() };
  commerceStore.state.orders.push(order);
  const items = available.map((product) => ({ id: id(), orderId: order.id, productId: product.id, sellerId: product.sellerId, titleSnapshot: product.title, quantity: requested.find((entry) => entry.productId === product.id)!.quantity, unitPriceCents: product.priceCents, currency: product.currency }));
  commerceStore.state.orderItems.push(...items);
  await notify(sellerId, buyerId, 'marketplace_order', 'A new marketplace order was placed.');
  return res.status(201).json({ order: { ...order, items } });
});

router.get('/marketplace/orders/me', requireAuth, async (req, res) => {
  const buyerId = req.user!.id;
  const orders = await isDatabaseAvailable()
    ? await prisma.marketplaceOrder.findMany({ where: { buyerId }, include: { items: true, disputes: true }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.orders.filter((entry) => entry.buyerId === buyerId).map((order) => ({ ...order, items: commerceStore.state.orderItems.filter((item) => item.orderId === order.id), disputes: commerceStore.state.disputes.filter((entry) => entry.orderId === order.id) }));
  return res.json({ orders });
});

router.get('/marketplace/seller/orders', requireAuth, async (req, res) => {
  const sellerId = req.user!.id;
  const orders = await isDatabaseAvailable()
    ? await prisma.marketplaceOrder.findMany({ where: { items: { some: { sellerId } } }, include: { items: true, disputes: true }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.orders.filter((order) => commerceStore.state.orderItems.some((item) => item.orderId === order.id && item.sellerId === sellerId)).map((order) => ({ ...order, items: commerceStore.state.orderItems.filter((item) => item.orderId === order.id && item.sellerId === sellerId), disputes: commerceStore.state.disputes.filter((entry) => entry.orderId === order.id) }));
  return res.json({ orders });
});

router.patch('/marketplace/orders/:id/status', requireAuth, async (req, res) => {
  const orderId = String(req.params.id);
  const statusResult = z.enum(orderStatuses).safeParse(req.body?.status);
  if (!statusResult.success) return res.status(400).json({ message: 'Invalid order status.' });
  const nextStatus = statusResult.data;
  if (!['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(nextStatus)) return res.status(400).json({ message: 'This order status cannot be set by a seller.' });
  if (await isDatabaseAvailable()) {
    const order = await prisma.marketplaceOrder.findFirst({ where: { id: orderId, items: { some: { sellerId: req.user!.id } } }, include: { items: true } });
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (order.paymentStatus !== 'PAID') return res.status(409).json({ message: 'Order must be paid before fulfillment.' });
    const transitions: Record<string, string[]> = { PENDING: ['CONFIRMED'], CONFIRMED: ['PROCESSING'], PROCESSING: ['SHIPPED'], SHIPPED: ['DELIVERED'] };
    if (!transitions[order.status]?.includes(nextStatus)) return res.status(409).json({ message: 'Invalid order status transition.' });
    const updated = await prisma.marketplaceOrder.update({ where: { id: orderId }, data: { status: nextStatus } });
    await audit(req.user!.id, order.buyerId, 'MARKETPLACE_ORDER_STATUS_UPDATED', `${orderId}:${nextStatus}`);
    await notify(order.buyerId, req.user!.id, 'marketplace_order_status', `Your order status is now ${nextStatus.toLowerCase()}.`);
    return res.json({ order: updated });
  }
  const order = commerceStore.state.orders.find((entry) => entry.id === orderId && commerceStore.state.orderItems.some((item) => item.orderId === orderId && item.sellerId === req.user!.id));
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  if (order.paymentStatus !== 'PAID') return res.status(409).json({ message: 'Order must be paid before fulfillment.' });
  const transitions: Record<string, string[]> = { PENDING: ['CONFIRMED'], CONFIRMED: ['PROCESSING'], PROCESSING: ['SHIPPED'], SHIPPED: ['DELIVERED'] };
  if (!transitions[order.status]?.includes(nextStatus)) return res.status(409).json({ message: 'Invalid order status transition.' });
  order.status = nextStatus;
  order.updatedAt = date();
  await notify(order.buyerId, req.user!.id, 'marketplace_order_status', `Your order status is now ${nextStatus.toLowerCase()}.`);
  return res.json({ order });
});

router.post('/marketplace/orders/:id/cancel', requireAuth, async (req, res) => {
  const orderId = String(req.params.id);
  const buyerId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const order = await prisma.marketplaceOrder.findFirst({ where: { id: orderId, buyerId }, include: { items: true } });
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (!['PENDING', 'CONFIRMED'].includes(order.status)) return res.status(409).json({ message: 'This order can no longer be cancelled.' });
    if (order.paymentStatus === 'PAID') return res.status(409).json({ message: 'Paid orders require an approved refund.' });
    let updated;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const claimed = await tx.marketplaceOrder.updateMany({ where: { id: orderId, buyerId, status: { in: ['PENDING', 'CONFIRMED'] }, paymentStatus: { not: 'PAID' } }, data: { status: 'CANCELLED', paymentStatus: 'CANCELLED', cancelledAt: new Date() } });
        if (!claimed.count) throw new Error('ORDER_CANCEL_CONFLICT');
        await tx.paymentIntent.updateMany({ where: { purpose: 'MARKETPLACE_ORDER', targetId: orderId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      for (const item of order.items) await tx.marketplaceProduct.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity }, status: 'ACTIVE' } });
        return tx.marketplaceOrder.findUniqueOrThrow({ where: { id: orderId } });
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'ORDER_CANCEL_CONFLICT') return res.status(409).json({ message: 'This order can no longer be cancelled.' });
      throw error;
    }
    await audit(buyerId, order.items[0]?.sellerId ?? null, 'MARKETPLACE_ORDER_CANCELLED', orderId);
    return res.json({ order: updated });
  }
  const order = commerceStore.state.orders.find((entry) => entry.id === orderId && entry.buyerId === buyerId);
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  if (!['PENDING', 'CONFIRMED'].includes(order.status)) return res.status(409).json({ message: 'This order can no longer be cancelled.' });
  if (order.paymentStatus === 'PAID') return res.status(409).json({ message: 'Paid orders require an approved refund.' });
  for (const item of commerceStore.state.orderItems.filter((entry) => entry.orderId === orderId)) {
    const product = commerceStore.state.products.find((entry) => entry.id === item.productId);
    if (product) { product.stock += item.quantity; product.status = 'ACTIVE'; }
  }
  order.status = 'CANCELLED';
  order.paymentStatus = 'CANCELLED';
  for (const intent of commerceStore.state.paymentIntents.filter((entry) => entry.purpose === 'MARKETPLACE_ORDER' && entry.targetId === orderId && entry.status === 'PENDING')) intent.status = 'CANCELLED';
  order.cancelledAt = date();
  order.updatedAt = date();
  return res.json({ order });
});

router.post('/marketplace/orders/:id/disputes', requireAuth, async (req, res) => {
  const orderId = String(req.params.id);
  const reason = z.string().trim().min(5).max(2000).parse(req.body?.reason);
  const reporterId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const order = await prisma.marketplaceOrder.findFirst({ where: { id: orderId, OR: [{ buyerId: reporterId }, { items: { some: { sellerId: reporterId } } }] }, include: { items: true } });
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (['CANCELLED', 'DISPUTED'].includes(order.status)) return res.status(409).json({ message: 'This order cannot be disputed.' });
    const dispute = await prisma.$transaction(async (tx) => {
      const created = await tx.marketplaceDispute.create({ data: { orderId, reporterId, reason } });
      await tx.marketplaceOrder.update({ where: { id: orderId }, data: { status: 'DISPUTED' } });
      return created;
    });
    await audit(reporterId, order.buyerId, 'MARKETPLACE_DISPUTE_OPENED', orderId);
    return res.status(201).json({ dispute });
  }
  const order = commerceStore.state.orders.find((entry) => entry.id === orderId && (entry.buyerId === reporterId || commerceStore.state.orderItems.some((item) => item.orderId === orderId && item.sellerId === reporterId)));
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  if (['CANCELLED', 'DISPUTED'].includes(order.status)) return res.status(409).json({ message: 'This order cannot be disputed.' });
  const dispute = { id: id(), orderId, reporterId, reason, status: 'OPEN', createdAt: date(), updatedAt: date() };
  commerceStore.state.disputes.push(dispute);
  order.status = 'DISPUTED';
  order.updatedAt = date();
  return res.status(201).json({ dispute });
});

export { router as creatorBusinessMarketplaceRouter };