CREATE TABLE "TopicCreation" (
  "id" UUID NOT NULL,
  "requestKey" UUID NOT NULL,
  "topic" TEXT NOT NULL,
  "state" "GenerationState" NOT NULL DEFAULT 'QUEUED',
  "stage" TEXT NOT NULL DEFAULT 'ARTICLE',
  "textModelId" UUID NOT NULL,
  "textConfigVersion" INTEGER NOT NULL,
  "imageModelId" UUID NOT NULL,
  "imageConfigVersion" INTEGER NOT NULL,
  "articleJobId" UUID,
  "coverJobId" UUID,
  "coverRequestKey" UUID NOT NULL,
  "articleId" UUID,
  "error" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TopicCreation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TopicCreation_requestKey_key" ON "TopicCreation"("requestKey");
CREATE UNIQUE INDEX "TopicCreation_coverRequestKey_key" ON "TopicCreation"("coverRequestKey");
CREATE INDEX "TopicCreation_state_createdAt_idx" ON "TopicCreation"("state", "createdAt");
ALTER TABLE "GenerationJob" ADD COLUMN "topicId" UUID;
CREATE INDEX "GenerationJob_topicId_idx" ON "GenerationJob"("topicId");
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_topicId_fkey"
 FOREIGN KEY ("topicId") REFERENCES "TopicCreation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
