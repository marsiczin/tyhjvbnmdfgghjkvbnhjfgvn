const { Client } = require('./lib/client.js')

// Актуальная версия официального клиента (DDNet 20.2, master 2026:
// DDNET_VERSION_NUMBER 20020, GAME_RELEASE_VERSION 20.2).
// ВАЖНО: сервер палит ботов по номеру версии в OnClientDDNetVersionKnown:
//   - "Your client has bots..." при version 15..99 или 502
//   - "Your DDNet client is old..." при version < VERSION_DDNET_UPDATER_FIXED
// Поэтому шлём реальный текущий номер, как настоящий клиент.
const DDNET_VERSION = {
	version: 20020,
	release_version: '20.2'
}

// Глобальный массив активных ботов
let activeBots = []
let proxyList = []
let tunnelList = []
let tunnelFailureHandler = null

/**
 * Приводит запись прокси/туннеля к единому виду.
 * Поддерживаются оба варианта:
 *   { ip, port, username, password }                     — обычный SOCKS5
 *   { ip:'127.0.0.1', port, tunIP, via, id, kind:'ovpn' } — туннель из ovpn-pool
 *     (или вложенный socks: { ip, port })
 */
function normalizeProxy(p) {
	if (!p) return null
	const src = p.socks && p.socks.ip ? p.socks : p
	const ip = src.ip != null ? String(src.ip).trim() : ''
	const port = typeof src.port === 'number' ? src.port : (parseInt(src.port) || 0)
	if (!ip || !port) return null
	const tunIP = p.tunIP || p.bindIP || null
	return {
		ip,
		port,
		username: (src.username != null ? String(src.username).trim() : (p.username != null ? String(p.username).trim() : '')) || null,
		password: src.password != null ? String(src.password) : (p.password != null ? String(p.password) : null),
		tunIP: tunIP ? String(tunIP) : null,
		via: p.via || null,
		id: p.id || null,
		kind: p.kind || (tunIP ? 'ovpn' : 'socks')
	}
}

function proxyLabel(p) {
	if (!p) return 'прямой IP'
	return p.via || `${p.ip}:${p.port}`
}

/**
 * Устанавливает список прокси для последующих подключений.
 * Принимает и обычные SOCKS5, и туннельные дескрипторы из ovpn-pool.
 * @param {Array} proxies - [{ ip, port, username?, password?, tunIP?, via?, id? }]
 */
function setProxies(proxies) {
	if (!Array.isArray(proxies) || proxies.length === 0) {
		proxyList = []
		return
	}
	proxyList = proxies.map(normalizeProxy).filter(Boolean)
}

/**
 * Получает текущий список прокси
 */
function getProxies() {
	return [...proxyList]
}

/**
 * Отдельный список OVPN-туннелей (те же дескрипторы, что и в setProxies,
 * но хранится раздельно — удобно для статистики и ротации по волнам).
 */
function setTunnels(tunnels) {
	tunnelList = Array.isArray(tunnels) ? tunnels.map(normalizeProxy).filter(Boolean) : []
	return tunnelList.length
}

function getTunnels() {
	return [...tunnelList]
}

/**
 * Callback на смерть туннеля: (proxy, reason) -> void.
 * cli.js вешает сюда ovpnPool.healthNow(), чтобы поднять openvpn заново.
 */
function setTunnelFailureHandler(fn) {
	tunnelFailureHandler = typeof fn === 'function' ? fn : null
}

function reportTunnelFailure(proxy, reason) {
	if (!proxy || !proxy.tunIP || !tunnelFailureHandler) return
	try { tunnelFailureHandler(proxy, reason) } catch (e) {}
}

/**
 * Создает и возвращает нового бота (экстремально быстрый режим)
 * @param {string} serverIp - IP сервера
 * @param {number} serverPort - Порт сервера
 * @param {string} nickname - Базовый никнейм бота
 * @param {Object} proxy - (опционально) SOCKS5 или OVPN-туннель { ip, port, username?, password?, tunIP?, via? }
 * @param {Object} opts - (опционально) Переопределения настроек, напр. { timeout }
 * @returns {Promise<Object>} - Объект бота
 */
