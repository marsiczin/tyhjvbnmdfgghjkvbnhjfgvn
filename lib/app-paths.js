"use strict";
// Единая база для файлов, в которые пишем на диске (bin/, конфиги, pid).
// В dev: корень проекта. В pkg-сборке (__dirname внутри read-only снапшота):
// папка рядом с exe — туда можно писать.
const path = require("path");

function baseDir() {
    if (process.pkg) {
        return path.dirname(process.execPath);
    }
    return path.join(__dirname, "..");
}

module.exports = { baseDir };
