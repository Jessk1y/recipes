// Тёмная/светлая тема. Перенесено из app.js без изменений.
import { LS } from "../core/storage.js";

// ---------- Тема ----------
function initTheme() {
  let theme = LS.get("theme", null);
  if (!theme) theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(theme);
  const btn = document.getElementById("theme-btn");
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next); LS.set("theme", next);
  });
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-btn");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#1c1a17" : "#e8662a";
}

export { initTheme };
