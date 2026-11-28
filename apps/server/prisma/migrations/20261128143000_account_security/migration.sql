ALTER TABLE "User"
    ADD COLUMN "securityVersion" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "totpSecretEncrypted" TEXT,
    ADD COLUMN "totpLastStep" INTEGER,
    ADD COLUMN "pendingTotpEncrypted" TEXT,
    ADD COLUMN "pendingTotpExpiresAt" TIMESTAMP(3),
    ADD COLUMN "pendingTotpSessionHash" TEXT,
    ADD COLUMN "pendingTotpSetupId" UUID,
    ADD COLUMN "factorFailureCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "factorFailureStartedAt" TIMESTAMP(3),
    ADD COLUMN "factorBlockedUntil" TIMESTAMP(3);

CREATE TABLE "LoginChallenge" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "securityVersion" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginChallenge_userId_expiresAt_idx" ON "LoginChallenge"("userId", "expiresAt");
CREATE INDEX "LoginChallenge_expiresAt_idx" ON "LoginChallenge"("expiresAt");
CREATE UNIQUE INDEX "RecoveryCode_codeHash_key" ON "RecoveryCode"("codeHash");
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

ALTER TABLE "LoginChallenge" ADD CONSTRAINT "LoginChallenge_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
