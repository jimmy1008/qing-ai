"use strict";
// news_calendar.js — 高影響力財經新聞行事曆
//
// 資料來源：ForexFactory 本週行事曆 JSON feed（公開，每小時更新）
//   https://nfs.faireconomy.media/ff_calendar_thisweek.json
//
// 功能：
//   isNearHighImpactNews(windowMin)  → 目前時間是否在高影響力消息前後 N 分鐘內
//   getUpcomingEvents(n)             → 最近 N 個高影響力 USD 事件
//   getCalendarSummary()             → 今日/本週高影響力事件列表

const axios = require("axios");

const FF_URL     = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CACHE_TTL  = 60 * 60 * 1000; // 1 小時快取
const HIGH_IMPACT_WINDOW_DEFAULT = 30; // 分鐘

let _cache     = null;
let _cacheTime = 0;

// ── 資料抓取與快取 ─────────────────────────────────────────────────────────────

async function fetchCalendar() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  try {
    const resp = await axios.get(FF_URL, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0 SocialAI/1.0" },
    });
    _cache     = Array.isArray(resp.data) ? resp.data : [];
    _cacheTime = now;
  } catch (err) {
    console.warn("[news_calendar] fetch failed:", err.message);
    _cache = _cache || []; // 沿用舊快取，或空陣列
  }

  return _cache;
}

// ── 過濾高影響力 USD 事件 ───────────────────────────────────────────────────────

function parseEventTime(event) {
  if (!event.date) return null;
  return new Date(event.date).getTime();
}

function isHighImpact(event) {
  return (
    (event.impact === "High" || event.impact === "3") &&
    (event.country === "USD" || !event.country)
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * 目前時間是否在高影響力 USD 新聞前後 windowMin 分鐘內。
 * @param {number} windowMin — 前後幾分鐘算「附近」（預設 30）
 * @returns {Promise<{near: boolean, events: object[]}>}
 */
async function isNearHighImpactNews(windowMin = HIGH_IMPACT_WINDOW_DEFAULT) {
  const events = await fetchCalendar();
  const now    = Date.now();
  const window = windowMin * 60 * 1000;

  const nearEvents = events.filter(ev => {
    if (!isHighImpact(ev)) return false;
    const t = parseEventTime(ev);
    if (!t) return false;
    return Math.abs(now - t) <= window;
  });

  return { near: nearEvents.length > 0, events: nearEvents.map(formatEvent) };
}

/**
 * 未來最近 N 個高影響力 USD 事件（已過的不顯示）。
 */
async function getUpcomingEvents(n = 5) {
  const events = await fetchCalendar();
  const now    = Date.now();

  return events
    .filter(ev => isHighImpact(ev) && parseEventTime(ev) > now)
    .sort((a, b) => parseEventTime(a) - parseEventTime(b))
    .slice(0, n)
    .map(formatEvent);
}

/**
 * 今日 + 明日高影響力 USD 事件摘要。
 */
async function getCalendarSummary() {
  const events = await fetchCalendar();
  const now    = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;

  const relevant = events
    .filter(ev => isHighImpact(ev))
    .filter(ev => {
      const t = parseEventTime(ev);
      return t && t >= now - 60 * 60 * 1000 && t <= tomorrow;
    })
    .sort((a, b) => parseEventTime(a) - parseEventTime(b))
    .map(formatEvent);

  return {
    count:       relevant.length,
    events:      relevant,
    fetched_at:  _cacheTime || null,
    has_high_risk: relevant.some(ev => {
      if (!ev.time) return false;
      const t = new Date(ev.time).getTime();
      return !isNaN(t) && Math.abs(Date.now() - t) < 4 * 60 * 60 * 1000; // 4小時內
    }),
  };
}

function formatEvent(ev) {
  return {
    title:    ev.title  || ev.name || "?",
    country:  ev.country || "USD",
    time:     ev.date   || null,
    impact:   ev.impact || "High",
    forecast: ev.forecast || null,
    previous: ev.previous || null,
  };
}

module.exports = { isNearHighImpactNews, getUpcomingEvents, getCalendarSummary };
