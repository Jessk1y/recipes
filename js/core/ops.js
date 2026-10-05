// Личные данные, которые синхронизируются с аккаунтом, и чистый редьюсер для них.
// Типы действий совпадают с операциями POST /me/sync, поэтому одно и то же действие
// меняет локальное состояние и уходит на сервер через outbox.
//   data = { favs: [slug], notes: { slug: text }, shopping: [{ name, checked, contribs: [{ r, a }] }] }
import { normName } from "../lib/utils.js";

export const SYNC_OPS = new Set([
  "favorite.add", "favorite.remove",
  "note.set", "note.remove",
  "shopping.add", "shopping.remove", "shopping.check", "shopping.removeDish", "shopping.clear",
]);

export const emptyData = () => ({ favs: [], notes: {}, shopping: [] });

const cloneItem = (it) => ({ ...it, contribs: (it.contribs || []).map((c) => ({ ...c })) });

export function applyOp(d, op) {
  switch (op.type) {
    case "favorite.add":
      return d.favs.includes(op.slug) ? d : { ...d, favs: [...d.favs, op.slug] };
    case "favorite.remove":
      return { ...d, favs: d.favs.filter((s) => s !== op.slug) };
    case "note.set":
    case "note.remove": {
      const notes = { ...d.notes };
      if (op.type === "note.set" && op.text.trim()) notes[op.slug] = op.text; else delete notes[op.slug];
      return { ...d, notes };
    }
    case "shopping.add": {
      // как на сервере: позиции с одинаковым normName сливаются, одинаковый вклад не дублируется
      const shopping = d.shopping.map(cloneItem);
      const key = normName(op.name);
      let item = shopping.find((it) => normName(it.name) === key);
      if (!item) { item = { name: op.name.trim(), checked: false, contribs: [] }; shopping.push(item); }
      const r = op.recipe || null, a = (op.amount || "").trim();
      if (!item.contribs.some((c) => c.r === r && c.a === a)) item.contribs.push({ r, a });
      return { ...d, shopping };
    }
    case "shopping.remove":
      return { ...d, shopping: d.shopping.filter((it) => normName(it.name) !== normName(op.name)) };
    case "shopping.check":
      return {
        ...d,
        shopping: d.shopping.map((it) =>
          normName(it.name) === normName(op.name) ? { ...cloneItem(it), checked: op.checked } : it),
      };
    case "shopping.removeDish":
      return {
        ...d,
        shopping: d.shopping
          .map((it) => ({ ...cloneItem(it), contribs: (it.contribs || []).filter((c) => c.r !== op.slug) }))
          .filter((it) => it.contribs.length),
      };
    case "shopping.clear":
      return { ...d, shopping: [] };
    default:
      return d;
  }
}

// Применить к состоянию очередь операций (ещё не подтверждённых сервером)
export const replay = (d, ops) => ops.reduce(applyOp, d);

// Ответ POST /me/sync → локальный формат
export function fromServer(res) {
  const notes = {};
  res.notes.forEach((n) => { notes[n.slug] = n.text; });
  return {
    favs: res.favorites.map((f) => f.slug),
    notes,
    shopping: res.shopping.map((it) => ({ name: it.name, checked: !!it.checked, contribs: it.contribs })),
  };
}

// Старые форматы списка покупок (строки, {name, amount}) → {name, checked, contribs}
export function migrateShopping(list, parseIng) {
  return (list || []).map((it) => {
    if (it && it.contribs) return { checked: false, ...it };
    const p = typeof it === "string" ? parseIng(it) : { name: it.name, amount: it.amount };
    return { name: p.name, checked: false, contribs: p.amount ? [{ r: null, a: p.amount }] : [] };
  });
}
