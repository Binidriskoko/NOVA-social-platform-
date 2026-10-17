export type MessageWithId = { id: string }

export function upsertMessageById<T extends MessageWithId>(messages: T[], message: T) {
  const index = messages.findIndex((entry) => entry.id === message.id)
  if (index < 0) return [...messages, message]
  return messages.map((entry, entryIndex) => entryIndex === index ? message : entry)
}
