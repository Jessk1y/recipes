// OpenAPI 3.0 — описание всего API. Отдаётся как Swagger UI на /api/docs и JSON на /api/docs.json.
// Спецификация написана вручную; tests/docs.test.js сверяет её с реальными маршрутами и проверяет валидность.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const uuid = { type: "string", format: "uuid" };
const dateTime = { type: "string", format: "date-time" };
const str = (extra) => ({ type: "string", ...extra });
const int = { type: "integer" };
const bool = { type: "boolean" };
const arr = (items) => ({ type: "array", items });
const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });

const json = (schema) => ({ "application/json": { schema } });
const body = (schema) => ({ required: true, content: json(schema) });
const ok = (description, schema) => ({ description, ...(schema ? { content: json(schema) } : {}) });
const err = (description) => ({ description, content: json(ref("Error")) });
const noContent = (description = "Успешно, тела нет") => ({ description });

const E = {
  401: err("Нет или недействителен access-токен (`UNAUTHORIZED`, `TOKEN_EXPIRED`)"),
  403: err("Недостаточно прав (`FORBIDDEN`) или аккаунт заблокирован (`ACCOUNT_BLOCKED`)"),
  404: err("Не найдено (`NOT_FOUND`)"),
  422: err("Ошибка валидации (`VALIDATION_ERROR`), `details` — список `{field, message}`"),
  429: err("Слишком много запросов (`RATE_LIMITED`)"),
};
const auth = [{ bearerAuth: [] }];
const adminOnly = (summary, description = "") => ({
  summary,
  description: `**Только администратор.** ${description}`.trim(),
  security: auth,
});
const param = (name, where, schema, description) => ({
  name,
  in: where,
  required: where === "path",
  schema,
  ...(description ? { description } : {}),
});
const slugParam = param("slug", "path", str(), "slug рецепта (на фронтенде — `recipe.id`)");
const idParam = (description) => param("id", "path", uuid, description);
const page = param("page", "query", { type: "integer", minimum: 1, default: 1 });
const limit = (max) => param("limit", "query", { type: "integer", minimum: 1, maximum: max, default: 20 });
const pageOf = (items) => obj({ items: arr(items), page: int, limit: int, total: int });

