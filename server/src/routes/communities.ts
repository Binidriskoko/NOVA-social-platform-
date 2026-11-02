import { Router } from 'express';
import { z } from 'zod';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { findUserById } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { createNotification } from '../lib/platform.js';
import { reviewContentForSafety } from '../lib/moderation.js';
import { requireActiveAccountIfAuthenticated, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireActiveAccountIfAuthenticated);

const createCommunitySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(1000).optional(),
  avatarUrl: z.string().url().max(500).optional(),
  type: z.enum(['GROUP', 'COMMUNITY', 'CHANNEL']).default('COMMUNITY'),
  isPrivate: z.boolean().default(false),
});
const announcementSchema = z.object({ content: z.string().trim().min(1).max(2500), imageUrl: z.string().url().max(500).optional() });
const inviteSchema = z.object({ userId: z.string().min(1) });
const roleSchema = z.object({ role: z.enum(['MEMBER', 'MODERATOR']) });
const reportSchema = z.object({ category: z.enum(['SPAM', 'HARASSMENT', 'SEXUAL_CONTENT', 'HATE', 'VIOLENCE', 'SCAM', 'OTHER']), reason: z.string().trim().min(4).max(500) });

const makeId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

async function getCommunity(communityId: string) {
  if (await isDatabaseAvailable()) {
    return prisma.community.findUnique({ where: { id: communityId } });
  }
  return socialStore.state.communities.find((community) => community.id === communityId) ?? null;
}

async function getMember(communityId: string, userId: string) {
  if (await isDatabaseAvailable()) {
    return prisma.communityMember.findUnique({ where: { communityId_userId: { communityId, userId } } });
  }
  return socialStore.state.communityMembers.find((member) => member.communityId === communityId && member.userId === userId) ?? null;
}

async function canModerate(communityId: string, userId: string) {
  const member = await getMember(communityId, userId);
  return member?.role === 'OWNER' || member?.role === 'MODERATOR';
}

async function getBlockedUserIds(userId: string) {
  if (await isDatabaseAvailable()) {
    const blocks = await prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    return blocks.map((block) => block.blockerId === userId ? block.blockedId : block.blockerId);
  }
  return socialStore.state.blocks
    .filter((block) => block.blockerId === userId || block.blockedId === userId)
    .map((block) => block.blockerId === userId ? block.blockedId : block.blockerId);
}

export const communitiesRouter = router;