async function createBot(serverIp, serverPort, nickname, proxy, opts) {
	if (!serverIp || !serverPort) {
		throw new Error('Не указан IP или порт сервера')
	}

	const px = normalizeProxy(proxy)

	// Никнейм используется как есть, без случайных цифр.
	// Если ник пуст — генерируем случайный (буквы+цифры, 8 символов:
	// у 4-значных чисел коллизии уже при ~100 ботах, сервер режет дубли).
	// т.к. сервер не пускает с пустым именем.
	const cleanNick = nickname && nickname.trim() !== '' ? nickname.trim() : null
	const botName = cleanNick || ('k' + Math.random().toString(36).slice(2, 9))

	// Кастомная внешность (шпион): ник/клан/скин из opts.identity, иначе дефолты
	const customIdentity = (opts && opts.identity) || {}
	// Таймаут без входящих пакетов. Прямым ботам хватает агрессивных 500 мс,
	// через прокси handshake дольше (релей, лишний хоп) — даём 3000 мс,
	// через OVPN-туннель добавляется шифрование и TUN — 4000 мс.
	const viaTunnel = !!(px && px.tunIP)
	const defaultTimeout = px ? (viaTunnel ? 4000 : 3000) : 500
	// Экстремально быстрые настройки
	const client = new Client(serverIp, serverPort, botName, {
		identity: {
			name: botName,
			clan: customIdentity.clan != null ? String(customIdentity.clan) : '',
			skin: customIdentity.skin ? String(customIdentity.skin) : 'default',
			use_custom_color: 0,
			color_body: 0,  // Устанавливаем фиксированные цвета вместо случайных
			color_feet: 0,  // для ускорения
			country: -1,
		},
		timeout: (opts && opts.timeout) || defaultTimeout,
		lightweight: true,    // Обязательно lightweight
		ddnet_version: DDNET_VERSION,
		retries: 0,           // Без повторных попыток
		retryDelay: 0         // Без задержки
	})

	// Прокси/туннель обязателен для обхода бана по IP: SOCKS5 UDP relay
	// поднимается в Client.connect(). TunnelSocksServer сам биндится к tunIP.
	if (px) {
		client.setProxy(px.ip, px.port, px.username, px.password)
		client._proxyLabel = proxyLabel(px)
		client._tunnelId = px.id || null
		client._tunnelIP = px.tunIP || null
	} else {
		client._proxyLabel = null
		client._tunnelId = null
		client._tunnelIP = null
	}
	client._proxy = px

	// Обработчик ошибок подключения (через ui-log мост — require renderer напрямую небезопасен)
	const uiLog = require('./lib/ui-log')
	const health = require('./lib/proxy-health')
	const usedProxy = px

	client.on('error', (error) => {
		try {
			const via = (typeof client.getProxyLabel === 'function' && client.getProxyLabel()) || client._proxyLabel
			uiLog.addLog(
				via ? `Ошибка бота ${botName} [${px && px.via ? px.via : `proxy ${via}`}]: ${error.message}` : `Ошибка бота ${botName}: ${error.message}`,
				'error'
			)
			uiLog.updateStats('failed')
		} catch {}
		// Ошибка = неудача прокси (если бот шёл через него)
		try {
			if (usedProxy) {
				const r = health.recordResult(usedProxy, false)
				if (r && r.skipped) {
					try { uiLog.addLog(`Прокси ${proxyLabel(usedProxy)} исключён после ${r.fails} неудач`, 'warning') } catch {}
				}
				reportTunnelFailure(usedProxy, (error && error.message) || String(error))
			}
		} catch {}
	})

	// Абсолютный минимум для отслеживания состояния
	let isConnected = false

	// Максимально простой обработчик подключения
	client.on('connected', () => {
		isConnected = true
		try {
			uiLog.updateStats('success')
		} catch {}
		// Успех сбрасывает счётчик неудач прокси
		try {
			if (usedProxy) {
				const r = health.recordResult(usedProxy, true)
				if (r && r.recovered) {
					try { uiLog.addLog(`Прокси ${proxyLabel(usedProxy)} снова в строю`, 'success') } catch {}
				}
			}
		} catch {}
	})

	// Простой обработчик отключения
	client.on('disconnect', (reason) => {
		const wasConnected = isConnected
		isConnected = false
		// Прокси-ошибки (associate failed, auth failed) приходят сюда — показываем их,
		// иначе кажется что "боты не используют прокси", а на деле прокси мёртвые.
		if (reason && /proxy|associate|socks|ovpn|tunnel/i.test(String(reason))) {
			try {
				uiLog.addLog(`Бот ${botName} отключён [${proxyLabel(usedProxy)}]: ${reason}`, 'error')
				uiLog.updateStats('failed')
			} catch {}
			reportTunnelFailure(usedProxy, String(reason))
		}
		// Отвал ДО первого коннекта = неудача прокси (плановые отключения уже после connected)
		try {
			if (usedProxy && !wasConnected) {
				const r = health.recordResult(usedProxy, false)
				if (r && r.skipped) {
					try { uiLog.addLog(`Прокси ${proxyLabel(usedProxy)} исключён после ${r.fails} неудач`, 'warning') } catch {}
				}
			}
		} catch {}
	})

	// Добавляем в массив активных ботов
	activeBots.push(client)

	// Только минимально необходимый функционал
	client.isConnected = () => isConnected

	// Супер-упрощенный sendInput
	if (!client.sendInput) {
		client.sendInput = () => {
			try {
				if (client._sendInput) client._sendInput()
				else if (client.sendInputPacket) client.sendInputPacket({
					direction: 0, target_x: 0, target_y: 0, jump: 0, fire: 0, hook: 0,
					player_flags: 0, wanted_weapon: 0, next_weapon: 0, prev_weapon: 0
				})
			} catch (e) {}
		}
	}

	return client
}

/**
 * Отключает всех активных ботов мгновенно
 */
async function disconnectAllBots() {
	// Быстрое отключение без ожиданий и проверок
	const bots = activeBots
	activeBots = []

	for (const bot of bots) {
		try { bot.Disconnect() } catch (e) {}
	}
}

module.exports = {
	createBot,
	disconnectAllBots,
	setProxies,
	getProxies,
	setTunnels,
	getTunnels,
	setTunnelFailureHandler,
	normalizeProxy,
	proxyLabel,
}
