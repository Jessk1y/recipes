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
