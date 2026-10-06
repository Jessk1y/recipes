// Вызовы конкретных эндпоинтов API (/api/v1).
import { SLOW_TIMEOUT } from "../config.js";
import { api, raw } from "./client.js";

const slow = { timeout: SLOW_TIMEOUT };
const post = (body) => ({ method: "POST", body, ...slow });

// ---------- auth ----------
export const login = (email, password) => raw("/auth/login", post({ email, password }));
export const register = (email, password, confirmPassword, displayName) =>
  raw("/auth/register", post({ email, password, confirmPassword, displayName }));
export const verifyEmail = (token) => raw("/auth/verify-email", post({ token }));
export const resendVerification = () => api("/auth/resend-verification", { auth: true, ...post() });
export const forgotPassword = (email) => raw("/auth/forgot-password", post({ email }));
export const resetPassword = (token, password, confirmPassword) =>
  raw("/auth/reset-password", post({ token, password, confirmPassword }));
export const logout = (refreshToken) => api("/auth/logout", { auth: true, method: "POST", body: { refreshToken }, timeout: 10000 });
export const me = () => api("/auth/me", { auth: true, ...slow });

// публичные настройки сервера (mailEnabled: false — почта отключена)
export const serverConfig = () => raw("/config", { timeout: 10000 });

// ---------- каталог ----------
// cache: "no-cache" — браузер сам отправит If-None-Match и при неизменном каталоге получит короткий 304
export const snapshot = () => raw("/catalog/snapshot", { cache: "no-cache", ...slow });

// ---------- личные данные ----------
export const sync = (ops) => api("/me/sync", { auth: true, ...post({ ops }) });

// ---------- админка ----------
export async function adminRecipes() {
  const all = [];
  for (let page = 1; ; page++) {
    const r = await api(`/recipes?status=all&limit=50&page=${page}`, { auth: true, ...slow });
    all.push(...r.items);
    if (all.length >= r.total || !r.items.length) return all;
  }
}
export const adminRecipe = (slug) => api(`/recipes/${encodeURIComponent(slug)}`, { auth: true, ...slow });
export const categories = () => raw("/categories", slow);
export const createRecipe = (input) => api("/recipes", { auth: true, ...post(input) });
export const updateRecipe = (id, input) => api(`/recipes/${id}`, { auth: true, method: "PUT", body: input, ...slow });
export const setRecipeStatus = (id, status) => api(`/recipes/${id}/status`, { auth: true, method: "PATCH", body: { status }, ...slow });
export const deleteRecipe = (id) => api(`/recipes/${id}`, { auth: true, method: "DELETE", ...slow });
// ---------- предложения рецептов ----------
export const mySubmissions = () => api("/me/submissions", { auth: true, ...slow });
export const mySubmission = (id) => api(`/me/submissions/${encodeURIComponent(id)}`, { auth: true, ...slow });
export const submitRecipe = (input) => api("/me/submissions", { auth: true, ...post(input) });
export const updateSubmission = (id, input) => api(`/me/submissions/${encodeURIComponent(id)}`, { auth: true, method: "PUT", body: input, ...slow });
export async function adminQueue() {
  const all = [];
  for (let page = 1; ; page++) {
    const r = await api(`/admin/submissions?limit=50&page=${page}`, { auth: true, ...slow });
    all.push(...r.items);
    if (all.length >= r.total || !r.items.length) return all;
  }
}
export const approveSubmission = (id) => api(`/admin/submissions/${encodeURIComponent(id)}/approve`, { auth: true, ...post() });
export const rejectSubmission = (id, reason) => api(`/admin/submissions/${encodeURIComponent(id)}/reject`, { auth: true, ...post({ reason }) });

export function uploadImage(file) {
  const form = new FormData();
  form.append("file", file);
  return api("/uploads/image", { auth: true, method: "POST", form, ...slow });
}