router.get('/communities', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  if (await isDatabaseAvailable()) {
    const communities = await prisma.community.findMany({
      where: { OR: [{ isPrivate: false }, { members: { some: { userId } } }] },
      include: { _count: { select: { members: true } }, members: { where: { userId }, select: { role: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ communities: communities.map((community) => ({
      ...community,
      memberCount: community._count.members,
      joined: community.members.length > 0,
      myRole: community.members[0]?.role ?? null,
      _count: undefined,
      members: undefined,
    })) });
  }

  return res.json({ communities: socialStore.state.communities.filter((community) => !community.isPrivate || socialStore.state.communityMembers.some((member) => member.communityId === community.id && member.userId === userId)).map((community) => {
    const members = socialStore.state.communityMembers.filter((member) => member.communityId === community.id);
    const mine = members.find((member) => member.userId === userId);
    return { ...community, memberCount: members.length, joined: Boolean(mine), myRole: mine?.role ?? null };
  }) });
});

router.post('/communities', requireAuth, async (req, res) => {
  const payload = createCommunitySchema.parse(req.body ?? {});
  const baseSlug = slugify(payload.name) || 'community';
  if (await isDatabaseAvailable()) {
    let slug = baseSlug;
    let suffix = 2;
    while (await prisma.community.findUnique({ where: { slug }, select: { id: true } })) slug = `${baseSlug}-${suffix++}`;
    const community = await prisma.community.create({
      data: {
        ownerId: req.user!.id,
        name: payload.name,
        slug,
        description: payload.description ?? null,
        avatarUrl: payload.avatarUrl ?? null,
        type: payload.type,
        isPrivate: payload.isPrivate,
        members: { create: { userId: req.user!.id, role: 'OWNER' } },
      },
      include: { _count: { select: { members: true } } },
    });
    return res.status(201).json({ community: { ...community, memberCount: community._count.members, joined: true, myRole: 'OWNER', _count: undefined } });
  }

  let slug = baseSlug;
  let suffix = 2;
  while (socialStore.state.communities.some((community) => community.slug === slug)) slug = `${baseSlug}-${suffix++}`;
  const now = new Date().toISOString();
  const community = { id: makeId('community'), ownerId: req.user!.id, name: payload.name, slug, description: payload.description ?? null, avatarUrl: payload.avatarUrl ?? null, type: payload.type, isPrivate: payload.isPrivate, createdAt: now, updatedAt: now };
  socialStore.state.communities.push(community);
  socialStore.state.communityMembers.push({ id: makeId('community_member'), communityId: community.id, userId: req.user!.id, role: 'OWNER', joinedAt: now });
  return res.status(201).json({ community: { ...community, memberCount: 1, joined: true, myRole: 'OWNER' } });
});

router.get('/communities/:id', requireAuth, async (req, res) => {
  const communityId = String(req.params.id);
  const community = await getCommunity(communityId);
  if (!community) return res.status(404).json({ message: 'Community not found.' });
  if (community.isPrivate && !(await getMember(communityId, req.user!.id))) return res.status(404).json({ message: 'Community not found.' });
  const blockedUserIds = await getBlockedUserIds(req.user!.id);
  if (await isDatabaseAvailable()) {
    const [members, posts, mine] = await Promise.all([
      prisma.communityMember.findMany({ where: { communityId }, include: { user: { select: { id: true, name: true } } }, orderBy: { joinedAt: 'asc' } }),
      prisma.post.findMany({ where: { communityId, moderationHiddenAt: null, ...(blockedUserIds.length ? { authorId: { notIn: blockedUserIds } } : {}) }, orderBy: { createdAt: 'desc' }, take: 30 }),
      getMember(communityId, req.user!.id),
    ]);
    return res.json({ community: { ...community, members, posts, joined: Boolean(mine), myRole: mine?.role ?? null, memberCount: members.length } });
  }
  const members = socialStore.state.communityMembers.filter((member) => member.communityId === communityId).map((member) => ({ ...member, user: findUserById(member.userId) ? { id: member.userId, name: findUserById(member.userId)!.name } : null }));
  const blocked = new Set(blockedUserIds);
  const posts = socialStore.state.posts
    .filter((post) => post.communityId === communityId && !post.moderationHiddenAt && !blocked.has(post.authorId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const mine = members.find((member) => member.userId === req.user!.id);
  return res.json({ community: { ...community, members, posts, joined: Boolean(mine), myRole: mine?.role ?? null, memberCount: members.length } });
});

router.post('/communities/:id/join', requireAuth, async (req, res) => {
  const communityId = String(req.params.id);
  const community = await getCommunity(communityId);
  if (!community) return res.status(404).json({ message: 'Community not found.' });
  if (community.isPrivate) return res.status(403).json({ message: 'Private communities require an invitation.' });
  if (await getMember(communityId, req.user!.id)) return res.status(409).json({ message: 'You are already a member.' });
  if (await isDatabaseAvailable()) {
    const member = await prisma.communityMember.create({ data: { communityId, userId: req.user!.id } });
    return res.status(201).json({ member });
  }
  const member = { id: makeId('community_member'), communityId, userId: req.user!.id, role: 'MEMBER' as const, joinedAt: new Date().toISOString() };
  socialStore.state.communityMembers.push(member);
  return res.status(201).json({ member });
});

router.delete('/communities/:id/members/me', requireAuth, async (req, res) => {
  const communityId = String(req.params.id);
  const member = await getMember(communityId, req.user!.id);
  if (!member) return res.status(404).json({ message: 'Membership not found.' });
  if (member.role === 'OWNER') return res.status(409).json({ message: 'The owner must transfer ownership before leaving.' });
  if (await isDatabaseAvailable()) await prisma.communityMember.delete({ where: { communityId_userId: { communityId, userId: req.user!.id } } });
  else socialStore.state.communityMembers.splice(socialStore.state.communityMembers.findIndex((entry) => entry.id === member.id), 1);
  return res.json({ left: true });
});

router.post('/communities/:id/invites', requireAuth, async (req, res) => {
  const communityId = String(req.params.id);
  const { userId } = inviteSchema.parse(req.body ?? {});
  if (!(await canModerate(communityId, req.user!.id))) return res.status(403).json({ message: 'Only community moderators can invite members.' });
  if (await getMember(communityId, userId)) return res.status(409).json({ message: 'User is already a member.' });
  const target = await (async () => await isDatabaseAvailable() ? prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } }) : findUserById(userId))();
  if (!target) return res.status(404).json({ message: 'User not found.' });
  if (await isDatabaseAvailable()) await prisma.communityMember.create({ data: { communityId, userId } });
  else socialStore.state.communityMembers.push({ id: makeId('community_member'), communityId, userId, role: 'MEMBER', joinedAt: new Date().toISOString() });
  await createNotification(userId, req.user!.id, 'community_invite', `You were invited to join a community by ${req.user!.name}.`);
  return res.status(201).json({ invited: true });
});

router.patch('/communities/:id/members/:userId', requireAuth, async (req, res) => {
  const communityId = String(req.params.id);
  const userId = String(req.params.userId);
  const { role } = roleSchema.parse(req.body ?? {});
  const actor = await getMember(communityId, req.user!.id);
  const target = await getMember(communityId, userId);
  if (!actor || actor.role !== 'OWNER') return res.status(403).json({ message: 'Only the community owner can change moderator roles.' });
  if (!target) return res.status(404).json({ message: 'Community member not found.' });
  if (target.role === 'OWNER') return res.status(409).json({ message: 'Owner role cannot be changed here.' });
  if (await isDatabaseAvailable()) {
    const member = await prisma.communityMember.update({ where: { communityId_userId: { communityId, userId } }, data: { role } });
    return res.json({ member });
  }
  target.role = role;
  return res.json({ member: target });
});

router.delete('/communities/:id/members/:userId', requireAuth, async (req, res) => {
  const communityId = String(req.params.id);
  const userId = String(req.params.userId);
  const actor = await getMember(communityId, req.user!.id);
  const target = await getMember(communityId, userId);
  if (!actor || !target) return res.status(404).json({ message: 'Community member not found.' });
  const selfLeave = userId === req.user!.id;
  if (!selfLeave && !['OWNER', 'MODERATOR'].includes(actor.role)) return res.status(403).json({ message: 'Only moderators can remove community members.' });
  if (target.role === 'OWNER') return res.status(409).json({ message: 'The owner cannot leave or be removed before transferring ownership.' });
  if (!selfLeave && actor.role === 'MODERATOR' && target.role === 'MODERATOR') return res.status(403).json({ message: 'Moderators cannot remove other moderators.' });
  if (await isDatabaseAvailable()) await prisma.communityMember.delete({ where: { communityId_userId: { communityId, userId } } });
  else socialStore.state.communityMembers.splice(socialStore.state.communityMembers.findIndex((member) => member.id === target.id), 1);
  return res.json({ removed: userId });
});

router.post('/communities/:id/announcements', requireAuth, async (req, res) => {
  const communityId = String(req.params.id);
  const payload = announcementSchema.parse(req.body ?? {});
  if (!(await getCommunity(communityId))) return res.status(404).json({ message: 'Community not found.' });
  if (!(await canModerate(communityId, req.user!.id))) return res.status(403).json({ message: 'Only community moderators can post announcements.' });
  const moderation = reviewContentForSafety({ type: 'post', text: payload.content, userId: req.user!.id });
  if (moderation === 'REMOVE') return res.status(400).json({ message: 'This announcement violates NOVA Community & Safety Rules.' });
  if (moderation === 'REVIEW') return res.status(422).json({ message: 'This announcement requires moderator review.' });
  const post = await (async () => {
    if (await isDatabaseAvailable()) return prisma.post.create({ data: { authorId: req.user!.id, communityId, content: payload.content, imageUrl: payload.imageUrl ?? null, visibility: 'PUBLIC' } });
    const now = new Date().toISOString();
    const created = { id: makeId('community_post'), authorId: req.user!.id, communityId, content: payload.content, imageUrl: payload.imageUrl ?? null, visibility: 'PUBLIC' as const, createdAt: now, updatedAt: now };
    socialStore.state.posts.push(created);
    return created;
  })();
  const memberIds = await (async () => await isDatabaseAvailable()
    ? (await prisma.communityMember.findMany({ where: { communityId }, select: { userId: true } })).map((member) => member.userId)
    : socialStore.state.communityMembers.filter((member) => member.communityId === communityId).map((member) => member.userId))();
  const community = await getCommunity(communityId);
  await Promise.all(memberIds.filter((memberId) => memberId !== req.user!.id).map((memberId) => createNotification(memberId, req.user!.id, 'community_announcement', `${community?.name ?? 'Your community'} posted an announcement.`)));
  return res.status(201).json({ announcement: post });
});

router.post('/communities/:id/report', requireAuth, async (req, res) => {
  const communityId = String(req.params.id);
  const payload = reportSchema.parse(req.body ?? {});
  const community = await getCommunity(communityId);
  if (!community) return res.status(404).json({ message: 'Community not found.' });
  const details = `Community report: ${community.name} (${communityId})\n\n${payload.reason}`;
  if (await isDatabaseAvailable()) {
    const report = await prisma.report.create({ data: { reporterId: req.user!.id, targetUserId: community.ownerId, category: payload.category, details } });
    return res.status(201).json({ report, message: 'Report submitted successfully.' });
  }
  const report = { id: makeId('report'), reporterId: req.user!.id, targetType: 'user' as const, targetId: community.ownerId, category: payload.category, reason: details, createdAt: new Date().toISOString() };
  socialStore.state.reports.push(report);
  return res.status(201).json({ report, message: 'Report submitted successfully.' });
});