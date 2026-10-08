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
      description:
        "Создаёт пользователя с ролью USER, открывает сессию и отправляет письмо со ссылкой подтверждения e-mail (если почта недоступна, регистрация всё равно проходит — `verificationSent: false`, письмо можно запросить повторно). Пароль нужно ввести дважды (`confirmPassword`). Неподтверждённые аккаунты старше 7 дней удаляются; аккаунты без единого действия (вход, синхронизация, предложение) старше 30 дней — тоже. Если на сервере включена капча (`turnstileSiteKey` в `/config` не null), нужен токен `turnstileToken` из виджета Cloudflare Turnstile. E-mail Gmail сравнивается без точек и `+метки` (`a.b+x@gmail.com` = `ab@gmail.com`). Лимит: 30 запросов за 15 минут на весь `/auth`; кроме того, более 100 регистраций за час на весь сайт — временный отказ 429 `REGISTRATION_PAUSED` (заголовок `Retry-After`).",
      requestBody: body(ref("RegisterInput")),
      responses: { 201: ok("Пользователь создан", ref("Session")), 400: err("Нет токена капчи (`CAPTCHA_REQUIRED`) или проверка не пройдена (`CAPTCHA_FAILED`)"), 409: err("E-mail занят (`EMAIL_TAKEN`), в т.ч. другой вариант записи того же адреса Gmail"), 422: err("Ошибка валидации (`VALIDATION_ERROR`, в т.ч. не-ASCII e-mail), одноразовый домен (`EMAIL_DISPOSABLE`) опечатка в популярном домене (`EMAIL_TYPO`) или домен без приёма почты (`EMAIL_DOMAIN_INVALID`, в т.ч. MX в «чёрную дыру»)"), 429: err("Лимит запросов (`RATE_LIMITED`) или регистрация временно приостановлена (`REGISTRATION_PAUSED`)"), 503: err("Капча временно недоступна (`CAPTCHA_UNAVAILABLE`)") },
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
  "/auth/verify-email": {
    post: {
      tags: ["Авторизация"],
      summary: "Подтверждение e-mail по ссылке из письма",
      description:
        "Токен из ссылки (страница фронтенда `#/verify?token=…` отправляет его сюда). Одноразовый, действует 24 часа, в БД хранится только его SHA-256. Вход не требуется — ссылку можно открыть на другом устройстве.",
      requestBody: body(obj({ token: str() }, ["token"])),
      responses: {
        200: ok("E-mail подтверждён", obj({ verified: bool, email: str({ format: "email" }) })),
        400: err("Ссылка недействительна, устарела или уже использована (`INVALID_TOKEN`)"),
        422: E[422],
        429: E[429],
      },
    },
  },
  "/auth/resend-verification": {
    post: {
      tags: ["Авторизация"],
      summary: "Повторно отправить письмо подтверждения",
      description:
        "Не чаще раза в минуту и не больше 5 писем в час на пользователя (`RESEND_TOO_SOON`, `RESEND_LIMIT`); дополнительно — не больше 10 запросов в час с одного IP. Старые ссылки остаются действительными до истечения срока.",
      security: auth,
      responses: {
        202: ok("Письмо отправлено", obj({ ok: bool })),
        503: err("Почта отключена (`MAIL_DISABLED`): в production нет ключей Brevo/Mailjet — временно недоступно"),
        401: E[401],
        403: E[403],
        409: err("E-mail уже подтверждён (`ALREADY_VERIFIED`)"),
        429: err("`RESEND_TOO_SOON`, `RESEND_LIMIT` или `RATE_LIMITED`"),
        502: err("Почтовый сервис не принял письмо (`EMAIL_SEND_FAILED`)"),
      },
    },
  },
  "/auth/forgot-password": {
    post: {
      tags: ["Авторизация"],
      summary: "Забыли пароль: письмо со ссылкой для сброса",
      description:
        "Ответ всегда одинаковый (202), независимо от того, зарегистрирован ли e-mail, — адреса перебирать нельзя. Ссылка одноразовая, действует 1 час; действует только последняя запрошенная. Не чаще раза в минуту и 5 раз в час на пользователя (лишние запросы молча игнорируются); не больше 10 запросов в час с одного IP.",
      requestBody: body(obj({ email: str({ format: "email" }) }, ["email"])),
      responses: { 202: ok("Если такой e-mail есть, письмо отправлено", obj({ ok: bool })), 422: E[422], 429: E[429], 503: err("Почта отключена (`MAIL_DISABLED`): в production нет ключей Brevo/Mailjet — временно недоступно"), },
    },
  },
  "/auth/reset-password": {
    post: {
      tags: ["Авторизация"],
      summary: "Установить новый пароль по ссылке из письма",
      description:
        "Меняет пароль, **отзывает все сессии** пользователя (везде придётся войти заново) и подтверждает e-mail. Токен одноразовый.",
      requestBody: body(ref("ResetPasswordInput")),
      responses: {
        200: ok("Пароль изменён", obj({ ok: bool })),
        400: err("Ссылка недействительна, устарела или уже использована (`INVALID_TOKEN`)"),
        422: E[422],
        429: E[429],
      },
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
  "/config": {
    get: {
      tags: ["Справочники"],
      summary: "Публичные настройки сервера",
      description: "`mailEnabled: false` — почта отключена: e-mail не подтверждается (все считаются подтверждёнными), «забыли пароль» и повторная отправка письма отвечают 503 `MAIL_DISABLED`. Фронтенд по этому флагу прячет соответствующие элементы.",
      responses: { 200: ok("Настройки", obj({ mailEnabled: bool, submissionsPerDay: int, turnstileSiteKey: { type: "string", nullable: true, description: "Публичный ключ виджета Cloudflare Turnstile; null — капча выключена" } })) },
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
      summary: "Загрузить фото",
      description:
        "**Действующий администратор или пользователь с подтверждённым e-mail** (для предложений рецептов; права читаются из БД). jpeg/png/webp до 5 МБ; тип определяется по сигнатуре файла. Обычным пользователям — не больше 20 загрузок в час (429 `RATE_LIMITED`); без подтверждённого e-mail — 403 `EMAIL_NOT_VERIFIED`.",
      security: auth,
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

  // ---------- предложения рецептов ----------
  "/me/submissions": {
    get: {
      tags: ["Предложения рецептов"],
      summary: "Мои предложения",
      description: "Только предложения текущего пользователя (новые сверху, до 100), со статусом и причиной отказа.",
      security: auth,
      responses: { 200: ok("Список", obj({ items: arr(ref("Submission")), limitPerDay: int })), 401: E[401] },
    },
    post: {
      tags: ["Предложения рецептов"],
      summary: "Предложить рецепт",
      description:
        "Нужен подтверждённый e-mail (403 `EMAIL_NOT_VERIFIED`). Рецепт уходит на модерацию (`PENDING`). Поля `slug` и `status` игнорируются; категория — только существующая; фото — только загруженное через `/uploads/image`; до 10 тегов. Лимит — `SUBMISSIONS_PER_DAY` (3) отправок за 24 часа: 429 `SUBMISSION_LIMIT`. При включённой капче нужен `turnstileToken` (400 `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED`, 503 `CAPTCHA_UNAVAILABLE`); у `PUT` капчи нет.",
      security: auth,
      requestBody: body(ref("SubmissionInput")),
      responses: { 201: ok("Предложение создано", ref("Submission")), 400: err("Капча: `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED`"), 401: E[401], 403: E[403], 422: E[422], 503: err("Капча временно недоступна (`CAPTCHA_UNAVAILABLE`)"), 429: err("Лимит предложений (`SUBMISSION_LIMIT`) или общий лимит запросов") },
    },
  },
  "/me/submissions/{id}": {
    get: {
      tags: ["Предложения рецептов"],
      summary: "Моё предложение",
      description: "Чужое или несуществующее предложение — 404.",
      security: auth,
      parameters: [idParam("id предложения")],
      responses: { 200: ok("Предложение", ref("Submission")), 401: E[401], 404: E[404] },
    },
    put: {
      tags: ["Предложения рецептов"],
      summary: "Изменить предложение",
      description:
        "Пока оно `PENDING` или `REJECTED`; после одобрения — 409 `NOT_EDITABLE`. Если администратор сохранил правки без публикации (`adminEditedAt` задан), пока он не принял решение, автор править не может — 409 `ADMIN_EDITING`; после отказа правка снова доступна. Правка отклонённого возвращает его на модерацию (причина стирается) и считается новой отправкой в лимите.",
      security: auth,
      parameters: [idParam("id предложения")],
      requestBody: body(ref("SubmissionInput")),
      responses: { 200: ok("Предложение после правки", ref("Submission")), 401: E[401], 403: E[403], 404: E[404], 409: err("Уже рассмотрено (`NOT_EDITABLE`) или администратор вносит правки (`ADMIN_EDITING`)"), 422: E[422], 429: err("Лимит предложений (`SUBMISSION_LIMIT`)") },
    },
  },
  "/admin/submissions": {
    get: {
      tags: ["Предложения рецептов"],
      ...adminOnly("Очередь предложений", "Только `PENDING`, старые сверху, с автором. «Поправить и опубликовать» — обычный `PUT /recipes/{id}` со `status: PUBLISHED`."),
      parameters: [page, limit(50)],
      responses: { 200: ok("Страница очереди", pageOf(ref("SubmissionQueueItem"))), 401: E[401], 403: E[403], 422: E[422] },
    },
  },
  "/admin/submissions/{id}": {
    put: {
      tags: ["Предложения рецептов"],
      ...adminOnly(
        "Сохранить правки предложения без публикации",
        "Тело — как у `POST /recipes` (`status` игнорируется). Предложение остаётся `PENDING`, ставится `adminEditedAt`: автор больше не может его править (409 `ADMIN_EDITING`), в «Моих предложениях» — «Администратор вносит правки», в очереди — метка «в работе». Обновление условное (только `PENDING`): уже рассмотренное — 409 `NOT_PENDING`. Отказ снимает блокировку автора."
      ),
      parameters: [idParam("id предложения")],
      requestBody: body(ref("RecipeInput")),
      responses: { 200: ok("Предложение с правками", ref("SubmissionQueueItem")), 401: E[401], 403: E[403], 404: E[404], 409: err("Уже рассмотрено (`NOT_PENDING`) или занят slug (`SLUG_TAKEN`)"), 422: E[422] },
    },
  },
  "/admin/submissions/{id}/approve": {
    post: {
      tags: ["Предложения рецептов"],
      ...adminOnly("Одобрить предложение", "Рецепт публикуется и поднимается в начало ленты. Уже рассмотренное — 409 `NOT_PENDING`."),
      parameters: [idParam("id предложения")],
      responses: { 200: ok("Опубликованный рецепт", ref("Submission")), 401: E[401], 403: E[403], 404: E[404], 409: err("Уже рассмотрено (`NOT_PENDING`)") },
    },
  },
  "/admin/submissions/{id}/reject": {
    post: {
      tags: ["Предложения рецептов"],
      ...adminOnly("Отклонить предложение", "Причина обязательна (3–500 символов), её видит автор. Отклонённые без правок 30 дней удаляются вместе с фото."),
      parameters: [idParam("id предложения")],
      requestBody: body(obj({ reason: str({ minLength: 3, maxLength: 500 }) }, ["reason"])),
      responses: { 200: ok("Отклонённое предложение", ref("Submission")), 401: E[401], 403: E[403], 404: E[404], 409: err("Уже рассмотрено (`NOT_PENDING`)"), 422: E[422] },
    },
  },

  // ---------- статистика ----------
  "/stats/view": {
    post: {
      tags: ["Статистика"],
      summary: "Засчитать просмотр рецепта",
      description:
        "Лёгкий публичный запрос, который фронтенд шлёт при открытии рецепта — не чаще раза в сутки с устройства (это следит клиент: сервер устройств не различает). Хранится только счётчик на пару (рецепт, день UTC): ни IP, ни пользователя, ни устройства. Неизвестный и неопубликованный slug молча игнорируется (тот же 204). Лимит: 60 запросов за 15 минут с одного IP.",
      requestBody: body(obj({ slug: str() }, ["slug"])),
      responses: { 204: noContent("Принято"), 422: E[422], 429: E[429] },
    },
  },
  "/admin/stats": {
    get: {
      tags: ["Статистика"],
      ...adminOnly(
        "Сводка статистики",
        "Просмотры, избранное и корзина по опубликованным рецептам (избранное и корзина — сколько пользователей держат рецепт сейчас), новые пользователи и предложения по неделям (недели с понедельника, UTC; последняя — текущая, неполная)."
      ),
      parameters: [param("weeks", "query", { type: "integer", minimum: 1, maximum: 52, default: 12 }, "Сколько недель в графиках")],
      responses: { 200: ok("Статистика", ref("Stats")), 401: E[401], 403: E[403], 422: E[422] },
    },
  },

  // ---------- push ----------
  "/admin/push/key": {
    get: {
      tags: ["Push-уведомления"],
      ...adminOnly("Открытый ключ VAPID", "Нужен браузеру для `pushManager.subscribe`. `enabled: false` — на сервере нет ключей, пуши отключены."),
      responses: { 200: ok("Ключ", obj({ enabled: bool, publicKey: { type: "string", nullable: true } })), 401: E[401], 403: E[403] },
    },
  },
  "/admin/push/subscription": {
    put: {
      tags: ["Push-уведомления"],
      ...adminOnly(
        "Подписать этот браузер",
        "Повторный вызов с тем же `endpoint` обновляет ключи и передаёт подписку текущему админу. Не больше 10 подписок на админа (старые вытесняются). Принимаются только https-адреса push-сервисов (не localhost/IP)."
      ),
      requestBody: body(ref("PushSubscription")),
      responses: { 204: noContent("Подписка сохранена"), 401: E[401], 403: E[403], 422: E[422], 503: err("Нет VAPID-ключей (`PUSH_DISABLED`)") },
    },
    delete: {
      tags: ["Push-уведомления"],
      ...adminOnly("Отписать этот браузер", "Удаляет только подписки текущего админа; повторный вызов безвреден."),
      requestBody: body(obj({ endpoint: str() }, ["endpoint"])),
      responses: { 204: noContent("Подписки нет (или удалена)"), 401: E[401], 403: E[403], 422: E[422] },
    },
  },
  "/admin/push/test": {
    post: {
      tags: ["Push-уведомления"],
      ...adminOnly("Тестовое уведомление", "Отправляет пробный пуш на подписку этого устройства и ждёт ответа push-сервиса."),
      requestBody: body(obj({ endpoint: str() }, ["endpoint"])),
      responses: {
        200: ok("Отправлено", obj({ sent: bool })),
        401: E[401],
        403: E[403],
        404: E[404],
        410: err("Подписка устарела и удалена (`SUBSCRIPTION_GONE`)"),
        422: E[422],
        502: err("Push-сервис не принял уведомление (`PUSH_FAILED`)"),
        503: err("Нет VAPID-ключей (`PUSH_DISABLED`)"),
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
  PublicUser: obj({ id: uuid, email: str({ format: "email" }), displayName: str(), role: roleEnum, emailVerified: bool }),
  Stats: obj({
    generatedAt: dateTime,
    summary: obj({
      views: int, views7d: int, favorites: int, cart: int, users: int, newUsers7d: int,
      publishedRecipes: int, submissions: int, pendingSubmissions: int,
    }),
    weeks: arr(obj({ week: str({ format: "date", description: "понедельник недели (UTC)" }), views: int, newUsers: int, submissions: int })),
    recipes: arr(obj({ slug: str(), title: str(), views: int, views7d: int, favorites: int, cart: int })),
  }),
  PushSubscription: obj(
    { endpoint: str({ format: "uri", description: "https-адрес push-сервиса браузера" }), keys: obj({ p256dh: str(), auth: str() }, ["p256dh", "auth"]) },
    ["endpoint", "keys"]
  ),
  AdminUser: obj({ id: uuid, email: str({ format: "email" }), displayName: str(), role: roleEnum, isBlocked: bool, createdAt: dateTime }),
  Tokens: obj({ accessToken: str({ description: "JWT на 15 минут" }), refreshToken: str({ description: "Одноразовый, 30 дней" }) }),
  Session: obj({
    user: ref("PublicUser"),
    accessToken: str(),
    refreshToken: str(),
    verificationSent: { type: "boolean", description: "Только при регистрации: ушло ли письмо подтверждения" },
  }),
  RegisterInput: obj(
    {
      email: str({ format: "email" }),
      password: str({ minLength: 8, maxLength: 72 }),
      confirmPassword: str({ description: "Повтор пароля; должен совпадать с `password`" }),
      displayName: str({ minLength: 1, maxLength: 50 }),
      turnstileToken: str({ description: "Токен виджета Cloudflare Turnstile; обязателен, если капча включена (см. `/config`)" }),
    },
    ["email", "password", "confirmPassword", "displayName"]
  ),
  ResetPasswordInput: obj(
    {
      token: str({ description: "Токен из ссылки в письме" }),
      password: str({ minLength: 8, maxLength: 72 }),
      confirmPassword: str(),
    },
    ["token", "password", "confirmPassword"]
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
    status: str({ enum: ["DRAFT", "PUBLISHED", "PENDING", "REJECTED"] }),
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
  SubmissionInput: obj(
    {
      title: str({ maxLength: 200 }),
      category: str({ description: "Название СУЩЕСТВУЮЩЕЙ категории (из /categories)" }),
      main: arr(str()),
      tags: { type: "array", maxItems: 10, items: str({ maxLength: 40 }) },
      image: nullableStr({ description: "URL фото, загруженного через /uploads/image" }),
      turnstileToken: str({ description: "Токен Cloudflare Turnstile; нужен только в POST и только если капча включена" }),
      time: nullableStr(),
      servings: nullableStr(),
      ingredients: { type: "array", minItems: 1, maxItems: 100, items: obj({ kind: itemKind, name: str(), amount: nullableStr() }, ["name"]) },
      steps: { type: "array", minItems: 1, maxItems: 100, items: obj({ kind: itemKind, text: str(), timerSeconds: nullableInt() }, ["text"]) },
    },
    ["title", "category", "ingredients", "steps"]
  ),
  Submission: {
    allOf: [
      ref("Recipe"),
      obj({ submittedAt: dateTime, rejectReason: nullableStr({ description: "Только у `REJECTED`" }), reviewedAt: { ...dateTime, nullable: true }, adminEditedAt: { ...dateTime, nullable: true, description: "Админ сохранил правки без публикации (только у `PENDING`): автор править не может" } }),
    ],
  },
  SubmissionQueueItem: {
    allOf: [ref("Submission"), obj({ author: obj({ id: uuid, displayName: str(), email: str() }) })],
  },
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
      "**Лимиты запросов** (по IP, ответ `429 RATE_LIMITED`, заголовки `RateLimit-*`): всё API — 3000 за 15 минут; запись (POST/PUT/PATCH/DELETE) — 150 за 15 минут; `/me/sync` — 1500 за 15 минут; просмотры рецептов — 600 за 15 минут; вход — 10 неудачных попыток за 15 минут на пару IP+e-mail и 200 за 15 минут по IP; регистрация — 50 за 15 минут по IP (`/auth/refresh` и `/auth/me` — только общий лимит); письма (`forgot-password`, `resend-verification`) — 10 в час. `/health` без лимита.\n\n" +
      "Чтобы пробовать защищённые методы: выполните `/auth/login`, скопируйте `accessToken` и нажмите **Authorize**.",
  },
  servers: [{ url: "/api/v1", description: "Текущий сервер" }],
  tags: [
    { name: "Служебное" },
    { name: "Авторизация" },
    { name: "Рецепты" },
    { name: "Справочники" },
    { name: "Загрузки" },
    { name: "Предложения рецептов" },
    { name: "Избранное и заметки" },
    { name: "Список покупок" },
    { name: "Синхронизация" },
    { name: "Администрирование" },
    { name: "Статистика" },
    { name: "Push-уведомления" },
  ],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas,
  },
};
