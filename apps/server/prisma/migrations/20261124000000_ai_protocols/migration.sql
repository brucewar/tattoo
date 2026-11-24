ALTER TABLE "AiModel"
    ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'chat-completions',
    ADD COLUMN "anthropicMaxTokens" INTEGER NOT NULL DEFAULT 4096;

ALTER TABLE "GenerationJob"
    ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'chat-completions';

UPDATE "AiModel" SET "protocol" = 'images-generations' WHERE "capability" = 'image';
UPDATE "GenerationJob" SET "protocol" = 'images-generations' WHERE "capability" = 'image';
