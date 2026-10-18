import { Router } from 'express';
import { z } from 'zod';
import { commerceStore } from '../lib/commerceStore.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { isDatabaseAvailable, prisma } from '../lib/prisma.js';
import { socialStore } from '../lib/socialStore.js';
import { requireActiveAccountIfAuthenticated, requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const admin = [requireAuth, requireRole(['ADMIN', 'SUPER_ADMIN'])] as const;
const publicAdPlacements = ['feed', 'content'] as const;
const defaultMonetizationSettings = {
  id: 'default',
  enabled: false,
  minimumFollowers: 1000,
  minimumQualifiedViews: 0,
  qualifiedViewWindowDays: 30,
  minimumWatchTimeSeconds: 0,
  minimumEngagementRate: 0,
  minimumAccountAgeDays: 30,
  minimumPublicPosts: 0,
  revenueSharePercent: 90,
  minimumPayoutCents: 0,
};
const measurementSourceSchema = z.enum(['feed', 'videos', 'explore', 'profile', 'home', 'stories', 'messages', 'unknown']).default('unknown');
const videoMeasurementStartSchema = z.object({
  postId: z.string().trim().min(1, 'A postId is required.').max(128),
  sessionId: z.string().trim().min(1, 'A sessionId is required.').max(128),
  durationSeconds: z.number().int().min(1).max(86_400),
  source: measurementSourceSchema.optional(),
}).strict();
const videoMeasurementHeartbeatSchema = z.object({
  postId: z.string().trim().min(1).max(128),
  sessionId: z.string().trim().min(1).max(128),
  currentTimeSeconds: z.number().min(0).max(86_400),
}).strict();
const monetizationSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  minimumFollowers: z.number().int().min(0).max(100_000_000).optional(),
  minimumQualifiedViews: z.number().int().min(0).max(1_000_000_000).optional(),
  qualifiedViewWindowDays: z.number().int().min(1).max(365).optional(),
  minimumWatchTimeSeconds: z.number().int().min(0).max(31_536_000).optional(),
  minimumEngagementRate: z.number().min(0).max(1).optional(),
  minimumAccountAgeDays: z.number().int().min(0).max(36500).optional(),
  minimumPublicPosts: z.number().int().min(0).max(1_000_000).optional(),
  revenueSharePercent: z.number().int().min(0).max(100).optional(),
  minimumPayoutCents: z.number().int().min(0).max(100_000_000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const campaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  placement: z.enum(publicAdPlacements),
  creativeUrl: z.string().url().max(1000).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  destinationUrl: z.string().url().max(1000).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  totalBudgetCents: z.number().int().positive().max(100_000_000),
  dailyBudgetCents: z.number().int().positive().max(100_000_000),
  costPerImpressionCents: z.number().int().min(0).max(100_000).default(0),
  costPerClickCents: z.number().int().min(0).max(100_000).default(0),
}).strict().refine((value) => new Date(value.endsAt) > new Date(value.startsAt), { message: 'Campaign end must be after its start.' })
  .refine((value) => value.dailyBudgetCents <= value.totalBudgetCents, { message: 'Daily budget cannot exceed the total budget.' });
