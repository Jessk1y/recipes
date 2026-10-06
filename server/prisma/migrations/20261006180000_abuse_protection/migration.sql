-- Защита от массовых регистраций: канонический адрес (Gmail без точек и +меток) и время последнего действия.
ALTER TABLE "users" ADD COLUMN "email_key" TEXT;
ALTER TABLE "users" ADD COLUMN "last_active_at" TIMESTAMP(3);

-- Существующим пользователям — отсрочка: 30 дней отсчитываются от выкладки, а не от регистрации
-- (раньше действия не фиксировались, и их аккаунты нельзя считать «пустыми»).
UPDATE "users" SET "last_active_at" = now();

-- Канонический адрес для существующих: у Gmail/Googlemail убираем точки и всё после «+».
-- Если несколько старых аккаунтов сводятся к одному адресу, ключ получает только самый ранний,
-- остальные (старые дубли) остаются как есть, с NULL.
WITH keyed AS (
  SELECT id,
         CASE
           WHEN substring(email from '@([^@]*)$') IN ('gmail.com', 'googlemail.com')
                AND replace(split_part(substring(email from '^(.*)@[^@]*$'), '+', 1), '.', '') <> ''
             THEN replace(split_part(substring(email from '^(.*)@[^@]*$'), '+', 1), '.', '') || '@gmail.com'
           ELSE email
         END AS k,
         created_at
  FROM "users"
), ranked AS (
  SELECT id, k, row_number() OVER (PARTITION BY k ORDER BY created_at, id) AS rn FROM keyed
)
UPDATE "users" u SET "email_key" = r.k FROM ranked r WHERE u.id = r.id AND r.rn = 1;

CREATE UNIQUE INDEX "users_email_key_key" ON "users"("email_key");
