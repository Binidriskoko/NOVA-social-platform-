import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { reviewContentForSafety } from '../lib/moderation.js';
import { isNotificationEnabled } from '../lib/platform.js';
import { requireAuth, requireActiveAccountIfAuthenticated } from '../middleware/auth.js';
import { mediaKeyFromUrl, uploadedMediaBelongsTo, uploadedVideoBelongsTo, videoMediaKeyFromUrl } from '../lib/mediaStorage.js';

function isSafeMediaUrl(value: string) {
  if (value === '' || mediaKeyFromUrl(value) || videoMediaKeyFromUrl(value)) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  username: z.string().trim().min(2).max(32).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  bio: z.string().trim().max(220).optional(),
  avatarUrl: z.string().trim().max(500).refine(isSafeMediaUrl, 'Use an HTTPS image URL or an uploaded NOVAKOKO image.').optional(),
  coverUrl: z.string().trim().max(500).refine(isSafeMediaUrl, 'Use an HTTPS image URL or an uploaded NOVAKOKO image.').optional(),
  website: z.string().trim().max(200).url().optional().or(z.literal('')),
  location: z.string().trim().max(80).optional(),
});

const createPostSchema = z.object({
  content: z.string().trim().min(1).max(2500),
  imageUrl: z.string().trim().max(500).refine(isSafeMediaUrl, 'Use an HTTPS image URL or an uploaded NOVAKOKO image or video.').optional(),
  visibility: z.enum(['PUBLIC', 'FOLLOWERS', 'PRIVATE']).default('PUBLIC'),
});

const createStorySchema = z.object({
  text: z.string().trim().max(500).optional(),
  mediaUrl: z.string().trim().max(2000).refine((value) => value === '' || mediaKeyFromUrl(value) || isSafeMediaUrl(value) && !videoMediaKeyFromUrl(value), 'Use an HTTPS image URL or an uploaded NOVAKOKO image.').optional(),
}).refine((payload) => Boolean(payload.text || payload.mediaUrl), { message: 'A story needs text or media.' });

const createStatusSchema = z.object({
  text: z.string().trim().max(500).optional(),
  mediaUrl: z.string().trim().max(2000).refine((value) => value === '' || mediaKeyFromUrl(value) || videoMediaKeyFromUrl(value), 'Choose an uploaded NOVAKOKO image or video.').optional(),
}).refine((payload) => Boolean(payload.text || payload.mediaUrl), { message: 'A status needs text or media.' });

const updatePostSchema = z.object({
  content: z.string().trim().min(1).max(2500).optional(),
  imageUrl: z.string().trim().max(500).refine(isSafeMediaUrl, 'Use an HTTPS image URL or an uploaded NOVAKOKO image or video.').optional(),
  visibility: z.enum(['PUBLIC', 'FOLLOWERS', 'PRIVATE']).optional(),
});

const reactSchema = z.object({
  type: z.enum(['LIKE', 'LOVE', 'LAUGH', 'SAD', 'ANGRY']),
});

const commentSchema = z.object({
  content: z.string().trim().min(1).max(1200),
  parentId: z.string().min(1).optional(),
});

const reportSchema = z.object({
  targetType: z.enum(['post', 'comment', 'user']),
  targetId: z.string().min(1),
  category: z.enum(['SPAM', 'HARASSMENT', 'SEXUAL_CONTENT', 'HATE', 'VIOLENCE', 'SCAM', 'OTHER']),
  reason: z.string().trim().min(4).max(500),
  details: z.string().trim().max(1000).optional(),
});

const reactionTypes = ['LIKE', 'LOVE', 'LAUGH', 'SAD', 'ANGRY'] as const;

function getProfileForUserId(userId: string) {
  return socialStore.state.profiles.find((profile) => profile.userId === userId) ?? null;
}

function makeHandle(user: { email: string | null; name: string; username?: string | null }, profile?: { username?: string | null } | null) {
  const username = profile?.username ?? user.username ?? user.email?.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24);
  return username || user.name.replace(/\s+/g, '').toLowerCase();
}

async function getUserById(id: string) {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        profile: {
          select: {
            displayName: true,
            username: true,
            bio: true,
            avatarUrl: true,
            coverUrl: true,
            website: true,
            location: true,
          },
        },
      },
    });
  }

  return fallbackStore.list().find((user) => user.id === id) ?? null;
}

async function getUserSummary(user: any) {
  const profile = user && 'profile' in user ? user.profile : await getProfilePayload(user.id);
  const safeProfile = profile
    ? {
        displayName: profile.displayName ?? user.name,
        username: profile.username ?? makeHandle(user, profile),
        bio: profile.bio ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        coverUrl: profile.coverUrl ?? null,
        website: profile.website ?? null,
        location: profile.location ?? null,
      }
    : {
        displayName: user.name,
        username: makeHandle(user),
        bio: null,
        avatarUrl: null,
        coverUrl: null,
        website: null,
        location: null,
      };

  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name,
    role: user.role ?? 'USER',
    status: user.status ?? 'ACTIVE',
    profile: {
      ...safeProfile,
      username: safeProfile.username ?? makeHandle(user),
    },
    handle: safeProfile.username ?? makeHandle(user),
    avatar: safeProfile.avatarUrl ?? '',
  };
}

async function getProfilePayload(userId: string) {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: {
        displayName: true,
        bio: true,
        avatarUrl: true,
        coverUrl: true,
        website: true,
        location: true,
      },
    });

    return profile;
  }

  return getProfileForUserId(userId);
}

async function getPostReactionCounts(postId: string) {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const reactions = await prisma.reaction.findMany({
      where: { postId },
      select: { type: true },
    });

    return Object.fromEntries(reactionTypes.map((type) => [type, reactions.filter((reaction) => reaction.type === type).length])) as Record<(typeof reactionTypes)[number], number>;
  }

  return Object.fromEntries(reactionTypes.map((type) => [type, socialStore.state.reactions.filter((reaction) => reaction.postId === postId && reaction.type === type).length])) as Record<(typeof reactionTypes)[number], number>;
}

