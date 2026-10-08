-- Админ сохранил правки предложения без публикации: пока метка стоит, автор предложение править не может
ALTER TABLE "recipes" ADD COLUMN "admin_edited_at" TIMESTAMP(3);
