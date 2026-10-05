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
| `npm test` | интеграционные тесты (нужна БД) |

## Документация API (Swagger)

Интерактивная документация всех эндпоинтов — http://localhost:3000/api/docs (сама спецификация
OpenAPI 3 — `/api/docs.json`, исходник — `src/docs/openapi.js`). Защищённые методы: войти через
`/auth/login`, скопировать `accessToken`, нажать **Authorize**. Тест `tests/docs.test.js` сверяет
спецификацию с реальными роутерами: новый маршрут без описания ломает `npm test`.

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

## Администрирование (`/api/v1/admin`) — только администратор

Роль и блокировка проверяются по БД на каждый запрос, а не по JWT: разжалованный или заблокированный
админ теряет доступ сразу, не дожидаясь истечения access-токена (15 мин). Тот же guard (`requireActiveAdmin`)
стоит на записи рецептов (POST/PUT/PATCH/DELETE `/recipes`) и загрузке фото. Единственное место, где роль ещё
берётся из JWT, — просмотр черновиков в GET `/recipes` (`optionalAuth`).

| Метод | Путь | Описание |
|---|---|---|
| GET | `/admin/users` | query: `q` (e-mail/имя), `role`, `blocked`, `page`, `limit` ≤ 100 → `{items, page, limit, total}`; без хешей паролей |
| PATCH | `/admin/users/:id/role` | `{role: USER|ADMIN}` → пользователь |
| PATCH | `/admin/users/:id/block` | `{blocked: bool}` → пользователь. Блокировка отзывает все refresh-токены |

Нельзя снять роль или заблокировать последнего **активного** (не заблокированного) администратора —
409 `LAST_ADMIN`. Проверка идёт в транзакции под advisory-блокировкой, поэтому два админа, одновременно
лишающие друг друга прав, не оставят систему без администратора (проигравший получит 409 или 403).
Заблокированный не может войти (403 `ACCOUNT_BLOCKED`) и обновить токен. Ограничение: уже выданный
access-токен заблокированного работает на не-админских путях до истечения (≤ 15 мин).

Тесты admin идут в отдельной схеме Postgres `recipes_test` (создаётся автоматически), потому что
правило «последний админ» считает всех админов в БД; рабочие данные не затрагиваются.

## Личные данные (`/api/v1/me`) — только для вошедшего

Все пути требуют `Authorization: Bearer <access>`; каждый запрос ограничен `userId` из токена, чужие
данные недостижимы (чужой id позиции даёт тот же 404, что и несуществующий). Рецепты адресуются по
`slug` (на фронтенде это `recipe.id`); годятся только опубликованные.

| Метод | Путь | Описание |
|---|---|---|
| GET | `/me/favorites` | `{items: [{slug, createdAt}]}`, новые сверху |
| PUT / DELETE | `/me/favorites/:slug` | добавить / убрать, идемпотентно, 204. Неизвестный или черновой slug → 404 |
| GET | `/me/notes` | `{items: [{slug, text, updatedAt}]}` |
| PUT | `/me/notes/:slug` | `{text ≤ 2000}` → 200 `{slug, text, updatedAt}`; пустой текст удаляет (204) |
| DELETE | `/me/notes/:slug` | 204 |
| GET | `/me/shopping` | `{items: [{id, name, checked, contribs: [{r: slug\|null, a: "количество"}]}]}` в порядке добавления |
| POST | `/me/shopping/items` | `{items: [{name, amount?, recipe?}]}` (до 100) → `{added, items}`. Одинаковые названия (без учёта регистра и пробелов) сливаются в одну позицию, одинаковый вклад (блюдо + количество) не дублируется; неизвестное блюдо → 404, ничего не добавляется |
| PATCH | `/me/shopping/items/:id` | `{checked}` → `{items}` |
| DELETE | `/me/shopping/items/:id` | 204 |
| DELETE | `/me/shopping/dishes/:slug` | «убрать блюдо»: вклады блюда удаляются, пустые позиции пропадают → `{items}` |
| DELETE | `/me/shopping` | очистить список, 204 |
| POST | `/me/sync` | синхронизация офлайн-очереди (ниже) |

### POST /me/sync

Клиент шлёт накопленный outbox `{ops: [...]}` (до 200 операций; тело ≤ 100 КБ, иначе 413).
Каждая операция содержит `type` и `at` (ISO 8601, время действия по часам клиента):
`favorite.add|remove {slug}`, `note.set {slug, text}`, `note.remove {slug}`,
`shopping.add {name, amount?, recipe?}`, `shopping.remove {name}`, `shopping.check {name, checked}`,
`shopping.removeDish {slug}`, `shopping.clear`.

Сервер применяет их одной транзакцией в порядке `at` (всё или ничего) и отвечает
`{serverTime, applied, skipped: [{index, type, reason}], favorites, notes, shopping}` — актуальным
состоянием целиком. Правила конфликтов (last-write-wins):

- заметки сравниваются по `updatedAt`: правка старше сохранённой пропускается (`STALE`);
- избранное и покупки: операции идемпотентны, при конфликте побеждает последняя по `at`;
- `at` из будущего обрезается до времени сервера; неизвестный/черновой рецепт — `NOT_FOUND` (операция
  пропускается, остальные применяются).

Ограничение: удаления не хранятся как «надгробия» — запоздавший старый `note.set` после
`note.remove` с другого устройства восстановит заметку.