const placementSchema = z.object({
  key: z.enum(publicAdPlacements),
  enabled: z.boolean(),
  dailyBudgetCents: z.number().int().min(0).max(100_000_000),
}).strict();
const reviewSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'PAUSED', 'RESUMED', 'COMPLETED']),
  reason: z.string().trim().min(3).max(1000).optional(),
}).strict();
const id = () => `ad_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
const timestamp = () => new Date();

async function audit(actorId: string, targetUserId: string | null, actionType: string, details: unknown) {
  const safeDetails = JSON.stringify(details);
  if (await isDatabaseAvailable()) {
    await prisma.adminAction.create({ data: { actorId, targetUserId, actionType, details: safeDetails } });
    return;
  }
  fallbackStore.createAdminAction({ actorId, targetUserId, actionType, details: safeDetails });
}

async function getSettings() {
  if (await isDatabaseAvailable()) return (await prisma.monetizationSettings.findUnique({ where: { id: 'default' } })) ?? defaultMonetizationSettings;
  return commerceStore.state.monetizationSettings ?? defaultMonetizationSettings;
}

async function getMeasurementReadiness() {
  if (await isDatabaseAvailable()) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const yes = await prisma.videoMeasurement.findFirst({ where: { qualified: true, createdAt: { gte: cutoff } }, select: { id: true } });
    return Boolean(yes);
  }
  return false;
}

async function getCreatorMeasurementMetrics(userId: string, settings: Awaited<ReturnType<typeof getSettings>>) {
  const cutoff = new Date(Date.now() - settings.qualifiedViewWindowDays * 24 * 60 * 60 * 1000);
  if (await isDatabaseAvailable()) {
    const records = await prisma.videoMeasurement.findMany({
      where: {
        qualified: true,
        createdAt: { gte: cutoff },
        post: { authorId: userId },
      },
      select: { watchSeconds: true },
    });
    const qualifiedViews = records.length;
    const watchTimeSeconds = records.reduce((sum, record) => sum + record.watchSeconds, 0);
    return { qualifiedViews, watchTimeSeconds, available: true };
  }
  const records = socialStore.state.videoMeasurements.filter((entry) => {
    const createdAt = new Date(entry.createdAt).getTime();
    return entry.qualified && createdAt >= cutoff.getTime() && socialStore.state.posts.some((post) => post.id === entry.postId && post.authorId === userId);
  });
  const qualifiedViews = records.length;
  const watchTimeSeconds = records.reduce((sum, record) => sum + record.watchSeconds, 0);
  return { qualifiedViews, watchTimeSeconds, available: records.length > 0 };
}

async function getEligibility(userId: string) {
  const settings = await getSettings();
  let accountCreatedAt: Date | null = null;
  let followers = 0;
  let publicPosts = 0;
  let engagements = 0;
  let approved = false;
  let active = false;
  if (await isDatabaseAvailable()) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true, creatorProfile: { select: { isEnabled: true } } } });
    if (!user) return null;
    accountCreatedAt = user.createdAt;
    const approvedApplication = await prisma.creatorApplication.findFirst({ where: { creatorId: userId, status: 'APPROVED' }, select: { id: true } });
    approved = Boolean(approvedApplication);
    active = Boolean(approved && user.creatorProfile?.isEnabled);
    [followers, publicPosts] = await Promise.all([
      prisma.follow.count({ where: { followingId: userId } }),
      prisma.post.count({ where: { authorId: userId, visibility: 'PUBLIC' } }),
    ]);
    const publicPostFilter = { post: { authorId: userId, visibility: 'PUBLIC' as const } };
    const [reactions, comments, shares] = await Promise.all([
      prisma.reaction.count({ where: publicPostFilter }),
      prisma.comment.count({ where: publicPostFilter }),
      prisma.postShare.count({ where: publicPostFilter }),
    ]);
    engagements = reactions + comments + shares;
  } else {
    const user = fallbackStore.findById(userId);
    if (!user) return null;
    accountCreatedAt = new Date(user.createdAt);
    approved = commerceStore.state.creatorApplications.some((application) => application.creatorId === userId && application.status === 'APPROVED');
    active = Boolean(approved && commerceStore.state.creators.some((profile) => profile.userId === userId && profile.isEnabled));
    followers = socialStore.state.follows.filter((follow) => follow.followingId === userId).length;
    const posts = socialStore.state.posts.filter((post) => post.authorId === userId && post.visibility === 'PUBLIC');
    publicPosts = posts.length;
    const postIds = new Set(posts.map((post) => post.id));
    engagements = socialStore.state.reactions.filter((reaction) => postIds.has(reaction.postId)).length
      + socialStore.state.comments.filter((comment) => postIds.has(comment.postId)).length
      + socialStore.state.postShares.filter((share) => postIds.has(share.postId)).length;
  }
  const ageDays = Math.max(0, Math.floor((Date.now() - accountCreatedAt.getTime()) / 86_400_000));
  const measurement = await getCreatorMeasurementMetrics(userId, settings);
  const metrics = {
    followers,
    qualifiedViews: measurement.qualifiedViews,
    watchTimeSeconds: measurement.watchTimeSeconds,
    publicPosts,
    engagements,
    engagementRate: publicPosts * followers === 0 ? 0 : engagements / (publicPosts * followers),
    accountAgeDays: ageDays,
    qualifiedViewsAvailable: measurement.available,
    watchTimeAvailable: measurement.available,
  };
  const requirements = [
    { key: 'program', label: 'Monetization program is enabled', required: true, met: settings.enabled },
    { key: 'followers', label: `At least ${settings.minimumFollowers} followers`, required: settings.minimumFollowers, actual: followers, met: followers >= settings.minimumFollowers },
    { key: 'qualifiedViews', label: `At least ${settings.minimumQualifiedViews} qualified views in ${settings.qualifiedViewWindowDays} days`, required: settings.minimumQualifiedViews, actual: metrics.qualifiedViews, met: settings.minimumQualifiedViews === 0 || (measurement.available && metrics.qualifiedViews >= settings.minimumQualifiedViews), available: measurement.available },
    { key: 'watchTime', label: `At least ${settings.minimumWatchTimeSeconds} seconds watch time`, required: settings.minimumWatchTimeSeconds, actual: metrics.watchTimeSeconds, met: settings.minimumWatchTimeSeconds === 0 || (measurement.available && metrics.watchTimeSeconds >= settings.minimumWatchTimeSeconds), available: measurement.available },
    { key: 'engagement', label: `Engagement rate of at least ${(settings.minimumEngagementRate * 100).toFixed(1)}%`, required: settings.minimumEngagementRate, actual: metrics.engagementRate, met: metrics.engagementRate >= settings.minimumEngagementRate },
    { key: 'accountAge', label: `Account age of at least ${settings.minimumAccountAgeDays} days`, required: settings.minimumAccountAgeDays, actual: ageDays, met: ageDays >= settings.minimumAccountAgeDays },
    { key: 'publicPosts', label: `At least ${settings.minimumPublicPosts} public posts`, required: settings.minimumPublicPosts, actual: publicPosts, met: publicPosts >= settings.minimumPublicPosts },
  ];
  return { settings, metrics, requirements, eligible: requirements.every((requirement) => requirement.met), approved, active };
}

async function findPostForMeasurement(postId: string, viewerId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, authorId: true, visibility: true },
    });
    if (!post) return null;
    if (post.authorId === viewerId) return post;
    if (post.visibility === 'PUBLIC') return post;
    if (post.visibility === 'FOLLOWERS') {
      const follow = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewerId, followingId: post.authorId } }, select: { id: true } });
      if (follow) return post;
      return null;
    }
    return null;
  }
  const post = socialStore.state.posts.find((entry) => entry.id === postId);
  if (!post) return null;
  if (post.authorId === viewerId) return post;
  if (post.visibility === 'PUBLIC') return post;
  if (post.visibility === 'FOLLOWERS') {
    const isFollowing = socialStore.state.follows.some((follow) => follow.followerId === viewerId && follow.followingId === post.authorId);
    if (isFollowing) return post;
    return null;
  }
  return null;
}

router.use(requireActiveAccountIfAuthenticated);

router.get('/creators/me/monetization', requireAuth, async (req, res) => {
  const eligibility = await getEligibility(req.user!.id);
  if (!eligibility) return res.status(404).json({ message: 'User not found.' });
  const applications = await isDatabaseAvailable()
    ? await prisma.creatorApplication.findMany({ where: { creatorId: req.user!.id }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.creatorApplications.filter((application) => application.creatorId === req.user!.id);
  const entries = await isDatabaseAvailable()
    ? await prisma.creatorLedgerEntry.findMany({ where: { creatorId: req.user!.id }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.creatorLedger.filter((entry) => entry.creatorId === req.user!.id);
  const payouts = await isDatabaseAvailable()
    ? await prisma.creatorPayoutRequest.findMany({ where: { creatorId: req.user!.id }, orderBy: { requestedAt: 'desc' } })
    : commerceStore.state.creatorPayouts.filter((payout) => payout.creatorId === req.user!.id);
  return res.json({
    ...eligibility,
    applications,
    earnings: {
      entries,
      estimatedBalanceCents: entries.reduce((sum, entry) => sum + Number(entry.amountCents), 0),
      paidCents: payouts.filter((payout) => payout.status === 'PAID').reduce((sum, payout) => sum + Number(payout.amountCents), 0),
      pendingPayoutCents: payouts.filter((payout) => ['PENDING', 'APPROVED', 'PROCESSING'].includes(payout.status)).reduce((sum, payout) => sum + Number(payout.amountCents), 0),
      payouts,
    },
  });
});

router.post('/creators/me/monetization/applications', requireAuth, async (req, res) => {
  const payload = z.object({ reason: z.string().trim().max(1000).optional() }).strict().safeParse(req.body ?? {});
  if (!payload.success) return res.status(400).json({ message: 'Invalid application.' });
  const eligibility = await getEligibility(req.user!.id);
  if (!eligibility) return res.status(404).json({ message: 'User not found.' });
  if (!eligibility.eligible) return res.status(409).json({ message: 'Eligibility requirements are not met.', requirements: eligibility.requirements.filter((requirement) => !requirement.met) });
  if (eligibility.approved) return res.status(409).json({ message: 'A creator monetization application has already been approved.' });
  if (await isDatabaseAvailable()) {
    const pending = await prisma.creatorApplication.findFirst({ where: { creatorId: req.user!.id, status: 'PENDING' } });
    if (pending) return res.status(409).json({ message: 'An application is already pending.' });
    const application = await prisma.creatorApplication.create({ data: { creatorId: req.user!.id, reason: payload.data.reason ?? null } });
    return res.status(201).json({ application });
  }
  if (commerceStore.state.creatorApplications.some((application) => application.creatorId === req.user!.id && application.status === 'PENDING')) return res.status(409).json({ message: 'An application is already pending.' });
  const application = { id: id(), creatorId: req.user!.id, status: 'PENDING', reason: payload.data.reason ?? null, reviewNote: null, reviewedBy: null, reviewedAt: null, createdAt: timestamp(), updatedAt: timestamp() };
  commerceStore.state.creatorApplications.push(application);
  return res.status(201).json({ application });
});

router.get('/admin/monetization/settings', ...admin, async (_req, res) => {
  const settings = await getSettings();
  res.json({ settings, measurementReady: await getMeasurementReadiness() });
});

router.post('/monetization/video-views/start', requireAuth, async (req, res) => {
  const parsed = videoMeasurementStartSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid video playback session.', errors: parsed.error.flatten() });
  const body = parsed.data;
  const post = await findPostForMeasurement(body.postId, req.user!.id);
  if (!post || post.authorId === req.user!.id) return res.status(403).json({ message: 'This video is not eligible for playback measurement.' });
  const startedAt = timestamp();
  if (await isDatabaseAvailable()) {
    try {
      const record = await prisma.videoMeasurement.create({
        data: {
          postId: body.postId,
          viewerId: req.user!.id,
          sessionId: body.sessionId,
          source: body.source ?? 'unknown',
          watchSeconds: 0,
          durationSeconds: body.durationSeconds,
          lastPositionSeconds: 0,
          lastHeartbeatAt: startedAt,
          active: true,
          startedAt,
          endedAt: startedAt,
          qualified: false,
        },
      });
      return res.status(201).json({ sessionId: record.sessionId, startedAt: record.startedAt });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        return res.status(409).json({ message: 'This playback session has already been recorded.', duplicate: true });
      }
      throw error;
    }
  }
  const exists = socialStore.state.videoMeasurements.some((entry) => entry.postId === body.postId && entry.viewerId === req.user!.id && entry.sessionId === body.sessionId);
  if (exists) return res.status(409).json({ message: 'This playback session has already been recorded.', duplicate: true });
  socialStore.state.videoMeasurements.push({ id: `video_measurement_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, postId: body.postId, viewerId: req.user!.id, sessionId: body.sessionId, source: body.source ?? 'unknown', watchSeconds: 0, durationSeconds: body.durationSeconds, lastPositionSeconds: 0, lastHeartbeatAt: startedAt.toISOString(), active: true, startedAt: startedAt.toISOString(), endedAt: startedAt.toISOString(), qualified: false, createdAt: startedAt.toISOString() });
  return res.status(201).json({ sessionId: body.sessionId, startedAt });
});

