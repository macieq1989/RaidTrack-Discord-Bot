-- CreateTable
CREATE TABLE "LootPost" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lootKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "LootPost_lootKey_key" ON "LootPost"("lootKey");
