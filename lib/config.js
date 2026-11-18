"use strict";
// Центральная конфигурация вместо магических чисел по коду.
//
// DDNET_VERSION: номер актуального официального клиента.
// Сервер детектит ботов в OnClientDDNetVersionKnown:
//   - "Your client has bots..." при version 15..99 или 502
//   - "Your DDNet client is old..." при version < VERSION_DDNET_UPDATER_FIXED
// Свежий номер брать из https://github.com/ddnet/ddnet/blob/master/src/game/version.h
// (DDNET_VERSION_NUMBER). Строка release_version должна ему соответствовать.
module.exports = {
  DDNET_VERSION: { version: 20020, release_version: '20.2' },

  // Отправка сообщений атакующими ботами
  MESSAGE: {
    preDelayMs: 800, // пауза после входа (серверный антиспам новичков)
    resendCount: 3, // сколько раз слать сообщение
    resendGapMs: 300, // интервал между повторами
    minDwellMs: 500, // минимум жизни бота после отправки перед отключением
  },

  BOT: {
    staggerMs: 15, // пауза между созданием ботов
    settleMs: 500, // пауза после пачки перед отключением
    defaultTimeoutMs: 500, // агрессивный таймаут атакующих ботов
    spyTimeoutMs: 15000, // таймаут долгоживущего шпиона
  },

  PROXY_CHECK: {
    workers: 10, // параллельных проверок во вкладке
    timeoutMs: 6000, // таймаут associate-стадии во вкладке
    udpTimeoutMs: 5000, // таймаут UDP-стадии (DNS через релей)
    quickWorkers: 20, // параллельных проверок перед стартом атаки
    quickTimeoutMs: 2500, // таймаут одной проверки перед стартом
    skipAfterFails: 3, // пропускать прокси после N подряд неудач (0 = не пропускать)
    skipCooldownMs: 120000, // через сколько дать исключённому прокси новый шанс
  },

  UI: {
    maxLogEntries: 50, // записей лога в DOM
    maxStoredLogs: 1000, // записей для экспорта
    maxFeedEntries: 200, // сообщений в ленте шпиона
    chartPoints: 50, // точек графика
  },

  SETTINGS_VERSION: 2, // версия схемы настроек в localStorage
};