async function getCurrentUserReaction(postId: string, userId: string) {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const reaction = await prisma.reaction.findFirst({
      where: { postId, userId },
      select: { type: true },
    });

    return reaction?.type ?? null;
  }

  const reaction = socialStore.state.reactions.find((entry) => entry.postId === postId && entry.userId === userId);
  return reaction?.type ?? null;
}

async function getFollowCounts(userId: string) {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const [followers, following] = await Promise.all([
      prisma.follow.count({ where: { followingId: userId } }),
      prisma.follow.count({ where: { followerId: userId } }),
    ]);

    return { followers, following };
  }

  const follows = socialStore.state.follows;
  return {
    followers: follows.filter((entry) => entry.followingId === userId).length,
    following: follows.filter((entry) => entry.followerId === userId).length,
  };
}

async function isFollowing(currentUserId: string, targetUserId: string) {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const follow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: currentUserId,
          followingId: targetUserId,
        },
      },
      select: { id: true },
    });

    return Boolean(follow);
  }

  return socialStore.state.follows.some(
    (entry) => entry.followerId === currentUserId && entry.followingId === targetUserId,
  );
}

async function canViewPost(post: { authorId: string; visibility?: string | null }, currentUserId?: string) {
  if (post.visibility !== 'FOLLOWERS' && post.visibility !== 'PRIVATE') {
    return true;
  }
  if (post.authorId === currentUserId) {
    return true;
  }
  return post.visibility === 'FOLLOWERS' && Boolean(currentUserId) && await isFollowing(currentUserId!, post.authorId);
}

async function getBlockStatus(currentUserId: string, targetUserId: string) {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const [blockedByMe, blockedMe] = await Promise.all([
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: currentUserId, blockedId: targetUserId } }, select: { id: true } }),
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: targetUserId, blockedId: currentUserId } }, select: { id: true } }),
    ]);
    return { blockedByMe: Boolean(blockedByMe), blockedMe: Boolean(blockedMe) };
  }

  return {
    blockedByMe: socialStore.state.blocks.some((entry) => entry.blockerId === currentUserId && entry.blockedId === targetUserId),
    blockedMe: socialStore.state.blocks.some((entry) => entry.blockerId === targetUserId && entry.blockedId === currentUserId),
  };
}

async function addNotification(recipientId: string, actorId: string | null, type: string, message: string) {
  if (!(await isNotificationEnabled(recipientId, type))) return;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    await prisma.notification.create({
      data: {
        recipientId,
        actorId: actorId ?? null,
        type,
        message,
      },
    });
    return;
  }

  socialStore.state.notifications.push({
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    recipientId,
    actorId,
    type,
    message,
    createdAt: new Date().toISOString(),
  });
}

async function serializePost(post: any, currentUserId?: string) {
  const author = await getUserById(post.authorId ?? post.author?.id);
  const authorSummary = author ? await getUserSummary(author) : null;
  const reactionCounts = await getPostReactionCounts(post.id);
  const currentUserReaction = currentUserId ? await getCurrentUserReaction(post.id, currentUserId) : null;
  const likeCount = reactionCounts.LIKE ?? 0;
  const commentCount = post.comments?.length ?? await (async () => {
    const dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) {
      return prisma.comment.count({ where: { postId: post.id } });
    }

    return socialStore.state.comments.filter((comment) => comment.postId === post.id).length;
  })();
  const dbAvailable = await isDatabaseAvailable();
  let shareCount = 0;
  let saveCount = 0;
  let savedByCurrentUser = false;
  if (dbAvailable) {
    const [shares, saves, saved] = await Promise.all([
      prisma.postShare.count({ where: { postId: post.id } }),
      prisma.postSave.count({ where: { postId: post.id } }),
      currentUserId ? prisma.postSave.findUnique({ where: { postId_userId: { postId: post.id, userId: currentUserId } }, select: { id: true } }) : null,
    ]);
    shareCount = shares;
    saveCount = saves;
    savedByCurrentUser = Boolean(saved);
  } else {
    shareCount = socialStore.state.postShares.filter((share) => share.postId === post.id).length;
    saveCount = socialStore.state.postSaves.filter((save) => save.postId === post.id).length;
    savedByCurrentUser = Boolean(currentUserId && socialStore.state.postSaves.some((save) => save.postId === post.id && save.userId === currentUserId));
  }

  return {
    id: post.id,
    content: post.content,
    imageUrl: post.imageUrl ?? null,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    visibility: post.visibility ?? 'PUBLIC',
    author: authorSummary ? {
      id: authorSummary.id,
      name: authorSummary.name,
      handle: authorSummary.handle,
      avatar: authorSummary.avatar,
      profile: authorSummary.profile,
    } : {
      id: 'unknown',
      name: 'Unknown user',
      email: '',
      handle: 'unknown',
      avatar: '',
      profile: null,
    },
    likes: likeCount,
    comments: commentCount,
    shares: shareCount,
    saved: saveCount,
    savedByCurrentUser: Boolean(savedByCurrentUser),
    reactionCounts,
    currentUserReaction,
    userReaction: currentUserReaction,
    authorFollowing: currentUserId ? await isFollowing(currentUserId, post.authorId ?? post.author?.id) : false,
  };
}

export const socialRouter = Router();

async function requireAccountAccess(req: any, res: any, next: any) {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  if (user.status === 'BANNED' || user.status === 'SUSPENDED') {
    return res.status(403).json({ message: 'Your account is restricted and cannot access the platform.' });
  }

  return next();
}

socialRouter.use(requireActiveAccountIfAuthenticated);

