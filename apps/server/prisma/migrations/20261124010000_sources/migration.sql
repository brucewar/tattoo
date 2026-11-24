ALTER TABLE "GenerationJob" ADD COLUMN "sourceReferences" JSONB NOT NULL DEFAULT '[]';

CREATE TYPE "SourceJobKind" AS ENUM ('URL', 'FEED', 'SEARCH');
CREATE TYPE "SourceJobState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN');

CREATE TABLE "SourceFeed" (
    "id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "lastFetchedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceFeed_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SourceFeed_urlHash_key" ON "SourceFeed"("urlHash");

CREATE TABLE "Source" (
    "id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "resolvedUrl" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contentKind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "feedId" UUID,
    "feedUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Source_urlHash_key" ON "Source"("urlHash");
CREATE INDEX "Source_updatedAt_id_idx" ON "Source"("updatedAt", "id");
CREATE INDEX "Source_feedId_idx" ON "Source"("feedId");
ALTER TABLE "Source" ADD CONSTRAINT "Source_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "SourceFeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SourceSearchConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "baseUrl" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SourceSearchConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SourceJob" (
    "id" UUID NOT NULL,
    "requestKey" UUID NOT NULL,
    "kind" "SourceJobKind" NOT NULL,
    "state" "SourceJobState" NOT NULL DEFAULT 'QUEUED',
    "url" TEXT NOT NULL DEFAULT '',
    "feedId" UUID,
    "query" TEXT NOT NULL DEFAULT '',
    "origin" TEXT NOT NULL DEFAULT 'url',
    "configVersion" INTEGER,
    "inputHash" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "executionId" UUID,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SourceJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SourceJob_requestKey_key" ON "SourceJob"("requestKey");
CREATE INDEX "SourceJob_state_createdAt_idx" ON "SourceJob"("state", "createdAt");
CREATE INDEX "SourceJob_feedId_state_idx" ON "SourceJob"("feedId", "state");
