import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import env from '../config/env.js';
import { getMediaStorage, MediaStorageUnavailableError, videoMediaKeyFromUrl } from '../lib/mediaStorage.js';
import { isDatabaseAvailable, prisma } from '../lib/prisma.js';
import { socialStore } from '../lib/socialStore.js';
import { requireActiveAccountIfAuthenticated, requireAuth } from '../middleware/auth.js';

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const attachmentTypes = new Map([
  ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['video/webm', 'webm'],
  ['video/mp4', 'mp4'],
  ['video/ogg', 'ogg'],
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
]);

export const mediaRouter = Router();

function uploadMediaFile(req: Request, res: Response, next: NextFunction) {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MEDIA_BYTES, files: 1 },
    fileFilter(_request, file, callback) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
        return;
      }
      callback(null, true);
    },
  }).single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        message: tooLarge ? 'Images must be 10 MB or smaller.' : 'Choose a JPEG, PNG, or WebP image.',
      });
    }
    return next(error);
  });
}

function uploadAttachmentFile(req: Request, res: Response, next: NextFunction) {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MEDIA_BYTES, files: 1 },
    fileFilter(_request, file, callback) {
      const extension = file.originalname.split('.').at(-1)?.toLowerCase();
      if (attachmentTypes.get(file.mimetype) !== extension) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
        return;
      }
      callback(null, true);
    },
  }).single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        message: tooLarge ? 'Attachments must be 10 MB or smaller.' : 'Choose a supported audio, video, PDF, or DOCX file.',
      });
    }
    return next(error);
  });
}

function uploadVideoFile(req: Request, res: Response, next: NextFunction) {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MEDIA_BYTES, files: 1 },
    fileFilter(_request, file, callback) {
      const extension = file.originalname.split('.').at(-1)?.toLowerCase();
      if (!['video/mp4', 'video/webm', 'video/ogg'].includes(file.mimetype)
        || attachmentTypes.get(file.mimetype) !== extension) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
        return;
      }
      callback(null, true);
    },
  }).single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        message: tooLarge ? 'Videos must be 10 MB or smaller.' : 'Choose an MP4, WebM, or Ogg video.',
      });
    }
    return next(error);
  });
}

function hasValidFileSignature(contentType: string, bytes: Buffer) {
  if (contentType === 'application/pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
  if (contentType.endsWith('/webm')) return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (contentType.endsWith('/ogg')) return bytes.subarray(0, 4).toString() === 'OggS';
  if (contentType === 'video/mp4' || contentType === 'audio/mp4') return bytes.subarray(4, 8).toString() === 'ftyp';
  if (contentType === 'audio/mpeg') {
    return bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  }
  return false;
}

async function canReadAttachment(key: string, ownerUserId: string, viewerId: string) {
  if (ownerUserId === viewerId) return true;
  const mediaUrl = `/api/media/files/${key}`;
  if (!(await isDatabaseAvailable())) {
    const referencedByMessage = socialStore.state.messages.some((message) =>
      message.mediaUrl === mediaUrl
      && !message.deletedAt
      && (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now())
      && socialStore.state.conversationParticipants.some((participant) =>
        participant.conversationId === message.conversationId
        && participant.userId === viewerId
        && !participant.leftAt,
      ),
    );
    if (referencedByMessage) return true;
    if (!videoMediaKeyFromUrl(mediaUrl)) return false;
    const isBlocked = socialStore.state.blocks.some((block) =>
      (block.blockerId === viewerId && block.blockedId === ownerUserId)
      || (block.blockerId === ownerUserId && block.blockedId === viewerId),
    );
    if (isBlocked) return false;
    const followsOwner = socialStore.state.follows.some((follow) => follow.followerId === viewerId && follow.followingId === ownerUserId);
    return socialStore.state.posts.some((post) =>
      post.authorId === ownerUserId
      && post.imageUrl === mediaUrl
      && (post.visibility === 'PUBLIC' || (post.visibility === 'FOLLOWERS' && followsOwner)),
    );
  }
  const message = await prisma.message.findFirst({
    where: {
      mediaUrl,
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      conversation: { participants: { some: { userId: viewerId, leftAt: null } } },
    },
    select: { id: true },
  });
  if (message) return true;
  if (!videoMediaKeyFromUrl(mediaUrl)) return false;
  const [blocked, follow, post] = await Promise.all([
    prisma.block.findFirst({
      where: { OR: [{ blockerId: viewerId, blockedId: ownerUserId }, { blockerId: ownerUserId, blockedId: viewerId }] },
      select: { id: true },
    }),
    prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: ownerUserId } },
      select: { id: true },
    }),
    prisma.post.findFirst({
      where: { authorId: ownerUserId, imageUrl: mediaUrl, visibility: { in: ['PUBLIC', 'FOLLOWERS'] } },
      select: { visibility: true },
    }),
  ]);
  return Boolean(!blocked && post && (post.visibility === 'PUBLIC' || follow));
}

