"use strict";
// tv_datafeed.js — TradingView market data fetcher
//
// Data sources (TradingView only):
//   1. TradingView Scanner API  — real-time snapshot (price, change, volume, indicators)
//      POST https://scanner.tradingview.com/crypto/scan
//   2. TradingView History API  — OHLCV candles (UDF protocol, public for major symbols)
//      GET  https://history.tradingview.com/history?symbol=...&resolution=...
//
// Supported assets: BTC, ETH only
// Supported timeframes: 4H, 1H, 15M, 5M

const axios = require("axios");

// TradingView exchange-prefixed symbols
const TV_SYMBOL = {
  BTC: "BINANCE:BTCUSDT",
  ETH: "BINANCE:ETHUSDT",
};

// TradingView resolution map
const TV_RESOLUTION = {
  "4H": "240",
  "1H": "60",
  "15M": "15",
  "5M":  "5",
};

const SCANNER_URL = "https://scanner.tradingview.com/crypto/scan";
const HISTORY_URL = "https://history.tradingview.com/history";

// Browser-like headers to avoid 403 from TradingView
const TV_HEADERS = {
  "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  "Origin":       "https://www.tradingview.com",
  "Referer":      "https://www.tradingview.com/",
  "Content-Type": "application/json",
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get real-time market snapshot from TradingView Scanner.
 * Returns current price, change%, volume, and key indicators.
 *
 * @param {"BTC"|"ETH"} asset
 * @returns {Promise<SnapshotResult>}
 */
async function fetchSnapshot(asset) {
  const sym = TV_SYMBOL[asset.toUpperCase()];
  if (!sym) throw new Error(`Unsupported asset: ${asset}. Only BTC and ETH are supported.`);

  const body = {
    symbols:  { tickers: [sym] },
    columns: [
      "close",           // current price
      "open",
      "high",
      "low",
      "volume",
      "change",          // % change
      "change_abs",      // absolute change
      "Recommend.All",   // oscillator summary (-1 sell … +1 buy)
      "RSI",
      "MACD.macd",
      "MACD.signal",
      "ADX",
      "Stoch.K",
      "Stoch.D",
    ],
  };

  const resp = await axios.post(SCANNER_URL, body, {
    headers: TV_HEADERS,
    timeout: 10000,
  });

  const row = resp.data?.data?.[0]?.d;
  if (!row) throw new Error("Scanner returned empty data");

  const [close, open, high, low, volume, change, changeAbs,
    recommend, rsi, macdLine, macdSignal, adx, stochK, stochD] = row;

  return {
    asset:      asset.toUpperCase(),
    symbol:     sym,
    price:      close,
    open, high, low,
    volume:     volume ? Math.round(volume) : null,
    change_pct: change  ? Number(change.toFixed(3))  : null,
    change_abs: changeAbs ? Number(changeAbs.toFixed(2)) : null,
    indicators: {
      recommend: recommend != null ? Number(recommend.toFixed(3)) : null,
      rsi:       rsi       != null ? Number(rsi.toFixed(1))       : null,
      macd:      macdLine != null  ? Number(macdLine.toFixed(2))  : null,
      macd_signal: macdSignal != null ? Number(macdSignal.toFixed(2)) : null,
      adx:       adx       != null ? Number(adx.toFixed(1))       : null,
      stoch_k:   stochK    != null ? Number(stochK.toFixed(1))    : null,
      stoch_d:   stochD    != null ? Number(stochD.toFixed(1))    : null,
    },
    fetched_at: Date.now(),
  };
}

// Binance interval map (TradingView uses Binance as data source for BINANCE: prefix symbols)
// Binance API is used as fallback when TradingView history endpoint is not reachable.
const BINANCE_INTERVAL = { "4H": "4h", "1H": "1h", "15M": "15m", "5M": "5m" };
const BINANCE_SYMBOL   = { "BTC": "BTCUSDT", "ETH": "ETHUSDT" };
const BINANCE_URL      = "https://api.binance.com/api/v3/klines";

/**
 * Fetch historical OHLCV candles.
 * Primary: TradingView history API.
 * Fallback: Binance REST API (TradingView sources BINANCE:BTCUSDT from Binance).
 *
 * @param {"BTC"|"ETH"} asset
 * @param {"4H"|"1H"|"15M"|"5M"} timeframe
 * @param {number} bars  — number of candles (default 100)
 * @returns {Promise<Candle[]>}
 */
async function fetchCandles(asset, timeframe, bars = 100) {
  const A = asset.toUpperCase();
  const sym = TV_SYMBOL[A];
  const res = TV_RESOLUTION[timeframe];
  if (!sym) throw new Error(`Unsupported asset: ${asset}`);
  if (!res) throw new Error(`Unsupported timeframe: ${timeframe}. Use 4H, 1H, 15M, 5M.`);

  // ── Try TradingView history first ─────────────────────────────────────────
  try {
    const now  = Math.floor(Date.now() / 1000);
    const intervalSec = resolutionToSeconds(res);
    const from = now - (bars + 20) * intervalSec;

    const resp = await axios.get(HISTORY_URL, {
      params: { symbol: sym, resolution: res, from, to: now, firstDataRequest: 1 },
      headers: TV_HEADERS,
      timeout: 10000,
    });

    const { s, t, o, h, l, c, v } = resp.data;
    if (s === "ok" && t && t.length > 0) {
      return t.map((ts, i) => ({
        time:   ts * 1000,
        open:   o[i], high: h[i], low: l[i], close: c[i],
        volume: v ? v[i] : null,
        source: "tradingview",
      })).slice(-bars);
    }
  } catch { /* fall through to Binance */ }

  // ── Fallback: Binance API (same underlying data for BINANCE:BTCUSDT) ──────
  const bInterval = BINANCE_INTERVAL[timeframe];
  const bSymbol   = BINANCE_SYMBOL[A];
  if (!bInterval || !bSymbol) throw new Error(`No fallback available for ${asset}/${timeframe}`);

  const resp = await axios.get(BINANCE_URL, {
    params: { symbol: bSymbol, interval: bInterval, limit: bars },
    timeout: 10000,
  });

  return resp.data.map(k => ({
    time:   k[0],                      // open time ms
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
    source: "binance",                 // same data TV uses
  }));
}

/**
 * Fetch multi-timeframe data for an asset.
 * Returns { "4H": Candle[], "1H": Candle[], "15M": Candle[], "5M": Candle[] }
 *
 * @param {"BTC"|"ETH"} asset
 * @returns {Promise<MultiTFData>}
 */
async function fetchMultiTF(asset) {
  const timeframes = ["4H", "1H", "15M", "5M"];
  const bars = { "4H": 80, "1H": 100, "15M": 100, "5M": 80 };

  const results = {};
  const errors  = {};

  await Promise.allSettled(
    timeframes.map(async tf => {
      try {
        results[tf] = await fetchCandles(asset, tf, bars[tf]);
      } catch (err) {
        errors[tf] = err.message;
        results[tf] = [];
      }
    })
  );

  return { asset: asset.toUpperCase(), data: results, errors, fetched_at: Date.now() };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolutionToSeconds(res) {
  const n = Number(res);
  return n * 60;  // TV resolution is always in minutes
}

module.exports = { fetchSnapshot, fetchCandles, fetchMultiTF, TV_SYMBOL, TV_RESOLUTION };
