import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { commerceStore } from '../lib/commerceStore.js';
import { hmacPaymentWebhookVerifier, manualPaymentProvider, type PaymentStatus, type PaymentWebhookPayload } from '../lib/paymentProviders.js';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { socialStore } from '../lib/socialStore.js';
import { requireActiveAccountIfAuthenticated, requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const paymentStatuses = ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED', 'DISPUTED'] as const;
const feeBasisPoints = 1000;
const businessVerificationFeeCents = 2500;
const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${randomUUID()}`;
const intentSchema = z.object({
  purpose: z.enum(['CREATOR_SUBSCRIPTION', 'MARKETPLACE_ORDER', 'BUSINESS_VERIFICATION', 'PLATFORM_SUBSCRIPTION']),
  targetId: z.string().min(1).max(128),
}).strict();
const webhookSchema = z.object({
  eventId: z.string().min(1).max(200),
  reference: z.string().min(1).max(200),
  status: z.enum(paymentStatuses),
  providerReference: z.string().max(200).optional(),
}).strict();

function platformFee(amountCents: number) {
  return Math.floor(amountCents * feeBasisPoints / 10000);
}

async function currentCreatorRevenueSharePercent() {
  if (await isDatabaseAvailable()) {
    const settings = await prisma.monetizationSettings.findUnique({ where: { id: 'default' }, select: { revenueSharePercent: true } });
    return settings?.revenueSharePercent ?? 90;
  }
  return commerceStore.state.monetizationSettings?.revenueSharePercent ?? 90;
}

function creatorNetAmount(intent: any) {
  const configured = Number(intent.metadata?.creatorRevenueSharePercent);
  const sharePercent = Number.isInteger(configured) && configured >= 0 && configured <= 100 ? configured : 90;
  return Math.floor(intent.amountCents * sharePercent / 100);
}

async function audit(actorId: string, targetUserId: string | null, actionType: string, details: string) {
  if (await isDatabaseAvailable()) {
    await prisma.adminAction.create({ data: { actorId, targetUserId, actionType, details } });
    return;
  }
  const { fallbackStore } = await import('../lib/fallbackStore.js');
  fallbackStore.createAdminAction({ actorId, targetUserId, actionType, details });
}

function ownerCanSeeIntent(intent: any, userId: string) {
  if (intent.payerId === userId) return true;
  if (intent.purpose === 'CREATOR_SUBSCRIPTION') return intent.metadata?.creatorId === userId;
  if (intent.purpose === 'BUSINESS_VERIFICATION') return intent.metadata?.ownerId === userId;
  return intent.metadata?.sellerId === userId;
}

async function makeIntent(payerId: string, purpose: string, targetId: string, amountCents: number, currency: string, metadata: Record<string, string>, idempotencyKey: string) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100000000) throw new Error('INVALID_AMOUNT');
  if (await isDatabaseAvailable()) {
    const existing = await prisma.paymentIntent.findUnique({ where: { payerId_idempotencyKey: { payerId, idempotencyKey } } });
    if (existing) {
      if (existing.purpose !== purpose || existing.targetId !== targetId || existing.amountCents !== amountCents || existing.currency !== currency) throw new Error('IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const reference = newId('pay');
    const provider = await manualPaymentProvider.createIntent({ reference, amountCents, currency, payerId });
    return prisma.paymentIntent.create({ data: { reference, idempotencyKey, payerId, provider: manualPaymentProvider.name, providerReference: provider.providerReference, amountCents, currency, purpose, targetId, metadata } });
  }
  const existing = commerceStore.state.paymentIntents.find((entry) => entry.payerId === payerId && entry.idempotencyKey === idempotencyKey);
  if (existing) {
    if (existing.purpose !== purpose || existing.targetId !== targetId || existing.amountCents !== amountCents || existing.currency !== currency) throw new Error('IDEMPOTENCY_CONFLICT');
    return existing;
  }
  const reference = newId('pay');
  const provider = await manualPaymentProvider.createIntent({ reference, amountCents, currency, payerId });
  const intent = { id: newId('intent'), reference, idempotencyKey, payerId, provider: manualPaymentProvider.name, providerReference: provider.providerReference, amountCents, currency, purpose, targetId, metadata, status: 'PENDING', createdAt: now(), updatedAt: now() };
  if (commerceStore.state.paymentIntents.some((entry) => entry.reference === reference)) throw new Error('DUPLICATE_REFERENCE');
  commerceStore.state.paymentIntents.push(intent);
  return intent;
}

async function findPendingIntent(payerId: string, purpose: string, targetId: string, idempotencyKey: string) {
  const pending = await isDatabaseAvailable()
    ? await prisma.paymentIntent.findFirst({ where: { payerId, purpose, targetId, status: 'PENDING' } })
    : commerceStore.state.paymentIntents.find((entry) => entry.payerId === payerId && entry.purpose === purpose && entry.targetId === targetId && entry.status === 'PENDING');
  if (pending && pending.idempotencyKey !== idempotencyKey) throw new Error('PAYMENT_PENDING');
  return pending ?? null;
}

export async function createCreatorSubscriptionIntent(subscriberId: string, creatorId: string, idempotencyKey: string) {
  if (creatorId === subscriberId) throw new Error('CREATOR_SELF');
  if (await isDatabaseAvailable()) {
    const profile = await prisma.creatorProfile.findFirst({ where: { userId: creatorId, isEnabled: true } });
    if (!profile) throw new Error('CREATOR_NOT_FOUND');
    const existing = await prisma.creatorSubscription.findUnique({ where: { creatorId_subscriberId: { creatorId, subscriberId } } });
    if (existing?.status === 'ACTIVE') throw new Error('CREATOR_ALREADY_SUBSCRIBED');
    const subscription = existing ?? await prisma.creatorSubscription.create({ data: { creatorId, subscriberId, status: 'PENDING', amountCents: profile.subscriptionPriceCents, currency: profile.currency, provider: manualPaymentProvider.name } });
    const pending = await findPendingIntent(subscriberId, 'CREATOR_SUBSCRIPTION', subscription.id, idempotencyKey);
    const revenueSharePercent = String(await currentCreatorRevenueSharePercent());
    const intent = pending ?? await makeIntent(subscriberId, 'CREATOR_SUBSCRIPTION', subscription.id, profile.subscriptionPriceCents, profile.currency, { creatorId, subscriberId, creatorRevenueSharePercent: revenueSharePercent }, idempotencyKey);
    return { subscription, intent };
  }
  const profile = commerceStore.state.creators.find((entry) => entry.userId === creatorId && entry.isEnabled);
  if (!profile) throw new Error('CREATOR_NOT_FOUND');
  if (commerceStore.state.creatorSubscriptions.some((entry) => entry.creatorId === creatorId && entry.subscriberId === subscriberId && entry.status === 'ACTIVE')) throw new Error('CREATOR_ALREADY_SUBSCRIBED');
  let subscription = commerceStore.state.creatorSubscriptions.find((entry) => entry.creatorId === creatorId && entry.subscriberId === subscriberId && entry.status === 'PENDING');
  if (!subscription) {
    subscription = { id: newId('creator_sub'), creatorId, subscriberId, status: 'PENDING', amountCents: profile.subscriptionPriceCents, currency: profile.currency, provider: manualPaymentProvider.name, providerReference: null, startedAt: now(), createdAt: now(), updatedAt: now() };
    commerceStore.state.creatorSubscriptions.push(subscription);
  }
  const pending = await findPendingIntent(subscriberId, 'CREATOR_SUBSCRIPTION', subscription.id, idempotencyKey);
  const revenueSharePercent = String(await currentCreatorRevenueSharePercent());
  const intent = pending ?? await makeIntent(subscriberId, 'CREATOR_SUBSCRIPTION', subscription.id, profile.subscriptionPriceCents, profile.currency, { creatorId, subscriberId, creatorRevenueSharePercent: revenueSharePercent }, idempotencyKey);
  return { subscription, intent };
}

export async function createPlatformSubscriptionIntent(userId: string, planId: string, idempotencyKey: string) {
  if (await isDatabaseAvailable()) {
    const plan = await prisma.subscriptionPlan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) throw new Error('PLAN_NOT_FOUND');
    const active = await prisma.subscription.findFirst({ where: { userId, planId, status: { in: ['ACTIVE', 'TRIALING'] } } });
    if (active) throw new Error('SUBSCRIPTION_ACTIVE');
    let subscription = await prisma.subscription.findFirst({ where: { userId, planId, status: 'PENDING' } });
    if (!subscription) subscription = await prisma.subscription.create({ data: { userId, planId, status: 'PENDING' } });
    const pending = await findPendingIntent(userId, 'PLATFORM_SUBSCRIPTION', subscription.id, idempotencyKey);
    const intent = pending ?? await makeIntent(userId, 'PLATFORM_SUBSCRIPTION', subscription.id, plan.priceCents, plan.currency, { planId, interval: plan.interval }, idempotencyKey);
    let payment = await prisma.payment.findFirst({ where: { subscriptionId: subscription.id, userId } });
    if (!payment) payment = await prisma.payment.create({ data: { subscriptionId: subscription.id, userId, provider: intent.provider, providerReference: intent.providerReference, amountCents: intent.amountCents, currency: intent.currency, status: 'PENDING' } });
    return { subscription, intent, payment };
  }
  const plan = socialStore.state.subscriptionPlans.find((entry) => entry.id === planId && entry.isActive);
  if (!plan) throw new Error('PLAN_NOT_FOUND');
  if (socialStore.state.subscriptions.some((entry) => entry.userId === userId && entry.planId === planId && ['ACTIVE', 'TRIALING'].includes(entry.status))) throw new Error('SUBSCRIPTION_ACTIVE');
  let subscription = socialStore.state.subscriptions.find((entry) => entry.userId === userId && entry.planId === planId && entry.status === 'PENDING');
  if (!subscription) {
    const startedAt = now();
    subscription = { id: newId('subscription'), userId, planId, status: 'PENDING', currentPeriodStart: startedAt, currentPeriodEnd: null, createdAt: startedAt, updatedAt: startedAt };
    socialStore.state.subscriptions.push(subscription);
  }
  const pending = await findPendingIntent(userId, 'PLATFORM_SUBSCRIPTION', subscription.id, idempotencyKey);
  const intent = pending ?? await makeIntent(userId, 'PLATFORM_SUBSCRIPTION', subscription.id, plan.priceCents, plan.currency, { planId, interval: plan.interval }, idempotencyKey);
  let payment = socialStore.state.payments.find((entry) => entry.subscriptionId === subscription.id);
  if (!payment) {
    payment = { id: newId('payment'), subscriptionId: subscription.id, userId, provider: intent.provider, providerReference: intent.providerReference, amountCents: intent.amountCents, currency: intent.currency, status: 'PENDING', createdAt: now() };
    socialStore.state.payments.push(payment);
  }
  return { subscription, intent, payment };
}

async function applySettlement(intent: any, status: PaymentStatus, providerReference?: string) {
  const fee = platformFee(intent.amountCents);
  if (intent.purpose === 'PLATFORM_SUBSCRIPTION') {
    const subscription = socialStore.state.subscriptions.find((entry) => entry.id === intent.targetId);
    const payment = socialStore.state.payments.find((entry) => entry.subscriptionId === intent.targetId);
    if (status === 'SUCCESS' && subscription?.status === 'PENDING') {
      const start = new Date();
      const end = new Date(start);
      if (intent.metadata.interval === 'year') end.setFullYear(end.getFullYear() + 1);
      else end.setMonth(end.getMonth() + 1);
      subscription.status = 'ACTIVE';
      subscription.currentPeriodStart = start.toISOString();
      subscription.currentPeriodEnd = end.toISOString();
      subscription.updatedAt = now();
      if (payment) { payment.status = 'PAID'; payment.providerReference = providerReference ?? intent.providerReference; }
      if (!commerceStore.state.financialLedger.some((entry) => entry.idempotencyKey === `${intent.reference}:platform-subscription`)) commerceStore.state.financialLedger.push({ id: newId('ledger'), ownerId: 'platform', direction: 'CREDIT', type: 'PLATFORM_SUBSCRIPTION', amountCents: intent.amountCents, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:platform-subscription`, createdAt: now() });
    } else if (status === 'FAILED') {
      if (subscription?.status === 'PENDING') subscription.status = 'FAILED';
      if (payment) payment.status = 'FAILED';
    } else if (status === 'CANCELLED') {
      if (subscription?.status === 'PENDING') subscription.status = 'CANCELLED';
      if (payment) payment.status = 'CANCELLED';
    } else if (status === 'REFUNDED') {
      if (subscription) subscription.status = 'CANCELLED';
      if (payment) payment.status = 'REFUNDED';
    }
    return;
  }
  if (intent.purpose === 'CREATOR_SUBSCRIPTION' && status === 'SUCCESS') {
    const creatorId = intent.metadata.creatorId;
    const net = creatorNetAmount(intent);
    const creatorFee = intent.amountCents - net;
    if (await isDatabaseAvailable()) {
      await prisma.creatorSubscription.updateMany({ where: { id: intent.targetId, status: 'PENDING' }, data: { status: 'ACTIVE', providerReference, startedAt: new Date() } });
      if (!await prisma.creatorLedgerEntry.findFirst({ where: { reference: intent.reference } })) {
        await prisma.creatorLedgerEntry.create({ data: { creatorId, type: 'SUBSCRIPTION', amountCents: net, currency: intent.currency, reference: intent.reference, description: 'Creator subscription net earnings' } });
        await prisma.financialLedgerEntry.create({ data: { ownerId: creatorId, direction: 'CREDIT', type: 'CREATOR_EARNING', amountCents: net, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:creator` } });
        if (creatorFee > 0) await prisma.financialLedgerEntry.create({ data: { ownerId: 'platform', direction: 'CREDIT', type: 'PLATFORM_FEE', amountCents: creatorFee, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:fee` } });
      }
      return;
    }
    const subscription = commerceStore.state.creatorSubscriptions.find((entry) => entry.id === intent.targetId);
    if (subscription?.status === 'PENDING') {
      subscription.status = 'ACTIVE';
      subscription.providerReference = providerReference ?? null;
      subscription.startedAt = now();
      subscription.updatedAt = now();
    }
    if (!commerceStore.state.creatorLedger.some((entry) => entry.reference === intent.reference)) {
      commerceStore.state.creatorLedger.push({ id: newId('ledger'), creatorId, type: 'SUBSCRIPTION', amountCents: net, currency: intent.currency, reference: intent.reference, description: 'Creator subscription net earnings', createdAt: now() });
      commerceStore.state.financialLedger.push({ id: newId('ledger'), ownerId: creatorId, direction: 'CREDIT', type: 'CREATOR_EARNING', amountCents: net, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:creator`, createdAt: now() });
      if (creatorFee > 0) commerceStore.state.financialLedger.push({ id: newId('ledger'), ownerId: 'platform', direction: 'CREDIT', type: 'PLATFORM_FEE', amountCents: creatorFee, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:fee`, createdAt: now() });
    }
  }
  if (intent.purpose === 'MARKETPLACE_ORDER' && status === 'SUCCESS') {
    if (await isDatabaseAvailable()) {
      const order = await prisma.marketplaceOrder.findFirst({ where: { id: intent.targetId, buyerId: intent.payerId }, include: { items: true } });
      if (order && order.status !== 'CANCELLED') {
        await prisma.marketplaceOrder.updateMany({ where: { id: order.id, paymentStatus: { in: ['UNPAID', 'PENDING'] } }, data: { paymentStatus: 'PAID' } });
        const sellerId = order.items[0]?.sellerId;
        if (sellerId && !await prisma.financialLedgerEntry.findUnique({ where: { idempotencyKey: `${intent.reference}:seller` } })) {
          const net = intent.amountCents - fee;
          await prisma.financialLedgerEntry.create({ data: { ownerId: sellerId, direction: 'CREDIT', type: 'MARKETPLACE_SALE', amountCents: net, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:seller` } });
          if (fee > 0) await prisma.financialLedgerEntry.create({ data: { ownerId: 'platform', direction: 'CREDIT', type: 'PLATFORM_FEE', amountCents: fee, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:fee` } });
        }
      }
      return;
    }
    const order = commerceStore.state.orders.find((entry) => entry.id === intent.targetId && entry.buyerId === intent.payerId);
    if (order && order.status !== 'CANCELLED') {
      order.paymentStatus = 'PAID';
      order.updatedAt = now();
      const sellerId = intent.metadata.sellerId;
      if (!commerceStore.state.financialLedger.some((entry) => entry.idempotencyKey === `${intent.reference}:seller`)) {
        commerceStore.state.financialLedger.push({ id: newId('ledger'), ownerId: sellerId, direction: 'CREDIT', type: 'MARKETPLACE_SALE', amountCents: intent.amountCents - fee, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:seller`, createdAt: now() });
        if (fee > 0) commerceStore.state.financialLedger.push({ id: newId('ledger'), ownerId: 'platform', direction: 'CREDIT', type: 'PLATFORM_FEE', amountCents: fee, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:fee`, createdAt: now() });
      }
    }
  }
  if (intent.purpose === 'BUSINESS_VERIFICATION' && status === 'SUCCESS') {
    if (await isDatabaseAvailable()) {
      await prisma.businessProfile.updateMany({ where: { id: intent.targetId, ownerId: intent.payerId, verificationStatus: 'UNVERIFIED' }, data: { verificationStatus: 'PENDING' } });
      await prisma.financialLedgerEntry.create({ data: { ownerId: 'platform', direction: 'CREDIT', type: 'BUSINESS_VERIFICATION_FEE', amountCents: intent.amountCents, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:business` } });
    } else if (!commerceStore.state.financialLedger.some((entry) => entry.idempotencyKey === `${intent.reference}:business`)) {
      const business = commerceStore.state.businesses.find((entry) => entry.id === intent.targetId && entry.ownerId === intent.payerId);
      if (business?.verificationStatus === 'UNVERIFIED') business.verificationStatus = 'PENDING';
      commerceStore.state.financialLedger.push({ id: newId('ledger'), ownerId: 'platform', direction: 'CREDIT', type: 'BUSINESS_VERIFICATION_FEE', amountCents: intent.amountCents, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:business`, createdAt: now() });
    }
  }
  if (status === 'FAILED' && intent.purpose === 'MARKETPLACE_ORDER') {
    if (await isDatabaseAvailable()) await prisma.marketplaceOrder.updateMany({ where: { id: intent.targetId, buyerId: intent.payerId, paymentStatus: 'PENDING' }, data: { paymentStatus: 'FAILED' } });
    else {
      const order = commerceStore.state.orders.find((entry) => entry.id === intent.targetId && entry.buyerId === intent.payerId);
      if (order && order.paymentStatus === 'PENDING') order.paymentStatus = 'FAILED';
    }
  }
  if (status === 'REFUNDED') {
    const refund = commerceStore.state.refunds.find((entry) => entry.paymentReference === intent.reference && entry.status === 'APPROVED');
    if (!refund) return;
    const feeAmount = ['BUSINESS_VERIFICATION', 'PLATFORM_SUBSCRIPTION'].includes(intent.purpose) ? intent.amountCents : intent.purpose === 'CREATOR_SUBSCRIPTION' ? intent.amountCents - creatorNetAmount(intent) : fee;
    const netAmount = intent.amountCents - feeAmount;
    const ownerId = intent.purpose === 'CREATOR_SUBSCRIPTION' ? intent.metadata.creatorId : intent.metadata.sellerId;
    if (ownerId && netAmount > 0) commerceStore.state.financialLedger.push({ id: newId('ledger'), ownerId, direction: 'DEBIT', type: 'REFUND', amountCents: netAmount, currency: intent.currency, sourceType: 'REFUND', sourceId: refund.id, idempotencyKey: `${refund.reference}:seller`, createdAt: now() });
    if (feeAmount > 0) commerceStore.state.financialLedger.push({ id: newId('ledger'), ownerId: 'platform', direction: 'DEBIT', type: 'REFUND', amountCents: feeAmount, currency: intent.currency, sourceType: 'REFUND', sourceId: refund.id, idempotencyKey: `${refund.reference}:fee`, createdAt: now() });
    commerceStore.state.financialLedger.push({ id: newId('ledger'), ownerId: intent.payerId, direction: 'CREDIT', type: 'REFUND', amountCents: refund.amountCents, currency: intent.currency, sourceType: 'REFUND', sourceId: refund.id, idempotencyKey: `${refund.reference}:payer`, createdAt: now() });
    if (intent.purpose === 'CREATOR_SUBSCRIPTION') commerceStore.state.creatorLedger.push({ id: newId('ledger'), creatorId: intent.metadata.creatorId, type: 'SUBSCRIPTION_REFUND', amountCents: -netAmount, currency: intent.currency, reference: refund.reference, createdAt: now() });
    if (intent.purpose === 'MARKETPLACE_ORDER') {
      const order = commerceStore.state.orders.find((entry) => entry.id === intent.targetId);
      if (order) order.paymentStatus = 'REFUNDED';
    }
    refund.status = 'REFUNDED';
    refund.updatedAt = now();
  }
}

