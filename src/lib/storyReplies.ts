type StoryReplyConversation = {
  id: string
  isGroup?: boolean
  participants: { userId: string }[]
}

type StoryReplyApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>

export function isVideoStoryMedia(mediaUrl: string | null | undefined) {
  return Boolean(mediaUrl && /\.(mp4|webm|ogv|mov)(?:[?#]|$)/i.test(mediaUrl))
}

export async function sendStoryReply(
  ownerId: string,
  text: string,
  request: StoryReplyApiRequest,
) {
  const reply = text.trim()
  if (!reply) throw new Error('Write a reply before sending.')
  const { conversations } = await request<{ conversations: StoryReplyConversation[] }>('/api/conversations')
  let conversation = conversations.find((entry) => !entry.isGroup && entry.participants.some((participant) => participant.userId === ownerId))
  if (!conversation) {
    const response = await request<{ conversation: { id: string } }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ participantId: ownerId }),
    })
    conversation = { id: response.conversation.id, participants: [{ userId: ownerId }] }
  }
  await request(`/api/conversations/${encodeURIComponent(conversation.id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: `Reply to your story: ${reply}` }),
  })
}
