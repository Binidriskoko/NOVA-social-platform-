import env from '../config/env.js';

export type SocialProfileRecord = {
  userId: string;
  displayName: string | null;
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  website: string | null;
  location: string | null;
  updatedAt: string;
};

export type SocialPostRecord = {
  id: string;
  authorId: string;
  content: string;
  imageUrl: string | null;
  visibility: 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE';
  communityId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoryRecord = {
  id: string;
  authorId: string;
  kind?: string;
  text: string | null;
  mediaUrl: string | null;
  createdAt: string;
  expiresAt: string;
};

export type StoryViewRecord = { id: string; storyId: string; viewerId: string; viewedAt: string };

export type CommunityRecord = {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string | null;
  avatarUrl: string | null;
  type?: 'GROUP' | 'COMMUNITY' | 'CHANNEL';
  isPrivate?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CommunityMemberRecord = {
  id: string;
  communityId: string;
  userId: string;
  role: 'MEMBER' | 'MODERATOR' | 'OWNER';
  joinedAt: string;
};

export type SocialCommentRecord = {
  id: string;
  postId: string;
  authorId: string;
  parentId?: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type SocialReactionRecord = {
  id: string;
  userId: string;
  postId: string;
  type: 'LIKE' | 'LOVE' | 'LAUGH' | 'SAD' | 'ANGRY';
  createdAt: string;
};

export type SocialFollowRecord = {
  id: string;
  followerId: string;
  followingId: string;
  createdAt: string;
};

export type SocialNotificationRecord = {
  id: string;
  recipientId: string;
  actorId?: string | null;
  type: string;
  message: string;
  readAt?: string | null;
  createdAt: string;
};

export type SocialReportRecord = {
  id: string;
  reporterId: string;
  targetType: 'post' | 'comment' | 'user';
  targetId: string;
  category: 'SPAM' | 'HARASSMENT' | 'SEXUAL_CONTENT' | 'HATE' | 'VIOLENCE' | 'SCAM' | 'OTHER';
  reason: string;
  details?: string | null;
  status?: 'OPEN' | 'REVIEWING' | 'RESOLVED' | 'REJECTED';
  resolvedAt?: string | null;
  createdAt: string;
};

export type SocialBlockRecord = {
  id: string;
  blockerId: string;
  blockedId: string;
  createdAt: string;
};

export type ConversationRecord = {
  id: string;
  name: string | null;
  description?: string | null;
  imageUrl?: string | null;
  ownerId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  isChannel?: boolean;
  isGroup?: boolean;
  disappearingAfterSeconds?: number;
};

export type ConversationParticipantRecord = {
  id: string;
  conversationId: string;
  userId: string;
  role: 'MEMBER' | 'MODERATOR' | 'OWNER';
  joinedAt: string;
  lastReadAt: string | null;
  leftAt: string | null;
  pinnedAt?: string | null;
  archivedAt?: string | null;
  starredAt?: string | null;
  mutedUntil?: string | null;
};

export type MessageRecord = {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  deletedAt: string | null;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'DELETED';
  contentType?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'VOICE' | 'CONTACT' | 'LOCATION' | 'POLL' | 'EVENT';
  mediaUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  replyToId?: string | null;
  forwardedFromId?: string | null;
  editedAt?: string | null;
  expiresAt?: string | null;
};

export type MessageReactionRecord = {
  id: string;
  messageId: string;
  userId: string;
  type: string;
  createdAt: string;
};

export type SubscriptionPlanRecord = {
  id: string;
  slug: string;
  name: string;
  priceCents: number;
  currency: string;
  interval: 'month' | 'year';
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SubscriptionRecord = {
  id: string;
  userId: string;
  planId: string;
  status: 'PENDING' | 'ACTIVE' | 'TRIALING' | 'PAUSED' | 'CANCELLED' | 'FAILED';
  currentPeriodStart: string;
  currentPeriodEnd: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaymentRecord = {
  id: string;
  subscriptionId: string;
  userId: string;
  provider: string;
  providerReference: string | null;
  amountCents: number;
  currency: string;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'CANCELLED';
  createdAt: string;
};

export type EntitlementRecord = {
  id: string;
  userId: string;
  key: string;
  value: string | null;
  source: 'subscription' | 'admin';
  createdAt: string;
  updatedAt: string;
};

const globalStore = globalThis as typeof globalThis & {
  __novaSocialStore?: {
    profiles: SocialProfileRecord[];
    posts: SocialPostRecord[];
    stories: StoryRecord[];
    storyViews: StoryViewRecord[];
    comments: SocialCommentRecord[];
    postSaves: { id: string; postId: string; userId: string; createdAt: string }[];
    postShares: { id: string; postId: string; userId: string; createdAt: string }[];
    reactions: SocialReactionRecord[];
    follows: SocialFollowRecord[];
    notifications: SocialNotificationRecord[];
    reports: SocialReportRecord[];
    blocks: SocialBlockRecord[];
    conversations: ConversationRecord[];
    conversationParticipants: ConversationParticipantRecord[];
    messages: MessageRecord[];
    messageReactions: MessageReactionRecord[];
    communities: CommunityRecord[];
    communityMembers: CommunityMemberRecord[];
    subscriptionPlans: SubscriptionPlanRecord[];
    subscriptions: SubscriptionRecord[];
    payments: PaymentRecord[];
    entitlements: EntitlementRecord[];
  };
};

if (!globalStore.__novaSocialStore) {
  globalStore.__novaSocialStore = {
    profiles: [],
    posts: [],
    stories: [],
    storyViews: [],
    comments: [],
    postSaves: [],
    postShares: [],
    reactions: [],
    follows: [],
    notifications: [],
    reports: [],
    blocks: [],
    conversations: [],
    conversationParticipants: [],
    messages: [],
    messageReactions: [],
    communities: [],
    communityMembers: [],
    subscriptionPlans: [],
    subscriptions: [],
    payments: [],
    entitlements: [],
  };
}

export const socialStore = {
  get state() {
    if (env.NODE_ENV === 'production') {
      throw new Error('In-memory fallback storage is disabled in production.');
    }
    return globalStore.__novaSocialStore!;
  },
  clear() {
    if (env.NODE_ENV === 'production') {
      throw new Error('In-memory fallback storage is disabled in production.');
    }
    globalStore.__novaSocialStore = {
      profiles: [],
      posts: [],
      stories: [],
      storyViews: [],
      comments: [],
      postSaves: [],
      postShares: [],
      reactions: [],
      follows: [],
      notifications: [],
      reports: [],
      blocks: [],
      conversations: [],
      conversationParticipants: [],
      messages: [],
      messageReactions: [],
      communities: [],
      communityMembers: [],
      subscriptionPlans: [],
      subscriptions: [],
      payments: [],
      entitlements: [],
    };
  },
};