async function applyDatabaseSettlement(tx: Prisma.TransactionClient, intent: any, status: PaymentStatus, providerReference?: string) {
  const fee = platformFee(intent.amountCents);
  if (intent.purpose === 'PLATFORM_SUBSCRIPTION') {
    if (status === 'SUCCESS') {
      const start = new Date();
      const end = new Date(start);
      if (intent.metadata.interval === 'year') end.setFullYear(end.getFullYear() + 1);
      else end.setMonth(end.getMonth() + 1);
      const activated = await tx.subscription.updateMany({ where: { id: intent.targetId, userId: intent.payerId, status: 'PENDING' }, data: { status: 'ACTIVE', currentPeriodStart: start, currentPeriodEnd: end } });
      if (!activated.count) return;
      await tx.payment.updateMany({ where: { subscriptionId: intent.targetId, userId: intent.payerId, status: 'PENDING' }, data: { status: 'PAID', providerReference: providerReference ?? intent.providerReference } });
      await tx.financialLedgerEntry.create({ data: { ownerId: 'platform', direction: 'CREDIT', type: 'PLATFORM_SUBSCRIPTION', amountCents: intent.amountCents, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:platform-subscription` } });
    } else if (status === 'FAILED' || status === 'CANCELLED') {
      await tx.subscription.updateMany({ where: { id: intent.targetId, userId: intent.payerId, status: 'PENDING' }, data: { status: status === 'FAILED' ? 'FAILED' : 'CANCELLED' } });
      await tx.payment.updateMany({ where: { subscriptionId: intent.targetId, userId: intent.payerId, status: 'PENDING' }, data: { status: status === 'FAILED' ? 'FAILED' : 'REFUNDED' } });
    }
    return;
  }
  if (intent.purpose === 'CREATOR_SUBSCRIPTION' && status === 'SUCCESS') {
    const activated = await tx.creatorSubscription.updateMany({ where: { id: intent.targetId, status: 'PENDING' }, data: { status: 'ACTIVE', providerReference, startedAt: new Date() } });
    if (!activated.count) return;
    const net = creatorNetAmount(intent);
    const creatorFee = intent.amountCents - net;
    await tx.creatorLedgerEntry.create({ data: { creatorId: intent.metadata.creatorId, type: 'SUBSCRIPTION', amountCents: net, currency: intent.currency, reference: intent.reference, description: 'Creator subscription net earnings' } });
    await tx.financialLedgerEntry.create({ data: { ownerId: intent.metadata.creatorId, direction: 'CREDIT', type: 'CREATOR_EARNING', amountCents: net, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:creator` } });
    if (creatorFee > 0) await tx.financialLedgerEntry.create({ data: { ownerId: 'platform', direction: 'CREDIT', type: 'PLATFORM_FEE', amountCents: creatorFee, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:fee` } });
    return;
  }
  if (intent.purpose === 'MARKETPLACE_ORDER' && status === 'SUCCESS') {
    const order = await tx.marketplaceOrder.findFirst({ where: { id: intent.targetId, buyerId: intent.payerId }, include: { items: true } });
    if (!order || order.status === 'CANCELLED') return;
    const paid = await tx.marketplaceOrder.updateMany({ where: { id: order.id, paymentStatus: { in: ['UNPAID', 'PENDING'] } }, data: { paymentStatus: 'PAID' } });
    if (!paid.count) return;
    const sellerId = order.items[0]?.sellerId;
    if (!sellerId) return;
    const net = intent.amountCents - fee;
    await tx.financialLedgerEntry.create({ data: { ownerId: sellerId, direction: 'CREDIT', type: 'MARKETPLACE_SALE', amountCents: net, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:seller` } });
    if (fee > 0) await tx.financialLedgerEntry.create({ data: { ownerId: 'platform', direction: 'CREDIT', type: 'PLATFORM_FEE', amountCents: fee, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:fee` } });
    return;
  }
  if (intent.purpose === 'BUSINESS_VERIFICATION' && status === 'SUCCESS') {
    await tx.businessProfile.updateMany({ where: { id: intent.targetId, ownerId: intent.payerId, verificationStatus: 'UNVERIFIED' }, data: { verificationStatus: 'PENDING' } });
    await tx.financialLedgerEntry.create({ data: { ownerId: 'platform', direction: 'CREDIT', type: 'BUSINESS_VERIFICATION_FEE', amountCents: intent.amountCents, currency: intent.currency, sourceType: 'PAYMENT', sourceId: intent.reference, idempotencyKey: `${intent.reference}:business` } });
    return;
  }
  if (status === 'FAILED' && intent.purpose === 'MARKETPLACE_ORDER') {
    await tx.marketplaceOrder.updateMany({ where: { id: intent.targetId, buyerId: intent.payerId, paymentStatus: 'PENDING' }, data: { paymentStatus: 'FAILED' } });
    return;
  }
  if (status === 'REFUNDED') {
    const refund = await tx.financialRefund.findFirst({ where: { paymentReference: intent.reference, status: 'APPROVED' } });
    if (!refund) throw new Error('REFUND_NOT_APPROVED');
    const sellerOrCreatorId = intent.purpose === 'CREATOR_SUBSCRIPTION' ? intent.metadata.creatorId : intent.metadata.sellerId;
    const feeAmount = ['BUSINESS_VERIFICATION', 'PLATFORM_SUBSCRIPTION'].includes(intent.purpose) ? intent.amountCents : intent.purpose === 'CREATOR_SUBSCRIPTION' ? intent.amountCents - creatorNetAmount(intent) : fee;
    const netAmount = intent.amountCents - feeAmount;
    if (sellerOrCreatorId && netAmount > 0) {
      await tx.financialLedgerEntry.create({ data: { ownerId: sellerOrCreatorId, direction: 'DEBIT', type: 'REFUND', amountCents: netAmount, currency: intent.currency, sourceType: 'REFUND', sourceId: refund.id, idempotencyKey: `${refund.reference}:seller` } });
    }
    if (feeAmount > 0) await tx.financialLedgerEntry.create({ data: { ownerId: 'platform', direction: 'DEBIT', type: 'REFUND', amountCents: feeAmount, currency: intent.currency, sourceType: 'REFUND', sourceId: refund.id, idempotencyKey: `${refund.reference}:fee` } });
    await tx.financialLedgerEntry.create({ data: { ownerId: intent.payerId, direction: 'CREDIT', type: 'REFUND', amountCents: refund.amountCents, currency: intent.currency, sourceType: 'REFUND', sourceId: refund.id, idempotencyKey: `${refund.reference}:payer` } });
    await tx.financialRefund.update({ where: { id: refund.id }, data: { status: 'REFUNDED' } });
    if (intent.purpose === 'MARKETPLACE_ORDER') await tx.marketplaceOrder.updateMany({ where: { id: intent.targetId }, data: { paymentStatus: 'REFUNDED' } });
    if (intent.purpose === 'CREATOR_SUBSCRIPTION') await tx.creatorLedgerEntry.create({ data: { creatorId: intent.metadata.creatorId, type: 'SUBSCRIPTION_REFUND', amountCents: -netAmount, currency: intent.currency, reference: refund.reference, description: 'Creator subscription refund' } });
    if (intent.purpose === 'PLATFORM_SUBSCRIPTION') {
      await tx.subscription.updateMany({ where: { id: intent.targetId, userId: intent.payerId }, data: { status: 'CANCELLED' } });
      await tx.payment.updateMany({ where: { subscriptionId: intent.targetId, userId: intent.payerId }, data: { status: 'REFUNDED' } });
    }
  }
}

async function processWebhook(provider: string, payload: PaymentWebhookPayload, payloadHash: string) {
  if (await isDatabaseAvailable()) {
    const existingEvent = await prisma.financialWebhookEvent.findUnique({ where: { provider_providerEventId: { provider, providerEventId: payload.eventId } } });
    if (existingEvent) return existingEvent.payloadHash === payloadHash ? 'duplicate' : 'conflict';
    const intent = await prisma.paymentIntent.findUnique({ where: { reference: payload.reference } });
    if (!intent || intent.provider !== provider) return 'missing';
    if (payload.status === 'REFUNDED') {
      const eligibleRefund = await prisma.financialRefund.findFirst({ where: { paymentReference: intent.reference, status: 'APPROVED' } });
      if (!eligibleRefund) return 'unapproved_refund';
    }
    const transitioned = await prisma.$transaction(async (tx) => {
      await tx.financialWebhookEvent.create({ data: { provider, providerEventId: payload.eventId, paymentReference: payload.reference, payloadHash } });
      const accepted = await tx.paymentIntent.updateMany({ where: { id: intent.id, status: payload.status === 'REFUNDED' || payload.status === 'DISPUTED' ? 'SUCCESS' : 'PENDING' }, data: { status: payload.status, providerReference: payload.providerReference ?? intent.providerReference } });
      if (!accepted.count) {
        await tx.financialWebhookEvent.update({ where: { provider_providerEventId: { provider, providerEventId: payload.eventId } }, data: { status: 'IGNORED', processedAt: new Date() } });
        return false;
      }
      const freshIntent = { ...intent, status: payload.status, providerReference: payload.providerReference ?? intent.providerReference };
      await applyDatabaseSettlement(tx, freshIntent, payload.status, payload.providerReference);
      await tx.financialWebhookEvent.update({ where: { provider_providerEventId: { provider, providerEventId: payload.eventId } }, data: { status: 'PROCESSED', processedAt: new Date() } });
      return true;
    });
    return transitioned ? 'processed' : 'ignored';
  }
  const previous = commerceStore.state.paymentEvents.find((event) => event.provider === provider && event.eventId === payload.eventId);
  if (previous) return previous.payloadHash === payloadHash ? 'duplicate' : 'conflict';
  const intent = commerceStore.state.paymentIntents.find((entry) => entry.reference === payload.reference && entry.provider === provider);
  if (!intent) return 'missing';
  if (payload.status === 'REFUNDED' && !commerceStore.state.refunds.some((refund) => refund.paymentReference === intent.reference && refund.status === 'APPROVED')) return 'unapproved_refund';
  commerceStore.state.paymentEvents.push({ id: newId('event'), provider, eventId: payload.eventId, reference: payload.reference, payloadHash, status: 'RECEIVED', receivedAt: now() });
  const allowable = payload.status === 'REFUNDED' || payload.status === 'DISPUTED' ? intent.status === 'SUCCESS' : intent.status === 'PENDING';
  if (!allowable) {
    const event = commerceStore.state.paymentEvents.at(-1)!;
    event.status = 'IGNORED';
    event.processedAt = now();
    return 'ignored';
  }
  intent.status = payload.status;
  intent.providerReference = payload.providerReference ?? intent.providerReference;
  intent.updatedAt = now();
  await applySettlement(intent, payload.status, payload.providerReference);
  const event = commerceStore.state.paymentEvents.at(-1)!;
  event.status = 'PROCESSED';
  event.processedAt = now();
  return 'processed';
}

router.post('/payments/intents', requireAuth, async (req, res) => {
  const parsedInput = intentSchema.safeParse(req.body ?? {});
  if (!parsedInput.success) return res.status(400).json({ message: 'Invalid payment intent request.' });
  const input = parsedInput.data;
  const idempotencyKey = z.string().trim().min(8).max(120).safeParse(req.header('Idempotency-Key'));
  if (!idempotencyKey.success) return res.status(400).json({ message: 'An Idempotency-Key header is required.' });
  const payerId = req.user!.id;
  let amountCents: number;
  let currency = 'USD';
  let metadata: Record<string, string>;
  try {
    if (input.purpose === 'CREATOR_SUBSCRIPTION') {
      const creatorId = input.targetId;
      if (creatorId === payerId) return res.status(400).json({ message: 'You cannot subscribe to yourself.' });
      if (await isDatabaseAvailable()) {
        const profile = await prisma.creatorProfile.findFirst({ where: { userId: creatorId, isEnabled: true } });
        if (!profile) return res.status(404).json({ message: 'Creator is unavailable.' });
        const existing = await prisma.creatorSubscription.findUnique({ where: { creatorId_subscriberId: { creatorId, subscriberId: payerId } } });
        if (existing?.status === 'ACTIVE') return res.status(409).json({ message: 'You are already subscribed.' });
        const subscription = existing ?? await prisma.creatorSubscription.create({ data: { creatorId, subscriberId: payerId, status: 'PENDING', amountCents: profile.subscriptionPriceCents, currency: profile.currency, provider: manualPaymentProvider.name } });
        await findPendingIntent(payerId, input.purpose, subscription.id, idempotencyKey.data);
        amountCents = profile.subscriptionPriceCents;
        currency = profile.currency;
        metadata = { creatorId, subscriberId: payerId, creatorRevenueSharePercent: String(await currentCreatorRevenueSharePercent()) };
        const intent = await makeIntent(payerId, input.purpose, subscription.id, amountCents, currency, metadata, idempotencyKey.data);
        return res.status(201).json({ paymentIntent: intent });
      }
      const profile = commerceStore.state.creators.find((entry) => entry.userId === creatorId && entry.isEnabled);
      if (!profile) return res.status(404).json({ message: 'Creator is unavailable.' });
      if (commerceStore.state.creatorSubscriptions.some((entry) => entry.creatorId === creatorId && entry.subscriberId === payerId && entry.status === 'ACTIVE')) return res.status(409).json({ message: 'You are already subscribed.' });
      let subscription = commerceStore.state.creatorSubscriptions.find((entry) => entry.creatorId === creatorId && entry.subscriberId === payerId && entry.status === 'PENDING');
      if (!subscription) {
        subscription = { id: newId('creator_sub'), creatorId, subscriberId: payerId, status: 'PENDING', amountCents: profile.subscriptionPriceCents, currency: profile.currency, provider: manualPaymentProvider.name, providerReference: null, startedAt: now(), createdAt: now(), updatedAt: now() };
        commerceStore.state.creatorSubscriptions.push(subscription);
      }
      await findPendingIntent(payerId, input.purpose, subscription.id, idempotencyKey.data);
      amountCents = profile.subscriptionPriceCents;
      currency = profile.currency;
      metadata = { creatorId, subscriberId: payerId, creatorRevenueSharePercent: String(await currentCreatorRevenueSharePercent()) };
      const intent = await makeIntent(payerId, input.purpose, subscription.id, amountCents, currency, metadata, idempotencyKey.data);
      return res.status(201).json({ paymentIntent: intent });
    }

    if (input.purpose === 'PLATFORM_SUBSCRIPTION') {
      const result = await createPlatformSubscriptionIntent(payerId, input.targetId, idempotencyKey.data);
      return res.status(201).json({ subscription: result.subscription, paymentIntent: result.intent, payment: result.payment });
    }

    if (input.purpose === 'MARKETPLACE_ORDER') {
      const order = await (async () => await isDatabaseAvailable()
        ? prisma.marketplaceOrder.findFirst({ where: { id: input.targetId, buyerId: payerId }, include: { items: true } })
        : commerceStore.state.orders.find((entry) => entry.id === input.targetId && entry.buyerId === payerId))();
      if (!order) return res.status(404).json({ message: 'Order not found.' });
      if (order.status === 'CANCELLED' || order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUNDED') return res.status(409).json({ message: 'Order is not payable.' });
      const items = 'items' in order ? order.items : commerceStore.state.orderItems.filter((entry) => entry.orderId === order.id);
      const sellerId = items[0]?.sellerId;
      amountCents = order.totalCents;
      currency = order.currency;
      metadata = { sellerId: sellerId ?? '' };
      const intent = await makeIntent(payerId, input.purpose, order.id, amountCents, currency, metadata, idempotencyKey.data);
      if (await isDatabaseAvailable()) await prisma.marketplaceOrder.updateMany({ where: { id: order.id, paymentStatus: 'UNPAID' }, data: { paymentStatus: 'PENDING' } });
      else order.paymentStatus = 'PENDING';
      return res.status(201).json({ paymentIntent: intent });
    }

    const business = await (async () => await isDatabaseAvailable()
      ? prisma.businessProfile.findFirst({ where: { id: input.targetId, ownerId: payerId } })
      : commerceStore.state.businesses.find((entry) => entry.id === input.targetId && entry.ownerId === payerId))();
    if (!business) return res.status(404).json({ message: 'Business not found.' });
    if (business.verificationStatus !== 'UNVERIFIED') return res.status(409).json({ message: 'Business verification is already pending or complete.' });
    amountCents = businessVerificationFeeCents;
    currency = 'USD';
    metadata = { ownerId: payerId, businessId: business.id };
    const intent = await makeIntent(payerId, input.purpose, business.id, amountCents, currency, metadata, idempotencyKey.data);
    return res.status(201).json({ paymentIntent: intent });
  } catch (error) {
    if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') return res.status(409).json({ message: 'Idempotency key was already used for a different payment.' });
    if (error instanceof Error && error.message === 'PAYMENT_PENDING') return res.status(409).json({ message: 'A payment is already pending for this subscription.' });
    if (error instanceof Error && error.message === 'INVALID_AMOUNT') return res.status(409).json({ message: 'Payment amount must be a positive integer in minor units.' });
    if (error instanceof Error && error.message === 'PLAN_NOT_FOUND') return res.status(404).json({ message: 'Subscription plan not found or inactive.' });
    if (error instanceof Error && error.message === 'SUBSCRIPTION_ACTIVE') return res.status(409).json({ message: 'You already have an active subscription for this plan.' });
    throw error;
  }
});

router.get('/payments/me', requireAuth, async (req, res) => {
  const payerId = req.user!.id;
  const payments = await isDatabaseAvailable()
    ? await prisma.paymentIntent.findMany({ where: { payerId }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.paymentIntents.filter((entry) => entry.payerId === payerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return res.json({ payments });
});

router.post('/payments/:reference/cancel', requireAuth, async (req, res) => {
  const reference = String(req.params.reference);
  if (await isDatabaseAvailable()) {
    const intent = await prisma.paymentIntent.findFirst({ where: { reference, payerId: req.user!.id, status: 'PENDING' } });
    if (!intent) return res.status(404).json({ message: 'Pending payment not found.' });
    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.paymentIntent.updateMany({ where: { id: intent.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      if (!claimed.count) return null;
      if (intent.purpose === 'MARKETPLACE_ORDER') await tx.marketplaceOrder.updateMany({ where: { id: intent.targetId!, buyerId: req.user!.id, paymentStatus: 'PENDING' }, data: { paymentStatus: 'CANCELLED' } });
      if (intent.purpose === 'CREATOR_SUBSCRIPTION') await tx.creatorSubscription.updateMany({ where: { id: intent.targetId!, subscriberId: req.user!.id, status: 'PENDING' }, data: { status: 'CANCELLED', endsAt: new Date() } });
      if (intent.purpose === 'PLATFORM_SUBSCRIPTION') {
        await tx.subscription.updateMany({ where: { id: intent.targetId!, userId: req.user!.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
        await tx.payment.updateMany({ where: { subscriptionId: intent.targetId!, userId: req.user!.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      }
      return tx.paymentIntent.findUnique({ where: { id: intent.id } });
    });
    if (!updated) return res.status(409).json({ message: 'Payment has already been updated.' });
    await audit(req.user!.id, req.user!.id, 'PAYMENT_INTENT_CANCELLED', reference);
    return res.json({ payment: updated });
  }
  const intent = commerceStore.state.paymentIntents.find((entry) => entry.reference === reference && entry.payerId === req.user!.id && entry.status === 'PENDING');
  if (!intent) return res.status(404).json({ message: 'Pending payment not found.' });
  intent.status = 'CANCELLED';
  intent.updatedAt = now();
  if (intent.purpose === 'MARKETPLACE_ORDER') {
    const order = commerceStore.state.orders.find((entry) => entry.id === intent.targetId && entry.buyerId === req.user!.id);
    if (order && order.paymentStatus === 'PENDING') order.paymentStatus = 'CANCELLED';
  }
  if (intent.purpose === 'CREATOR_SUBSCRIPTION') {
    const subscription = commerceStore.state.creatorSubscriptions.find((entry) => entry.id === intent.targetId && entry.subscriberId === req.user!.id);
    if (subscription?.status === 'PENDING') subscription.status = 'CANCELLED';
  }
  if (intent.purpose === 'PLATFORM_SUBSCRIPTION') {
    const subscription = socialStore.state.subscriptions.find((entry) => entry.id === intent.targetId && entry.userId === req.user!.id);
    if (subscription?.status === 'PENDING') subscription.status = 'CANCELLED';
    const payment = socialStore.state.payments.find((entry) => entry.subscriptionId === intent.targetId && entry.userId === req.user!.id);
    if (payment?.status === 'PENDING') payment.status = 'CANCELLED';
  }
  await audit(req.user!.id, req.user!.id, 'PAYMENT_INTENT_CANCELLED', reference);
  return res.json({ payment: intent });
});

router.get('/payments/:reference', requireAuth, async (req, res) => {
  const reference = String(req.params.reference);
  const intent = await isDatabaseAvailable()
    ? await prisma.paymentIntent.findUnique({ where: { reference } })
    : commerceStore.state.paymentIntents.find((entry) => entry.reference === reference) ?? null;
  if (!intent || !ownerCanSeeIntent(intent, req.user!.id)) return res.status(404).json({ message: 'Payment not found.' });
  return res.json({ payment: intent });
});

router.post('/payments/webhooks/:provider', async (req, res) => {
  const payload = webhookSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ message: 'Invalid payment webhook payload.' });
  const provider = String(req.params.provider);
  const signature = String(req.header('x-payment-signature') ?? '');
  if (!hmacPaymentWebhookVerifier.verify(provider, payload.data, signature)) return res.status(401).json({ message: 'Invalid payment webhook signature.' });
  const payloadHash = createHash('sha256').update(JSON.stringify(payload.data)).digest('hex');
  const result = await processWebhook(provider, payload.data, payloadHash);
  if (result === 'conflict') return res.status(409).json({ message: 'Webhook event ID was already used with a different payload.' });
  if (result === 'missing') return res.status(404).json({ message: 'Payment intent not found.' });
  if (result === 'unapproved_refund') return res.status(409).json({ message: 'Refund has not been approved.' });
  if (result === 'processed') {
    const intent = await isDatabaseAvailable()
      ? await prisma.paymentIntent.findUnique({ where: { reference: payload.data.reference } })
      : commerceStore.state.paymentIntents.find((entry) => entry.reference === payload.data.reference);
    if (intent) await audit(intent.payerId, intent.metadata?.creatorId ?? intent.metadata?.sellerId ?? intent.metadata?.ownerId ?? null, `PAYMENT_${payload.data.status}`, `${intent.reference}:${payload.data.eventId}`);
  }
  return res.json({ received: true, duplicate: result === 'duplicate' });
});

router.get('/marketplace/seller/transactions', requireAuth, async (req, res) => {
  const sellerId = req.user!.id;
  const entries = await isDatabaseAvailable()
    ? await prisma.financialLedgerEntry.findMany({ where: { ownerId: sellerId, type: 'MARKETPLACE_SALE' }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.financialLedger.filter((entry) => entry.ownerId === sellerId && entry.type === 'MARKETPLACE_SALE').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return res.json({ transactions: entries });
});

router.get('/businesses/:id/transactions', requireAuth, async (req, res) => {
  const businessId = String(req.params.id);
  const business = await (async () => await isDatabaseAvailable()
    ? prisma.businessProfile.findFirst({ where: { id: businessId, ownerId: req.user!.id } })
    : commerceStore.state.businesses.find((entry) => entry.id === businessId && entry.ownerId === req.user!.id))();
  if (!business) return res.status(404).json({ message: 'Business not found.' });
  const transactions = await isDatabaseAvailable()
    ? await prisma.paymentIntent.findMany({ where: { purpose: 'BUSINESS_VERIFICATION', targetId: businessId }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.paymentIntents.filter((entry) => entry.purpose === 'BUSINESS_VERIFICATION' && entry.targetId === businessId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return res.json({ transactions });
});

router.post('/payments/:reference/refunds', requireAuth, async (req, res) => {
  const reference = String(req.params.reference);
  const reason = z.string().trim().min(5).max(1000).safeParse(req.body?.reason);
  if (!reason.success) return res.status(400).json({ message: 'A refund reason of at least 5 characters is required.' });
  const intent = await isDatabaseAvailable()
    ? await prisma.paymentIntent.findUnique({ where: { reference } })
    : commerceStore.state.paymentIntents.find((entry) => entry.reference === reference) ?? null;
  if (!intent || intent.payerId !== req.user!.id || intent.status !== 'SUCCESS') return res.status(404).json({ message: 'Eligible payment not found.' });
  const refund = { id: newId('refund'), paymentReference: reference, requestorId: req.user!.id, reference: newId('refundref'), amountCents: intent.amountCents, currency: intent.currency, reason: reason.data, status: 'PENDING', createdAt: now(), updatedAt: now() };
  if (await isDatabaseAvailable()) {
    try {
      return res.status(201).json({ refund: await prisma.financialRefund.create({ data: refund }) });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ message: 'A refund has already been requested for this payment.' });
      throw error;
    }
  }
  if (commerceStore.state.refunds.some((entry) => entry.paymentReference === reference && entry.requestorId === req.user!.id)) return res.status(409).json({ message: 'A refund has already been requested for this payment.' });
  commerceStore.state.refunds.push(refund);
  await audit(req.user!.id, intent.payerId, 'PAYMENT_REFUND_REQUESTED', refund.id);
  return res.status(201).json({ refund });
});

router.post('/payments/:reference/disputes', requireAuth, async (req, res) => {
  const reference = String(req.params.reference);
  const reason = z.string().trim().min(5).max(2000).safeParse(req.body?.reason);
  if (!reason.success) return res.status(400).json({ message: 'A dispute reason of at least 5 characters is required.' });
  const intent = await isDatabaseAvailable()
    ? await prisma.paymentIntent.findUnique({ where: { reference } })
    : commerceStore.state.paymentIntents.find((entry) => entry.reference === reference) ?? null;
  if (!intent || !ownerCanSeeIntent(intent, req.user!.id)) return res.status(404).json({ message: 'Payment not found.' });
  const dispute = { id: newId('dispute'), paymentReference: reference, reporterId: req.user!.id, status: 'OPEN', reason: reason.data, notes: null, evidenceReference: null, createdAt: now(), updatedAt: now() };
  if (await isDatabaseAvailable()) return res.status(201).json({ dispute: await prisma.financialDispute.create({ data: dispute }) });
  commerceStore.state.financialDisputes.push(dispute);
  await audit(req.user!.id, intent.payerId, 'PAYMENT_DISPUTE_OPENED', dispute.id);
  return res.status(201).json({ dispute });
});

const admin = [requireAuth, requireActiveAccountIfAuthenticated, requireRole(['ADMIN', 'SUPER_ADMIN'])] as const;
router.get('/admin/finance/dashboard', ...admin, async (_req, res) => {
  const payments = await isDatabaseAvailable() ? await prisma.paymentIntent.findMany() : commerceStore.state.paymentIntents;
  const ledger = await isDatabaseAvailable() ? await prisma.financialLedgerEntry.findMany() : commerceStore.state.financialLedger;
  const creatorLedger = await isDatabaseAvailable() ? await prisma.creatorLedgerEntry.findMany() : commerceStore.state.creatorLedger;
  const payouts = await isDatabaseAvailable() ? await prisma.creatorPayoutRequest.findMany({ orderBy: { requestedAt: 'desc' } }) : commerceStore.state.creatorPayouts;
  const refunds = await isDatabaseAvailable() ? await prisma.financialRefund.findMany({ orderBy: { createdAt: 'desc' } }) : commerceStore.state.refunds;
  const disputes = await isDatabaseAvailable() ? await prisma.financialDispute.findMany({ orderBy: { createdAt: 'desc' } }) : commerceStore.state.financialDisputes;
  const successful = payments.filter((payment: any) => payment.status === 'SUCCESS');
  const grossRevenueCents = successful.reduce((sum: number, payment: any) => sum + payment.amountCents, 0);
  const platformFeesCents = ledger.filter((entry: any) => entry.ownerId === 'platform').reduce((sum: number, entry: any) => sum + (entry.direction === 'CREDIT' ? entry.amountCents : -entry.amountCents), 0);
  const creatorEarningsCents = creatorLedger.reduce((sum: number, entry: any) => sum + entry.amountCents, 0);
  const pendingPayoutsCents = payouts.filter((entry: any) => ['PENDING', 'APPROVED', 'PROCESSING'].includes(entry.status)).reduce((sum: number, entry: any) => sum + entry.amountCents, 0);
  return res.json({ summary: { grossRevenueCents, platformFeesCents, creatorEarningsCents, pendingPayoutsCents, successfulPayments: successful.length, pendingPayments: payments.filter((entry: any) => entry.status === 'PENDING').length, pendingRefunds: refunds.filter((entry: any) => entry.status === 'PENDING').length, openDisputes: disputes.filter((entry: any) => ['OPEN', 'REVIEWING'].includes(entry.status)).length }, payments, refunds, disputes, payouts, ledger });
});

router.get('/admin/finance/transactions', ...admin, async (req, res) => {
  const search = String(req.query.search ?? '').trim().toLowerCase();
  const status = String(req.query.status ?? '');
  const payments = await isDatabaseAvailable() ? await prisma.paymentIntent.findMany({ orderBy: { createdAt: 'desc' } }) : [...commerceStore.state.paymentIntents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const filtered = payments.filter((payment: any) => (!status || payment.status === status) && (!search || [payment.reference, payment.providerReference, payment.payerId, payment.purpose].some((value) => String(value ?? '').toLowerCase().includes(search))));
  return res.json({ payments: filtered });
});

router.get('/admin/finance/refunds', ...admin, async (_req, res) => {
  const refunds = await isDatabaseAvailable() ? await prisma.financialRefund.findMany({ orderBy: { createdAt: 'desc' } }) : commerceStore.state.refunds;
  return res.json({ refunds });
});

router.get('/admin/finance/payouts', ...admin, async (_req, res) => {
  const payouts = await isDatabaseAvailable() ? await prisma.creatorPayoutRequest.findMany({ orderBy: { requestedAt: 'desc' } }) : commerceStore.state.creatorPayouts;
  return res.json({ payouts });
});

router.patch('/admin/finance/refunds/:id', ...admin, async (req, res) => {
  const decision = z.object({ status: z.enum(['APPROVED', 'REJECTED']), reason: z.string().trim().min(5).max(1000) }).safeParse(req.body);
  if (!decision.success) return res.status(400).json({ message: 'Refund review requires APPROVED or REJECTED and a reason.' });
  const refundId = String(req.params.id);
  if (await isDatabaseAvailable()) {
    const refund = await prisma.financialRefund.findUnique({ where: { id: refundId } });
    if (!refund) return res.status(404).json({ message: 'Refund not found.' });
    if (refund.status !== 'PENDING') return res.status(409).json({ message: 'Refund has already been reviewed.' });
    const updated = await prisma.financialRefund.update({ where: { id: refundId }, data: { status: decision.data.status, reviewedBy: req.user!.id, reviewedAt: new Date(), reviewReason: decision.data.reason } });
    await audit(req.user!.id, refund.requestorId, 'PAYMENT_REFUND_REVIEWED', `${refund.id}:${decision.data.status}`);
    return res.json({ refund: updated });
  }
  const refund = commerceStore.state.refunds.find((entry) => entry.id === refundId);
  if (!refund) return res.status(404).json({ message: 'Refund not found.' });
  if (refund.status !== 'PENDING') return res.status(409).json({ message: 'Refund has already been reviewed.' });
  Object.assign(refund, { status: decision.data.status, reviewedBy: req.user!.id, reviewedAt: now(), reviewReason: decision.data.reason, updatedAt: now() });
  await audit(req.user!.id, refund.requestorId, 'PAYMENT_REFUND_REVIEWED', `${refund.id}:${decision.data.status}`);
  return res.json({ refund });
});

router.get('/admin/finance/disputes', ...admin, async (_req, res) => {
  const disputes = await isDatabaseAvailable() ? await prisma.financialDispute.findMany({ orderBy: { createdAt: 'desc' } }) : commerceStore.state.financialDisputes;
  return res.json({ disputes });
});

router.patch('/admin/finance/disputes/:id', ...admin, async (req, res) => {
  const payload = z.object({ status: z.enum(['REVIEWING', 'RESOLVED', 'REJECTED']), notes: z.string().trim().max(2000).optional(), evidenceReference: z.string().trim().max(500).optional() }).safeParse(req.body);
  if (!payload.success) return res.status(400).json({ message: 'Invalid dispute update.' });
  const disputeId = String(req.params.id);
  if (await isDatabaseAvailable()) {
    const dispute = await prisma.financialDispute.findUnique({ where: { id: disputeId } });
    if (!dispute) return res.status(404).json({ message: 'Dispute not found.' });
    const updated = await prisma.financialDispute.update({ where: { id: disputeId }, data: { ...payload.data } });
    await audit(req.user!.id, dispute.reporterId, 'PAYMENT_DISPUTE_REVIEWED', `${dispute.id}:${payload.data.status}`);
    return res.json({ dispute: updated });
  }
  const dispute = commerceStore.state.financialDisputes.find((entry) => entry.id === disputeId);
  if (!dispute) return res.status(404).json({ message: 'Dispute not found.' });
  Object.assign(dispute, payload.data, { updatedAt: now() });
  await audit(req.user!.id, dispute.reporterId, 'PAYMENT_DISPUTE_REVIEWED', `${dispute.id}:${payload.data.status}`);
  return res.json({ dispute });
});

router.get('/admin/finance/ledger', ...admin, async (_req, res) => {
  const entries = await isDatabaseAvailable() ? await prisma.financialLedgerEntry.findMany({ orderBy: { createdAt: 'desc' } }) : commerceStore.state.financialLedger;
  return res.json({ entries });
});

export { router as paymentsRouter };
