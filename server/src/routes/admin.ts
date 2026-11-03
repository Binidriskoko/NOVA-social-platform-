import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { commerceStore } from '../lib/commerceStore.js';
import { socialStore } from '../lib/socialStore.js';
import { requireAuth, requireActiveAccountIfAuthenticated, requireAdminAccess, requireModeratorAccess } from '../middleware/auth.js';

const adminRouter = Router();
const adminRoles = new Set(['ADMIN', 'SUPER_ADMIN']);

const reportDecisionSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  reason: z.string().trim().max(1000).optional(),
});

function parsePagination(req: any) {
  const rawPage = Number(req.query.page ?? 1);
  const rawLimit = Number(req.query.limit ?? 20);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 20;
  return { page, limit, skip: (page - 1) * limit };
}

async function trackAdminAction(actorId: string, targetUserId: string | null, actionType: string, details: string | null) {
  if (await isDatabaseAvailable()) {
    await prisma.adminAction.create({
      data: {
        actorId,
        targetUserId,
        actionType,
        details,
      },
    });
    return;
  }

  fallbackStore.createAdminAction({
    actorId,
    targetUserId,
    actionType,
    details,
  });
}

function normalizeUser(user: any) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role ?? 'USER',
    status: user.status ?? 'ACTIVE',
    createdAt: user.createdAt ?? user.created_at ?? null,
    updatedAt: user.updatedAt ?? user.updated_at ?? null,
    communityRulesAccepted: Boolean(user.communityRulesAccepted ?? user.community_rules_accepted ?? true),
  };
}

