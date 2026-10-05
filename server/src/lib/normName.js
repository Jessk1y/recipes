// Ключ слияния позиций списка покупок — то же правило, что normName() на фронтенде
module.exports = (name) => String(name).trim().toLowerCase().replace(/\s+/g, " ");
