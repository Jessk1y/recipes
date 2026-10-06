-- CreateTable
CREATE TABLE "recipe_views" (
    "recipe_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "recipe_views_pkey" PRIMARY KEY ("recipe_id","day")
);

-- CreateIndex
CREATE INDEX "recipe_views_day_idx" ON "recipe_views"("day");

-- AddForeignKey
ALTER TABLE "recipe_views" ADD CONSTRAINT "recipe_views_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
