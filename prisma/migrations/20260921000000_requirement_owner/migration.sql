ALTER TABLE "Requirement"
ADD COLUMN "ownerId" TEXT;

CREATE INDEX "Requirement_projectId_ownerId_idx" ON "Requirement"("projectId", "ownerId");

ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