async function listTimedUpdates(req: any, res: Response, kind: 'STORY' | 'STATUS', responseKey: 'stories' | 'statuses') {
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const followedIds = dbAvailable
    ? (await prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } })).map((follow) => follow.followingId)
    : socialStore.state.follows.filter((follow) => follow.followerId === userId).map((follow) => follow.followingId);
  const authorIds = [userId, ...followedIds];
  const now = new Date();
  const records = dbAvailable
    ? await prisma.story.findMany({
        where: { authorId: { in: authorIds }, kind, expiresAt: { gt: now } },
        include: {
          author: { select: { id: true, name: true, email: true, profile: { select: { displayName: true, username: true, avatarUrl: true } } } },
          views: { where: { viewerId: userId }, select: { id: true } },
          _count: { select: { views: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      })
    : socialStore.state.stories.filter((story) => (story.kind ?? 'STORY') === kind && authorIds.includes(story.authorId) && new Date(story.expiresAt).getTime() > now.getTime())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-100);

  const stories = [];
  for (const story of records) {
    const authorId = story.authorId;
    const blockStatus = authorId === userId ? { blockedByMe: false, blockedMe: false } : await getBlockStatus(userId, authorId);
    if (blockStatus.blockedByMe || blockStatus.blockedMe) continue;
    const databaseStory = 'author' in story ? story : null;
    const author = databaseStory ? databaseStory.author : await getUserById(authorId);
    const views = databaseStory ? databaseStory._count.views : socialStore.state.storyViews.filter((view) => view.storyId === story.id).length;
    const viewedByMe = authorId === userId || (databaseStory ? databaseStory.views.length > 0 : socialStore.state.storyViews.some((view) => view.storyId === story.id && view.viewerId === userId));
    stories.push({
      id: story.id,
      authorId,
      text: story.text,
      mediaUrl: story.mediaUrl,
      createdAt: story.createdAt,
      expiresAt: story.expiresAt,
      viewCount: views,
      viewedByMe,
      author: author ? await getUserSummary(author) : null,
    });
  }

  return res.json({ [responseKey]: stories });
}

async function createTimedUpdate(req: any, res: Response, kind: 'STORY' | 'STATUS', responseKey: 'story' | 'status') {
  const payload = kind === 'STORY' ? createStorySchema.parse(req.body ?? {}) : createStatusSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  if (payload.mediaUrl) {
    const ownsMedia = videoMediaKeyFromUrl(payload.mediaUrl)
      ? await uploadedVideoBelongsTo(payload.mediaUrl, userId, process.env.NODE_ENV ?? 'development')
      : await uploadedMediaBelongsTo(payload.mediaUrl, userId, process.env.NODE_ENV ?? 'development');
    if (!ownsMedia) return res.status(403).json({ message: 'You can only publish media that you uploaded.' });
  }
  const text = payload.text?.trim() || null;
  const moderation = reviewContentForSafety({ type: 'post', text: text ?? '', userId });
  if (moderation === 'REMOVE') return res.status(400).json({ message: `This ${kind.toLowerCase()} violates NOVA Community & Safety Rules.` });
  if (moderation === 'REVIEW') return res.status(422).json({ message: `This ${kind.toLowerCase()} requires moderator review before publication.` });

  const now = new Date();
  const data = { authorId: userId, kind, text, mediaUrl: payload.mediaUrl ?? null, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) };
  const dbAvailable = await isDatabaseAvailable();
  const story = dbAvailable
    ? await prisma.story.create({ data })
    : { id: `story_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...data, createdAt: now };
  if (!dbAvailable) socialStore.state.stories.push({ ...story, createdAt: story.createdAt.toISOString(), expiresAt: story.expiresAt.toISOString() });
  const author = await getUserById(userId);
  return res.status(201).json({ [responseKey]: {
    ...story,
    createdAt: story.createdAt.toISOString(),
    expiresAt: story.expiresAt.toISOString(),
    viewCount: 0,
    viewedByMe: true,
    author: author ? await getUserSummary(author) : null,
  } });
}

socialRouter.get('/stories', requireAuth, (req, res) => listTimedUpdates(req, res, 'STORY', 'stories'));
socialRouter.get('/statuses', requireAuth, (req, res) => listTimedUpdates(req, res, 'STATUS', 'statuses'));
socialRouter.post('/stories', requireAuth, requireAccountAccess, (req, res) => createTimedUpdate(req, res, 'STORY', 'story'));
socialRouter.post('/statuses', requireAuth, requireAccountAccess, (req, res) => createTimedUpdate(req, res, 'STATUS', 'status'));

async function viewTimedUpdate(req: any, res: Response, kind: 'STORY' | 'STATUS') {
  const userId = req.user!.id;
  const storyId = String(req.params.id);
  const dbAvailable = await isDatabaseAvailable();
  const story = dbAvailable
    ? await prisma.story.findFirst({ where: { id: storyId, kind, expiresAt: { gt: new Date() } }, select: { id: true, authorId: true } })
    : socialStore.state.stories.find((entry) => entry.id === storyId && (entry.kind ?? 'STORY') === kind && new Date(entry.expiresAt).getTime() > Date.now());
  if (!story) return res.status(404).json({ message: 'Story not found.' });
  if (story.authorId !== userId) {
    const [following, blockStatus] = await Promise.all([isFollowing(userId, story.authorId), getBlockStatus(userId, story.authorId)]);
    if (!following || blockStatus.blockedByMe || blockStatus.blockedMe) return res.status(404).json({ message: 'Story not found.' });
  }

  if (story.authorId === userId) {
    const viewCount = dbAvailable ? await prisma.storyView.count({ where: { storyId } }) : socialStore.state.storyViews.filter((view) => view.storyId === storyId).length;
    return res.json({ viewed: true, viewCount });
  }

  if (dbAvailable) {
    await prisma.storyView.upsert({ where: { storyId_viewerId: { storyId, viewerId: userId } }, create: { storyId, viewerId: userId }, update: {} });
    const viewCount = await prisma.storyView.count({ where: { storyId } });
    return res.json({ viewed: true, viewCount });
  }

  if (!socialStore.state.storyViews.some((view) => view.storyId === storyId && view.viewerId === userId)) {
    socialStore.state.storyViews.push({ id: `story_view_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, storyId, viewerId: userId, viewedAt: new Date().toISOString() });
  }
  const viewCount = socialStore.state.storyViews.filter((view) => view.storyId === storyId).length;
  return res.json({ viewed: true, viewCount });
}