async function getUsers() {
  if (await isDatabaseAvailable()) {
    return prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        communityRulesAccepted: true,
        profile: { select: { displayName: true, username: true, bio: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  return fallbackStore.list().map((user) => ({
    ...user,
    profile: null,
  }));
}

function getReportStatusValue(status: string | null | undefined) {
  return status ?? 'OPEN';
}

async function loadReports() {
  if (await isDatabaseAvailable()) {
    return prisma.report.findMany({
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        post: { select: { id: true, content: true, moderationHiddenAt: true, moderationHiddenById: true, moderationReason: true } },
        comment: { select: { id: true, content: true, moderationHiddenAt: true, moderationHiddenById: true, moderationReason: true } },
        message: { select: { id: true, text: true, senderId: true, moderationHiddenAt: true, moderationHiddenById: true, moderationReason: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  return socialStore.state.reports.map((report) => ({
    id: report.id,
    reporterId: report.reporterId,
    postId: report.targetType === 'post' ? report.targetId : null,
    commentId: report.targetType === 'comment' ? report.targetId : null,
    messageId: report.targetType === 'message' ? report.targetId : null,
    category: report.category,
    details: report.reason,
    status: getReportStatusValue(report.status),
    createdAt: report.createdAt,
    resolvedAt: report.resolvedAt ?? null,
    reporter: fallbackStore.findById(report.reporterId) ? {
      id: fallbackStore.findById(report.reporterId)!.id,
      name: fallbackStore.findById(report.reporterId)!.name,
      email: fallbackStore.findById(report.reporterId)!.email,
    } : null,
    post: report.targetType === 'post'
      ? (() => {
          const post = socialStore.state.posts.find((entry) => entry.id === report.targetId);
          return post ? { id: post.id, content: post.content, moderationHiddenAt: post.moderationHiddenAt ?? null, moderationHiddenById: post.moderationHiddenById ?? null, moderationReason: post.moderationReason ?? null } : null;
        })()
      : null,
    comment: report.targetType === 'comment'
      ? (() => {
          const comment = socialStore.state.comments.find((entry) => entry.id === report.targetId);
          return comment ? { id: comment.id, content: comment.content, moderationHiddenAt: comment.moderationHiddenAt ?? null, moderationHiddenById: comment.moderationHiddenById ?? null, moderationReason: comment.moderationReason ?? null } : null;
        })()
      : null,
    message: report.targetType === 'message'
      ? (() => {
          const message = socialStore.state.messages.find((entry) => entry.id === report.targetId);
          return message ? { id: message.id, text: message.text, senderId: message.senderId, moderationHiddenAt: message.moderationHiddenAt ?? null, moderationHiddenById: message.moderationHiddenById ?? null, moderationReason: message.moderationReason ?? null } : null;
        })()
      : null,
  }));
}

async function loadSubscriptions() {
  if (await isDatabaseAvailable()) {
    return prisma.subscription.findMany({
      include: { plan: true, user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  return socialStore.state.subscriptions.map((subscription) => {
    const plan = socialStore.state.subscriptionPlans.find((entry) => entry.id === subscription.planId) ?? null;
    const user = fallbackStore.findById(subscription.userId) ?? null;
    return {
      id: subscription.id,
      userId: subscription.userId,
      planId: subscription.planId,
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
      user,
      plan,
    };
  });
}

async function loadPayments() {
  if (await isDatabaseAvailable()) {
    return prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
      include: { subscription: true },
    });
  }

  return socialStore.state.payments.map((payment) => ({
    id: payment.id,
    userId: payment.userId,
    subscriptionId: payment.subscriptionId,
    provider: payment.provider,
    providerReference: payment.providerReference,
    amountCents: payment.amountCents,
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt,
    subscription: socialStore.state.subscriptions.find((entry) => entry.id === payment.subscriptionId) ?? null,
  }));
}

type RevenuePayment = {
  status: string;
  provider?: string | null;
  providerReference?: string | null;
  amountCents: number;
};

function isSuccessfulRevenuePayment(value: unknown): value is RevenuePayment {
  if (typeof value !== 'object' || value === null || !('status' in value) || !('amountCents' in value)) return false;
  if (typeof value.status !== 'string' || !['SUCCESS', 'PAID'].includes(value.status) || typeof value.amountCents !== 'number') return false;
  if ('provider' in value && value.provider !== undefined && value.provider !== null && typeof value.provider !== 'string') return false;
  return !('providerReference' in value) || value.providerReference === undefined || value.providerReference === null || typeof value.providerReference === 'string';
}

function uniqueSuccessfulPayments(payments: unknown[]) {
  const seenProviderReferences = new Set<string>();
  return payments.filter(isSuccessfulRevenuePayment).filter((payment) => {
    if (!payment.providerReference) return true;

    const reference = `${payment.provider ?? 'unknown'}:${payment.providerReference}`;
    if (seenProviderReferences.has(reference)) return false;
    seenProviderReferences.add(reference);
    return true;
  });
}

async function loadAppeals() {
  if (await isDatabaseAvailable()) {
    return prisma.appeal.findMany({
      include: {
        user: { select: { id: true, name: true, email: true } },
        reviewer: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  return fallbackStore.listAppeals().map((appeal) => ({
    id: appeal.id,
    userId: appeal.userId,
    originalAction: appeal.originalAction,
    reason: appeal.reason,
    status: appeal.status,
    reviewerId: appeal.reviewerId,
    reviewerNote: appeal.reviewerNote,
    createdAt: appeal.createdAt,
    reviewedAt: appeal.reviewedAt,
    user: fallbackStore.findById(appeal.userId) ? {
      id: fallbackStore.findById(appeal.userId)!.id,
      name: fallbackStore.findById(appeal.userId)!.name,
      email: fallbackStore.findById(appeal.userId)!.email,
    } : null,
  }));
}

adminRouter.use(requireAuth, requireActiveAccountIfAuthenticated);

adminRouter.get('/dashboard', requireAdminAccess, async (req, res) => {
  const users = await getUsers();
  const reports = await loadReports();
  const subscriptions = await loadSubscriptions();
  const payments = await loadPayments();
  const databaseAvailable = await isDatabaseAvailable();
  const [creatorLedger, financialLedger, creatorPayouts, paymentIntents] = await Promise.all([
    databaseAvailable ? prisma.creatorLedgerEntry.findMany({ select: { amountCents: true } }) : Promise.resolve(commerceStore.state.creatorLedger),
    databaseAvailable ? prisma.financialLedgerEntry.findMany({ select: { ownerId: true, direction: true, amountCents: true } }) : Promise.resolve(commerceStore.state.financialLedger),
    databaseAvailable ? prisma.creatorPayoutRequest.findMany({ select: { status: true, amountCents: true } }) : Promise.resolve(commerceStore.state.creatorPayouts),
    databaseAvailable
      ? prisma.paymentIntent.findMany({ where: { status: 'SUCCESS' }, select: { status: true, provider: true, providerReference: true, amountCents: true, purpose: true } })
      : Promise.resolve(commerceStore.state.paymentIntents),
  ]);
  const adminActions = await (async () => {
    if (await isDatabaseAvailable()) {
      return prisma.adminAction.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
    }

    return fallbackStore.listAdminActions().slice(0, 10);
  })();

  const totalUsers = users.length;
  const activeUsers = users.filter((user: any) => user.status === 'ACTIVE').length;
  const newUsers = users.filter((user: any) => {
    const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : Date.now();
    return createdAt >= Date.now() - 1000 * 60 * 60 * 24 * 30;
  }).length;
  const suspendedUsers = users.filter((user: any) => user.status === 'SUSPENDED').length;
  const bannedUsers = users.filter((user: any) => user.status === 'BANNED').length;
  const totalPosts = (await (async () => {
    if (await isDatabaseAvailable()) return prisma.post.count();
    return socialStore.state.posts.length;
  })());
  const pendingReports = reports.filter((report: any) => report.status === 'OPEN' || report.status === 'REVIEWING').length;
  const resolvedReports = reports.filter((report: any) => report.status === 'RESOLVED').length;
  const pendingModerationItems = reports.filter((report: any) => (report.status ?? 'OPEN') !== 'RESOLVED' && (report.status ?? 'OPEN') !== 'REJECTED').length;

  const successfulPayments = uniqueSuccessfulPayments([...payments, ...paymentIntents]);
  const grossRevenue = successfulPayments.reduce((sum: number, payment: any) => sum + Number(payment.amountCents ?? 0), 0);
  const subscriptionPayments = uniqueSuccessfulPayments([
    ...payments,
    ...paymentIntents.filter((payment) => ['CREATOR_SUBSCRIPTION', 'PLATFORM_SUBSCRIPTION'].includes(payment.purpose)),
  ]);
  const platformRevenue = financialLedger.filter((entry) => entry.ownerId === 'platform' && entry.direction === 'CREDIT').reduce((sum, entry) => sum + Number(entry.amountCents), 0);
  const creatorNetEarnings = creatorLedger.filter((entry) => ['SUBSCRIPTION', 'SUBSCRIPTION_REFUND'].includes(entry.type)).reduce((sum, entry) => sum + Number(entry.amountCents), 0);
  const pendingPayouts = creatorPayouts.filter((payout) => ['PENDING', 'APPROVED', 'PROCESSING'].includes(payout.status)).reduce((sum, payout) => sum + Number(payout.amountCents), 0);
  const activeSubscriptions = subscriptions.filter((subscription: any) => ['ACTIVE', 'TRIALING'].includes(subscription.status)).length;
  const subscriptionRevenue = subscriptionPayments.reduce((sum, payment) => sum + Number(payment.amountCents ?? 0), 0);

  return res.json({
    metrics: {
      totalUsers,
      activeUsers,
      newUsers,
      suspendedUsers,
      bannedUsers,
      totalPosts,
      reportsReceived: reports.length,
      pendingReports,
      pendingModerationItems,
      resolvedReports,
      activeSubscriptions,
      subscriptionRevenue,
      creatorEarnings: creatorNetEarnings,
      platformRevenue,
      pendingPayouts,
      totalReports: reports.length,
    },
    recentReports: reports.slice(0, 6),
    recentModerationActions: adminActions.slice(0, 6),
    subscriptionSummary: { active: activeSubscriptions, total: subscriptions.length },
    revenueSummary: {
      grossRevenue,
      platformRevenue,
      creatorNetEarnings,
      pendingPayouts,
    },
    recentAdminActivity: adminActions.slice(0, 6),
  });
});

adminRouter.get('/users', requireAdminAccess, async (req, res) => {
  const { page, limit, skip } = parsePagination(req);
  const users = await getUsers();

  const filtered = users
    .filter((user: any) => !req.query.role || user.role === req.query.role)
    .filter((user: any) => !req.query.status || user.status === req.query.status)
    .filter((user: any) => {
      const search = String(req.query.search ?? '').trim().toLowerCase();
      if (!search) return true;
      return [user.email, user.name].some((value) => String(value ?? '').toLowerCase().includes(search));
    });

  const paginated = filtered.slice(skip, skip + limit);

  return res.json({
    users: paginated.map(normalizeUser),
    pagination: {
      page,
      limit,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
    },
  });
});

adminRouter.get('/users/:id', requireAdminAccess, async (req, res) => {
  const targetId = String(req.params.id);
  const user = await (async () => {
    if (process.env.NODE_ENV !== "production") return fallbackStore.findById(targetId);
    if (await isDatabaseAvailable()) return prisma.user.findUnique({ where: { id: targetId }, select: { id: true, status: true, name: true, email: true, role: true } });
    return null;
  })();

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const reports = (await loadReports()).filter((report: any) => report.reporterId === user.id || report.postId || report.commentId);
  return res.json({ user: normalizeUser(user), reports, moderationHistory: reports });
});

async function updateUserStatus(
  targetId: string,
  newStatus: string,
  reason: string,
  actor: { id: string; role: string }
) {
  const user = await (async () => {
    if (process.env.NODE_ENV !== 'production') {
      return fallbackStore.findById(targetId);
    }

    if (!(await isDatabaseAvailable())) {
      return null;
    }

    return prisma.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        status: true,
        name: true,
        email: true,
        role: true,
      },
    });
  })();

  if (!user) return null;

  const previousStatus = user.status ?? 'ACTIVE';

  if (await isDatabaseAvailable()) {
    const updated = await prisma.user.update({
      where: { id: targetId },
      data: { status: newStatus as any },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        role: true,
      },
    });

    await trackAdminAction(
      actor.id,
      targetId,
      `USER_${newStatus}`,
      reason
    );

    return {
      user: normalizeUser(updated),
      previousStatus,
      message: `User was ${newStatus.toLowerCase()}.`,
    };
  }

  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  const updated = fallbackStore.updateUser(targetId, {
    status: newStatus as any,
  });

  fallbackStore.createAdminAction({
    actorId: actor.id,
    targetUserId: targetId,
    actionType: `USER_${newStatus}`,
    details: reason,
  });

  if (!updated) return null;

  return {
    user: normalizeUser(updated),
    previousStatus,
    message: `User was ${newStatus.toLowerCase()}.`,
  };
}

adminRouter.post('/users/:id/suspend', requireAdminAccess, async (req, res) => {
  if (!adminRoles.has(req.user!.role)) {
    return res.status(403).json({ message: 'Only administrators can suspend users.' });
  }

  const reason = z.string().trim().min(1).max(1000).parse(req.body?.reason ?? 'Account suspended by administrator.');
  const targetId = String(req.params.id);
  const result = await updateUserStatus(targetId, 'SUSPENDED', reason, req.user!);

  if (!result) {
    return res.status(404).json({ message: 'User not found.' });
  }

  return res.json({
    user: result.user,
    previousStatus: result.previousStatus,
    message: `User ${result.user.name} was suspended.`,
  });
});

adminRouter.post('/users/:id/ban', requireAdminAccess, async (req, res) => {
  if (!adminRoles.has(req.user!.role)) {
    return res.status(403).json({ message: 'Only administrators can ban users.' });
  }

  const reason = z.string().trim().min(1).max(1000).parse(req.body?.reason ?? 'Account banned by administrator.');
  const targetId = String(req.params.id);
  const result = await updateUserStatus(targetId, 'BANNED', reason, req.user!);

  if (!result) {
    return res.status(404).json({ message: 'User not found.' });
  }

  return res.json({
    user: result.user,
    previousStatus: result.previousStatus,
    message: `User ${result.user.name} was banned.`,
  });
});

adminRouter.post('/users/:id/unban', requireAdminAccess, async (req, res) => {
  if (!adminRoles.has(req.user!.role)) {
    return res.status(403).json({ message: 'Only administrators can unban users.' });
  }

  const reason = z.string().trim().min(1).max(1000).parse(req.body?.reason ?? 'Account restored by administrator.');
  const result = await updateUserStatus(String(req.params.id), 'ACTIVE', reason, req.user!);
  if (!result) return res.status(404).json({ message: 'User not found.' });
  return res.json({ user: result.user, previousStatus: result.previousStatus, message: `User ${result.user.name} was unbanned.` });
});

adminRouter.post('/users/:id/unsuspend', requireAdminAccess, async (req, res) => {
  if (!adminRoles.has(req.user!.role)) {
    return res.status(403).json({ message: 'Only administrators can unsuspend users.' });
  }

  const reason = z.string().trim().min(1).max(1000).parse(req.body?.reason ?? 'Account restored by administrator.');
  const result = await updateUserStatus(String(req.params.id), 'ACTIVE', reason, req.user!);
  if (!result) return res.status(404).json({ message: 'User not found.' });
  return res.json({ user: result.user, previousStatus: result.previousStatus, message: `User ${result.user.name} was unsuspended.` });
});

adminRouter.get('/reports', requireAdminAccess, async (req, res) => {
  const { page, limit, skip } = parsePagination(req);
  const reports = (await loadReports()).filter((report: any) => !req.query.status || report.status === req.query.status);
  const paginated = reports.slice(skip, skip + limit);
  return res.json({
    reports: paginated,
    pagination: { page, limit, total: reports.length, totalPages: Math.max(1, Math.ceil(reports.length / limit)) },
  });
});

adminRouter.get('/reports/:id', requireAdminAccess, async (req, res) => {
  const report = (await loadReports()).find((entry: any) => entry.id === req.params.id);
  if (!report) return res.status(404).json({ message: 'Report not found.' });
  return res.json({ report });
});

adminRouter.post('/reports/:id/resolve', requireAdminAccess, async (req, res) => {
  const payload = reportDecisionSchema.parse(req.body ?? {});
  const reports = await loadReports();
  const reportId = String(req.params.id);
  const report = reports.find((entry: any) => entry.id === reportId);
  if (!report) return res.status(404).json({ message: 'Report not found.' });

  if (await isDatabaseAvailable()) {
    const updated = await prisma.report.update({
      where: { id: reportId },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
    await trackAdminAction(req.user!.id, report.reporterId, 'REPORT_RESOLVED', payload.note ?? payload.reason ?? 'Report resolved.');
    return res.json({ report: updated, message: 'Report resolved.' });
  }

  const target = socialStore.state.reports.find((entry) => entry.id === reportId);
  if (target) {
    target.status = 'RESOLVED';
    target.resolvedAt = new Date().toISOString();
  }
  report.status = 'RESOLVED';
  report.resolvedAt = target?.resolvedAt ?? new Date().toISOString();
  await trackAdminAction(req.user!.id, report.reporterId, 'REPORT_RESOLVED', payload.note ?? payload.reason ?? 'Report resolved.');
  return res.json({ report, message: 'Report resolved.' });
});

adminRouter.post('/reports/:id/reject', requireAdminAccess, async (req, res) => {
  const payload = reportDecisionSchema.parse(req.body ?? {});
  const reports = await loadReports();
  const reportId = String(req.params.id);
  const report = reports.find((entry: any) => entry.id === reportId);
  if (!report) return res.status(404).json({ message: 'Report not found.' });

  if (await isDatabaseAvailable()) {
    const updated = await prisma.report.update({
      where: { id: reportId },
      data: { status: 'REJECTED', resolvedAt: new Date() },
    });
    await trackAdminAction(req.user!.id, report.reporterId, 'REPORT_REJECTED', payload.note ?? payload.reason ?? 'Report rejected.');
    return res.json({ report: updated, message: 'Report rejected.' });
  }

  const target = socialStore.state.reports.find((entry) => entry.id === reportId);
  const resolvedAt = new Date().toISOString();
  if (target) {
    target.status = 'REJECTED';
    target.resolvedAt = resolvedAt;
  }
  report.status = 'REJECTED';
  report.resolvedAt = resolvedAt;
  await trackAdminAction(req.user!.id, report.reporterId, 'REPORT_REJECTED', payload.note ?? payload.reason ?? 'Report rejected.');
  return res.json({ report, message: 'Report rejected.' });
});

adminRouter.get('/moderation/queue', requireModeratorAccess, async (_req, res) => {
  const reports = (await loadReports()).filter((report: any) => (report.status ?? 'OPEN') !== 'RESOLVED' && (report.status ?? 'OPEN') !== 'REJECTED');
  return res.json({ items: reports });
});

adminRouter.post('/moderation/:id/remove', requireModeratorAccess, async (req, res) => {
  const id = String(req.params.id);
  const parsed = reportDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Moderation reason must be 1000 characters or fewer.' });
  const reason = parsed.data.reason ?? parsed.data.note ?? 'Content removed by moderator.';

  if (await isDatabaseAvailable()) {
    const outcome = await prisma.$transaction(async (transaction) => {
      const report = await transaction.report.findUnique({
        where: { id },
        select: { id: true, postId: true, commentId: true, messageId: true, status: true },
      });
      if (!report) return { type: 'not-found' as const };
      if (!report.postId && !report.commentId && !report.messageId) return { type: 'unsupported' as const };
      if (report.status === 'RESOLVED' || report.status === 'REJECTED') return { type: 'closed' as const };

      const target = report.postId
        ? await transaction.post.findUnique({ where: { id: report.postId }, select: { authorId: true } })
        : report.commentId
          ? await transaction.comment.findUnique({ where: { id: report.commentId }, select: { authorId: true } })
          : await transaction.message.findUnique({ where: { id: report.messageId! }, select: { senderId: true } });
      if (!target) return { type: 'target-not-found' as const };
      const targetUserId = 'authorId' in target ? target.authorId : target.senderId;

      const hiddenAt = new Date();
      if (report.postId) {
        await transaction.post.update({
          where: { id: report.postId },
          data: { moderationHiddenAt: hiddenAt, moderationHiddenById: req.user!.id, moderationReason: reason },
        });
      } else if (report.commentId) {
        await transaction.comment.update({
          where: { id: report.commentId! },
          data: { moderationHiddenAt: hiddenAt, moderationHiddenById: req.user!.id, moderationReason: reason },
        });
      } else {
        await transaction.message.update({
          where: { id: report.messageId! },
          data: { moderationHiddenAt: hiddenAt, moderationHiddenById: req.user!.id, moderationReason: reason },
        });
      }
      const updated = await transaction.report.update({
        where: { id },
        data: { status: 'RESOLVED', resolvedAt: hiddenAt },
      });
      await transaction.adminAction.create({
        data: {
          actorId: req.user!.id,
          targetUserId,
          actionType: 'MODERATION_REMOVED',
          details: JSON.stringify({
            reportId: id,
            targetType: report.postId ? 'post' : report.commentId ? 'comment' : 'message',
            targetId: report.postId ?? report.commentId ?? report.messageId,
            reason,
          }),
        },
      });
      return { type: 'ok' as const, item: updated };
    });
    if (outcome.type === 'not-found') return res.status(404).json({ message: 'Moderation item not found.' });
    if (outcome.type === 'unsupported') return res.status(400).json({ message: 'This report does not identify removable content.' });
    if (outcome.type === 'target-not-found') return res.status(404).json({ message: 'Reported content not found.' });
    if (outcome.type === 'closed') return res.status(409).json({ message: 'This report has already been resolved.' });
    return res.json({ item: outcome.item, message: 'Content hidden and report resolved.' });
  }

  const target = socialStore.state.reports.find((entry) => entry.id === id);
  if (!target) return res.status(404).json({ message: 'Moderation item not found.' });
  if (!['post', 'comment', 'message'].includes(target.targetType)) return res.status(400).json({ message: 'This report does not identify removable content.' });
  if (target.status === 'RESOLVED' || target.status === 'REJECTED') return res.status(409).json({ message: 'This report has already been resolved.' });
  const content = target.targetType === 'post'
    ? socialStore.state.posts.find((entry) => entry.id === target.targetId)
    : target.targetType === 'comment'
      ? socialStore.state.comments.find((entry) => entry.id === target.targetId)
      : socialStore.state.messages.find((entry) => entry.id === target.targetId);
  if (!content) return res.status(404).json({ message: 'Reported content not found.' });

  const resolvedAt = new Date().toISOString();
  Object.assign(content, { moderationHiddenAt: resolvedAt, moderationHiddenById: req.user!.id, moderationReason: reason });
  target.status = 'RESOLVED';
  target.resolvedAt = resolvedAt;
  const item = await loadReports().then((reports) => reports.find((report: any) => report.id === id));
  await trackAdminAction(
    req.user!.id,
    'authorId' in content ? content.authorId : content.senderId,
    'MODERATION_REMOVED',
    JSON.stringify({ reportId: id, targetType: target.targetType, targetId: target.targetId, reason }),
  );
  return res.json({ item, message: 'Content hidden and report resolved.' });
});

adminRouter.post('/moderation/:id/approve', requireModeratorAccess, async (req, res) => {
  const id = String(req.params.id);
  const parsed = reportDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Moderation note must be 1000 characters or fewer.' });
  const note = parsed.data.note ?? parsed.data.reason ?? 'Content approved.';
  if (await isDatabaseAvailable()) {
    const outcome = await prisma.$transaction(async (transaction) => {
      const report = await transaction.report.findUnique({
        where: { id },
        select: { id: true, postId: true, commentId: true, messageId: true },
      });
      if (!report) return null;
      let targetUserId: string | null = null;
      if (report.postId) {
        const post = await transaction.post.findUnique({ where: { id: report.postId }, select: { authorId: true } });
        targetUserId = post?.authorId ?? null;
        await transaction.post.updateMany({
          where: { id: report.postId },
          data: { moderationHiddenAt: null, moderationHiddenById: null, moderationReason: null },
        });
      } else if (report.commentId) {
        const comment = await transaction.comment.findUnique({ where: { id: report.commentId }, select: { authorId: true } });
        targetUserId = comment?.authorId ?? null;
        await transaction.comment.updateMany({
          where: { id: report.commentId },
          data: { moderationHiddenAt: null, moderationHiddenById: null, moderationReason: null },
        });
      } else if (report.messageId) {
        const message = await transaction.message.findUnique({ where: { id: report.messageId }, select: { senderId: true } });
        targetUserId = message?.senderId ?? null;
        await transaction.message.updateMany({
          where: { id: report.messageId },
          data: { moderationHiddenAt: null, moderationHiddenById: null, moderationReason: null },
        });
      }
      const updated = await transaction.report.update({
        where: { id },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
      await transaction.adminAction.create({
        data: {
          actorId: req.user!.id,
          targetUserId,
          actionType: 'MODERATION_APPROVED',
          details: JSON.stringify({ reportId: id, note }),
        },
      });
      return updated;
    });
    if (!outcome) return res.status(404).json({ message: 'Moderation item not found.' });
    return res.json({ item: outcome, message: 'Content approved and visible.' });
  }
  const target = socialStore.state.reports.find((entry) => entry.id === id);
  if (!target) return res.status(404).json({ message: 'Moderation item not found.' });
  let targetUserId: string | null = null;
  if (target.targetType === 'post') {
    const post = socialStore.state.posts.find((entry) => entry.id === target.targetId);
    if (post) {
      targetUserId = post.authorId;
      Object.assign(post, { moderationHiddenAt: null, moderationHiddenById: null, moderationReason: null });
    }
  } else if (target.targetType === 'comment') {
    const comment = socialStore.state.comments.find((entry) => entry.id === target.targetId);
    if (comment) {
      targetUserId = comment.authorId;
      Object.assign(comment, { moderationHiddenAt: null, moderationHiddenById: null, moderationReason: null });
    }
  } else if (target.targetType === 'message') {
    const message = socialStore.state.messages.find((entry) => entry.id === target.targetId);
    if (message) {
      targetUserId = message.senderId;
      Object.assign(message, { moderationHiddenAt: null, moderationHiddenById: null, moderationReason: null });
    }
  }
  target.status = 'RESOLVED';
  target.resolvedAt = new Date().toISOString();
  await trackAdminAction(req.user!.id, targetUserId, 'MODERATION_APPROVED', JSON.stringify({ reportId: id, note }));
  const item = await loadReports().then((reports) => reports.find((report: any) => report.id === id));
  return res.json({ item, message: 'Content approved and visible.' });
});

adminRouter.get('/appeals', requireAdminAccess, async (_req, res) => {
  const appeals = await loadAppeals();
  return res.json({ appeals });
});

adminRouter.get('/appeals/:id', requireAdminAccess, async (req, res) => {
  const appeal = (await loadAppeals()).find((entry: any) => entry.id === req.params.id);
  if (!appeal) return res.status(404).json({ message: 'Appeal not found.' });
  return res.json({ appeal });
});

async function reviewAppeal(req: Request, res: Response, decision: 'APPROVED' | 'REJECTED') {
  const parsed = reportDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: 'Appeal review note must be 1000 characters or fewer.' });
  }
  const appeal = (await loadAppeals()).find((entry: any) => entry.id === req.params.id);
  if (!appeal) return res.status(404).json({ message: 'Appeal not found.' });
  if (appeal.userId === req.user!.id) {
    return res.status(403).json({ message: 'You cannot review your own appeal.' });
  }
  if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ message: 'Only administrators can review appeals.' });
  }

  if (appeal.status !== 'OPEN') {
    return res.status(409).json({ message: 'This appeal has already been reviewed.' });
  }

  const note = parsed.data.note ?? parsed.data.reason ?? `${decision === 'APPROVED' ? 'Appeal approved' : 'Appeal rejected'}.`;
  if (await isDatabaseAvailable()) {
    const updated = await prisma.$transaction(async (transaction) => {
      const result = await transaction.appeal.updateMany({
        where: { id: appeal.id, status: 'OPEN' },
        data: { status: decision, openAppealUserId: null, reviewerId: req.user!.id, reviewerNote: note, reviewedAt: new Date() },
      });
      if (!result.count) return null;
      if (decision === 'APPROVED') {
        await transaction.user.update({ where: { id: appeal.userId }, data: { status: 'ACTIVE' } });
      }
      await transaction.adminAction.create({
        data: {
          actorId: req.user!.id,
          targetUserId: appeal.userId,
          actionType: `APPEAL_${decision}`,
          details: note,
        },
      });
      return transaction.appeal.findUnique({
        where: { id: appeal.id },
        include: {
          user: { select: { id: true, name: true, email: true } },
          reviewer: { select: { id: true, name: true, email: true } },
        },
      });
    });
    if (!updated) return res.status(409).json({ message: 'This appeal has already been reviewed.' });
    return res.json({ appeal: updated, message: `Appeal ${decision.toLowerCase()}.` });
  }

  const item = fallbackStore.updateAppeal(appeal.id, {
    status: decision,
    reviewerId: req.user!.id,
    reviewerNote: note,
    reviewedAt: new Date().toISOString(),
  });
  if (!item) return res.status(404).json({ message: 'Appeal not found.' });
  if (decision === 'APPROVED') {
    fallbackStore.updateUser(appeal.userId, { status: 'ACTIVE' });
  }
  await trackAdminAction(req.user!.id, appeal.userId, `APPEAL_${decision}`, note);
  return res.json({ appeal: item, message: `Appeal ${decision.toLowerCase()}.` });
}

function appealReviewHandler(decision: 'APPROVED' | 'REJECTED') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await reviewAppeal(req, res, decision);
    } catch (error) {
      next(error);
    }
  };
}

adminRouter.post('/appeals/:id/approve', requireAdminAccess, appealReviewHandler('APPROVED'));
adminRouter.post('/appeals/:id/reject', requireAdminAccess, appealReviewHandler('REJECTED'));

adminRouter.get('/subscriptions', requireAdminAccess, async (_req, res) => {
  const subscriptions = await loadSubscriptions();
  return res.json({ subscriptions });
});

adminRouter.get('/payments', requireAdminAccess, async (_req, res) => {
  const payments = await loadPayments();
  return res.json({
    payments: payments.map((payment: any) => ({
      ...payment,
      providerReference: payment.providerReference ?? null,
      amountCents: Number(payment.amountCents ?? 0),
    })),
  });
});

adminRouter.get('/creators', requireAdminAccess, async (_req, res) => {
  const creators = await (async () => {
    if (await isDatabaseAvailable()) {
      const profiles = await prisma.creatorProfile.findMany({
        include: { user: { select: { id: true, name: true, email: true, createdAt: true } }, _count: { select: { subscribers: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return Promise.all(profiles.map(async (profile) => ({
        id: profile.id,
        creatorId: profile.userId,
        name: profile.user.name,
        email: profile.user.email,
        status: profile.isEnabled ? 'ACTIVE' : 'SUSPENDED',
        subscribers: profile._count.subscribers,
        createdAt: profile.user.createdAt,
        applicationStatus: (await prisma.creatorApplication.findFirst({ where: { creatorId: profile.userId, status: 'APPROVED' }, select: { status: true } }))?.status ?? 'NOT_APPROVED',
      })));
    }
    return commerceStore.state.creators.map((profile) => ({
      id: profile.id,
      creatorId: profile.userId,
      name: fallbackStore.findById(profile.userId)?.name ?? null,
      email: fallbackStore.findById(profile.userId)?.email ?? null,
      status: profile.isEnabled ? 'ACTIVE' : 'SUSPENDED',
      subscribers: commerceStore.state.creatorSubscriptions.filter((item) => item.creatorId === profile.userId && item.status === 'ACTIVE').length,
      applicationStatus: commerceStore.state.creatorApplications.some((item) => item.creatorId === profile.userId && item.status === 'APPROVED') ? 'APPROVED' : 'NOT_APPROVED',
    }));
  })();
  return res.json({ creators });
});

adminRouter.get('/earnings', requireAdminAccess, async (_req, res) => {
  const entries = await isDatabaseAvailable()
    ? await prisma.creatorLedgerEntry.findMany({ orderBy: { createdAt: 'desc' } })
    : commerceStore.state.creatorLedger;
  const payouts = await isDatabaseAvailable()
    ? await prisma.creatorPayoutRequest.findMany()
    : commerceStore.state.creatorPayouts;
  const confirmedEarningsCents = entries
    .filter((entry) => ['SUBSCRIPTION', 'SUBSCRIPTION_REFUND'].includes(entry.type))
    .reduce((sum, entry) => sum + Number(entry.amountCents), 0);
  const withdrawableBalanceCents = entries.reduce((sum, entry) => sum + Number(entry.amountCents), 0);
  return res.json({
    metrics: {
      estimatedEarningsCents: null,
      confirmedEarningsCents,
      pendingPayoutCents: payouts.filter((payout) => ['PENDING', 'APPROVED', 'PROCESSING'].includes(payout.status)).reduce((sum, payout) => sum + Number(payout.amountCents), 0),
      paidCents: payouts.filter((payout) => payout.status === 'PAID').reduce((sum, payout) => sum + Number(payout.amountCents), 0),
      withdrawableBalanceCents,
    },
    entries,
  });
});

adminRouter.get('/payouts', requireAdminAccess, async (_req, res) => {
  const payouts = await isDatabaseAvailable()
    ? await prisma.creatorPayoutRequest.findMany({ orderBy: { requestedAt: 'desc' } })
    : commerceStore.state.creatorPayouts;
  return res.json({ payouts });
});

adminRouter.get('/revenue', requireAdminAccess, async (_req, res) => {
  const databaseAvailable = await isDatabaseAvailable();
  const [creatorEntries, financialEntries, payouts, payments, adEvents] = await Promise.all([
    databaseAvailable ? prisma.creatorLedgerEntry.findMany() : Promise.resolve(commerceStore.state.creatorLedger),
    databaseAvailable ? prisma.financialLedgerEntry.findMany() : Promise.resolve(commerceStore.state.financialLedger),
    databaseAvailable ? prisma.creatorPayoutRequest.findMany() : Promise.resolve(commerceStore.state.creatorPayouts),
    databaseAvailable
      ? Promise.all([
          prisma.payment.findMany({ where: { status: { in: ['PAID', 'SUCCESS'] } }, select: { status: true, provider: true, providerReference: true, amountCents: true } }),
          prisma.paymentIntent.findMany({ where: { status: 'SUCCESS' }, select: { status: true, provider: true, providerReference: true, amountCents: true } }),
        ]).then(([legacyPayments, paymentIntents]) => [...legacyPayments, ...paymentIntents])
      : Promise.resolve([...socialStore.state.payments, ...commerceStore.state.paymentIntents]),
    databaseAvailable ? prisma.adEvent.findMany({ select: { eventType: true, amountCents: true } }) : Promise.resolve(commerceStore.state.adEvents),
  ]);
  const grossRevenue = uniqueSuccessfulPayments(payments).reduce((sum, payment) => sum + Number(payment.amountCents ?? 0), 0);
  const platformRevenue = financialEntries.filter((entry) => entry.ownerId === 'platform').reduce((sum, entry) => sum + (entry.direction === 'CREDIT' ? Number(entry.amountCents) : -Number(entry.amountCents)), 0);
  const creatorNetEarnings = creatorEntries.filter((entry) => ['SUBSCRIPTION', 'SUBSCRIPTION_REFUND'].includes(entry.type)).reduce((sum, entry) => sum + Number(entry.amountCents), 0);
  const adSpendCents = adEvents.reduce((sum, event) => sum + Number(event.amountCents), 0);
  return res.json({
    metrics: {
      grossRevenue,
      platformRevenue,
      creatorNetEarnings,
      adSpendCents,
      adImpressions: adEvents.filter((event) => event.eventType === 'IMPRESSION').length,
      adClicks: adEvents.filter((event) => event.eventType === 'CLICK').length,
      pendingPayouts: payouts.filter((payout) => ['PENDING', 'APPROVED', 'PROCESSING'].includes(payout.status)).reduce((sum, payout) => sum + Number(payout.amountCents), 0),
    },
  });
});

adminRouter.get('/audit-logs', requireAdminAccess, async (_req, res: Response) => {
  const logs = await (async () => {
    if (await isDatabaseAvailable()) {
      return prisma.adminAction.findMany({
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, name: true, email: true } }, targetUser: { select: { id: true, name: true, email: true } } },
      });
    }

    return fallbackStore.listAdminActions();
  })();

  return res.json({ logs });
});

export { adminRouter };
