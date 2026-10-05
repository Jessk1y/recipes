// Таймеры шагов и свои таймеры, звук (WebAudio) и уведомления.
// Перенесено из app.js без изменений логики — звук таймера должен остаться ровно таким же.
import { state } from "./ui.js";
import { fmtClock, toast } from "../lib/utils.js";

// ---------- Таймеры ----------
const timers = new Map();
const ringingBtns = new Set();
function handleTimerClick(btn) {
  if (btn.classList.contains("ringing")) { stopRing(btn); return; }
  if (timers.has(btn)) stopTimer(btn); else startTimerBtn(btn);
}
function stopRing(btn) {
  ringingBtns.delete(btn);
  btn.classList.remove("ringing");
  btn.textContent = "✅ Готово!";
  if (ringingBtns.size === 0) silenceAlarm();
}
function clearAllTimers() {
  timers.forEach((iv) => clearInterval(iv));
  timers.clear();
  ringingBtns.clear();
  silenceAlarm();
}
function startTimerBtn(btn) {
  ensureAudio();              // разблокировать звук по жесту
  requestNotifyPermission();  // спросить разрешение на уведомления
  if (timers.has(btn)) return;
  const total = +btn.dataset.sec;
  const endAt = Date.now() + total * 1000;
  btn.classList.remove("done");
  btn.classList.add("running");
  const tick = () => {
    const left = Math.round((endAt - Date.now()) / 1000);
    if (left <= 0) { finishTimer(btn); return; }
    btn.textContent = "⏸ " + fmtClock(left);
  };
  tick();
  timers.set(btn, setInterval(tick, 1000));
}
function bindTimers() {
  document.querySelectorAll(".timer-btn").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => handleTimerClick(btn));
  });
}
function stopTimer(btn) {
  clearInterval(timers.get(btn));
  timers.delete(btn);
  btn.classList.remove("running");
  btn.textContent = "⏱ " + fmtClock(+btn.dataset.sec);
}
function finishTimer(btn) {
  clearInterval(timers.get(btn));
  timers.delete(btn);
  btn.classList.remove("running");
  btn.classList.add("done", "ringing");
  btn.textContent = "🔔 Стоп";
  ringingBtns.add(btn);
  startAlarm();
  const title = state.current ? state.current.title : "Рецепт";
  const li = btn.closest(".step-item");
  if (btn.dataset.name) {
    notify(btn.dataset.name, "");          // уведомление — только твоё слово
    toast("🔔 " + btn.dataset.name);
  } else if (li && li.dataset.stepno) {
    notify(title, "Шаг " + li.dataset.stepno + " готов");
    toast("🔔 " + title + " · шаг " + li.dataset.stepno);
  } else {
    notify(title, "Таймер готов");
    toast("🔔 " + title);
  }
}

// Свой (произвольный) таймер на странице рецепта
function addCustomTimer() {
  const min = parseInt(document.getElementById("ctMin").value, 10) || 0;
  const sec = parseInt(document.getElementById("ctSec").value, 10) || 0;
  const total = min * 60 + sec;
  if (total <= 0) { toast("Укажи время таймера"); return; }
  const name = (document.getElementById("ctName").value || "").trim();
  startCustomTimer(total, name);
  document.getElementById("ctMin").value = "";
  document.getElementById("ctSec").value = "";
  document.getElementById("ctName").value = "";
}
function startCustomTimer(total, name) {
  const list = document.getElementById("ctList");
  if (!list) return;
  const chip = document.createElement("div");
  chip.className = "ct-chip";
  const label = document.createElement("span");
  label.className = "ct-name";
  label.textContent = name || "Таймер";
  const btn = document.createElement("button");
  btn.className = "timer-btn";
  btn.dataset.sec = total;
  if (name) btn.dataset.name = name;
  btn.dataset.bound = "1";
  btn.textContent = "⏱ " + fmtClock(total);
  btn.addEventListener("click", () => handleTimerClick(btn));
  const del = document.createElement("button");
  del.className = "ct-x";
  del.title = "Убрать таймер";
  del.textContent = "✕";
  del.addEventListener("click", () => {
    if (timers.has(btn)) stopTimer(btn);
    if (btn.classList.contains("ringing")) stopRing(btn); // заглушить звонок, если звенел
    chip.remove();
  });
  chip.appendChild(label);
  chip.appendChild(btn);
  chip.appendChild(del);
  list.appendChild(chip);
  startTimerBtn(btn); // запускаем сразу
}
// Единый AudioContext, создаётся/возобновляется по жесту (клик «старт таймера»)
let audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}
// Один «звонок» — серия из трёх коротких сигналов
function ringOnce() {
  ensureAudio();
  try {
    const A = audioCtx;
    if (A) {
      const base = A.currentTime;
      [0, 0.17, 0.34].forEach((off) => {
        const o = A.createOscillator(), g = A.createGain();
        o.connect(g); g.connect(A.destination);
        o.type = "square"; o.frequency.value = 988;
        const t = base + off;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.6, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.start(t); o.stop(t + 0.15);
      });
    }
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate([300, 120, 300, 120, 300]);
}
// Будильник: звенит повторно, пока не нажмёшь «Стоп» (или 40 секунд)
let alarmIv = null, alarmStop = null;
function startAlarm() {
  if (alarmIv) return;
  ringOnce();
  alarmIv = setInterval(ringOnce, 1300);
  alarmStop = setTimeout(() => {
    ringingBtns.forEach((b) => { b.classList.remove("ringing"); b.textContent = "✅ Готово!"; });
    ringingBtns.clear();
    silenceAlarm();
  }, 40000);
}
function silenceAlarm() {
  if (alarmIv) { clearInterval(alarmIv); alarmIv = null; }
  if (alarmStop) { clearTimeout(alarmStop); alarmStop = null; }
}
function requestNotifyPermission() {
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch (e) {}
}
function notify(title, body) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const opt = {
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: "timer-" + Date.now(),
      renotify: true,
      requireInteraction: true,          // не исчезает само — чтобы не пропустить
      vibrate: [400, 200, 400, 200, 400], // вибрация в фоне
      silent: false,                      // разрешить системный звук уведомления
    };
    if (body) opt.body = body;
    // Через service worker — так телефон проигрывает звук/вибрацию даже в фоне.
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready
        .then((reg) => reg.showNotification(title, opt))
        .catch(() => { try { new Notification(title, opt); } catch (e) {} });
    } else {
      new Notification(title, opt);
    }
  } catch (e) {}
}

export { clearAllTimers, bindTimers, addCustomTimer, startCustomTimer };
