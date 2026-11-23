CREATE TYPE "AiCapability" AS ENUM ('text', 'image');
CREATE TYPE "GenerationKind" AS ENUM ('ARTICLE', 'REWRITE', 'COVER', 'ILLUSTRATION', 'TEST_TEXT', 'TEST_IMAGE');
CREATE TYPE "GenerationState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN');

CREATE TABLE "AiModel" (
  "id" UUID NOT NULL,
  "capability" "AiCapability" NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "apiKeyEncrypted" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "imageSize" TEXT NOT NULL DEFAULT '',
  "imageResponseFormat" TEXT NOT NULL DEFAULT 'auto',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiModel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiModel_capability_key" ON "AiModel"("capability");

CREATE TABLE "GenerationJob" (
  "id" UUID NOT NULL,
  "requestKey" UUID NOT NULL,
  "kind" "GenerationKind" NOT NULL,
  "capability" "AiCapability" NOT NULL,
  "modelId" UUID NOT NULL,
  "model" TEXT NOT NULL,
  "configVersion" INTEGER NOT NULL,
  "inputHash" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "sourceText" TEXT NOT NULL DEFAULT '',
  "articleId" UUID,
  "state" "GenerationState" NOT NULL DEFAULT 'QUEUED',
  "result" JSONB,
  "error" TEXT,
  "executionId" UUID,
  "heartbeatAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GenerationJob_requestKey_key" ON "GenerationJob"("requestKey");
CREATE INDEX "GenerationJob_state_createdAt_idx" ON "GenerationJob"("state", "createdAt");
CREATE INDEX "GenerationJob_modelId_configVersion_kind_createdAt_idx" ON "GenerationJob"("modelId", "configVersion", "kind", "createdAt");
CREATE INDEX "GenerationJob_articleId_createdAt_idx" ON "GenerationJob"("articleId", "createdAt");
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AiModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