router.post('/monetization/video-views/heartbeat', requireAuth, async (req, res) => {
  const parsed = videoMeasurementHeartbeatSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid playback heartbeat.', errors: parsed.error.flatten() });
  const body = parsed.data;
  const now = timestamp();
  if (await isDatabaseAvailable()) {
    const record = await prisma.videoMeasurement.findUnique({ where: { postId_viewerId_sessionId: { postId: body.postId, viewerId: req.user!.id, sessionId: body.sessionId } } });
    if (!record || !record.active || !record.lastHeartbeatAt) return res.status(409).json({ message: 'Playback session is not active.' });
    const elapsed = (now.getTime() - record.lastHeartbeatAt.getTime()) / 1000;
    const positionDelta = body.currentTimeSeconds - record.lastPositionSeconds;
    const creditedSeconds = elapsed > 0 && elapsed <= 15 && positionDelta > 0 && positionDelta <= elapsed * 4 + 2 ? Math.floor(elapsed) : 0;
    const updated = await prisma.videoMeasurement.updateMany({
      where: { id: record.id, active: true, lastHeartbeatAt: record.lastHeartbeatAt },
      data: { watchSeconds: { increment: creditedSeconds }, lastPositionSeconds: Math.floor(body.currentTimeSeconds), lastHeartbeatAt: now },
    });
    if (!updated.count) return res.status(409).json({ message: 'Playback heartbeat was already processed.' });
    return res.json({ accepted: true, creditedSeconds });
  }
  const record = socialStore.state.videoMeasurements.find((entry) => entry.postId === body.postId && entry.viewerId === req.user!.id && entry.sessionId === body.sessionId);
  if (!record || !record.active || !record.lastHeartbeatAt) return res.status(409).json({ message: 'Playback session is not active.' });
  const elapsed = (now.getTime() - new Date(record.lastHeartbeatAt).getTime()) / 1000;
  const positionDelta = body.currentTimeSeconds - record.lastPositionSeconds;
  const creditedSeconds = elapsed > 0 && elapsed <= 15 && positionDelta > 0 && positionDelta <= elapsed * 4 + 2 ? Math.floor(elapsed) : 0;
  record.watchSeconds += creditedSeconds;
  record.lastPositionSeconds = Math.floor(body.currentTimeSeconds);
  record.lastHeartbeatAt = now.toISOString();
  return res.json({ accepted: true, creditedSeconds });
});