const paths = {
  // ---------- служебное ----------
  "/health": {
    get: {
      tags: ["Служебное"],
      summary: "Проверка сервера и БД",
      responses: {
        200: ok("Сервер и БД работают", obj({ status: str({ enum: ["ok"] }), db: str({ enum: ["ok"] }) })),
        503: ok("БД недоступна", obj({ status: str({ enum: ["degraded"] }), db: str({ enum: ["error"] }) })),
      },
    },
  },

  // ---------- auth ----------
  "/auth/register": {
    post: {
      tags: ["Авторизация"],
      summary: "Регистрация",
      description: "Создаёт пользователя с ролью USER и сразу открывает сессию. Лимит: 30 запросов за 15 минут на весь `/auth`.",
      requestBody: body(ref("RegisterInput")),
      responses: { 201: ok("Пользователь создан", ref("Session")), 409: err("E-mail занят (`EMAIL_TAKEN`)"), 422: E[422], 429: E[429] },
    },
  },
  "/auth/login": {
    post: {
      tags: ["Авторизация"],
      summary: "Вход",
      description: "Неверный пароль и неизвестный e-mail дают одинаковый ответ. Заблокированный пользователь войти не может.",
      requestBody: body(ref("LoginInput")),
      responses: {
        200: ok("Сессия открыта", ref("Session")),
        401: err("Неверный e-mail или пароль (`INVALID_CREDENTIALS`)"),
        403: err("Аккаунт заблокирован (`ACCOUNT_BLOCKED`)"),
        422: E[422],
        429: E[429],
      },
    },
  },
  "/auth/refresh": {
    post: {
      tags: ["Авторизация"],
      summary: "Обновление токенов (ротация)",
      description:
        "Старый refresh-токен гасится, выдаётся новая пара. Повторное предъявление погашенного токена отзывает всю цепочку (`TOKEN_REUSED`). У заблокированного пользователя токен не обновляется.",
      requestBody: body(obj({ refreshToken: str() }, ["refreshToken"])),
      responses: {
        200: ok("Новая пара токенов", ref("Tokens")),
        401: err("`INVALID_TOKEN`, `TOKEN_EXPIRED` или `TOKEN_REUSED`"),
        403: err("Аккаунт заблокирован (`ACCOUNT_BLOCKED`)"),
        422: E[422],
        429: E[429],
      },
    },
  },
  "/auth/logout": {
    post: {
      tags: ["Авторизация"],
      summary: "Выход",
      description: "Отзывает цепочку переданного refresh-токена или все сессии пользователя (`all: true`). Идемпотентен.",
      security: auth,
      requestBody: body(obj({ refreshToken: str(), all: bool })),
      responses: { 204: noContent("Сессия закрыта"), 401: E[401], 422: E[422] },
    },
  },
  "/auth/me": {
    get: {
      tags: ["Авторизация"],
      summary: "Текущий пользователь",
      security: auth,
      responses: { 200: ok("Профиль", ref("PublicUser")), 401: E[401] },
    },
  },

  // ---------- рецепты ----------
  "/recipes": {
    get: {
      tags: ["Рецепты"],
      summary: "Список рецептов",
      description:
        "Для гостей и пользователей — только опубликованные. Администратор может запросить `status=DRAFT` или `all`; остальным это даёт 403.",
      parameters: [
        param("q", "query", str(), "Поиск по названию, тегам и ингредиентам"),
        param("main", "query", str(), "Основные теги через запятую (логическое И), напр. `Второе,Курица`"),
        param("category", "query", str(), "slug категории"),
        param("maxTime", "query", { type: "integer", minimum: 1 }, "Максимальное время, минут"),
        param("sort", "query", str({ enum: ["new", "time", "title"], default: "new" })),
        param("status", "query", str({ enum: ["PUBLISHED", "DRAFT", "all"] }), "Не-PUBLISHED — только админу"),
        page,
        limit(50),
      ],
      responses: { 200: ok("Страница рецептов", pageOf(ref("RecipeCard"))), 403: E[403], 422: E[422] },
    },
    post: {
      tags: ["Рецепты"],
      ...adminOnly("Создать рецепт", "По умолчанию создаётся черновик (`status: DRAFT`); slug строится из названия, если не задан."),
      requestBody: body(ref("RecipeInput")),
      responses: { 201: ok("Создан", ref("Recipe")), 401: E[401], 403: E[403], 409: err("slug занят (`SLUG_TAKEN`)"), 422: E[422] },
    },
  },
  "/recipes/random": {
    get: {
      tags: ["Рецепты"],
      summary: "Случайный опубликованный рецепт",
      parameters: [param("main", "query", str(), "Основные теги через запятую")],
      responses: { 200: ok("slug рецепта", obj({ slug: str() }, ["slug"])), 404: E[404] },
    },
  },
  "/recipes/{slug}": {
    get: {
      tags: ["Рецепты"],
      summary: "Рецепт целиком",
      description: "Поддерживает ETag/304. Черновик виден только администратору, остальным — 404.",
      parameters: [slugParam],
      responses: { 200: ok("Рецепт", ref("Recipe")), 304: { description: "Не изменился (ETag)" }, 404: E[404] },
    },
  },
  "/recipes/{id}": {
    put: {
      tags: ["Рецепты"],
      ...adminOnly("Заменить рецепт целиком"),
      parameters: [idParam("id рецепта")],
      requestBody: body(ref("RecipeInput")),
      responses: { 200: ok("Обновлён", ref("Recipe")), 401: E[401], 403: E[403], 404: E[404], 409: err("slug занят (`SLUG_TAKEN`)"), 422: E[422] },
    },
    delete: {
      tags: ["Рецепты"],
      ...adminOnly("Удалить рецепт", "Загруженное через API фото удаляется вместе с рецептом."),
      parameters: [idParam("id рецепта")],
      responses: { 204: noContent("Удалён"), 401: E[401], 403: E[403], 404: E[404] },
    },
  },
  "/recipes/{id}/status": {
    patch: {
      tags: ["Рецепты"],
      ...adminOnly("Опубликовать или вернуть в черновики"),
      parameters: [idParam("id рецепта")],
      requestBody: body(obj({ status: str({ enum: ["DRAFT", "PUBLISHED"] }) }, ["status"])),
      responses: { 200: ok("Обновлён", ref("Recipe")), 401: E[401], 403: E[403], 404: E[404], 422: E[422] },
    },
  },
  "/catalog/snapshot": {
    get: {
      tags: ["Рецепты"],
      summary: "Весь каталог для офлайн-кэша",
      description:
        "Все опубликованные рецепты одним ответом. ETag = версия каталога; с `If-None-Match` без изменений отдаётся 304 без выборки.",
      responses: {
        200: ok("Каталог", obj({ version: str(), recipes: arr(ref("Recipe")) })),
        304: { description: "Каталог не изменился" },
      },
    },
  },
  "/categories": {
    get: {
      tags: ["Справочники"],
      summary: "Категории",
      responses: { 200: ok("Категории со счётчиком опубликованных рецептов", arr(ref("Category"))) },
    },
  },
  "/tags": {
    get: {
      tags: ["Справочники"],
      summary: "Теги",
      description: "Основные теги (из контролируемого словаря) идут первыми.",
      parameters: [param("main", "query", str({ enum: ["true"] }), "`true` — только основные теги")],
      responses: { 200: ok("Теги", arr(ref("Tag"))) },
    },
  },
  "/uploads/image": {
    post: {
      tags: ["Загрузки"],
      ...adminOnly(
        "Загрузить фото",
        "jpeg/png/webp до 5 МБ; тип определяется по сигнатуре файла. Сейчас хранилище — локальная заглушка, перед деплоем заменяется на Cloudinary."
      ),
      requestBody: {
        required: true,
        content: { "multipart/form-data": { schema: obj({ file: str({ format: "binary" }) }, ["file"]) } },
      },
      responses: {
        201: ok("Файл сохранён", obj({ url: str(), publicId: str(), width: { ...int, nullable: true }, height: { ...int, nullable: true } })),
        401: E[401],
        403: E[403],
        413: err("Файл больше 5 МБ (`FILE_TOO_LARGE`)"),
        415: err("Не jpeg/png/webp (`UNSUPPORTED_MEDIA_TYPE`)"),
        422: E[422],
      },
    },
  },

  // ---------- me ----------
  "/me/favorites": {
    get: {
      tags: ["Избранное и заметки"],
      summary: "Избранное",
      security: auth,
      responses: { 200: ok("Новые сверху", obj({ items: arr(obj({ slug: str(), createdAt: dateTime })) })), 401: E[401] },
    },
  },
  "/me/favorites/{slug}": {
    put: {
      tags: ["Избранное и заметки"],
      summary: "Добавить в избранное",
      description: "Идемпотентно. Неизвестный или черновой рецепт — 404.",
      security: auth,
      parameters: [slugParam],
      responses: { 204: noContent("Добавлено"), 401: E[401], 404: E[404] },
    },
    delete: {
      tags: ["Избранное и заметки"],
      summary: "Убрать из избранного",
      security: auth,
      parameters: [slugParam],
      responses: { 204: noContent("Убрано"), 401: E[401], 404: E[404] },
    },
  },
  "/me/notes": {
    get: {
      tags: ["Избранное и заметки"],
      summary: "Заметки",
      security: auth,
      responses: { 200: ok("Заметки", obj({ items: arr(ref("Note")) })), 401: E[401] },
    },
  },
  "/me/notes/{slug}": {
    put: {
      tags: ["Избранное и заметки"],
      summary: "Сохранить заметку",
      description: "Пустой текст удаляет заметку (204).",
      security: auth,
      parameters: [slugParam],
      requestBody: body(obj({ text: str({ maxLength: 2000 }) }, ["text"])),
      responses: {
        200: ok("Сохранено", ref("Note")),
        204: noContent("Заметка удалена (пустой текст)"),
        401: E[401],
        404: E[404],
        422: E[422],
      },
    },
    delete: {
      tags: ["Избранное и заметки"],
      summary: "Удалить заметку",
      security: auth,
      parameters: [slugParam],
      responses: { 204: noContent("Удалено"), 401: E[401], 404: E[404] },
    },
  },

  // ---------- shopping ----------
  "/me/shopping": {
    get: {
      tags: ["Список покупок"],
      summary: "Список покупок",
      security: auth,
      responses: { 200: ok("Позиции в порядке добавления", ref("ShoppingList")), 401: E[401] },
    },
    delete: {
      tags: ["Список покупок"],
      summary: "Очистить список",
      security: auth,
      responses: { 204: noContent("Очищено"), 401: E[401] },
    },
  },
  "/me/shopping/items": {
    post: {
      tags: ["Список покупок"],
      summary: "Добавить позиции",
      description:
        "Одинаковые названия (без учёта регистра и пробелов) сливаются в одну позицию; одинаковый вклад (блюдо + количество) не дублируется. Неизвестное блюдо — 404, ничего не добавляется.",
      security: auth,
      requestBody: body(obj({ items: { type: "array", minItems: 1, maxItems: 100, items: ref("ShoppingEntry") } }, ["items"])),
      responses: {
        200: ok("Добавлено и актуальный список", obj({ added: int, items: arr(ref("ShoppingItem")) })),
        401: E[401],
        404: E[404],
        422: E[422],
      },
    },
  },
  "/me/shopping/items/{id}": {
    patch: {
      tags: ["Список покупок"],
      summary: "Отметить / снять отметку",
      security: auth,
      parameters: [idParam("id позиции")],
      requestBody: body(obj({ checked: bool }, ["checked"])),
      responses: { 200: ok("Актуальный список", ref("ShoppingList")), 401: E[401], 404: E[404], 422: E[422] },
    },
    delete: {
      tags: ["Список покупок"],
      summary: "Удалить позицию",
      security: auth,
      parameters: [idParam("id позиции")],
      responses: { 204: noContent("Удалено"), 401: E[401], 404: E[404], 422: E[422] },
    },
  },
  "/me/shopping/dishes/{slug}": {
    delete: {
      tags: ["Список покупок"],
      summary: "Убрать блюдо из списка",
      description: "Вклады блюда удаляются, позиции без вкладов пропадают.",
      security: auth,
      parameters: [slugParam],
      responses: { 200: ok("Актуальный список", ref("ShoppingList")), 401: E[401] },
    },
  },

  // ---------- sync ----------
  "/me/sync": {
    post: {
      tags: ["Синхронизация"],
      summary: "Отправить офлайн-очередь (outbox)",
      description:
        "До 200 операций (тело ≤ 100 КБ, иначе 413). Операции применяются одной транзакцией в порядке `at` — всё или ничего. Конфликты — last-write-wins: заметка с `at` старше сохранённой пропускается (`STALE`); `at` из будущего обрезается до времени сервера; неизвестный рецепт — `NOT_FOUND` (операция пропускается, остальные применяются). Ответ — актуальное состояние целиком.",
      security: auth,
      requestBody: body(obj({ ops: { type: "array", maxItems: 200, items: ref("SyncOp") } }, ["ops"])),
      responses: {
        200: ok("Результат и актуальное состояние", ref("SyncResult")),
        401: E[401],
        413: err("Тело больше 100 КБ (`PAYLOAD_TOO_LARGE`)"),
        422: E[422],
      },
    },
  },

  // ---------- admin ----------
  "/admin/users": {
    get: {
      tags: ["Администрирование"],
      ...adminOnly("Список пользователей", "Права проверяются по БД, а не по JWT: разжалованный или заблокированный админ теряет доступ сразу."),
      parameters: [
        param("q", "query", str(), "Поиск по e-mail или имени"),
        param("role", "query", str({ enum: ["USER", "ADMIN"] })),
        param("blocked", "query", str({ enum: ["true", "false"] })),
        page,
        limit(100),
      ],
      responses: { 200: ok("Страница пользователей (новые сверху)", pageOf(ref("AdminUser"))), 401: E[401], 403: E[403], 422: E[422] },
    },
  },
  "/admin/users/{id}/role": {
    patch: {
      tags: ["Администрирование"],
      ...adminOnly("Сменить роль", "Нельзя снять роль ADMIN у последнего активного (не заблокированного) администратора — 409 `LAST_ADMIN`."),
      parameters: [idParam("id пользователя")],
      requestBody: body(obj({ role: str({ enum: ["USER", "ADMIN"] }) }, ["role"])),
      responses: {
        200: ok("Пользователь после изменения", ref("AdminUser")),
        401: E[401],
        403: E[403],
        404: E[404],
        409: err("Последний администратор (`LAST_ADMIN`)"),
        422: E[422],
      },
    },
  },
  "/admin/users/{id}/block": {
    patch: {
      tags: ["Администрирование"],
      ...adminOnly(
        "Заблокировать / разблокировать",
        "Заблокированный не может войти и обновить токен; все его refresh-токены отзываются сразу. Нельзя заблокировать последнего активного администратора — 409 `LAST_ADMIN`."
      ),
      parameters: [idParam("id пользователя")],
      requestBody: body(obj({ blocked: bool }, ["blocked"])),
      responses: {
        200: ok("Пользователь после изменения", ref("AdminUser")),
        401: E[401],
        403: E[403],
        404: E[404],
        409: err("Последний администратор (`LAST_ADMIN`)"),
        422: E[422],
      },
    },
  },
};