async function deleteTimedUpdate(req: any, res: Response, kind: 'STORY' | 'STATUS') {
  const storyId = String(req.params.id);
  if (await isDatabaseAvailable()) {
    const deleted = await prisma.story.deleteMany({ where: { id: storyId, authorId: req.user!.id, kind } });
    if (!deleted.count) return res.status(404).json({ message: 'Story not found.' });
  } else {
    const index = socialStore.state.stories.findIndex((story) => story.id === storyId && story.authorId === req.user!.id && (story.kind ?? 'STORY') === kind);
    if (index < 0) return res.status(404).json({ message: 'Story not found.' });
    socialStore.state.stories.splice(index, 1);
    socialStore.state.storyViews = socialStore.state.storyViews.filter((view) => view.storyId !== storyId);
  }
  return res.json({ deleted: true });
}

socialRouter.post('/stories/:id/view', requireAuth, (req, res) => viewTimedUpdate(req, res, 'STORY'));
socialRouter.post('/statuses/:id/view', requireAuth, (req, res) => viewTimedUpdate(req, res, 'STATUS'));
socialRouter.delete('/stories/:id', requireAuth, requireAccountAccess, (req, res) => deleteTimedUpdate(req, res, 'STORY'));
socialRouter.delete('/statuses/:id', requireAuth, requireAccountAccess, (req, res) => deleteTimedUpdate(req, res, 'STATUS'));

