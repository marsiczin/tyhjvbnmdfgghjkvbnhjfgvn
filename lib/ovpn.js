"use strict";
// ovpn.js — движок OpenVPN (контракт как у sing-box / xray) + пул туннелей.
//
//   .ovpn файл(ы) -> openvpn (TUN) -> локальный SOCKS5, привязанный к IP туннеля
//   -> config.proxyList = ["127.0.0.1:port"] -> боты и UDP-флуд работают БЕЗ правок.
//
// Дополнительно к контракту движка:
//   addTunnel(ep) / restartTunnel(id, ep) / getTunnels() / isTunnelAlive(id)
//   — это даёт ovpn-pool.js возможность держать несколько туннелей и
//   перезапускать конкретный, не трогая остальные.
//
// Маршрутизация: если передать ep.routeTargets, в рабочую копию конфига
// добавляется `route <ip> 255.255.255.255` — трафик до цели уходит в туннель
// даже если в конфиге нет redirect-gateway. ВАЖНО: у ОС маршрутизация по
// destination, а не по source, поэтому активным (владеющим маршрутом до цели)
// может быть только ОДИН туннель одновременно. Пул это учитывает: активация
// = перезапуск владельца без маршрутов + перезапуск нового с маршрутами.

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { parseOvpnFile, materialize } = require("./ovpn-parser");
const { TunnelSocksServer } = require("./socks-tunnel");

function projectDir() { return require("./app-paths").baseDir(); }
function binDir() { return path.join(projectDir(), "bin"); }
function ovpnWorkDir() { return path.join(binDir(), "ovpn"); }
function pidDir() { return path.join(ovpnWorkDir(), "pids"); }
function pidPath(id) { return path.join(pidDir(), `${id || "ovpn"}.pid`); }

const CANDIDATES = [
  process.env.OPENVPN_BIN,
  path.join(binDir(), "openvpn.exe"),
  "C:\\Program Files\\OpenVPN\\bin\\openvpn.exe",
  "C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe",
  "C:\\Program Files\\OpenVPN Connect\\resources\\app\\openvpn.exe",
  "/usr/sbin/openvpn", "/usr/bin/openvpn", "/usr/local/sbin/openvpn",
].filter(Boolean);

// id -> { id, ep, label, file, proc, socks, tunIP, gateway, managementPort,
//         socksPort, routeTargets, warnings, startedAt, stopping }
const tunnels = new Map();

function binaryPath() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (e) {}
  }
  return process.platform === "win32" ? "openvpn.exe" : "openvpn";
}

function isBinaryPresent() {
  const p = binaryPath();
  if (fs.existsSync(p)) return true;
  try {
    const r = spawnSync(p, ["--version"], { timeout: 3000, windowsHide: true });
    return r.status === 0;
  } catch (e) { return false; }
}

function ensureBinary(onLog) {
  const log = onLog || (() => {});
  if (isBinaryPresent()) { log(`openvpn: ${binaryPath()}`); return Promise.resolve(binaryPath()); }
  return Promise.reject(new Error(
    "openvpn не найден. Установи OpenVPN (с TAP-Windows6/wintun) или положи openvpn.exe в bin/, " +
    "либо задай OPENVPN_BIN=<путь>. Туннель требует прав администратора."));
}

// Свободные порты (management + socks) через listen(0), как в xray.js.
function allocPorts(n) {
  return new Promise((resolve, reject) => {
    const srv = [], ports = [];
    let i = 0;
    const next = () => {
      if (i >= n * 2) {
        for (const s of srv) { try { s.close(); } catch (e) {} }
        setTimeout(() => resolve(ports), 100);
        return;
      }
      const s = net.createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        ports.push(s.address().port); srv.push(s); i++; next();
      });
    };
    if (n <= 0) return resolve([]);
    next();
  });
}

function idForFile(file) {
  return crypto.createHash("sha1").update(path.resolve(String(file))).digest("hex").slice(0, 10);
}

// ---- сетевые интерфейсы: определяем IPv4 только что поднявшегося tun ----
function localIPv4s() {
  const set = new Set();
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === "IPv4" && !a.internal) set.add(a.address);
    }
  }
  return set;
}

