ALTER TABLE "Conversation"
ADD COLUMN "description" TEXT,
ADD COLUMN "imageUrl" TEXT;

UPDATE "ConversationParticipant" AS participant
SET "role" = 'OWNER'
FROM "Conversation" AS conversation
WHERE conversation.id = participant."conversationId"
  AND conversation."ownerId" = participant."userId"
  AND (conversation."isGroup" = true OR conversation."isChannel" = true);