socialRouter.get('/users', async (req, res) => {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        profile: {
          select: {
            displayName: true,
            username: true,
            bio: true,
            avatarUrl: true,
            coverUrl: true,
            website: true,
            location: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const result = await Promise.all(users.map(async (user) => {
      const counts = await getFollowCounts(user.id);
      const relationship = req.user && req.user.id !== user.id
        ? { isFollowing: await isFollowing(req.user.id, user.id), ...await getBlockStatus(req.user.id, user.id) }
        : null;
      return {
        ...await getUserSummary(user),
        followerCount: counts.followers,
        followingCount: counts.following,
        ...(relationship ? { relationship } : {}),
      };
    }));

    return res.json({ users: result });
  }

  const users = fallbackStore.list().map((user) => ({ ...user, profile: getProfileForUserId(user.id) }));
  const result = await Promise.all(users.map(async (user) => {
    const counts = await getFollowCounts(user.id);
    const relationship = req.user && req.user.id !== user.id
      ? { isFollowing: await isFollowing(req.user.id, user.id), ...await getBlockStatus(req.user.id, user.id) }
      : null;
    return {
      ...await getUserSummary(user),
      followerCount: counts.followers,
      followingCount: counts.following,
      ...(relationship ? { relationship } : {}),
    };
  }));

  return res.json({ users: result });
});

socialRouter.get('/users/:id', async (req, res) => {
  const userId = String(req.params.id);
  const user = await getUserById(userId);

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const profile = await getProfilePayload(user.id);
  const counts = await getFollowCounts(user.id);
  const summary = await getUserSummary({ ...user, profile });
  const relationship = req.user && req.user.id !== user.id
    ? { isFollowing: await isFollowing(req.user.id, user.id), ...await getBlockStatus(req.user.id, user.id) }
    : null;

  return res.json({
    user: {
      ...summary,
      followerCount: counts.followers,
      followingCount: counts.following,
      ...(relationship ? { relationship } : {}),
    },
  });
});

socialRouter.get('/users/:id/profile', async (req, res: Response) => {
  const userId = String(req.params.id);
  const user = await getUserById(userId);

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  return res.json({
    profile: await getProfilePayload(user.id),
    user: await getUserSummary({ ...user, profile: await getProfilePayload(user.id) }),
  });
});

socialRouter.put('/users/me/profile', requireAuth, requireAccountAccess, async (req, res) => {
  const payload = updateProfileSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  for (const mediaUrl of [payload.avatarUrl, payload.coverUrl]) {
    if (mediaUrl && !(await uploadedMediaBelongsTo(mediaUrl, userId, process.env.NODE_ENV ?? 'development'))) {
      return res.status(403).json({ message: 'You can only use images that you uploaded.' });
    }
  }
  const dbAvailable = await isDatabaseAvailable();

  const profileData = {
    displayName: payload.displayName ?? null,
    username: payload.username ?? null,
    bio: payload.bio ?? null,
    avatarUrl: payload.avatarUrl === '' ? null : payload.avatarUrl ?? null,
    coverUrl: payload.coverUrl === '' ? null : payload.coverUrl ?? null,
    website: payload.website === '' ? null : payload.website ?? null,
    location: payload.location ?? null,
  };

  if (dbAvailable) {
    const existingProfile = await prisma.profile.findUnique({ where: { userId } });
    const updatedProfile = existingProfile
      ? await prisma.profile.update({
          where: { userId },
          data: profileData,
        })
      : await prisma.profile.create({
          data: {
            userId,
            ...profileData,
          },
        });

    return res.json({ profile: updatedProfile });
  }

  const existing = getProfileForUserId(userId);
  const updated = existing
    ? { ...existing, ...profileData, updatedAt: new Date().toISOString() }
    : {
        userId,
        displayName: null,
        username: null,
        bio: null,
        avatarUrl: null,
        coverUrl: null,
        website: null,
        location: null,
        updatedAt: new Date().toISOString(),
      };

  const fallbackProfile = {
    userId,
    displayName: updated.displayName ?? null,
    username: updated.username ?? null,
    bio: updated.bio ?? null,
    avatarUrl: updated.avatarUrl ?? null,
    coverUrl: updated.coverUrl ?? null,
    website: updated.website ?? null,
    location: updated.location ?? null,
    updatedAt: updated.updatedAt,
  };

  if (existing) {
    const index = socialStore.state.profiles.findIndex((entry) => entry.userId === userId);
    socialStore.state.profiles[index] = fallbackProfile;
  } else {
    socialStore.state.profiles.push(fallbackProfile);
  }

  return res.json({ profile: fallbackProfile });
});

socialRouter.post('/users/:id/follow', requireAuth, requireAccountAccess, async (req, res) => {
  const targetId = String(req.params.id);
  const userId = req.user!.id;

  if (userId === targetId) {
    return res.status(400).json({ message: 'You cannot follow yourself.' });
  }

  const targetUser = await getUserById(targetId);
  if (!targetUser) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const blockStatus = await getBlockStatus(userId, targetId);
  if (blockStatus.blockedByMe || blockStatus.blockedMe) {
    return res.status(403).json({ message: 'You cannot follow a user involved in a block relationship.' });
  }

  const alreadyFollowing = await isFollowing(userId, targetId);
  if (alreadyFollowing) {
    return res.status(409).json({ message: 'You are already following this user.' });
  }

  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    await prisma.follow.create({ data: { followerId: userId, followingId: targetId } });
    await addNotification(targetId, userId, 'follow', `${(await getUserById(userId))?.name ?? 'Someone'} followed you.`);
  } else {
    socialStore.state.follows.push({
      id: `follow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      followerId: userId,
      followingId: targetId,
      createdAt: new Date().toISOString(),
    });
    await addNotification(targetId, userId, 'follow', `${(await getUserById(userId))?.name ?? 'Someone'} followed you.`);
  }

  const counts = await getFollowCounts(targetId);
  const currentCounts = await getFollowCounts(userId);

  return res.json({
    following: true,
    followerCount: counts.followers,
    followingCount: currentCounts.following,
  });
});

socialRouter.delete('/users/:id/follow', requireAuth, requireAccountAccess, async (req, res) => {
  const targetId = String(req.params.id);
  const userId = req.user!.id;

  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const follow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: userId,
          followingId: targetId,
        },
      },
      select: { id: true },
    });

    if (!follow) {
      return res.status(404).json({ message: 'Follow relationship not found.' });
    }

    await prisma.follow.delete({ where: { id: follow.id } });
  } else {
    const index = socialStore.state.follows.findIndex(
      (entry) => entry.followerId === userId && entry.followingId === targetId,
    );

    if (index === -1) {
      return res.status(404).json({ message: 'Follow relationship not found.' });
    }

    socialStore.state.follows.splice(index, 1);
  }

  const counts = await getFollowCounts(targetId);
  const currentCounts = await getFollowCounts(userId);

  return res.json({
    following: false,
    followerCount: counts.followers,
    followingCount: currentCounts.following,
  });
});

socialRouter.post('/posts', requireAuth, requireAccountAccess, async (req, res) => {
  const payload = createPostSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  if (payload.imageUrl) {
    const nodeEnv = process.env.NODE_ENV ?? 'development';
    const ownsUploadedMedia = videoMediaKeyFromUrl(payload.imageUrl)
      ? await uploadedVideoBelongsTo(payload.imageUrl, userId, nodeEnv)
      : await uploadedMediaBelongsTo(payload.imageUrl, userId, nodeEnv);
    if (!ownsUploadedMedia) {
      return res.status(403).json({ message: 'You can only publish media that you uploaded.' });
    }
  }

  const moderation = reviewContentForSafety({ type: 'post', text: payload.content, userId });
  if (moderation === 'REMOVE') {
    return res.status(400).json({ message: 'This post violates NOVA Community & Safety Rules.' });
  }
  if (moderation === 'REVIEW') {
    return res.status(422).json({ message: 'This content requires moderator review before publication.' });
  }

  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const post = await prisma.post.create({
      data: {
        authorId: userId,
        content: payload.content,
        imageUrl: payload.imageUrl || null,
        visibility: payload.visibility,
      },
    });

    return res.status(201).json({ post: await serializePost(post, userId) });
  }

  const record = {
    id: `post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    authorId: userId,
    content: payload.content,
    imageUrl: payload.imageUrl || null,
    visibility: payload.visibility,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  socialStore.state.posts.push(record);
  return res.status(201).json({ post: await serializePost(record, userId) });
});

socialRouter.get('/posts', async (req, res) => {
  const limit = Number(req.query.limit ?? 10);
  const offset = Number(req.query.offset ?? 0);
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const followedIds = req.user
      ? (await prisma.follow.findMany({ where: { followerId: req.user.id }, select: { followingId: true } })).map((follow) => follow.followingId)
      : [];
    const posts = await prisma.post.findMany({
      where: {
        OR: [
          { visibility: 'PUBLIC' },
          ...(req.user ? [{ authorId: req.user.id }, { visibility: 'FOLLOWERS' as const, authorId: { in: followedIds } }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: Number.isFinite(limit) && limit > 0 ? limit : 10,
      include: { comments: true },
    });

    const result = await Promise.all(posts.map((post) => serializePost(post, req.user?.id)));
    return res.json({ posts: result });
  }

  const visiblePosts = (await Promise.all(socialStore.state.posts.map(async (post) => (
    await canViewPost(post, req.user?.id) ? post : null
  )))).filter((post): post is NonNullable<typeof post> => post !== null);
  const posts = visiblePosts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(offset, offset + (Number.isFinite(limit) && limit > 0 ? limit : 10));
  const result = await Promise.all(posts.map((post) => serializePost(post, req.user?.id)));
  return res.json({ posts: result });
});

socialRouter.get('/posts/:id', async (req, res) => {
  const postId = String(req.params.id);
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { comments: true },
    });

    if (!post) {
      return res.status(404).json({ message: 'Post not found.' });
    }
    if (!await canViewPost(post, req.user?.id)) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    return res.json({ post: await serializePost(post, req.user?.id) });
  }

  const post = socialStore.state.posts.find((entry) => entry.id === postId);
  if (!post) {
    return res.status(404).json({ message: 'Post not found.' });
  }
  if (!await canViewPost(post, req.user?.id)) {
    return res.status(404).json({ message: 'Post not found.' });
  }

  return res.json({ post: await serializePost(post, req.user?.id) });
});

socialRouter.patch('/posts/:id', requireAuth, requireAccountAccess, async (req, res) => {
  const postId = String(req.params.id);
  const payload = updatePostSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  if (payload.imageUrl) {
    const nodeEnv = process.env.NODE_ENV ?? 'development';
    const ownsUploadedMedia = videoMediaKeyFromUrl(payload.imageUrl)
      ? await uploadedVideoBelongsTo(payload.imageUrl, userId, nodeEnv)
      : await uploadedMediaBelongsTo(payload.imageUrl, userId, nodeEnv);
    if (!ownsUploadedMedia) {
      return res.status(403).json({ message: 'You can only use media that you uploaded.' });
    }
  }
  const dbAvailable = await isDatabaseAvailable();
  const post = dbAvailable
    ? await prisma.post.findUnique({ where: { id: postId } })
    : socialStore.state.posts.find((entry) => entry.id === postId) ?? null;

  if (!post) {
    return res.status(404).json({ message: 'Post not found.' });
  }
  if (post.authorId !== userId && !['MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ message: 'You may only edit your own posts.' });
  }
  if (payload.content !== undefined) {
    const moderation = reviewContentForSafety({ type: 'post', text: payload.content, userId });
    if (moderation === 'REMOVE') {
      return res.status(400).json({ message: 'This post violates NOVA Community & Safety Rules.' });
    }
    if (moderation === 'REVIEW') {
      return res.status(422).json({ message: 'This content requires moderator review before publication.' });
    }
  }

  const updates = {
    ...(payload.content !== undefined ? { content: payload.content } : {}),
    ...(payload.imageUrl !== undefined ? { imageUrl: payload.imageUrl || null } : {}),
    ...(payload.visibility !== undefined ? { visibility: payload.visibility } : {}),
  };
  const updated = dbAvailable
    ? await prisma.post.update({ where: { id: postId }, data: updates })
    : Object.assign(post, updates, { updatedAt: new Date().toISOString() });

  return res.json({ post: await serializePost(updated, userId) });
});

socialRouter.post('/posts/:id/save', requireAuth, requireAccountAccess, async (req, res) => {
  const postId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const post = dbAvailable
    ? await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true, visibility: true } })
    : socialStore.state.posts.find((entry) => entry.id === postId) ?? null;

  if (!post || !await canViewPost(post, userId)) {
    return res.status(404).json({ message: 'Post not found.' });
  }
  if (dbAvailable) {
    await prisma.postSave.upsert({
      where: { postId_userId: { postId, userId } },
      create: { postId, userId },
      update: {},
    });
    return res.json({
      saved: true,
      savedCount: await prisma.postSave.count({ where: { postId } }),
    });
  }

  if (!socialStore.state.postSaves.some((save) => save.postId === postId && save.userId === userId)) {
    socialStore.state.postSaves.push({
      id: `post_save_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      postId,
      userId,
      createdAt: new Date().toISOString(),
    });
  }
  return res.json({
    saved: true,
    savedCount: socialStore.state.postSaves.filter((save) => save.postId === postId).length,
  });
});

socialRouter.delete('/posts/:id/save', requireAuth, requireAccountAccess, async (req, res) => {
  const postId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const post = dbAvailable
    ? await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true, visibility: true } })
    : socialStore.state.posts.find((entry) => entry.id === postId) ?? null;

  if (!post || !await canViewPost(post, userId)) {
    return res.status(404).json({ message: 'Post not found.' });
  }
  if (dbAvailable) {
    await prisma.postSave.deleteMany({ where: { postId, userId } });
    return res.json({
      saved: false,
      savedCount: await prisma.postSave.count({ where: { postId } }),
    });
  }

  socialStore.state.postSaves = socialStore.state.postSaves.filter((save) => !(save.postId === postId && save.userId === userId));
  return res.json({
    saved: false,
    savedCount: socialStore.state.postSaves.filter((save) => save.postId === postId).length,
  });
});

socialRouter.post('/posts/:id/share', requireAuth, requireAccountAccess, async (req, res) => {
  const postId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const post = dbAvailable
    ? await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true, visibility: true } })
    : socialStore.state.posts.find((entry) => entry.id === postId) ?? null;

  if (!post || !await canViewPost(post, userId)) {
    return res.status(404).json({ message: 'Post not found.' });
  }
  if (dbAvailable) {
    await prisma.postShare.create({ data: { postId, userId } });
    return res.status(201).json({ shares: await prisma.postShare.count({ where: { postId } }) });
  }

  socialStore.state.postShares.push({
    id: `post_share_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    postId,
    userId,
    createdAt: new Date().toISOString(),
  });
  return res.status(201).json({ shares: socialStore.state.postShares.filter((share) => share.postId === postId).length });
});

socialRouter.delete('/posts/:id', requireAuth, async (req, res) => {
  const postId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true, id: true } });

    if (!post) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    if (post.authorId !== userId && !['MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
      return res.status(403).json({ message: 'You may only delete your own posts.' });
    }

    await prisma.post.delete({ where: { id: postId } });
    return res.json({ message: 'Post deleted.' });
  }

  const index = socialStore.state.posts.findIndex((post) => post.id === postId);
  if (index === -1) {
    return res.status(404).json({ message: 'Post not found.' });
  }

  const post = socialStore.state.posts[index];
  if (post.authorId !== userId && !['MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ message: 'You may only delete your own posts.' });
  }

  socialStore.state.posts.splice(index, 1);
  return res.json({ message: 'Post deleted.' });
});

