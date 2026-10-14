ALTER TABLE "Conversation"
ADD COLUMN "isGroup" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Conversation" AS conversation
SET "isGroup" = true
WHERE (
  SELECT COUNT(*)
  FROM "ConversationParticipant" AS participant
  WHERE participant."conversationId" = conversation.id
) > 2
OR conversation."isChannel" = true;