function diffIP(before, after) {
  for (const ip of after) if (!before.has(ip)) return ip;
  return null;
}

// log openvpn -> ждём "Initialization Sequence Completed". Заодно ловим
// фатальные ошибки (auth/tap/options), чтобы не ждать таймаут впустую.
function waitForTunnel(proc, timeoutMs, onLog) {
  return new Promise((resolve) => {
    let text = "";
    let detected = null; // { local, gateway }
    let done = false;
    let timer = null;
    const finish = (error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        proc.stdout.removeListener("data", onData);
        proc.stderr.removeListener("data", onData);
        // Без читателя пайп встаёт на backpressure и openvpn может зависнуть
        // на записи в лог (verb 3 при активном трафике). Поэтому дренируем.
        proc.stdout.on("data", () => {});
        proc.stderr.on("data", () => {});
        proc.stdout.resume();
        proc.stderr.resume();
      } catch (e) {}
      resolve({ ip: detected ? detected.local : null, gateway: detected ? detected.gateway : null, error: error || null, log: text });
    };
    const onData = (d) => {
      const s = d.toString();
      text += s;
      try { onLog("[openvpn] " + s.trim().slice(0, 300)); } catch (e) {}
      const m = /ifconfig\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})/i.exec(text);
      if (m) detected = { local: m[1], gateway: m[2] };
      const fatal = /AUTH_FAILED|Cannot open TUN\/TAP|All TAP-Windows adapters|Options error|ERROR: Cannot open|TLS handshake failed|Cannot ioctl TUNSETIFF/i.exec(text);
      if (fatal) return finish(fatal[0]);
      if (/Initialization Sequence Completed/i.test(text)) {
        // интерфейсу нужно мгновение, чтобы попасть в список адресов ОС
        setTimeout(() => finish(null), 700);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.once("exit", (code) => finish(`openvpn завершился (code ${code})`));
    timer = setTimeout(() => finish(text ? null : "timeout"), timeoutMs || 30000);
  });
}

// management-hold снимается командой "hold release". Порт открывается не
// мгновенно — поэтому ретраи. Раньше release вызывался ПОСЛЕ waitForTunnel,
// и туннель мог висеть на hold до таймаута.
function releaseHold(port, log, delayMs) {
  return new Promise((resolve) => {
    let attempts = 0;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve(); } };
    const attempt = () => {
      if (finished) return;
      attempts++;
      let connected = false;
      const s = net.createConnection({ host: "127.0.0.1", port: Number(port) });
      s.setTimeout(1200);
      const retry = () => {
        try { s.destroy(); } catch (e) {}
        if (attempts < 12) setTimeout(attempt, 250); else finish();
      };
      s.on("connect", () => {
        connected = true;
        try { s.write("hold release\n"); } catch (e) {}
        setTimeout(() => { try { s.end(); } catch (e) {} finish(); }, 80);
      });
      s.on("timeout", () => { if (connected) finish(); else retry(); });
      s.on("error", () => { if (!connected) retry(); else finish(); });
    };
    setTimeout(attempt, delayMs == null ? 400 : delayMs);
  });
}