socialRouter.post('/posts/:id/react', requireAuth, requireAccountAccess, async (req, res) => {
  const postId = String(req.params.id);
  const payload = reactSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const post = dbAvailable
    ? await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true, visibility: true } })
    : socialStore.state.posts.find((entry) => entry.id === postId) ?? null;
  if (!post || !await canViewPost(post, userId)) {
    return res.status(404).json({ message: 'Post not found.' });
  }

  if (dbAvailable) {
    const existing = await prisma.reaction.findFirst({
      where: { userId, postId },
      select: { id: true, type: true },
    });

    if (existing) {
      await prisma.reaction.update({
        where: { id: existing.id },
        data: { type: payload.type },
      });
    } else {
      await prisma.reaction.create({
        data: { userId, postId, type: payload.type },
      });
      const post = await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true } });
      if (post && post.authorId !== userId) {
        await addNotification(post.authorId, userId, 'reaction', `${(await getUserById(userId))?.name ?? 'Someone'} reacted to your post.`);
      }
    }

    const counts = await getPostReactionCounts(postId);
    return res.json({ reaction: { type: payload.type }, reactionCounts: counts });
  }

  const currentReaction = socialStore.state.reactions.find((reaction) => reaction.postId === postId && reaction.userId === userId);
  if (currentReaction) {
    currentReaction.type = payload.type;
  } else {
    socialStore.state.reactions.push({
      id: `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      postId,
      type: payload.type,
      createdAt: new Date().toISOString(),
    });
    const post = socialStore.state.posts.find((entry) => entry.id === postId);
    if (post && post.authorId !== userId) {
      await addNotification(post.authorId, userId, 'reaction', `${(await getUserById(userId))?.name ?? 'Someone'} reacted to your post.`);
    }
  }

  const counts = await getPostReactionCounts(postId);
  return res.json({ reaction: { type: payload.type }, reactionCounts: counts });
});

socialRouter.delete('/posts/:id/react', requireAuth, requireAccountAccess, async (req, res) => {
  const postId = String(req.params.id);
  const userId = req.user!.id;

  const dbAvailable = await isDatabaseAvailable();
  const post = dbAvailable
    ? await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true, visibility: true } })
    : socialStore.state.posts.find((entry) => entry.id === postId) ?? null;
  if (!post || !await canViewPost(post, userId)) {
    return res.status(404).json({ message: 'Post not found.' });
  }

  if (dbAvailable) {
    const reaction = await prisma.reaction.findFirst({
      where: { userId, postId },
      select: { id: true },
    });

    if (!reaction) {
      return res.status(404).json({ message: 'No reaction found.' });
    }

    await prisma.reaction.delete({ where: { id: reaction.id } });
    const counts = await getPostReactionCounts(postId);
    return res.json({ reaction: null, reactionCounts: counts });
  }

  const index = socialStore.state.reactions.findIndex((reaction) => reaction.postId === postId && reaction.userId === userId);
  if (index === -1) {
    return res.status(404).json({ message: 'No reaction found.' });
  }

  socialStore.state.reactions.splice(index, 1);
  const counts = await getPostReactionCounts(postId);
  return res.json({ reaction: null, reactionCounts: counts });
});

socialRouter.post('/posts/:id/comments', requireAuth, requireAccountAccess, async (req, res) => {
  const postId = String(req.params.id);
  const payload = commentSchema.parse(req.body ?? {});
  const userId = req.user!.id;

  const moderation = reviewContentForSafety({ type: 'comment', text: payload.content, userId });
  if (moderation === 'REMOVE') {
    return res.status(400).json({ message: 'This comment violates NOVA Community & Safety Rules.' });
  }
  if (moderation === 'REVIEW') {
    return res.status(422).json({ message: 'This content requires moderator review before publication.' });
  }

  const dbAvailable = await isDatabaseAvailable();
  const post = dbAvailable
    ? await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true, visibility: true } })
    : socialStore.state.posts.find((entry) => entry.id === postId) ?? null;
  if (!post || !await canViewPost(post, userId)) {
    return res.status(404).json({ message: 'Post not found.' });
  }

  let parentId: string | null = null;
  if (payload.parentId) {
    const parent = dbAvailable
      ? await prisma.comment.findUnique({ where: { id: payload.parentId }, select: { id: true, postId: true, parentId: true } })
      : socialStore.state.comments.find((comment) => comment.id === payload.parentId) ?? null;
    if (!parent || parent.postId !== postId || parent.parentId) {
      return res.status(400).json({ message: 'Replies must reference a top-level comment on this post.' });
    }
    parentId = parent.id;
  }

  let commentRecord: Awaited<ReturnType<typeof prisma.comment.create>> | { id: string; postId: string; authorId: string; content: string; createdAt: string; updatedAt: string; parentId: string | null; };

  if (dbAvailable) {
    commentRecord = await prisma.comment.create({ data: { postId, authorId: userId, content: payload.content, parentId } });
  } else {
    commentRecord = {
      id: `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      postId,
      authorId: userId,
      content: payload.content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      parentId,
    };
    socialStore.state.comments.push({
      id: commentRecord.id,
      postId: commentRecord.postId,
      authorId: commentRecord.authorId,
      parentId: commentRecord.parentId,
      content: commentRecord.content,
      createdAt: commentRecord.createdAt,
      updatedAt: commentRecord.updatedAt,
    });
  }

  const author = await getUserById(userId);
  const authorSummary = author ? await getUserSummary(author) : null;
  const result = {
    id: commentRecord.id,
    parentId: commentRecord.parentId,
    content: commentRecord.content,
    createdAt: commentRecord.createdAt,
    updatedAt: commentRecord.updatedAt,
    author: {
      id: authorSummary?.id ?? userId,
      name: authorSummary?.name ?? 'Unknown user',
      handle: authorSummary?.handle ?? 'unknown',
      avatar: authorSummary?.avatar ?? '',
      profile: authorSummary?.profile ?? null,
    },
  };

  const notificationPost = await (dbAvailable ? prisma.post.findUnique({ where: { id: postId }, select: { authorId: true } }) : Promise.resolve(socialStore.state.posts.find((entry) => entry.id === postId)));
  if (notificationPost && notificationPost.authorId !== userId) {
    await addNotification(notificationPost.authorId, userId, 'comment', `${(await getUserById(userId))?.name ?? 'Someone'} commented on your post.`);
  }

  return res.status(201).json({ comment: result });
});

