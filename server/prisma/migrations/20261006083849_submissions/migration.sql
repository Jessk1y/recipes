-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecipeStatus" ADD VALUE 'PENDING';
ALTER TYPE "RecipeStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "recipes" ADD COLUMN     "reject_reason" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "submitted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "recipes_author_id_submitted_at_idx" ON "recipes"("author_id", "submitted_at");
