# API сайта рецептов

Node.js 20 · Express 5 · Prisma 6 · PostgreSQL 16 · Zod · bcrypt + JWT.
Архитектура и схема БД — в практической работе №3.

## Запуск локально

```bash
cd server
npm install
cp .env.example .env          # затем впиши JWT_SECRET (≥ 32 символов)
docker compose up -d          # PostgreSQL на localhost:5433
npx prisma migrate dev        # создать таблицы
npm run db:seed               # перенести 19 рецептов из ../data/recipes.json
npm run dev                   # http://localhost:3000/api/v1/health
```

Порт БД — 5433, чтобы не конфликтовать с установленным в системе PostgreSQL.
Для Neon достаточно подставить его строку подключения в `DATABASE_URL`.

## Команды

| Команда | Что делает |
|---|---|
| `npm run dev` | сервер с автоперезапуском |
| `npm run db:seed` | импорт рецептов (идемпотентен, обновляет по slug) |
| `npm run create-admin -- <email> <пароль> [имя]` | создать/повысить администратора |
| `npm test` | интеграционные тесты auth (нужна БД) |

## Auth API (`/api/v1/auth`)

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| POST | `/register` | все | `{email, password ≥8, displayName}` | 201 `{user, accessToken, refreshToken}` · 409 `EMAIL_TAKEN` |
| POST | `/login` | все | `{email, password}` | 200 как выше · 401 `INVALID_CREDENTIALS` |
| POST | `/refresh` | все | `{refreshToken}` | 200 `{accessToken, refreshToken}` · 401 `TOKEN_REUSED` |
| POST | `/logout` | вошедший | `{refreshToken}` или `{all: true}` | 204 |
| GET | `/me` | вошедший | — | 200 `{id, email, displayName, role}` |

Access-токен — JWT на 15 минут (`Authorization: Bearer …`), refresh — случайная строка на 30 дней
с ротацией; в БД лежит только её хеш. Повторное предъявление использованного refresh-токена
отзывает всю цепочку. Ошибки: `{"error": {"code", "message", "details"}}`.

## API рецептов (`/api/v1`)

Доступ: «все» — включая гостя, «А» — администратор.

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | `/recipes` | все | query: `q` (название/ингредиент/тег), `main` (через запятую, логическое И), `category` (slug), `maxTime` (мин), `sort` (`new`/`time`/`title`), `page`, `limit` ≤ 50 → `{items, page, limit, total}`. Админ может добавить `status=DRAFT\|all` |
| GET | `/recipes/random?main=` | все | `{slug}` случайного опубликованного |
| GET | `/recipes/:slug` | все | полный рецепт, ETag/304. Черновик — только админу |
| GET | `/catalog/snapshot` | все | `{version, recipes[]}` всего каталога для офлайн-кэша, ETag/304 |
| GET | `/categories`, `/tags?main=true` | все | категории со счётчиком и теги |
| POST | `/recipes` | А | создать (201). По умолчанию `status: DRAFT`; slug из названия, если не задан |
| PUT | `/recipes/:id` | А | полная замена; 409 `SLUG_TAKEN` |
| PATCH | `/recipes/:id/status` | А | `{status: DRAFT\|PUBLISHED}` |
| DELETE | `/recipes/:id` | А | 204; загруженное через API фото удаляется |
| POST | `/uploads/image` | А | `multipart/form-data`, поле `file` (jpeg/png/webp ≤ 5 МБ) → `{url, publicId}` |

Формат `RecipeInput`: `{title, category, main[], tags[], image, time, servings, status,
ingredients: [{kind?: "ITEM"|"HEADER", name, amount?}], steps: [{kind?, text, timerSeconds?}]}`.
`main` — только из словаря (Первое, Второе, Салат, Десерт, Напиток, Курица, Свинина, Говядина, Шоколад).
`timeMinutes` и `timerSeconds` (если не заданы) сервер вычисляет из текста («1 ч 10 мин», «варить 25 мин»).

**Загрузка фото — заглушка:** файлы лежат в `server/uploads/` (не в git). Перед деплоем
`src/lib/storage.js` заменяется на Cloudinary с тем же интерфейсом `save` / `remove`.
