"use strict";
// ovpn-pool.js — пул .ovpn конфигов для ботов и UDP-флуда.
//
// Зачем отдельный слой: ovpn.js умеет поднять туннель и отдать SOCKS5, но
// боты/флудеру нужно больше:
//   * набор конфигов из разных источников (файл, папка, ovpn://base64, сырой
//     текст конфига из буфера обмена);
//   * один АКТИВНЫЙ туннель, через который реально ходит трафик до цели
//     (у ОС маршрутизация по destination — владелец /32-маршрута один);
//   * ротация: переключили активный -> поменялся внешний IP;
//   * health-луп: мёртвый openvpn поднимается сам, активный — переключается
//     на следующий и роняет callback для перепривязки флуда/ботов.
//
// Контракт:
//   const pool = new OvpnPool({ username, password, log, onActiveLost });
//   await pool.load(spec);                 // только разбор, ничего не запускает
//   const active = await pool.start({ routeTargets: ['1.2.3.4'] });
//   pool.active                            // дескриптор активного туннеля
//   await pool.next()                      // ротация, вернёт новый активный
//   pool.proxies()                         // SOCKS5-дескрипторы всех живых
//   pool.floodTunnels()                    // [ { id, label, tunIP, socks } ]
//   await pool.setRouteTargets(['1.2.3.4'])
//   await pool.close()

const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const ovpn = require("./ovpn");

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function inlineDir() {
  return path.join(require("./app-paths").baseDir(), "bin", "ovpn", "inline");
}

function splitSpec(spec) {
  const raw = Array.isArray(spec) ? spec : [spec];
  const out = [];
  for (const s of raw) {
    // Только переводы строк: в сыром конфиге встречается ';' (комментарии),
    // а в путях — запятые; резать по ним нельзя.
    for (const part of String(s == null ? "" : s).split(/[\r\n]+/)) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function normalizeTargets(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const ip = String(raw || "").trim();
    if (!IPV4.test(ip) || seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  return out;
}

function writeInline(text) {
  fs.mkdirSync(inlineDir(), { recursive: true });
  const id = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
  const file = path.join(inlineDir(), `inline-${id}.ovpn`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text, "utf8");
  return file;
}

function walkOvpn(dir, out, depth) {
  if (depth > 4) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "pids") walkOvpn(p, out, depth + 1); }
    // config.ovpn — наша же materialize-копия в bin/ovpn/<id>/; в набор не берём
    else if (/\.ovpn$/i.test(e.name) && e.name.toLowerCase() !== "config.ovpn") out.add(path.resolve(p));
  }
}

