WITH media_references AS (
  SELECT media.key, post."authorId" AS "ownerUserId"
  FROM "RegistrationMediaObject" AS media
  JOIN "Post" AS post ON post."imageUrl" = '/api/media/files/' || media.key
  WHERE media.key ~ '^[0-9a-f-]{36}\.(jpe?g|png|webp)$'

  UNION ALL

  SELECT media.key, story."authorId"
  FROM "RegistrationMediaObject" AS media
  JOIN "Story" AS story ON story."mediaUrl" = '/api/media/files/' || media.key
  WHERE media.key ~ '^[0-9a-f-]{36}\.(jpe?g|png|webp)$'

  UNION ALL

  SELECT media.key, message."senderId"
  FROM "RegistrationMediaObject" AS media
  JOIN "Message" AS message ON message."mediaUrl" = '/api/media/files/' || media.key
  WHERE media.key ~ '^[0-9a-f-]{36}\.(jpe?g|png|webp)$'
),
unique_owners AS (
  SELECT key, MIN("ownerUserId") AS "ownerUserId"
  FROM media_references
  GROUP BY key
  HAVING COUNT(DISTINCT "ownerUserId") = 1
)
UPDATE "RegistrationMediaObject" AS media
SET "ownerUserId" = unique_owners."ownerUserId"
FROM unique_owners
WHERE media.key = unique_owners.key
  AND media."ownerUserId" IS NULL;
