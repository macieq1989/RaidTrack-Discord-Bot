-- CreateTable
CREATE TABLE "Raid" (
    "raidId" TEXT NOT NULL PRIMARY KEY,
    "raidTitle" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME,
    "notes" TEXT,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "scheduledEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED'
);

-- CreateTable
CREATE TABLE "Signup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "raidId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'JOINED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PlayerProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "classKey" TEXT NOT NULL,
    "specKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Raid_messageId_key" ON "Raid"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Raid_scheduledEventId_key" ON "Raid"("scheduledEventId");

-- CreateIndex
CREATE INDEX "Raid_startAt_idx" ON "Raid"("startAt");

-- CreateIndex
CREATE INDEX "Raid_channelId_idx" ON "Raid"("channelId");

-- CreateIndex
CREATE INDEX "Signup_raidId_idx" ON "Signup"("raidId");

-- CreateIndex
CREATE UNIQUE INDEX "Signup_raidId_userId_key" ON "Signup"("raidId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerProfile_guildId_userId_key" ON "PlayerProfile"("guildId", "userId");
