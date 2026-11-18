"use strict";
// Ответы на checksum-request@ddnet.tw (порт одноимённой механики).
// Сервер просит sha256 окна виртуального layout'а [CChecksumData 20480B][exe],
// официальный клиент отвечает checksum-response, иначе (или при молчании)
// сервер может кикнуть. Наш lib раньше запросы игнорировал.
//
// Формула (ddnet-master): sha256(salt + req_uuid + start_be32 + end_be32 + window),
// salt@checksum.ddnet.tw = db877f2b-2ddb-3ba6-9f67-a6d169ec671d.
// Layout CChecksumData повторяет официальный: version-cstr, номер версии,
// платформа, метка времени, конфиги/команды/компоненты/файлы (без исходников
// DDNet — нули, как и положено для неизвестных частей).
const crypto = require("crypto");

const SALT = Buffer.from("db877f2b2ddb3ba69f67a6d169ec671d", "hex");
const DATA_LEN = 20480;

function putCstr(buf, pos, str, len) {
  const b = Buffer.from(String(str || ""), "utf8");
  const out = Buffer.alloc(len);
  b.copy(out, 0, 0, Math.max(0, Math.min(b.length, len - 1)));
  out.copy(buf, pos);
  return pos + len;
}

// Строит 20480-байтный CChecksumData. release/versionNumber — как в CLIENTVER.
function buildChecksumData(release, versionNumber) {
  const buf = Buffer.alloc(DATA_LEN);
  let pos = 0;
  const putI32 = (v) => {
    if (pos + 4 > buf.length) return;
    buf.writeInt32LE(v | 0, pos);
    pos += 4;
  };
  const putU32 = (v) => {
    if (pos + 4 > buf.length) return;
    buf.writeUInt32LE(v >>> 0, pos);
    pos += 4;
  };
  const putI64 = (v) => {
    if (pos + 8 > buf.length) return;
    buf.writeBigInt64LE(BigInt(v), pos);
    pos += 8;
  };
  const putF32 = (v) => {
    if (pos + 4 > buf.length) return;
    buf.writeFloatLE(v, pos);
    pos += 4;
  };

  putI32(DATA_LEN);
  pos = putCstr(buf, pos, `DDNet ${release} (win64; amd64)`, 128);
  putI32(versionNumber | 0);
  pos = putCstr(buf, pos, "Windows-10-x86_64", 256);
  putI64(BigInt(Date.now()) * 1000n); // микросекунды
  putI32(crypto.randomInt(0, 0x7fffffff));
  putI32(0);
  putI32(0);
  putF32(1.0);
  putI32(0); // config len = 0 (нет исходников DDNet)
  putI32(0); // cmd count = 0
  for (let i = 0; i < 1024; i++) putI32(0);
  putI32(0); // comp count = 0
  for (let i = 0; i < 64; i++) putI32(0);
  putI32(0); // file_num
  putI32(0); // extra_num
  for (let i = 0; i < 1024; i++) putU32(0);
  return buf;
}

let cachedData = null;
let cachedKey = "";

function getData(release, versionNumber) {
  const key = `${release}|${versionNumber}`;
  if (!cachedData || cachedKey !== key) {
    cachedData = buildChecksumData(release, versionNumber);
    cachedKey = key;
  }
  return cachedData;
}

// Возвращает Buffer(32) дайджест или null (тогда слать checksum-error).
// exeBytes — опционально (хвост виртуального layout'а); без него окно
// за пределами DATA_LEN считается недоступным.
function checksumCalc(reqUuid, start, length, opts) {
  try {
    const uuid = Buffer.from(reqUuid || []);
    if (uuid.length !== 16) return null;
    const o = opts || {};
    const data = o.data || getData(o.release || "20.1", o.versionNumber || 20010);
    const exe = o.exeBytes || Buffer.alloc(0);
    const s = start | 0;
    const l = length | 0;
    if (s < 0 || l < 0) return null;
    const end = s + l;
    if (end < s) return null;
    const virtualDataLen = data.length > 0 ? data.length : DATA_LEN;
    const out = [];
    if (s < virtualDataLen) {
      if (data.length <= 0) return null;
      out.push(data.slice(s, Math.min(end, virtualDataLen)));
    }
    if (end > virtualDataLen) {
      const exeStart = Math.max(s, virtualDataLen) - virtualDataLen;
      const exeEnd = end - virtualDataLen;
      if (exeEnd > exe.length) return null;
      out.push(exe.slice(exeStart, exeEnd));
    }
    const window = Buffer.concat(out);
    if (window.length !== l) return null;
    const h = crypto.createHash("sha256");
    h.update(SALT);
    h.update(uuid);
    const be = Buffer.alloc(8);
    be.writeUInt32BE(s >>> 0, 0);
    be.writeUInt32BE(end >>> 0, 4);
    h.update(be);
    h.update(window);
    return h.digest();
  } catch (e) {
    return null;
  }
}

module.exports = { SALT, DATA_LEN, buildChecksumData, checksumCalc };
