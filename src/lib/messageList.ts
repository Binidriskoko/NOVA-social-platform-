export type MessageWithId = { id: string }

type ConversationPreview = {
  id: string
  updatedAt: string
  lastMessageAt: string | null
  lastMessagePreview: string | null
  unreadCount?: number
  lastMessage?: { id: string; senderId: string; text: string; createdAt: string; readAt?: string | null; status?: string; contentType?: string }
}

export function upsertMessageById<T extends MessageWithId>(messages: T[], message: T) {
  const index = messages.findIndex((entry) => entry.id === message.id)
  if (index < 0) return [...messages, message]
  return messages.map((entry, entryIndex) => entryIndex === index ? message : entry)
}

export function updateConversationPreviewFromMessage<T extends ConversationPreview>(
  conversations: T[],
  message: { id: string; conversationId: string; senderId: string; text: string; createdAt: string; updatedAt: string; readAt?: string | null; status?: string; contentType?: string },
  currentUserId: string | undefined,
  selectedConversationId: string,
  deleted = false,
) {
  const conversation = conversations.find((entry) => entry.id === message.conversationId)
  if (!conversation) return conversations
  const messageTime = Date.parse(message.createdAt)
  const latestTime = conversation.lastMessageAt ? Date.parse(conversation.lastMessageAt) : Number.NEGATIVE_INFINITY
  if (messageTime < latestTime) return conversations
  const alreadyCurrent = conversation.lastMessage?.id === message.id
  const preview = deleted ? 'Message deleted' : message.text || `[${(message.contentType ?? 'text').toLowerCase()}]`
  return conversations.map((entry) => entry.id === message.conversationId ? {
    ...entry,
    updatedAt: message.updatedAt || message.createdAt,
    lastMessageAt: message.createdAt,
    lastMessagePreview: preview,
    unreadCount: (entry.unreadCount ?? 0) + (!alreadyCurrent && message.senderId !== currentUserId && entry.id !== selectedConversationId ? 1 : 0),
    lastMessage: { ...message, text: preview },
  } : entry)
}
