// Ввод строки в терминале без эха (пароль). Работает через raw-режим stdin, поэтому нужен настоящий TTY.
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error("Скрытый ввод возможен только в интерактивном терминале"));
    stdout.write(question);
    let value = "";
    const finish = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk) => {
      // вставка из буфера приходит одним куском — разбираем посимвольно
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new Error("Отменено"));
        if (ch === "\u0008" || ch === "\u007f") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

module.exports = { promptHidden };