function spawnOvpn(cfgPath, log, extraArgs) {
  const args = ["--config", cfgPath];
  // win32: маршруты кладём через route.exe (работает без прав на WFP API)
  if (process.platform === "win32") args.push("--route-method", "exe");
  if (Array.isArray(extraArgs)) args.push(...extraArgs);
  const p = spawn(binaryPath(), args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.on("error", (e) => { try { log("openvpn spawn error: " + e.message); } catch (_) {} });
  return p;
}

function view(rec) {
  return {
    id: rec.id,
    label: rec.label,
    file: rec.file,
    tunIP: rec.tunIP || null,
    gateway: rec.gateway || null,
    managementPort: rec.managementPort,
    socksPort: rec.socksPort,
    socks: { ip: "127.0.0.1", port: rec.socksPort, username: null, password: null },
    via: rec.via,
    alive: !!(rec.proc && rec.proc.exitCode === null && !rec.proc.killed),
    startedAt: rec.startedAt,
    routeTargets: rec.routeTargets.slice(),
    warnings: rec.warnings.slice(),
    ep: rec.ep,
  };
}

// Поднимает ОДИН туннель. ep: { file, username, password, routeTargets, id,
// managementPort?, localPort?, timeoutMs?, extraArgs? }
async function startTunnel(ep, onLog) {
  const log = onLog || (() => {});
  const file = ep.file || ep.config || ep.link;
  if (!file || !fs.existsSync(file)) throw new Error(`ovpn: файл не найден: ${file}`);
  const id = ep.id || idForFile(file);
  if (tunnels.has(id)) await removeTunnel(id);

  fs.mkdirSync(pidDir(), { recursive: true });

  let managementPort = ep.managementPort;
  let socksPort = ep.localPort;
  if (!managementPort || !socksPort) {
    const pair = await allocPorts(1);
    managementPort = managementPort || pair[0];
    socksPort = socksPort || pair[1];
  }

  const parsed = parseOvpnFile(file, { username: ep.username, password: ep.password });
  const workDir = path.join(ovpnWorkDir(), id);
  const routeTargets = Array.isArray(ep.routeTargets) ? ep.routeTargets.slice() : [];
  const mat = materialize(parsed, workDir, {
    username: ep.username, password: ep.password,
    managementPort, routeTargets,
  });
  for (const w of mat.warnings) log(`ovpn[${parsed.label}] WARN: ${w}`);

  const before = localIPv4s();
  const proc = spawnOvpn(mat.configPath, log, ep.extraArgs);
  try { fs.writeFileSync(pidPath(id), String(proc.pid)); } catch (e) {}

  const holdDone = releaseHold(managementPort, log, 500);
  const res = await waitForTunnel(proc, ep.timeoutMs || 30000, log);
  await holdDone;

  if (res.error) {
    try { proc.kill(); } catch (e) {}
    throw new Error(`openvpn[${parsed.label}]: ${res.error}`);
  }
  if (proc.exitCode !== null || proc.killed) {
    throw new Error(`openvpn[${parsed.label}] завершился до инициализации (нужны админ-права/TAP-драйвер?)`);
  }

  const after = localIPv4s();
  const tunIP = res.ip || diffIP(before, after) || null;
  log(`ovpn[${parsed.label}] tunIP=${tunIP || "не определён (system route)"} socks=127.0.0.1:${socksPort}` +
    (routeTargets.length ? ` route=${routeTargets.join(",")}` : ""));

  const socks = new TunnelSocksServer({
    bindHost: "127.0.0.1", port: socksPort, tunIP: tunIP || null, onLog: log,
  });
  try {
    await socks.start();
  } catch (e) {
    try { proc.kill(); } catch (_) {}
    throw new Error(`SOCKS5(tunnel) не поднялся на ${socksPort}: ${e.message}`);
  }

  const via = tunIP ? `ovpn:${tunIP} (${parsed.label})` : `ovpn:${parsed.label}`;
  const rec = {
    id,
    // Порты кладём в ep: рестарт туннеля должен оставить SOCKS5 на том же
    // порту, иначе уже выданные дескрипторы (боты/флуд) станут мёртвыми.
    ep: { ...ep, id, file, routeTargets, managementPort, localPort: socksPort },
    label: parsed.label, file,
    proc, socks, tunIP, gateway: res.gateway || null,
    managementPort, socksPort, routeTargets,
    warnings: mat.warnings.slice(), startedAt: Date.now(), stopping: false, via,
    workDir,
  };
  proc.once("exit", (code) => {
    if (rec.stopping) return;
    try { log(`ovpn[${rec.label}] процесс завершился (code ${code})`); } catch (e) {}
  });
  tunnels.set(id, rec);
  return view(rec);
}

async function removeTunnel(id) {
  const rec = tunnels.get(id);
  if (!rec) return false;
  rec.stopping = true;
  try { await rec.socks.stop(); } catch (e) {}
  try {
    if (rec.proc && rec.proc.exitCode === null && !rec.proc.killed) {
      rec.proc.kill();
      if (process.platform === "win32" && rec.proc.pid) {
        // openvpn на Windows иногда игнорирует SIGTERM — добиваем дерево
        spawnSync("taskkill", ["/PID", String(rec.proc.pid), "/T", "/F"], { windowsHide: true });
      }
    }
  } catch (e) {}
  try { if (fs.existsSync(pidPath(id))) fs.unlinkSync(pidPath(id)); } catch (e) {}
  tunnels.delete(id);
  return true;
}

async function restartTunnel(id, ep, onLog) {
  const prev = tunnels.get(id);
  const merged = { ...(prev ? prev.ep : {}), ...(ep || {}), id };
  await removeTunnel(id);
  // даём ОС освободить порты и (на Windows) снять маршруты прошлого инстанса
  await new Promise((r) => setTimeout(r, 500));
  try {
    return await startTunnel(merged, onLog);
  } catch (e) {
    // Порт мог не освободиться (TIME_WAIT/залипший listen) — один ретрай
    // на свежих портах. Ошибки кредов/TAP не ретраим: они не про порты.
    if (/AUTH_FAILED|Cannot open TUN|TAP-Windows|Options error/i.test(e.message)) throw e;
    const fresh = { ...merged };
    delete fresh.managementPort;
    delete fresh.localPort;
    try { onLog && onLog(`ovpn: рестарт на свежих портах (${e.message})`); } catch (_) {}
    return startTunnel(fresh, onLog);
  }
}

function getTunnels() {
  return [...tunnels.values()].map(view);
}

function isTunnelAlive(id) {
  const rec = tunnels.get(id);
  return !!(rec && rec.proc && rec.proc.exitCode === null && !rec.proc.killed);
}

// buildConfig: endpoints = [{ file|config, username, password, name, localPort }]
// -> [{ ...ep, parsed, workDir, managementPort }]. Ничего не запускает.
function buildConfig(endpoints) {
  fs.mkdirSync(ovpnWorkDir(), { recursive: true });
  return endpoints.map((ep) => {
    const file = ep.file || ep.config || ep.link;
    if (!file || !fs.existsSync(file)) throw new Error(`ovpn: файл не найден: ${file}`);
    const parsed = parseOvpnFile(file, { username: ep.username, password: ep.password });
    const id = ep.id || idForFile(file);
    const workDir = path.join(ovpnWorkDir(), id);
    return { ...ep, id, file, parsed, workDir, managementPort: ep.managementPort || 25340 };
  });
}

// ---- start: сброс пула и подъём всех переданных конфигов ----
// Возвращает [{ ...ep, socks: { ip, port, username, password, via } }] —
// ровно как xray.start(), чтобы startEngineWithLinks() проглотил без изменений.
async function start(endpoints, onLog) {
  const list = Array.isArray(endpoints) ? endpoints : [];
  if (!list.length) throw new Error("ovpn: нет конфигов");
  await stop();
  const ports = await allocPorts(list.length);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const ep = {
      ...list[i],
      managementPort: list[i].managementPort || ports[i * 2],
      localPort: list[i].localPort || ports[i * 2 + 1],
    };
    const t = await startTunnel(ep, onLog);
    results.push({
      ...ep,
      socks: { ip: "127.0.0.1", port: t.socksPort, username: null, password: null, via: t.via },
    });
  }
  return results;
}

function isRunning() {
  if (tunnels.size > 0) {
    for (const rec of tunnels.values()) {
      if (rec.proc && rec.proc.exitCode === null && !rec.proc.killed) return true;
    }
  }
  return false;
}

async function stop() {
  for (const id of [...tunnels.keys()]) {
    try { await removeTunnel(id); } catch (e) {}
  }
  tunnels.clear();
}

module.exports = {
  binaryPath, isBinaryPresent, ensureBinary, allocPorts, buildConfig,
  start, stop, isRunning, ovpnWorkDir,
  // пул
  addTunnel: startTunnel,
  removeTunnel, restartTunnel, getTunnels, isTunnelAlive, idForFile,
};