async function canReadUploadedMedia(key: string, ownerUserId: string, viewerId: string) {
  if (ownerUserId === viewerId) return true;
  const mediaUrl = `/api/media/avatars/${key}`;
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    const profile = socialStore.state.profiles.find((entry) => entry.userId === ownerUserId);
    const referencedByProfile = profile?.avatarUrl === mediaUrl || profile?.coverUrl === mediaUrl;
    const isBlocked = socialStore.state.blocks.some((block) =>
      (block.blockerId === viewerId && block.blockedId === ownerUserId)
      || (block.blockerId === ownerUserId && block.blockedId === viewerId),
    );
    if (isBlocked) return false;
    const followsOwner = socialStore.state.follows.some((follow) => follow.followerId === viewerId && follow.followingId === ownerUserId);
    const referencedByPost = socialStore.state.posts.some((post) =>
      post.authorId === ownerUserId
      && post.imageUrl === mediaUrl
      && (post.visibility === 'PUBLIC' || (post.visibility === 'FOLLOWERS' && followsOwner)),
    );
    const referencedByStory = socialStore.state.stories.some((story) =>
      story.authorId === ownerUserId
      && story.mediaUrl === mediaUrl
      && new Date(story.expiresAt).getTime() > Date.now()
      && followsOwner,
    );
    const referencedByMessage = socialStore.state.messages.some((message) =>
      message.mediaUrl === mediaUrl
      && !message.deletedAt
      && (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now())
      && socialStore.state.conversationParticipants.some((participant) =>
        participant.conversationId === message.conversationId
        && participant.userId === viewerId
        && !participant.leftAt,
      ),
    );
    const referencedByConversation = socialStore.state.conversations.some((conversation) =>
      conversation.isGroup
      && conversation.imageUrl === mediaUrl
      && socialStore.state.conversationParticipants.some((participant) =>
        participant.conversationId === conversation.id
        && participant.userId === viewerId
        && !participant.leftAt,
      ),
    );
    return Boolean(referencedByProfile || referencedByPost || referencedByStory || referencedByMessage || referencedByConversation);
  }

  const blocked = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: viewerId, blockedId: ownerUserId },
        { blockerId: ownerUserId, blockedId: viewerId },
      ],
    },
    select: { id: true },
  });
  if (blocked) return false;

  const profile = await prisma.profile.findFirst({
    where: { userId: ownerUserId, OR: [{ avatarUrl: mediaUrl }, { coverUrl: mediaUrl }] },
    select: { id: true },
  });
  if (profile) return true;

  const [follow, posts, stories, message, conversation] = await Promise.all([
    prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: ownerUserId } },
      select: { id: true },
    }),
    prisma.post.findMany({
      where: { authorId: ownerUserId, imageUrl: mediaUrl },
      select: { visibility: true },
    }),
    prisma.story.findFirst({
      where: { authorId: ownerUserId, mediaUrl, expiresAt: { gt: new Date() } },
      select: { id: true },
    }),
    prisma.message.findFirst({
      where: {
        mediaUrl,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        conversation: { participants: { some: { userId: viewerId, leftAt: null } } },
      },
      select: { id: true },
    }),
    prisma.conversation.findFirst({
      where: { isGroup: true, imageUrl: mediaUrl, participants: { some: { userId: viewerId, leftAt: null } } },
      select: { id: true },
    }),
  ]);

  return posts.some((post) => post.visibility === 'PUBLIC' || (post.visibility === 'FOLLOWERS' && Boolean(follow))) || Boolean((stories && follow) || message || conversation);
}

