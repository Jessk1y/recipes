// Тесты документации: Swagger UI доступен, спецификация валидна и совпадает с реальными маршрутами.
process.env.NODE_ENV = "test";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");
const SwaggerParser = require("@apidevtools/swagger-parser");
const app = require("../src/app");
const prisma = require("../src/lib/prisma");
const spec = require("../src/docs/openapi");

after(() => prisma.$disconnect());

const METHODS = ["get", "post", "put", "patch", "delete"];
const norm = (p) => p.replace(/\{[^}]+\}|:[A-Za-z]+/g, "{}").replace(/\/+$/, "") || "/";

test("/api/docs отдаёт Swagger UI, /api/docs.json — спецификацию", async () => {
  const ui = await request(app).get("/api/docs/");
  assert.equal(ui.status, 200);
  assert.match(ui.headers["content-type"], /text\/html/);
  assert.match(ui.text, /swagger-ui/);

  const doc = await request(app).get("/api/docs.json");
  assert.equal(doc.status, 200);
  assert.equal(doc.body.openapi, "3.0.3");
  assert.ok(Object.keys(doc.body.paths).length > 20);
});

test("спецификация — корректный OpenAPI 3 (все $ref разрешаются)", async () => {
  await SwaggerParser.validate(structuredClone(spec));
});

test("каждая операция описана: tags, summary, responses; защищённые — с security и ответом 401", () => {
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of METHODS.filter((m) => item[m])) {
      const op = item[m];
      const where = `${m.toUpperCase()} ${p}`;
      assert.ok(op.tags?.length, `${where}: tags`);
      assert.ok(op.summary, `${where}: summary`);
      assert.ok(Object.keys(op.responses).length, `${where}: responses`);
      if (op.security) assert.ok(op.responses[401], `${where}: защищённый путь без описания 401`);
    }
  }
});

test("админские операции помечены security и 403", () => {
  const adminOps = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of METHODS.filter((m) => item[m])) {
      if (item[m].description?.startsWith("**Только администратор.**")) adminOps.push([m, p, item[m]]);
    }
  }
  // 4 записи рецептов + 3 метода admin/users + 3 метода admin/submissions (загрузка фото — не только админам)
  assert.equal(adminOps.length, 10, `админских операций: ${adminOps.length}`);
  for (const [m, p, op] of adminOps) {
    assert.ok(op.security, `${m} ${p}: security`);
    assert.ok(op.responses[403], `${m} ${p}: 403`);
  }
});

// Сверка с исходниками роутеров: новый маршрут без описания в Swagger (или описание несуществующего
// маршрута) ломает тест.
test("спецификация совпадает с реальными маршрутами приложения", () => {
  const mounts = {
    auth: "/auth",
    recipes: "/recipes",
    taxonomy: "",
    media: "/uploads",
    shopping: "/me/shopping",
    sync: "/me/sync",
    submissions: "/me/submissions",
    me: "/me",
    admin: "/admin",
  };
  const real = new Set(["GET /health", "GET /catalog/snapshot"]);
  // модерация предложений лежит в admin.router.js, но описана в модуле submissions — проверяется там же
  for (const [mod, prefix] of Object.entries(mounts)) {
    const src = fs.readFileSync(path.join(__dirname, `../src/modules/${mod}/${mod}.router.js`), "utf8");
    const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g;
    let m;
    let found = 0;
    while ((m = re.exec(src))) {
      real.add(`${m[1].toUpperCase()} ${norm(prefix + (m[2] === "/" ? "" : m[2]))}`);
      found++;
    }
    assert.ok(found > 0, `в ${mod}.router.js не найдено маршрутов — сломался разбор`);
  }

  const documented = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of METHODS.filter((m) => item[m])) documented.add(`${m.toUpperCase()} ${norm(p)}`);
  }

  const undocumented = [...real].filter((r) => !documented.has(r));
  const phantom = [...documented].filter((d) => !real.has(d));
  assert.deepEqual(undocumented, [], "маршруты без описания в Swagger");
  assert.deepEqual(phantom, [], "описаны, но не существуют");
});