const roleEnum = str({ enum: ["USER", "ADMIN"] });
const itemKind = str({ enum: ["ITEM", "HEADER"], default: "ITEM" });
const nullableStr = (extra) => str({ nullable: true, ...extra });
const nullableInt = (extra) => ({ ...int, nullable: true, ...extra });

const recipeFields = {
  title: str({ maxLength: 200 }),
  main: arr(str({ enum: ["Первое", "Второе", "Салат", "Десерт", "Напиток", "Курица", "Свинина", "Говядина", "Шоколад"] })),
  tags: arr(str()),
  image: nullableStr({ description: "URL, `images/…` или `/uploads/…`" }),
  time: nullableStr({ example: "1 ч 10 мин" }),
  servings: nullableStr(),
};

const schemas = {
  Error: obj(
    {
      error: obj(
        {
          code: str({ example: "VALIDATION_ERROR" }),
          message: str(),
          details: { nullable: true, description: "Для 422 — массив `{field, message}`" },
        },
        ["code", "message"]
      ),
    },
    ["error"]
  ),
  PublicUser: obj({ id: uuid, email: str({ format: "email" }), displayName: str(), role: roleEnum }),
  AdminUser: obj({ id: uuid, email: str({ format: "email" }), displayName: str(), role: roleEnum, isBlocked: bool, createdAt: dateTime }),
  Tokens: obj({ accessToken: str({ description: "JWT на 15 минут" }), refreshToken: str({ description: "Одноразовый, 30 дней" }) }),
  Session: obj({ user: ref("PublicUser"), accessToken: str(), refreshToken: str() }),
  RegisterInput: obj(
    {
      email: str({ format: "email" }),
      password: str({ minLength: 8, maxLength: 72 }),
      displayName: str({ minLength: 1, maxLength: 50 }),
    },
    ["email", "password", "displayName"]
  ),
  LoginInput: obj({ email: str({ format: "email" }), password: str() }, ["email", "password"]),
  Category: obj({ id: uuid, name: str(), slug: str(), count: int }),
  Tag: obj({ id: uuid, name: str(), isMain: bool }),
  RecipeCard: obj({
    id: uuid,
    slug: str(),
    ...recipeFields,
    category: obj({ id: uuid, name: str(), slug: str() }),
    timeMinutes: nullableInt(),
    status: str({ enum: ["DRAFT", "PUBLISHED"] }),
    createdAt: dateTime,
  }),
  RecipeIngredient: obj({ kind: itemKind, name: str(), amount: nullableStr() }),
  RecipeStep: obj({ kind: itemKind, text: str(), timerSeconds: nullableInt() }),
  Recipe: {
    allOf: [
      ref("RecipeCard"),
      obj({ updatedAt: dateTime, ingredients: arr(ref("RecipeIngredient")), steps: arr(ref("RecipeStep")) }),
    ],
  },
  RecipeInput: obj(
    {
      slug: str({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: "Необязателен, иначе строится из названия" }),
      ...recipeFields,
      category: str({ description: "Название категории; новая создаётся автоматически" }),
      ingredients: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: obj({ kind: itemKind, name: str(), amount: nullableStr() }, ["name"]),
      },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: obj(
          { kind: itemKind, text: str(), timerSeconds: nullableInt({ description: "Если не задан — берётся из текста («15 мин»)" }) },
          ["text"]
        ),
      },
      status: str({ enum: ["DRAFT", "PUBLISHED"], default: "DRAFT" }),
    },
    ["title", "category", "ingredients", "steps"]
  ),
  Note: obj({ slug: str(), text: str(), updatedAt: dateTime }),
  ShoppingEntry: obj(
    {
      name: str({ maxLength: 120 }),
      amount: str({ maxLength: 200 }),
      recipe: nullableStr({ description: "slug блюда; пусто — добавлено вручную" }),
    },
    ["name"]
  ),
  ShoppingItem: obj({
    id: uuid,
    name: str(),
    checked: bool,
    contribs: arr(obj({ r: nullableStr({ description: "slug блюда или null" }), a: str({ description: "Количество" }) })),
  }),
  ShoppingList: obj({ items: arr(ref("ShoppingItem")) }),
  SyncOp: {
    description: "Операция outbox. Поле `at` — ISO 8601, время действия по часам клиента.",
    oneOf: [
      obj({ type: str({ enum: ["favorite.add", "favorite.remove", "note.remove", "shopping.removeDish"] }), slug: str(), at: dateTime }, ["type", "slug", "at"]),
      obj({ type: str({ enum: ["note.set"] }), slug: str(), text: str({ maxLength: 2000 }), at: dateTime }, ["type", "slug", "text", "at"]),
      obj({ type: str({ enum: ["shopping.add"] }), name: str(), amount: str(), recipe: nullableStr(), at: dateTime }, ["type", "name", "at"]),
      obj({ type: str({ enum: ["shopping.remove"] }), name: str(), at: dateTime }, ["type", "name", "at"]),
      obj({ type: str({ enum: ["shopping.check"] }), name: str(), checked: bool, at: dateTime }, ["type", "name", "checked", "at"]),
      obj({ type: str({ enum: ["shopping.clear"] }), at: dateTime }, ["type", "at"]),
    ],
  },
  SyncResult: obj({
    serverTime: dateTime,
    applied: int,
    skipped: arr(obj({ index: int, type: str(), reason: str({ enum: ["STALE", "NOT_FOUND"] }) })),
    favorites: arr(obj({ slug: str(), createdAt: dateTime })),
    notes: arr(ref("Note")),
    shopping: arr(ref("ShoppingItem")),
  }),
};

module.exports = {
  openapi: "3.0.3",
  info: {
    title: "API сайта рецептов",
    version: "0.1.0",
    description:
      "Все пути — под префиксом `/api/v1`. Access-токен (JWT, 15 минут) передаётся как `Authorization: Bearer …`; " +
      "refresh-токен обновляется через `/auth/refresh`. Ошибки имеют единый формат `{error: {code, message, details}}`.\n\n" +
      "Чтобы пробовать защищённые методы: выполните `/auth/login`, скопируйте `accessToken` и нажмите **Authorize**.",
  },
  servers: [{ url: "/api/v1", description: "Текущий сервер" }],
  tags: [
    { name: "Служебное" },
    { name: "Авторизация" },
    { name: "Рецепты" },
    { name: "Справочники" },
    { name: "Загрузки" },
    { name: "Избранное и заметки" },
    { name: "Список покупок" },
    { name: "Синхронизация" },
    { name: "Администрирование" },
  ],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas,
  },
};