mediaRouter.post('/uploads', requireAuth, uploadMediaFile, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose an image to upload.' });
    const image = await sharp(req.file.buffer, { limitInputPixels: 20_000_000 })
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const stored = await getMediaStorage(env.NODE_ENV).put(image, 'image/webp', req.user!.id);
    return res.status(201).json({ mediaUrl: stored.publicUrl, contentType: 'image/webp' });
  } catch (error) {
    if (error instanceof MediaStorageUnavailableError) return res.status(503).json({ message: 'Persistent image storage is not configured.' });
    if (error instanceof Error && /Input buffer|unsupported image|corrupt|pixel limit/i.test(error.message)) {
      return res.status(400).json({ message: 'The uploaded file is not a valid supported image.' });
    }
    return next(error);
  }
});

mediaRouter.post('/videos', requireAuth, uploadVideoFile, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose a video to upload.' });
    if (!hasValidFileSignature(req.file.mimetype, req.file.buffer)) {
      return res.status(400).json({ message: 'The uploaded file does not match its declared video type.' });
    }
    const extension = attachmentTypes.get(req.file.mimetype);
    if (!extension) {
      return res.status(400).json({ message: 'Choose an MP4, WebM, or Ogg video.' });
    }
    const stored = await getMediaStorage(env.NODE_ENV).putAttachment(req.file.buffer, req.file.mimetype, extension, req.user!.id);
    return res.status(201).json({ mediaUrl: stored.publicUrl, contentType: req.file.mimetype });
  } catch (error) {
    if (error instanceof MediaStorageUnavailableError) return res.status(503).json({ message: 'Persistent video storage is not configured.' });
    return next(error);
  }
});

mediaRouter.post('/attachments', requireAuth, uploadAttachmentFile, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose an attachment to upload.' });
    if (!hasValidFileSignature(req.file.mimetype, req.file.buffer)) {
      return res.status(400).json({ message: 'The uploaded file does not match its declared type.' });
    }
    const extension = attachmentTypes.get(req.file.mimetype);
    if (!extension) return res.status(400).json({ message: 'Choose a supported audio, video, PDF, or DOCX file.' });
    const stored = await getMediaStorage(env.NODE_ENV).putAttachment(req.file.buffer, req.file.mimetype, extension, req.user!.id);
    return res.status(201).json({ mediaUrl: stored.publicUrl, contentType: req.file.mimetype });
  } catch (error) {
    if (error instanceof MediaStorageUnavailableError) return res.status(503).json({ message: 'Persistent attachment storage is not configured.' });
    return next(error);
  }
});

mediaRouter.get('/avatars/:key', requireActiveAccountIfAuthenticated, async (req, res, next) => {
  try {
    const key = String(req.params.key);
    if (!/^[0-9a-f-]{36}\.webp$/.test(key)) return res.status(404).end();
    const object = await getMediaStorage(env.NODE_ENV).get(key);
    if (!object) return res.status(404).end();
    if (!object.ownerUserId || !req.user || !(await canReadUploadedMedia(key, object.ownerUserId, req.user.id))) {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Vary', 'Cookie, Authorization');
    return res.send(object.bytes);
  } catch (error) {
    if (error instanceof MediaStorageUnavailableError) return res.status(503).json({ message: 'Profile image storage is not configured.' });
    return next(error);
  }
});

mediaRouter.get('/files/:key', requireAuth, async (req, res, next) => {
  try {
    const key = String(req.params.key);
    if (!/^[0-9a-f-]{36}\.(?:webm|mp4|ogg|mp3|m4a|pdf|docx)$/.test(key)) return res.status(404).end();
    const object = await getMediaStorage(env.NODE_ENV).get(key);
    if (!object || !object.ownerUserId || !(await canReadAttachment(key, object.ownerUserId, req.user!.id))) {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Cookie, Authorization');
    return res.send(object.bytes);
  } catch (error) {
    if (error instanceof MediaStorageUnavailableError) return res.status(503).json({ message: 'Persistent attachment storage is not configured.' });
    return next(error);
  }
});