socialRouter.get('/posts/:id/comments', async (req, res) => {
  const postId = String(req.params.id);
  const dbAvailable = await isDatabaseAvailable();
  const post = dbAvailable
    ? await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true, visibility: true } })
    : socialStore.state.posts.find((entry) => entry.id === postId) ?? null;
  if (!post || !await canViewPost(post, req.user?.id)) {
    return res.status(404).json({ message: 'Post not found.' });
  }

  if (dbAvailable) {
    const comments = await prisma.comment.findMany({
      where: { postId },
      orderBy: { createdAt: 'desc' },
      include: { author: { include: { profile: true } } },
    });

    return res.json({ comments: comments.map((comment) => ({
      id: comment.id,
      parentId: comment.parentId,
      content: comment.content,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: {
        id: comment.author.id,
        name: comment.author.name,
        email: comment.author.email,
        handle: comment.author.profile?.displayName ?? comment.author.email?.split('@')[0] ?? 'member',
        avatar: comment.author.profile?.avatarUrl ?? '',
      },
    })) });
  }

  const comments = socialStore.state.comments.filter((comment) => comment.postId === postId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const result = await Promise.all(comments.map(async (comment) => {
    const author = await getUserById(comment.authorId);
    return {
      id: comment.id,
      parentId: comment.parentId ?? null,
      content: comment.content,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: {
        id: comment.authorId,
        name: author?.name ?? 'Unknown user',
        email: author?.email ?? '',
        handle: (await getUserSummary(author!)).handle,
        avatar: (await getUserSummary(author!)).avatar,
      },
    };
  }));

  return res.json({ comments: result });
});

