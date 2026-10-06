// Web Push на фронтенде: обработчики service worker (push, notificationclick) и определение поддержки (iPhone).
// Браузера нет — sw.js выполняется в vm с поддельным `self`, push.js — с поддельными navigator/window.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- service worker ----------

function loadSW({ clients = [] } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: (title, opts) => { shown.push({ title, opts }); return Promise.resolve(); } },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => { opened.push(url); },
      claim: async () => {},
    },
    skipWaiting: async () => {},
    location: { origin: "https://site.test" },
  };
  self.self = self;
  vm.runInNewContext(fs.readFileSync(path.join(root, "sw.js"), "utf8"), { self, location: self.location, caches: {}, Request: class {}, URL, Promise });
  // dispatch ждёт waitUntil, как браузер
  const fire = async (type, ev) => {
    let p;
    handlers[type]({ ...ev, waitUntil: (x) => { p = x; } });
    await p;
  };
  return { fire, shown, opened };
}
const pushEvent = (obj) => ({ data: { json: () => obj, text: () => JSON.stringify(obj) } });

test("push: всегда показывает уведомление с заголовком, текстом, иконкой, тегом и страницей для клика", async () => {
  const sw = loadSW();
  await sw.fire("push", pushEvent({ title: "Новое предложение рецепта", body: "«Борщ» — Аня", hash: "#/admin/submissions", tag: "submission-1" }));
  assert.equal(sw.shown.length, 1);
  const { title, opts } = sw.shown[0];
  assert.equal(title, "Новое предложение рецепта");
  assert.equal(opts.body, "«Борщ» — Аня");
  assert.equal(opts.tag, "submission-1");
  assert.equal(opts.icon, "icons/icon-192.png");
  assert.equal(opts.data.hash, "#/admin/submissions");
});

test("push: мусор вместо JSON или пустое тело — уведомление всё равно показывается (требование iOS)", async () => {
  let sw = loadSW();
  await sw.fire("push", { data: { json: () => { throw new Error("bad json"); }, text: () => "просто текст" } });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "Рецепты");
  assert.equal(sw.shown[0].opts.body, "просто текст");

  sw = loadSW();
  await sw.fire("push", { data: null });
  assert.equal(sw.shown.length, 1);
});

test("push: hash принимается только вида #/…, чужие ссылки отбрасываются", async () => {
  const sw = loadSW();
  await sw.fire("push", pushEvent({ title: "x", hash: "https://evil.example/" }));
  await sw.fire("push", pushEvent({ title: "x", hash: 42 }));
  assert.equal(sw.shown[0].opts.data.hash, "");
  assert.equal(sw.shown[1].opts.data.hash, "");
});

test("клик по пушу, приложение открыто: фокус и сообщение push-open с нужной страницей", async () => {
  const log = [];
  const client = { focus: async () => { log.push("focus"); }, postMessage: (m) => log.push(m) };
  const sw = loadSW({ clients: [client] });
  let closed = false;
  await sw.fire("notificationclick", { notification: { close: () => { closed = true; }, data: { hash: "#/admin/submissions" } } });
  assert.ok(closed);
  assert.deepEqual(JSON.parse(JSON.stringify(log)), ["focus", { type: "push-open", hash: "#/admin/submissions" }]); // JSON — объекты из vm другого realm
  assert.equal(sw.opened.length, 0);
});

test("клик по пушу, приложение закрыто: открывается окно сразу на странице предложений", async () => {
  const sw = loadSW({ clients: [] });
  await sw.fire("notificationclick", { notification: { close() {}, data: { hash: "#/admin/submissions" } } });
  assert.deepEqual(sw.opened, ["./#/admin/submissions"]);
});

test("клик по уведомлению таймера (без data): как раньше — только фокус, без сообщений", async () => {
  const log = [];
  const client = { focus: async () => { log.push("focus"); }, postMessage: (m) => log.push(m) };
  let sw = loadSW({ clients: [client] });
  await sw.fire("notificationclick", { notification: { close() {} } });
  assert.deepEqual(log, ["focus"]);

  sw = loadSW({ clients: [] });
  await sw.fire("notificationclick", { notification: { close() {}, data: {} } });
  assert.deepEqual(sw.opened, ["./"]);
});

test("новые модули push есть в списке офлайн-кэша sw.js", () => {
  const src = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  for (const f of ["js/sync/push.js", "js/views/adminPush.js"]) assert.ok(src.includes(`"${f}"`), f);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const v = (re, s) => s.match(re)[1];
  assert.equal(v(/recipes-v(\d+)/, src), v(/js\/main\.js\?v=(\d+)/, html), "версия кэша sw.js = версия в index.html");
});

// ---------- определение поддержки ----------

async function support(env) {
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set("location", { hostname: "localhost" });
  set("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  set("navigator", env.navigator);
  // в браузере window — это и есть глобальный объект, поэтому PushManager/Notification кладём в оба места
  const win = { navigator: env.navigator, matchMedia: () => ({ matches: Boolean(env.standalone) }) };
  if (env.PushManager) win.PushManager = class {};
  if (env.Notification) win.Notification = class {};
  set("window", win);
  set("matchMedia", win.matchMedia);
  if (env.Notification) set("Notification", win.Notification);
  try {
    const mod = await import("../js/sync/push.js");
    return mod.support();
  } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
  }
}
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";
const nav = (ua, extra = {}) => ({ userAgent: ua, platform: "x", maxTouchPoints: 0, serviceWorker: {}, ...extra });

test("support: iPhone во вкладке Safari → просим установить на экран «Домой» (даже если PushManager есть)", async () => {
  assert.equal(await support({ navigator: nav(IPHONE), PushManager: true, Notification: true }), "ios-install");
  assert.equal(await support({ navigator: nav(IPHONE) }), "ios-install");
});

test("support: iPhone, сайт установлен на «Домой» (navigator.standalone или display-mode) → можно", async () => {
  assert.equal(await support({ navigator: nav(IPHONE, { standalone: true }), PushManager: true, Notification: true }), "ok");
  assert.equal(await support({ navigator: nav(IPHONE), standalone: true, PushManager: true, Notification: true }), "ok");
});

test("support: iPad с «десктопным» user-agent (MacIntel + касания) считается iOS", async () => {
  const ipad = nav(DESKTOP.replace("Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15_7"), { platform: "MacIntel", maxTouchPoints: 5 });
  assert.equal(await support({ navigator: ipad, PushManager: true, Notification: true }), "ios-install");
});

test("support: обычный браузер — ok при PushManager и Notification, иначе unsupported", async () => {
  assert.equal(await support({ navigator: nav(DESKTOP), PushManager: true, Notification: true }), "ok");
  assert.equal(await support({ navigator: nav(DESKTOP), Notification: true }), "unsupported");
  const noSW = nav(DESKTOP);
  delete noSW.serviceWorker; // "serviceWorker" in navigator — по наличию ключа
  assert.equal(await support({ navigator: noSW, PushManager: true, Notification: true }), "unsupported");
});
