// Wake Lock — экран не гаснет на странице рецепта. Перенесено из app.js без изменений.

// ---------- Wake Lock ----------
let wakeLock = null;
async function requestWake() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); }
  catch (e) {}
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && document.body.classList.contains("detail-open")) requestWake();
});

export { requestWake, releaseWake };