socialRouter.get('/notifications', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);

  if (dbAvailable) {
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { recipientId: userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notification.count({ where: { recipientId: userId, readAt: null } }),
    ]);

    return res.json({ notifications, unreadCount });
  }

  const notifications = socialStore.state.notifications.filter((notification) => notification.recipientId === userId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  const unreadCount = socialStore.state.notifications.filter((notification) => notification.recipientId === userId && !notification.readAt).length;
  return res.json({ notifications, unreadCount });
});

socialRouter.post('/notifications/:id/read', requireAuth, requireAccountAccess, async (req, res) => {
  const notificationId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const notification = await prisma.notification.findFirst({
      where: { id: notificationId, recipientId: userId },
      select: { id: true },
    });

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found.' });
    }

    await prisma.notification.update({
      where: { id: notification.id },
      data: { readAt: new Date() },
    });

    return res.json({ message: 'Notification marked as read.' });
  }

  const index = socialStore.state.notifications.findIndex(
    (notification) => notification.id === notificationId && notification.recipientId === userId,
  );

  if (index === -1) {
    return res.status(404).json({ message: 'Notification not found.' });
  }

  socialStore.state.notifications[index].readAt = new Date().toISOString();
  return res.json({ message: 'Notification marked as read.' });
});

socialRouter.post('/notifications/read-all', requireAuth, requireAccountAccess, async (req, res) => {
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const result = await prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ message: 'All notifications marked as read.', count: result.count });
  }

  const updated = socialStore.state.notifications.filter((notification) => notification.recipientId === userId && !notification.readAt);
  for (const notification of updated) {
    notification.readAt = new Date().toISOString();
  }

  return res.json({ message: 'All notifications marked as read.', count: updated.length });
});

socialRouter.post('/reports', requireAuth, requireAccountAccess, async (req, res) => {
  const payload = reportSchema.parse(req.body ?? {});
  const userId = req.user!.id;

  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const targetExists = payload.targetType === 'post'
      ? await prisma.post.findUnique({ where: { id: payload.targetId }, select: { id: true } })
      : payload.targetType === 'comment'
        ? await prisma.comment.findUnique({ where: { id: payload.targetId }, select: { id: true } })
        : await prisma.user.findUnique({ where: { id: payload.targetId }, select: { id: true } });

    if (!targetExists) {
      return res.status(404).json({ message: 'Report target not found.' });
    }

    const created = await prisma.report.create({
      data: {
        reporterId: userId,
        postId: payload.targetType === 'post' ? payload.targetId : null,
        commentId: payload.targetType === 'comment' ? payload.targetId : null,
        targetUserId: payload.targetType === 'user' ? payload.targetId : null,
        category: payload.category,
        details: [payload.reason, payload.details].filter(Boolean).join('\n\n'),
      },
    });

    return res.status(201).json({ report: created, message: 'Report submitted successfully.' });
  }

  socialStore.state.reports.push({
    id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    reporterId: userId,
    targetType: payload.targetType,
    targetId: payload.targetId,
    category: payload.category,
    reason: payload.reason,
    details: payload.details ?? null,
    createdAt: new Date().toISOString(),
  });

  return res.status(201).json({ message: 'Report submitted successfully.' });
});

socialRouter.post('/users/:id/block', requireAuth, requireAccountAccess, async (req, res) => {
  const targetId = String(req.params.id);
  const userId = req.user!.id;

  if (userId === targetId) {
    return res.status(400).json({ message: 'You cannot block yourself.' });
  }

  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const existing = await prisma.block.findUnique({
      where: {
        blockerId_blockedId: {
          blockerId: userId,
          blockedId: targetId,
        },
      },
      select: { id: true },
    });

    if (existing) {
      return res.status(409).json({ message: 'User already blocked.' });
    }

    await prisma.block.create({
      data: {
        blockerId: userId,
        blockedId: targetId,
      },
    });

    return res.json({ blocked: true });
  }

  const existing = socialStore.state.blocks.filter((entry) => entry.blockerId === userId && entry.blockedId === targetId);
  if (existing.length > 0) {
    return res.status(409).json({ message: 'User already blocked.' });
  }

  socialStore.state.blocks.push({
    id: `block_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    blockerId: userId,
    blockedId: targetId,
    createdAt: new Date().toISOString(),
  });

  return res.json({ blocked: true });
});

socialRouter.delete('/users/:id/block', requireAuth, requireAccountAccess, async (req, res) => {
  const userId = req.user!.id;
  const targetId = String(req.params.id);
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    await prisma.block.deleteMany({
      where: { blockerId: userId, blockedId: targetId },
    });
    return res.json({ blocked: false });
  }

  socialStore.state.blocks = socialStore.state.blocks.filter(
    (block) => !(block.blockerId === userId && block.blockedId === targetId),
  );
  return res.json({ blocked: false });
});

socialRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
