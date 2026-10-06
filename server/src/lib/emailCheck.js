// Проверки e-mail при регистрации (существующих пользователей не касаются):
// одноразовые домены (готовый список disposable-email-domains) и наличие у домена приёма почты (DNS).
const dns = require("node:dns").promises;
const env = require("../config/env");
const logger = require("./logger");

const DISPOSABLE = new Set(require("disposable-email-domains"));
// домены, у которых одноразовым считается и любой поддомен
const DISPOSABLE_WILDCARD = new Set(require("disposable-email-domains/wildcard.json"));

const DNS_TIMEOUT_MS = 3000;
const TTL_OK_MS = 60 * 60 * 1000;   // домен принимает почту — помним час
const TTL_BAD_MS = 10 * 60 * 1000;  // домена нет — недолго, вдруг опечатка уже исправили/домен зарегистрировали
const CACHE_MAX = 2000;

// в тестах DNS не трогаем (там example.com с «null MX»); конкретные тесты включают проверку через configure()
const state = { enabled: env.NODE_ENV !== "test", resolver: dns };
const cache = new Map(); // domain -> { ok, until }

function configure({ enabled, resolver } = {}) {
  if (enabled !== undefined) state.enabled = enabled;
  if (resolver !== undefined) state.resolver = resolver;
  cache.clear();
}

const isAscii = (s) => /^[\x21-\x7e]+$/.test(s);
const domainOf = (email) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

// mail.mailinator.com тоже одноразовый, если mailinator.com в списке: проверяем все родительские домены
function isDisposable(domain) {
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join(".");
    if (DISPOSABLE.has(d)) return true;
    if (i > 0 && DISPOSABLE_WILDCARD.has(d)) return true;
  }
  return DISPOSABLE_WILDCARD.has(domain);
}

// «Чёрные дыры»: парковки и заглушки (asdasd.ru → void.blackhole.mx) формально имеют MX, но письма уходят в никуда
const SINK_SUFFIXES = ["blackhole.mx", "invalid", "localhost", "example.com", "example.net", "example.org"];
const isSinkHost = (host) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  return SINK_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
};

const withTimeout = (p) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("DNS timeout"), { code: "ETIMEOUT" })), DNS_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });

// «нет такого домена / нет записей» — это определённый ответ; всё остальное (SERVFAIL, таймаут, сеть) — сбой DNS
const isDefinitive = (e) => e && (e.code === "ENOTFOUND" || e.code === "ENODATA");

const ipLookup = async (domain) => {
  const attempts = await Promise.allSettled([state.resolver.resolve4(domain), state.resolver.resolve6(domain)]);
  if (attempts.some((a) => a.status === "fulfilled" && a.value.length)) return true;
  const failure = attempts.find((a) => a.status === "rejected" && !isDefinitive(a.reason));
  if (failure) throw failure.reason;
  return false;
};

// true — почту принимать есть кому; false — домена нет или он явно не принимает почту; бросает при сбое DNS
async function lookup(domain) {
  let mx;
  try {
    mx = await state.resolver.resolveMx(domain);
  } catch (e) {
    if (!isDefinitive(e)) throw e;
    mx = [];
  }
  // «null MX» (RFC 7505): единственная запись с пустым обменником — домен прямо заявляет, что почту не принимает
  if (mx.length) return mx.some((r) => r.exchange && r.exchange !== "." && !isSinkHost(r.exchange));
  // MX нет → по RFC почту принимает сам домен, если у него есть A/AAAA
  return ipLookup(domain);
}

// Вердикт по домену: "ok" | "no-mail" | "unknown" (DNS сбоит — регистрацию не блокируем)
async function mailVerdict(domain) {
  if (!state.enabled) return "ok";
  const hit = cache.get(domain);
  if (hit && hit.until > Date.now()) return hit.ok ? "ok" : "no-mail";
  try {
    const ok = await withTimeout(lookup(domain));
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(domain, { ok, until: Date.now() + (ok ? TTL_OK_MS : TTL_BAD_MS) });
    return ok ? "ok" : "no-mail";
  } catch (e) {
    logger.warn({ domain, code: e.code }, "DNS-проверка e-mail не удалась, регистрация пропущена без проверки");
    return "unknown";
  }
}

module.exports = { configure, isAscii, domainOf, isDisposable, mailVerdict };
