"use strict";
// Парсер .ovpn конфигов.
//
// Что делает:
//   * читает файл (UTF-8/ANSI), снимает BOM и CRLF;
//   * сохраняет inline-блоки <ca>/<cert>/<key>/<tls-crypt>/<tls-auth> как есть
//     (OpenVPN понимает их во входящем конфиге);
//   * разбирает простые директивы (remote, proto, dev, auth-user-pass, ...);
//   * собирает РАБОЧУЮ копию конфига в writable-папке bin/ovpn/:
//       - абсолютные пути до ca/cert/key переписываются на рядом лежащие копии;
//       - auth-user-pass без файла -> auth-user-pass <creds.txt>;
//       - добавляются --verb 3, --suppress-timestamps, --management 127.0.0.1 <port>;
//   * НЕ меняет маршрутизацию хоста (redirect-gateway остаётся как в конфиге).
//
// Ничего не запускает — чистый парсер, можно тестировать в node.

const fs = require("fs");
const path = require("path");

const INLINE_TAGS = ["ca", "cert", "key", "tls-auth", "tls-crypt", "tls-crypt-v2", "pkcs12", "dh", "extra-certs"];
const FILE_DIRECTIVES = ["ca", "cert", "key", "tls-auth", "tls-crypt", "tls-crypt-v2", "pkcs12", "dh", "extra-certs", "crl-verify", "secret", "auth-user-pass", "askpass", "chroot", "cd", "config", "log", "log-append", "status", "writepid", "ifconfig-noexec", "iproute", "route-up", "route-pre-down", "up", "down", "plugin", "tmp-dir", "cryptoapicert", "pkcs11-providers", "management-client-user", "Management"];

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Разбивает текст на строки, вытаскивая inline-блоки <tag>...</tag>.
function tokenize(text) {
  const out = [];
  const lines = stripBom(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^\s*<([a-zA-Z0-9_-]+)>\s*$/.exec(line);
    if (m) {
      const tag = m[1].toLowerCase();
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*</${tag}>\\s*$`, "i").test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // пропускаем закрывающий тег
      out.push({ kind: "inline", tag, body: body.join("\n") });
      continue;
    }
    out.push({ kind: "line", raw: line });
    i++;
  }
  return out;
}

// Директива: первый токен = имя, остальное = аргументы (с учётом кавычек).
function parseDirective(raw) {
  const t = raw.trim();
  if (!t || t.startsWith("#") || t.startsWith(";")) return null;
  const parts = t.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (!parts.length) return null;
  const name = parts[0].replace(/^--/, "").toLowerCase();
  const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ""));
  return { name, args, raw: t };
}

function parseOvpn(text, opts) {
  opts = opts || {};
  const tokens = tokenize(text);
  const directives = [];
  const inline = {};
  const remotes = [];
  let dev = null, proto = null, hasAuthUserPass = false, hasRedirectGateway = false, hasFloat = false;
  let pushCount = 0;

  for (const tk of tokens) {
    if (tk.kind === "inline") {
      inline[tk.tag] = tk.body;
      continue;
    }
    const d = parseDirective(tk.raw);
    if (!d) continue;
    directives.push(d);
    switch (d.name) {
      case "remote": if (d.args.length >= 1) remotes.push({ host: d.args[0], port: parseInt(d.args[1], 10) || 1194, proto: (d.args[2] || proto || "udp").toLowerCase() }); break;
      case "proto": proto = d.args[0]; break;
      case "dev": case "dev-node": dev = d.args[0]; break;
      case "auth-user-pass": hasAuthUserPass = true; break;
      case "redirect-gateway": case "redirect-private": hasRedirectGateway = true; break;
      case "float": hasFloat = true; break;
      case "push": pushCount++; break;
      default: break;
    }
  }

  const warnings = [];
  if (!remotes.length) warnings.push("нет директивы remote — туннель не поднимется");
  if (hasAuthUserPass && !opts.username) warnings.push("конфиг требует auth-user-pass, но логин не задан");
  if (/tap/i.test(dev || "")) warnings.push("dev tap: TAP (L2) работает хуже с UDP-релеем, лучше dev tun");

  return {
    tokens, directives, inline, remotes, dev, proto: (proto || "udp").toLowerCase(),
    hasAuthUserPass, hasRedirectGateway, hasFloat, pushCount, warnings,
    // человеческая метка для логов
    label: remotes.length ? `${remotes[0].host}:${remotes[0].port}/${proto || "udp"}` : (opts.name || "ovpn"),
  };
}

function parseOvpnFile(file, opts) {
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseOvpn(text, Object.assign({ name: path.basename(file) }, opts));
  parsed.sourceFile = path.resolve(file);
  parsed.sourceDir = path.dirname(path.resolve(file));
  return parsed;
}

// Маршрут /32 до конкретной цели через туннель: нужен, когда в конфиге нет
// redirect-gateway (коммерческие full-tunnel его имеют, приватные — часто нет).
// Так флуд/боты точно уходят в OVPN, а не мимо него по системному маршруту.
function normalizeRouteTargets(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const ip = String(raw || "").trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
    if (seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  return out;
}

// Готовит рабочую копию конфига + все сопутствующие файлы в workDir.
// Возвращает { configPath, credsPath, managementPort, label, warnings }.
// opts.routeTargets = ['1.2.3.4', ...] -> в конфиг добавляются route <ip> 255.255.255.255.
function materialize(parsed, workDir, opts) {
  opts = opts || {};
  fs.mkdirSync(workDir, { recursive: true });
  const lines = [];
  const copied = [];

  const copyNear = (p) => {
    const abs = path.isAbsolute(p) ? p : path.join(parsed.sourceDir, p);
    if (!fs.existsSync(abs)) return null;
    const dst = path.join(workDir, copied.length + "_" + path.basename(abs).replace(/[^\w.-]/g, "_"));
    try { fs.copyFileSync(abs, dst); copied.push(dst); return dst; } catch (e) { return null; }
  };

  for (const tk of parsed.tokens) {
    if (tk.kind === "inline") {
      // inline-блоки просто переписываем как есть (OpenVPN их съест)
      lines.push(`<${tk.tag}>`);
      lines.push(tk.body);
      lines.push(`</${tk.tag}>`);
      continue;
    }
    const d = parseDirective(tk.raw);
    if (!d) { lines.push(tk.raw); continue; } // комментарии/пустые

    if (d.name === "auth-user-pass") {
      // Всегда подменяем на наш creds-файл (если есть креды)
      if (opts.username) {
        lines.push(`auth-user-pass ${JSON.stringify(opts.credsPath || path.join(workDir, "auth.txt"))}`);
      } else {
        lines.push(tk.raw); // оставляем как есть -> openvpn спросит в консоль (повиснет) — ниже WARN
      }
      continue;
    }

    if (FILE_DIRECTIVES.includes(d.name) && d.args.length) {
      // Относительные пути до внешних файлов перекладываем рядом с рабочим конфигом.
      const last = d.args[d.args.length - 1];
      if (/^[a-zA-Z0-9_.\/-]+$/.test(last) && !/^\d+$/.test(last)) {
        const dst = copyNear(last);
        if (dst) {
          const newArgs = d.args.slice(0, -1).concat(JSON.stringify(dst));
          lines.push(`${d.name} ${newArgs.join(" ")}`);
          continue;
        }
      }
    }
    lines.push(tk.raw);
  }

  // Наши добавки (идемпотентно: убираем прежние management/verb если были)
  const routeTargets = normalizeRouteTargets(opts.routeTargets);
  const routeSet = new Set(routeTargets);
  const filtered = lines.filter((l) => {
    if (/^\s*(management|verb|suppress-timestamps|log|log-append|management-hold)\b/i.test(l)) return false;
    // не дублируем route до той же цели, если он уже есть в конфиге
    const d = parseDirective(l);
    if (d && d.name === "route" && d.args.length >= 2 && routeSet.has(d.args[0])) return false;
    return true;
  });
  filtered.push("verb 3");
  filtered.push("suppress-timestamps");
  filtered.push(`management 127.0.0.1 ${opts.managementPort || 25340}`);
  filtered.push("management-hold"); // ждём `hold release` от нас — чтобы успеть снять снимок сетевых интерфейсов
  for (const ip of routeTargets) filtered.push(`route ${ip} 255.255.255.255`);
  filtered.push("");

  const configPath = path.join(workDir, "config.ovpn");
  fs.writeFileSync(configPath, filtered.join("\n"), "utf8");

  const credsPath = opts.credsPath || path.join(workDir, "auth.txt");
  if (opts.username) fs.writeFileSync(credsPath, `${opts.username}\n${opts.password || ""}\n`, "utf8");

  const warnings = parsed.warnings.slice();
  if (parsed.hasAuthUserPass && !opts.username) warnings.push("нет логина/пароля — openvpn может зависнуть в ожидании ввода");
  if (!parsed.hasRedirectGateway && !routeTargets.length) {
    warnings.push("в конфиге нет redirect-gateway: UDP дойдёт до цели только если маршрут до неё идёт через туннель (bind к tunIP + route)");
  }

  return {
    configPath, credsPath, managementPort: opts.managementPort || 25340,
    label: parsed.label, warnings, copied, routeTargets,
  };
}

module.exports = {
  parseOvpn, parseOvpnFile, materialize, normalizeRouteTargets,
  INLINE_TAGS, tokenize, parseDirective,
};