router.post('/monetization/video-views/finish', requireAuth, async (req, res) => {
  const parsed = z.object({ postId: z.string().trim().min(1).max(128), sessionId: z.string().trim().min(1).max(128) }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid playback session.' });
  const { postId, sessionId } = parsed.data;
  const settings = await getSettings();
  if (await isDatabaseAvailable()) {
    const record = await prisma.videoMeasurement.findUnique({ where: { postId_viewerId_sessionId: { postId, viewerId: req.user!.id, sessionId } } });
    if (!record) return res.status(404).json({ message: 'Playback session not found.' });
    if (!record.active) return res.status(409).json({ message: 'Playback session has already been closed.' });
    const finished = await prisma.videoMeasurement.updateMany({
      where: { id: record.id, active: true },
      data: { active: false, endedAt: timestamp(), qualified: record.watchSeconds >= settings.minimumWatchTimeSeconds },
    });
    if (!finished.count) return res.status(409).json({ message: 'Playback session has already been closed.' });
    return res.json({ accepted: true, watchSeconds: record.watchSeconds, qualified: record.watchSeconds >= settings.minimumWatchTimeSeconds });
  }
  const record = socialStore.state.videoMeasurements.find((entry) => entry.postId === postId && entry.viewerId === req.user!.id && entry.sessionId === sessionId);
  if (!record) return res.status(404).json({ message: 'Playback session not found.' });
  if (!record.active) return res.status(409).json({ message: 'Playback session has already been closed.' });
  record.active = false;
  record.endedAt = timestamp().toISOString();
  record.qualified = record.watchSeconds >= settings.minimumWatchTimeSeconds;
  return res.json({ accepted: true, watchSeconds: record.watchSeconds, qualified: record.qualified });
});


router.patch('/admin/monetization/settings', ...admin, async (req, res) => {
  const parsed = monetizationSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid monetization settings.', errors: parsed.error.flatten() });
  const data = { ...parsed.data, updatedBy: req.user!.id };
  const settings = await isDatabaseAvailable()
    ? await prisma.monetizationSettings.upsert({ where: { id: 'default' }, create: { ...defaultMonetizationSettings, ...data }, update: data })
    : (commerceStore.state.monetizationSettings = { ...defaultMonetizationSettings, ...commerceStore.state.monetizationSettings, ...data, updatedAt: timestamp() });
  await audit(req.user!.id, null, 'MONETIZATION_SETTINGS_UPDATED', parsed.data);
  return res.json({ settings });
});

router.get('/admin/monetization/applications', ...admin, async (_req, res) => {
  const records = await isDatabaseAvailable()
    ? await prisma.creatorApplication.findMany({ include: { creator: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.creatorApplications;
  const applications = records.map((application) => ({
    ...application,
    creatorName: application.creator?.name ?? fallbackStore.findById(application.creatorId)?.name ?? null,
    email: application.creator?.email ?? fallbackStore.findById(application.creatorId)?.email ?? null,
  }));
  return res.json({ applications });
});

router.patch('/admin/monetization/applications/:applicationId', ...admin, async (req, res) => {
  const parsed = z.object({ status: z.enum(['APPROVED', 'REJECTED']), reason: z.string().trim().min(3).max(1000).optional() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid application review.' });
  const { status, reason } = parsed.data;
  if (status === 'REJECTED' && !reason) return res.status(400).json({ message: 'A rejection reason is required.' });
  const applicationId = String(req.params.applicationId);
  if (await isDatabaseAvailable()) {
    const application = await prisma.creatorApplication.findUnique({ where: { id: applicationId } });
    if (!application) return res.status(404).json({ message: 'Application not found.' });
    if (application.creatorId === req.user!.id) return res.status(403).json({ message: 'Administrators cannot review their own creator application.' });
    if (application.status !== 'PENDING') return res.status(409).json({ message: 'Only pending applications can be reviewed.' });
    if (status === 'APPROVED') {
      const eligibility = await getEligibility(application.creatorId);
      if (!eligibility?.eligible) return res.status(409).json({ message: 'Creator eligibility changed and must be met before approval.', requirements: eligibility?.requirements.filter((requirement) => !requirement.met) ?? [] });
    }
    const reviewed = await prisma.$transaction(async (tx) => {
      const updated = await tx.creatorApplication.updateMany({ where: { id: applicationId, status: 'PENDING' }, data: { status, reviewNote: reason ?? null, reviewedBy: req.user!.id, reviewedAt: timestamp() } });
      if (!updated.count) throw new Error('CREATOR_APPLICATION_REVIEW_CONFLICT');
      if (status === 'APPROVED') await tx.creatorProfile.upsert({ where: { userId: application.creatorId }, create: { userId: application.creatorId, isEnabled: true }, update: { isEnabled: true } });
      return tx.creatorApplication.findUniqueOrThrow({ where: { id: applicationId } });
    });
    await audit(req.user!.id, application.creatorId, `CREATOR_APPLICATION_${status}`, { applicationId, reason: reason ?? null });
    return res.json({ application: reviewed });
  }
  const application = commerceStore.state.creatorApplications.find((item) => item.id === applicationId);
  if (!application) return res.status(404).json({ message: 'Application not found.' });
  if (application.creatorId === req.user!.id) return res.status(403).json({ message: 'Administrators cannot review their own creator application.' });
  if (application.status !== 'PENDING') return res.status(409).json({ message: 'Only pending applications can be reviewed.' });
  if (status === 'APPROVED') {
    const eligibility = await getEligibility(application.creatorId);
    if (!eligibility?.eligible) return res.status(409).json({ message: 'Creator eligibility changed and must be met before approval.', requirements: eligibility?.requirements.filter((requirement) => !requirement.met) ?? [] });
  }
  application.status = status;
  application.reviewNote = reason ?? null;
  application.reviewedBy = req.user!.id;
  application.reviewedAt = timestamp();
  if (status === 'APPROVED') {
    const profile = commerceStore.state.creators.find((creator) => creator.userId === application.creatorId);
    if (profile) profile.isEnabled = true;
    else commerceStore.state.creators.push({ id: id(), userId: application.creatorId, isEnabled: true, subscriptionPriceCents: 0, currency: 'USD', createdAt: timestamp(), updatedAt: timestamp() });
  }
  await audit(req.user!.id, application.creatorId, `CREATOR_APPLICATION_${status}`, { applicationId, reason: reason ?? null });
  return res.json({ application });
});

router.get('/admin/monetization/creators', ...admin, async (_req, res) => {
  const approved = await isDatabaseAvailable()
    ? await prisma.creatorApplication.findMany({
      where: { status: 'APPROVED' },
      include: { creator: { select: { id: true, name: true, email: true, createdAt: true, creatorProfile: { select: { isEnabled: true } } } } },
      orderBy: { reviewedAt: 'desc' },
    })
    : commerceStore.state.creatorApplications.filter((application) => application.status === 'APPROVED').map((application) => ({
      creatorId: application.creatorId as string,
      reviewNote: application.reviewNote as string | null,
      creator: fallbackStore.findById(application.creatorId as string) ?? null,
    }));
  const creators = await Promise.all(approved.map(async (application) => {
    const eligibility = await getEligibility(application.creatorId);
    return {
      creatorId: application.creatorId,
      creatorName: application.creator?.name ?? null,
      email: application.creator?.email ?? null,
      status: eligibility?.active ? 'ACTIVE' : 'SUSPENDED',
      followers: eligibility?.metrics.followers ?? 0,
      publicPosts: eligibility?.metrics.publicPosts ?? 0,
      createdAt: application.creator?.createdAt ?? null,
      reviewNote: application.reviewNote,
    };
  }));
  return res.json({ creators });
});

router.patch('/admin/monetization/creators/:creatorId/status', ...admin, async (req, res) => {
  const parsed = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(3).max(1000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'A status and reason are required.' });
  const creatorId = String(req.params.creatorId);
  if (creatorId === req.user!.id) return res.status(403).json({ message: 'Administrators cannot change their own creator status.' });
  if (parsed.data.status === 'ACTIVE') {
    const eligibility = await getEligibility(creatorId);
    if (!eligibility?.eligible || !eligibility.approved) return res.status(409).json({ message: 'Creator eligibility must be met before reactivation.' });
  }
  if (await isDatabaseAvailable()) {
    const approved = await prisma.creatorApplication.findFirst({ where: { creatorId, status: 'APPROVED' } });
    if (!approved) return res.status(404).json({ message: 'Approved creator application not found.' });
    const profile = await prisma.creatorProfile.updateMany({ where: { userId: creatorId }, data: { isEnabled: parsed.data.status === 'ACTIVE' } });
    if (!profile.count) return res.status(404).json({ message: 'Creator profile not found.' });
  } else {
    const approved = commerceStore.state.creatorApplications.some((application) => application.creatorId === creatorId && application.status === 'APPROVED');
    const profile = commerceStore.state.creators.find((creator) => creator.userId === creatorId);
    if (!approved || !profile) return res.status(404).json({ message: 'Approved creator profile not found.' });
    profile.isEnabled = parsed.data.status === 'ACTIVE';
  }
  await audit(req.user!.id, creatorId, `CREATOR_${parsed.data.status === 'ACTIVE' ? 'REACTIVATED' : 'SUSPENDED'}`, { reason: parsed.data.reason });
  return res.json({ creatorId, status: parsed.data.status });
});

router.post('/admin/monetization/recheck', ...admin, async (req, res) => {
  const applications = await isDatabaseAvailable()
    ? await prisma.creatorApplication.findMany({ where: { status: 'APPROVED' }, select: { creatorId: true } })
    : commerceStore.state.creatorApplications.filter((application) => application.status === 'APPROVED');
  let suspended = 0;
  for (const application of applications) {
    if (application.creatorId === req.user!.id) continue;
    const eligibility = await getEligibility(application.creatorId);
    if (!eligibility?.eligible || !eligibility.approved) {
      if (await isDatabaseAvailable()) await prisma.creatorProfile.updateMany({ where: { userId: application.creatorId }, data: { isEnabled: false } });
      else {
        const profile = commerceStore.state.creators.find((entry) => entry.userId === application.creatorId);
        if (profile) profile.isEnabled = false;
      }
      suspended += 1;
    }
  }
  await audit(req.user!.id, null, 'CREATOR_ELIGIBILITY_RECHECKED', { suspended });
  return res.json({ suspended });
});

router.post('/ads/campaigns', requireAuth, async (req, res) => {
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid campaign.', errors: parsed.error.flatten() });
  if (await isDatabaseAvailable()) {
    const placement = await prisma.adPlacement.findUnique({ where: { key: parsed.data.placement } });
    if (!placement) return res.status(404).json({ message: 'Advertising placement not found.' });
    const { placement: _placementKey, ...campaignData } = parsed.data;
    const campaign = await prisma.adCampaign.create({ data: { ...campaignData, advertiserId: req.user!.id, placementId: placement.id, startsAt: new Date(parsed.data.startsAt), endsAt: new Date(parsed.data.endsAt) } });
    return res.status(201).json({ campaign });
  }
  const placement = commerceStore.state.adPlacements.find((entry) => entry.key === parsed.data.placement);
  if (!placement) return res.status(404).json({ message: 'Advertising placement not found.' });
  const campaign = { id: id(), ...parsed.data, advertiserId: req.user!.id, placementId: placement.id, status: 'DRAFT', spendCents: 0, startsAt: new Date(parsed.data.startsAt), endsAt: new Date(parsed.data.endsAt), createdAt: timestamp(), updatedAt: timestamp(), reviewedBy: null, reviewedAt: null, reviewNote: null };
  commerceStore.state.adCampaigns.push(campaign);
  return res.status(201).json({ campaign });
});

router.get('/ads/consent', requireAuth, async (req, res) => {
  const consent = await isDatabaseAvailable()
    ? await prisma.adConsent.findUnique({ where: { userId: req.user!.id } })
    : commerceStore.state.adConsents.find((entry) => entry.userId === req.user!.id);
  const feedPlacementEnabled = await isDatabaseAvailable()
    ? Boolean(await prisma.adPlacement.findFirst({ where: { key: 'feed', enabled: true } }))
    : commerceStore.state.adPlacements.some((placement) => placement.key === 'feed' && placement.enabled);
  const network = await isDatabaseAvailable()
    ? await prisma.adNetworkSettings.findUnique({ where: { id: 'default' } })
    : commerceStore.state.adNetworkSettings;
  return res.json({ consented: Boolean(consent?.consentedAt), adsAvailable: Boolean(network?.enabled && feedPlacementEnabled) });
});

router.put('/ads/consent', requireAuth, async (req, res) => {
  const parsed = z.object({ consented: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid advertising consent preference.' });
  const consent = await isDatabaseAvailable()
    ? await prisma.adConsent.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, consentedAt: parsed.data.consented ? timestamp() : null },
      update: { consentedAt: parsed.data.consented ? timestamp() : null },
    })
    : (() => {
      let record = commerceStore.state.adConsents.find((entry) => entry.userId === req.user!.id);
      if (!record) {
        record = { id: id(), userId: req.user!.id, consentedAt: null, updatedAt: timestamp() };
        commerceStore.state.adConsents.push(record);
      }
      record.consentedAt = parsed.data.consented ? timestamp() : null;
      record.updatedAt = timestamp();
      return record;
    })();
  return res.json({ consented: Boolean(consent.consentedAt) });
});

router.get('/ads/campaigns/me', requireAuth, async (req, res) => {
  const campaigns = await isDatabaseAvailable()
    ? await prisma.adCampaign.findMany({ where: { advertiserId: req.user!.id }, include: { placement: true }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.adCampaigns.filter((campaign) => campaign.advertiserId === req.user!.id);
  return res.json({ campaigns });
});

router.post('/ads/campaigns/:campaignId/submit', requireAuth, async (req, res) => {
  const campaignId = String(req.params.campaignId);
  if (await isDatabaseAvailable()) {
    const campaign = await prisma.adCampaign.findFirst({ where: { id: campaignId, advertiserId: req.user!.id } });
    if (!campaign) return res.status(404).json({ message: 'Campaign not found.' });
    if (!['DRAFT', 'REJECTED'].includes(campaign.status)) return res.status(409).json({ message: 'Campaign cannot be submitted from its current status.' });
    const updated = await prisma.adCampaign.update({ where: { id: campaignId }, data: { status: 'SUBMITTED' } });
    return res.json({ campaign: updated });
  }
  const campaign = commerceStore.state.adCampaigns.find((item) => item.id === campaignId && item.advertiserId === req.user!.id);
  if (!campaign) return res.status(404).json({ message: 'Campaign not found.' });
  if (!['DRAFT', 'REJECTED'].includes(campaign.status)) return res.status(409).json({ message: 'Campaign cannot be submitted from its current status.' });
  campaign.status = 'SUBMITTED';
  return res.json({ campaign });
});

router.get('/ads/placements/:key', requireAuth, async (req, res) => {
  const key = String(req.params.key);
  if (!publicAdPlacements.includes(key as (typeof publicAdPlacements)[number])) return res.status(404).json({ campaign: null });
  const now = timestamp();
  if (await isDatabaseAvailable()) {
    const consent = await prisma.adConsent.findUnique({ where: { userId: req.user!.id }, select: { consentedAt: true } });
    if (!consent?.consentedAt) return res.json({ campaign: null });
    const settings = await prisma.adNetworkSettings.findUnique({ where: { id: 'default' } });
    if (!settings?.enabled) return res.json({ campaign: null });
    const placement = await prisma.adPlacement.findFirst({ where: { key, enabled: true } });
    if (!placement) return res.json({ campaign: null });
    const candidates = await prisma.adCampaign.findMany({
      where: { placementId: placement.id, status: { in: ['ACTIVE', 'APPROVED'] }, advertiserId: { not: req.user!.id }, startsAt: { lte: now }, endsAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
    });
    for (const candidate of candidates) {
      if (candidate.spendCents >= candidate.totalBudgetCents) continue;
      const dayKey = now.toISOString().slice(0, 10);
      const eventKey = `${candidate.id}:${req.user!.id}:IMPRESSION:${dayKey}`;
      const existing = await prisma.adEvent.findUnique({ where: { eventKey } });
      if (existing) return res.json({ campaign: { id: candidate.id, name: candidate.name, creativeUrl: candidate.creativeUrl, destinationUrl: candidate.destinationUrl, impressionId: existing.id } });
      const amountCents = candidate.costPerImpressionCents;
      try {
        const impression = await prisma.$transaction(async (tx) => {
          const today = new Date(`${dayKey}T00:00:00.000Z`);
          const placementSpend = await tx.adEvent.aggregate({ where: { campaign: { placementId: placement.id }, createdAt: { gte: today } }, _sum: { amountCents: true } });
          const campaignSpend = await tx.adEvent.aggregate({ where: { campaignId: candidate.id, createdAt: { gte: today } }, _sum: { amountCents: true } });
          if (candidate.spendCents + amountCents > candidate.totalBudgetCents
            || (campaignSpend._sum.amountCents ?? 0) + amountCents > candidate.dailyBudgetCents
            || (placement.dailyBudgetCents > 0 && (placementSpend._sum.amountCents ?? 0) + amountCents > placement.dailyBudgetCents)) throw new Error('AD_BUDGET_EXHAUSTED');
          const event = await tx.adEvent.create({ data: { campaignId: candidate.id, viewerId: req.user!.id, eventType: 'IMPRESSION', dayKey, eventKey, amountCents } });
          await tx.adCampaign.update({ where: { id: candidate.id }, data: { spendCents: { increment: amountCents }, ...(candidate.spendCents + amountCents >= candidate.totalBudgetCents ? { status: 'COMPLETED' } : {}) } });
          return event;
        }, { isolationLevel: 'Serializable' });
        return res.json({ campaign: { id: candidate.id, name: candidate.name, creativeUrl: candidate.creativeUrl, destinationUrl: candidate.destinationUrl, impressionId: impression.id } });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') continue;
        if (error instanceof Error && error.message === 'AD_BUDGET_EXHAUSTED') continue;
        if ((error as { code?: string }).code === 'P2034') return res.status(409).json({ message: 'Campaign budget changed. Retry the ad request.' });
        throw error;
      }
    }
    return res.json({ campaign: null });
  }
  const consent = commerceStore.state.adConsents.find((entry) => entry.userId === req.user!.id);
  if (!consent?.consentedAt) return res.json({ campaign: null });
  const settings = commerceStore.state.adNetworkSettings;
  const placement = commerceStore.state.adPlacements.find((item) => item.key === key && item.enabled);
  if (!settings?.enabled || !placement) return res.json({ campaign: null });
  const campaign = commerceStore.state.adCampaigns.find((item) =>
    item.placementId === placement.id && ['ACTIVE', 'APPROVED'].includes(item.status) && item.advertiserId !== req.user!.id
    && item.startsAt <= now && item.endsAt > now && item.spendCents < item.totalBudgetCents);
  if (!campaign) return res.json({ campaign: null });
  const dayKey = now.toISOString().slice(0, 10);
  const eventKey = `${campaign.id}:${req.user!.id}:IMPRESSION:${dayKey}`;
  let impression = commerceStore.state.adEvents.find((event) => event.eventKey === eventKey);
  if (!impression) {
    const amountCents = campaign.costPerImpressionCents;
    const daySpend = commerceStore.state.adEvents.filter((event) => event.campaignId === campaign.id && event.dayKey === dayKey).reduce((sum, event) => sum + event.amountCents, 0);
    const placementSpend = commerceStore.state.adEvents.filter((event) => commerceStore.state.adCampaigns.some((candidate) => candidate.id === event.campaignId && candidate.placementId === placement.id) && event.dayKey === dayKey).reduce((sum, event) => sum + event.amountCents, 0);
    if (campaign.spendCents + amountCents > campaign.totalBudgetCents || daySpend + amountCents > campaign.dailyBudgetCents || (placement.dailyBudgetCents > 0 && placementSpend + amountCents > placement.dailyBudgetCents)) return res.json({ campaign: null });
    impression = { id: id(), campaignId: campaign.id, viewerId: req.user!.id, eventType: 'IMPRESSION', dayKey, eventKey, amountCents, createdAt: now };
    commerceStore.state.adEvents.push(impression);
    campaign.spendCents += amountCents;
    if (campaign.spendCents >= campaign.totalBudgetCents) campaign.status = 'COMPLETED';
  }
  return res.json({ campaign: { id: campaign.id, name: campaign.name, creativeUrl: campaign.creativeUrl, destinationUrl: campaign.destinationUrl, impressionId: impression.id } });
});

router.post('/ads/campaigns/:campaignId/events', requireAuth, async (req, res) => {
  const parsed = z.object({ eventType: z.literal('CLICK'), impressionId: z.string().min(1).max(128) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid ad event.' });
  const campaignId = String(req.params.campaignId);
  const now = timestamp();
  const dayKey = now.toISOString().slice(0, 10);
  const eventKey = `${campaignId}:${req.user!.id}:${parsed.data.eventType}:${dayKey}`;
  if (await isDatabaseAvailable()) {
    const consent = await prisma.adConsent.findUnique({ where: { userId: req.user!.id }, select: { consentedAt: true } });
    if (!consent?.consentedAt) return res.status(403).json({ message: 'Advertising consent is required to record this event.' });
    const settings = await prisma.adNetworkSettings.findUnique({ where: { id: 'default' } });
    const campaign = await prisma.adCampaign.findUnique({ where: { id: campaignId }, include: { placement: true } });
    if (!settings?.enabled || !campaign || !campaign.placement.enabled || !['ACTIVE', 'APPROVED'].includes(campaign.status) || campaign.advertiserId === req.user!.id || campaign.startsAt > now || campaign.endsAt <= now) return res.status(404).json({ message: 'Campaign is unavailable.' });
    const impression = await prisma.adEvent.findFirst({ where: { id: parsed.data.impressionId, campaignId, viewerId: req.user!.id, eventType: 'IMPRESSION' } });
    if (!impression) return res.status(409).json({ message: 'A validated impression is required before recording a click.' });
    const amountCents = campaign.costPerClickCents;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.adEvent.findUnique({ where: { eventKey } });
        if (duplicate) return { duplicate: true, event: duplicate };
        const today = new Date(`${dayKey}T00:00:00.000Z`);
        const placementSpend = await tx.adEvent.aggregate({ where: { campaign: { placementId: campaign.placementId }, createdAt: { gte: today } }, _sum: { amountCents: true } });
        const campaignSpend = await tx.adEvent.aggregate({ where: { campaignId, createdAt: { gte: today } }, _sum: { amountCents: true } });
        if (campaign.spendCents + amountCents > campaign.totalBudgetCents
          || (campaignSpend._sum.amountCents ?? 0) + amountCents > campaign.dailyBudgetCents
          || (campaign.placement.dailyBudgetCents > 0 && (placementSpend._sum.amountCents ?? 0) + amountCents > campaign.placement.dailyBudgetCents)) {
          throw new Error('AD_BUDGET_EXHAUSTED');
        }
        const created = await tx.adEvent.create({ data: { campaignId, viewerId: req.user!.id, eventType: parsed.data.eventType, dayKey, eventKey, amountCents } });
        await tx.adCampaign.update({ where: { id: campaignId }, data: { spendCents: { increment: amountCents }, ...(campaign.spendCents + amountCents >= campaign.totalBudgetCents ? { status: 'COMPLETED' } : {}) } });
        return { duplicate: false, event: created };
      }, { isolationLevel: 'Serializable' });
      return res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof Error && error.message === 'AD_BUDGET_EXHAUSTED') return res.status(409).json({ message: 'Campaign spending limit reached.' });
      if ((error as { code?: string }).code === 'P2002') return res.status(200).json({ duplicate: true });
      if ((error as { code?: string }).code === 'P2034') return res.status(409).json({ message: 'Campaign budget changed. Retry the event.' });
      throw error;
    }
  }
  const consent = commerceStore.state.adConsents.find((entry) => entry.userId === req.user!.id);
  if (!consent?.consentedAt) return res.status(403).json({ message: 'Advertising consent is required to record this event.' });
  const settings = commerceStore.state.adNetworkSettings;
  const campaign = commerceStore.state.adCampaigns.find((item) => item.id === campaignId);
  const placement = commerceStore.state.adPlacements.find((item) => item.id === campaign?.placementId);
  if (!settings?.enabled || !campaign || !placement || !placement.enabled || !['ACTIVE', 'APPROVED'].includes(campaign.status) || campaign.advertiserId === req.user!.id || campaign.startsAt > now || campaign.endsAt <= now) return res.status(404).json({ message: 'Campaign is unavailable.' });
  const impression = commerceStore.state.adEvents.find((event) => event.id === parsed.data.impressionId && event.campaignId === campaignId && event.viewerId === req.user!.id && event.eventType === 'IMPRESSION');
  if (!impression) return res.status(409).json({ message: 'A validated impression is required before recording a click.' });
  const duplicate = commerceStore.state.adEvents.find((event) => event.eventKey === eventKey);
  if (duplicate) return res.json({ duplicate: true, event: duplicate });
  const amountCents = parsed.data.eventType === 'CLICK' ? campaign.costPerClickCents : campaign.costPerImpressionCents;
  const daySpend = commerceStore.state.adEvents.filter((event) => event.campaignId === campaignId && event.dayKey === dayKey).reduce((sum, event) => sum + event.amountCents, 0);
  const placementSpend = commerceStore.state.adEvents.filter((event) => commerceStore.state.adCampaigns.some((candidate) => candidate.id === event.campaignId && candidate.placementId === placement.id) && event.dayKey === dayKey).reduce((sum, event) => sum + event.amountCents, 0);
  if (campaign.spendCents + amountCents > campaign.totalBudgetCents || daySpend + amountCents > campaign.dailyBudgetCents || (placement.dailyBudgetCents > 0 && placementSpend + amountCents > placement.dailyBudgetCents)) return res.status(409).json({ message: 'Campaign spending limit reached.' });
  const event = { id: id(), campaignId, viewerId: req.user!.id, eventType: parsed.data.eventType, dayKey, eventKey, amountCents, createdAt: now };
  commerceStore.state.adEvents.push(event);
  campaign.spendCents += amountCents;
  if (campaign.spendCents >= campaign.totalBudgetCents) campaign.status = 'COMPLETED';
  return res.status(201).json({ duplicate: false, event });
});

router.get('/admin/ads/settings', ...admin, async (_req, res) => {
  const settings = await isDatabaseAvailable()
    ? (await prisma.adNetworkSettings.findUnique({ where: { id: 'default' } }) ?? { id: 'default', enabled: false })
    : commerceStore.state.adNetworkSettings ?? { id: 'default', enabled: false };
  return res.json({ settings });
});

router.patch('/admin/ads/settings', ...admin, async (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid advertising settings.' });
  const settings = await isDatabaseAvailable()
    ? await prisma.adNetworkSettings.upsert({ where: { id: 'default' }, create: { id: 'default', ...parsed.data, updatedBy: req.user!.id }, update: { ...parsed.data, updatedBy: req.user!.id } })
    : (commerceStore.state.adNetworkSettings = { id: 'default', ...parsed.data, updatedBy: req.user!.id, updatedAt: timestamp() });
  await audit(req.user!.id, null, 'AD_NETWORK_SETTINGS_UPDATED', parsed.data);
  return res.json({ settings });
});

router.get('/admin/ads/placements', ...admin, async (_req, res) => {
  const placements = await isDatabaseAvailable()
    ? await prisma.adPlacement.findMany({ orderBy: { key: 'asc' } })
    : commerceStore.state.adPlacements;
  return res.json({ placements });
});

router.put('/admin/ads/placements/:key', ...admin, async (req, res) => {
  const parsed = placementSchema.safeParse({ ...req.body, key: req.params.key });
  if (!parsed.success) return res.status(400).json({ message: 'Invalid advertising placement.' });
  const { key, ...data } = parsed.data;
  const placement = await isDatabaseAvailable()
    ? await prisma.adPlacement.upsert({ where: { key }, create: { key, ...data }, update: data })
    : (() => {
      const current = commerceStore.state.adPlacements.find((item) => item.key === key);
      if (current) Object.assign(current, data);
      else commerceStore.state.adPlacements.push({ id: id(), key, ...data, createdAt: timestamp(), updatedAt: timestamp() });
      return commerceStore.state.adPlacements.find((item) => item.key === key)!;
    })();
  await audit(req.user!.id, null, 'AD_PLACEMENT_UPDATED', { key, ...data });
  return res.json({ placement });
});

router.get('/admin/ads/campaigns', ...admin, async (_req, res) => {
  const records = await isDatabaseAvailable()
    ? await prisma.adCampaign.findMany({ include: { advertiser: { select: { id: true, name: true } }, placement: true }, orderBy: { createdAt: 'desc' } })
    : commerceStore.state.adCampaigns;
  const campaigns = records.map((campaign) => ({
    ...campaign,
    advertiserName: campaign.advertiser?.name ?? fallbackStore.findById(campaign.advertiserId)?.name ?? null,
    placementKey: campaign.placement?.key ?? commerceStore.state.adPlacements.find((item) => item.id === campaign.placementId)?.key ?? null,
  }));
  return res.json({ campaigns });
});

router.patch('/admin/ads/campaigns/:campaignId', ...admin, async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid campaign review.' });
  const campaignId = String(req.params.campaignId);
  const transitions: Record<string, string[]> = { SUBMITTED: ['APPROVED', 'REJECTED'], APPROVED: ['PAUSED', 'COMPLETED'], ACTIVE: ['PAUSED', 'COMPLETED'], PAUSED: ['RESUMED', 'COMPLETED'] };
  if (await isDatabaseAvailable()) {
    const campaign = await prisma.adCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ message: 'Campaign not found.' });
    if (campaign.advertiserId === req.user!.id) return res.status(403).json({ message: 'Administrators cannot review their own campaign.' });
    if (!transitions[campaign.status]?.includes(parsed.data.status)) return res.status(409).json({ message: 'Invalid campaign status transition.' });
    if (parsed.data.status === 'REJECTED' && !parsed.data.reason) return res.status(400).json({ message: 'A rejection reason is required.' });
    const status = parsed.data.status === 'APPROVED' ? (campaign.startsAt <= timestamp() && campaign.endsAt > timestamp() ? 'ACTIVE' : 'APPROVED') : parsed.data.status === 'RESUMED' ? 'ACTIVE' : parsed.data.status;
    const updated = await prisma.adCampaign.updateMany({ where: { id: campaignId, status: campaign.status }, data: { status, reviewNote: parsed.data.reason ?? null, reviewedBy: req.user!.id, reviewedAt: timestamp() } });
    if (!updated.count) return res.status(409).json({ message: 'Campaign status changed; refresh and retry.' });
    await audit(req.user!.id, campaign.advertiserId, `AD_CAMPAIGN_${status}`, { campaignId, reason: parsed.data.reason ?? null });
    return res.json({ campaign: await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId } }) });
  }
  const campaign = commerceStore.state.adCampaigns.find((item) => item.id === campaignId);
  if (!campaign) return res.status(404).json({ message: 'Campaign not found.' });
  if (campaign.advertiserId === req.user!.id) return res.status(403).json({ message: 'Administrators cannot review their own campaign.' });
  if (!transitions[campaign.status]?.includes(parsed.data.status)) return res.status(409).json({ message: 'Invalid campaign status transition.' });
  if (parsed.data.status === 'REJECTED' && !parsed.data.reason) return res.status(400).json({ message: 'A rejection reason is required.' });
  campaign.status = parsed.data.status === 'APPROVED' ? (campaign.startsAt <= timestamp() && campaign.endsAt > timestamp() ? 'ACTIVE' : 'APPROVED') : parsed.data.status === 'RESUMED' ? 'ACTIVE' : parsed.data.status;
  campaign.reviewNote = parsed.data.reason ?? null;
  campaign.reviewedBy = req.user!.id;
  campaign.reviewedAt = timestamp();
  await audit(req.user!.id, campaign.advertiserId, `AD_CAMPAIGN_${campaign.status}`, { campaignId, reason: parsed.data.reason ?? null });
  return res.json({ campaign });
});

router.get('/admin/ads/analytics', ...admin, async (_req, res) => {
  if (await isDatabaseAvailable()) {
    const [impressions, clicks, spend] = await Promise.all([
      prisma.adEvent.count({ where: { eventType: 'IMPRESSION' } }),
      prisma.adEvent.count({ where: { eventType: 'CLICK' } }),
      prisma.adEvent.aggregate({ _sum: { amountCents: true } }),
    ]);
    return res.json({ analytics: { impressions, clicks, spendCents: spend._sum.amountCents ?? 0 } });
  }
  const events = commerceStore.state.adEvents;
  return res.json({ analytics: { impressions: events.filter((event) => event.eventType === 'IMPRESSION').length, clicks: events.filter((event) => event.eventType === 'CLICK').length, spendCents: events.reduce((sum, event) => sum + event.amountCents, 0) } });
});

export { router as monetizationAdsRouter };
