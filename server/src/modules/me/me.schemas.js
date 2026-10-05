const { z } = require("zod");

// пустая строка допустима: «пустая заметка» удаляет заметку
const setNote = z.object({ text: z.string().max(2000, "Заметка — не более 2000 символов") });

module.exports = { setNote };