// spec: строка/массив, элементы — путь к файлу, папка, ovpn://base64,
// сырой текст конфига или .txt со списком путей.
function expandSpecs(spec, log, depth) {
  depth = depth || 0;
  const files = new Set();
  if (depth > 3) return [...files];
  for (const item of splitSpec(spec)) {
    if (/^ovpn:\/\//i.test(item)) {
      try { files.add(writeInline(Buffer.from(item.replace(/^ovpn:\/\//i, ""), "base64").toString("utf8"))); }
      catch (e) { if (log) log(`ovpn: битый inline-конфиг: ${e.message}`); }
      continue;
    }
    if (/-----BEGIN [A-Z0-9 ]+-----/.test(item) || /^\s*(client|remote)\s+\S+/m.test(item)) {
      files.add(writeInline(item));
      continue;
    }
    let st = null;
    try { st = fs.statSync(item); } catch (e) { st = null; }
    if (!st) { if (log) log(`ovpn: путь не найден: ${item}`); continue; }
    if (st.isDirectory()) walkOvpn(item, files, 0);
    else if (/\.ovpn$/i.test(item)) files.add(path.resolve(item));
    else if (/\.(txt|list)$/i.test(item)) {
      let data = "";
      try { data = fs.readFileSync(item, "utf8"); } catch (e) {}
      for (const f of expandSpecs(data, log, depth + 1)) files.add(f);
    } else if (log) log(`ovpn: не .ovpn файл: ${item}`);
  }
  return [...files];
}

function probeSocks(port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: Number(port) });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) {}
      resolve(ok);
    };
    s.setTimeout(timeoutMs || 900);
    s.on("connect", () => finish(true));
    s.on("timeout", () => finish(false));
    s.on("error", () => finish(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class OvpnPool {
  constructor(opts) {
    opts = opts || {};
    this.log = typeof opts.log === "function" ? opts.log : (() => {});
    this.username = opts.username || null;
    this.password = opts.password || null;
    this.spec = "";
    this.files = [];
    this.routeTargets = [];
    this.activeId = null;
    this.healthMs = Math.max(5000, opts.healthMs || 25000);
    this.onActiveLost = typeof opts.onActiveLost === "function" ? opts.onActiveLost : null;
    this._healthTimer = null;
    this._closed = true;
    this._busy = false;
    this._healthBusy = false;
  }

  async load(spec) {
    this.spec = spec;
    this.files = expandSpecs(spec, this.log);
    return this.files;
  }

  tunnels() { return ovpn.getTunnels(); }

  aliveCount() { return ovpn.getTunnels().filter((t) => t.alive).length; }

  get active() {
    const t = ovpn.getTunnels().find((x) => x.id === this.activeId);
    return t && t.alive ? this.descriptor(t) : null;
  }

  // Плоский дескриптор: годится и в setProxies (боты), и во флудер.
  descriptor(t) {
    return {
      id: t.id,
      label: t.label,
      file: t.file,
      tunIP: t.tunIP || null,
      ip: "127.0.0.1",
      port: t.socksPort,
      username: null,
      password: null,
      kind: "ovpn",
      via: t.via,
      socks: { ip: "127.0.0.1", port: t.socksPort },
    };
  }

  // ── старт ────────────────────────────────────────────────────────────────
  async start(opts) {
    opts = opts || {};
    if (!this.files.length) await this.load(this.spec);
    if (!this.files.length) throw new Error("ovpn: не найдено ни одного .ovpn");
    if (opts.routeTargets) this.routeTargets = normalizeTargets(opts.routeTargets);

    this._closed = false;
    this._stopHealth();
    await ovpn.stop();
    this.activeId = null;

    let launched = 0;
    for (const file of this.files) {
      const id = ovpn.idForFile(file);
      // первый удачно поднятый туннель забирает маршруты до цели
      const isActive = this.activeId == null;
      const ep = {
        file, id, name: path.basename(file),
        username: this.username, password: this.password,
        routeTargets: isActive ? this.routeTargets.slice() : [],
      };
      try {
        const rec = await ovpn.addTunnel(ep, this.log);
        launched++;
        if (isActive) this.activeId = rec.id;
      } catch (e) {
        this.log(`ovpn[${path.basename(file)}] не поднялся: ${e.message}`);
      }
    }
    if (!this.activeId) {
      this._closed = true;
      throw new Error(`ни один .ovpn туннель не поднялся (${launched}/${this.files.length})`);
    }
    this._startHealth();
    return this.active;
  }

  // Перезапуск всех: смена кредов/набора файлов/целей на лету.
  async restart(opts) {
    await this.start(opts);
    return this.active;
  }

  // ── активация / ротация ─────────────────────────────────────────────────
  async activate(id, opts) {
    opts = opts || {};
    if (opts.routeTargets) this.routeTargets = normalizeTargets(opts.routeTargets);

    const list = ovpn.getTunnels();
    const target = list.find((t) => t.id === id);
    if (!target) throw new Error(`ovpn: туннель ${id} не найден`);

    const want = this.routeTargets.slice().sort().join(",");
    const has = (target.routeTargets || []).slice().sort().join(",");
    if (this.activeId === id && want === has && target.alive) return this.active;

    this._busy = true;
    try {
      // Снимаем /32-маршруты с прошлого владельца, иначе два равных маршрута
      // и ОС выбирает победителя по метрике — непредсказуемо.
      const prevId = this.activeId;
      if (prevId && prevId !== id) {
        const prev = list.find((t) => t.id === prevId);
        if (prev && prev.alive) {
          try {
            await ovpn.restartTunnel(prev.id, { ...prev.ep, routeTargets: [] }, this.log);
          } catch (e) {
            this.log(`ovpn[${prev.label}] освобождение маршрута: ${e.message}`);
          }
        }
      }
      const rec = await ovpn.restartTunnel(id, { ...target.ep, routeTargets: this.routeTargets.slice() }, this.log);
      this.activeId = rec.id;
    } finally {
      this._busy = false;
    }
    return this.active;
  }

  async next(opts) {
    const alive = ovpn.getTunnels().filter((t) => t.alive);
    if (alive.length <= 1) return this.active;
    const idx = alive.findIndex((t) => t.id === this.activeId);
    const next = alive[(idx + 1) % alive.length];
    this.log(`ovpn: ротация ${this.activeId || "—"} -> ${next.id} (${next.label})`);
    return this.activate(next.id, opts);
  }

  // ── цели / маршруты ─────────────────────────────────────────────────────
  async setRouteTargets(ips) {
    const next = normalizeTargets(ips);
    if (next.slice().sort().join(",") === this.routeTargets.slice().sort().join(",")) return this.active;
    this.routeTargets = next;
    if (!this.activeId) return null;
    const t = ovpn.getTunnels().find((x) => x.id === this.activeId);
    if (!t) return null;
    if (!t.alive) return null;
    this.log(`ovpn: цель маршрутизации -> ${next.length ? next.join(",") : "нет (system route)"}`);
    return this.activate(t.id);
  }

  // ── дескрипторы для потребителей ────────────────────────────────────────
  // Только активный туннель: маршрут до цели один, у неактивных туннелей
  // пакет уйдёт с чужим src и будет срезан стеком/сервером. Остальные держим
  // тёплыми под ротацию.
  proxies() {
    const a = this.active;
    return a ? [a] : [];
  }

  allProxies() {
    return ovpn.getTunnels().filter((t) => t.alive).map((t) => this.descriptor(t));
  }

  // Флуду в bind-режиме нужен ровно один туннель — владелец маршрута.
  floodTunnels() {
    const a = this.active;
    return a ? [this.toFloodTunnel(a)] : [];
  }

  toFloodTunnel(t) {
    const d = t.socks ? t : this.descriptor(t);
    return {
      id: d.id,
      label: d.label,
      tunIP: d.tunIP,
      via: d.via,
      socks: { ip: d.ip, port: d.port },
      ip: d.ip,
      port: d.port,
    };
  }

  // ── health ──────────────────────────────────────────────────────────────
  _startHealth() {
    this._stopHealth();
    this._healthTimer = setInterval(() => {
      this.healthNow().catch(() => {});
    }, this.healthMs);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  _stopHealth() {
    if (this._healthTimer) {
      try { clearInterval(this._healthTimer); } catch (e) {}
      this._healthTimer = null;
    }
  }

  async healthNow() {
    if (this._closed || this._busy || this._healthBusy) return;
    this._healthBusy = true;
    try {
      const list = ovpn.getTunnels();
      for (const t of list) {
        const live = t.alive && (await probeSocks(t.socksPort));
        if (live) continue;
        const isActive = t.id === this.activeId;
        this.log(`ovpn[${t.label}] туннель мёртв — перезапуск${isActive ? " (активный)" : ""}`);
        try {
          const rec = await ovpn.restartTunnel(t.id, {
            ...t.ep,
            routeTargets: isActive ? this.routeTargets.slice() : [],
          }, this.log);
          if (isActive) this.activeId = rec.id;
        } catch (e) {
          this.log(`ovpn[${t.label}] перезапуск не удался: ${e.message}`);
          if (isActive) {
            // активный не встал: пробуем пересесть на другой живой
            const other = ovpn.getTunnels().find((x) => x.alive && x.id !== t.id);
            if (other) {
              try { await this.activate(other.id); } catch (_) {}
            } else if (this.onActiveLost) {
              try { this.onActiveLost(this.active); } catch (_) {}
            }
          }
        }
        // не ждём остальные рестарты пачкой: маршруты конфликтуют
        await sleep(300);
      }
    } finally {
      this._healthBusy = false;
    }
  }

  async close() {
    this._closed = true;
    this._stopHealth();
    this.activeId = null;
    await ovpn.stop();
  }
}

module.exports = { OvpnPool, expandSpecs, normalizeTargets, writeInline };
