"use strict";
// tv_datafeed.js — TradingView market data fetcher
//
// Data sources:
//   1. TradingView Scanner API  — real-time snapshot (price, change, volume, indicators)
//   2. TradingView History API  — OHLCV candles (UDF protocol)
//   3. Binance Futures API      — funding rate, open interest (fallback for candles)
//
// Supported assets: BTC, ETH
// Supported timeframes: 4H, 1H, 15M, 5M

const axios = require("axios");

const TV_SYMBOL = {
  BTC: "BINANCE:BTCUSDT",
  ETH: "BINANCE:ETHUSDT",
};

const TV_RESOLUTION = {
  "4H": "240",
  "1H": "60",
  "15M": "15",
  "5M":  "5",
};

const BINANCE_SYMBOL   = { BTC: "BTCUSDT", ETH: "ETHUSDT" };
const BINANCE_INTERVAL = { "4H": "4h", "1H": "1h", "15M": "15m", "5M": "5m" };
const BINANCE_URL      = "https://api.binance.com/api/v3/klines";
const BINANCE_FAPI_URL = "https://fapi.binance.com/fapi/v1";

const SCANNER_URL = "https://scanner.tradingview.com/crypto/scan";
const HISTORY_URL = "https://history.tradingview.com/history";

const TV_HEADERS = {
  "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  "Origin":       "https://www.tradingview.com",
  "Referer":      "https://www.tradingview.com/",
  "Content-Type": "application/json",
};

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry(fn, retries = 1, delayMs = 1500) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise(r => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get real-time market snapshot from TradingView Scanner.
 * Retries once on failure.
 */
async function fetchSnapshot(asset) {
  return withRetry(() => _fetchSnapshotOnce(asset));
}

async function _fetchSnapshotOnce(asset) {
  const sym = TV_SYMBOL[asset.toUpperCase()];
  if (!sym) throw new Error(`Unsupported asset: ${asset}. Only BTC and ETH are supported.`);

  const body = {
    symbols:  { tickers: [sym] },
    columns: [
      "close", "open", "high", "low", "volume",
      "change", "change_abs",
      "Recommend.All", "RSI",
      "MACD.macd", "MACD.signal",
      "ADX", "Stoch.K", "Stoch.D",
    ],
  };

  const resp = await axios.post(SCANNER_URL, body, { headers: TV_HEADERS, timeout: 10000 });
  const row  = resp.data?.data?.[0]?.d;
  if (!row) throw new Error("Scanner returned empty data");

  const [close, open, high, low, volume, change, changeAbs,
    recommend, rsi, macdLine, macdSignal, adx, stochK, stochD] = row;

  return {
    asset:      asset.toUpperCase(),
    symbol:     sym,
    price:      close,
    open, high, low,
    volume:     volume ? Math.round(volume) : null,
    change_pct: change    ? Number(change.toFixed(3))    : null,
    change_abs: changeAbs ? Number(changeAbs.toFixed(2)) : null,
    indicators: {
      recommend:   recommend   != null ? Number(recommend.toFixed(3))   : null,
      rsi:         rsi         != null ? Number(rsi.toFixed(1))         : null,
      macd:        macdLine    != null ? Number(macdLine.toFixed(2))    : null,
      macd_signal: macdSignal  != null ? Number(macdSignal.toFixed(2))  : null,
      adx:         adx         != null ? Number(adx.toFixed(1))         : null,
      stoch_k:     stochK      != null ? Number(stochK.toFixed(1))      : null,
      stoch_d:     stochD      != null ? Number(stochD.toFixed(1))      : null,
    },
    fetched_at: Date.now(),
  };
}

/**
 * Fetch historical OHLCV candles.
 * Primary: TradingView history API. Fallback: Binance REST API.
 * Retries once on failure.
 */
async function fetchCandles(asset, timeframe, bars = 100) {
  return withRetry(() => _fetchCandlesOnce(asset, timeframe, bars));
}

async function _fetchCandlesOnce(asset, timeframe, bars) {
  const A   = asset.toUpperCase();
  const sym = TV_SYMBOL[A];
  const res = TV_RESOLUTION[timeframe];
  if (!sym) throw new Error(`Unsupported asset: ${asset}`);
  if (!res) throw new Error(`Unsupported timeframe: ${timeframe}. Use 4H, 1H, 15M, 5M.`);

  // Try TradingView first
  try {
    const now         = Math.floor(Date.now() / 1000);
    const intervalSec = Number(res) * 60;
    const from        = now - (bars + 20) * intervalSec;

    const resp = await axios.get(HISTORY_URL, {
      params:  { symbol: sym, resolution: res, from, to: now, firstDataRequest: 1 },
      headers: TV_HEADERS,
      timeout: 10000,
    });

    const { s, t, o, h, l, c, v } = resp.data;
    if (s === "ok" && t && t.length > 0) {
      return t.map((ts, i) => ({
        time: ts * 1000, open: o[i], high: h[i], low: l[i], close: c[i],
        volume: v ? v[i] : null, source: "tradingview",
      })).slice(-bars);
    }
  } catch { /* fall through to Binance */ }

  // Fallback: Binance
  const bInterval = BINANCE_INTERVAL[timeframe];
  const bSymbol   = BINANCE_SYMBOL[A];
  if (!bInterval || !bSymbol) throw new Error(`No fallback available for ${asset}/${timeframe}`);

  const resp = await axios.get(BINANCE_URL, {
    params: { symbol: bSymbol, interval: bInterval, limit: bars },
    timeout: 10000,
  });

  return resp.data.map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]), high: parseFloat(k[2]),
    low:    parseFloat(k[3]), close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    source: "binance",
  }));
}

/**
 * Fetch multi-timeframe data for an asset.
 */
async function fetchMultiTF(asset) {
  const timeframes = ["4H", "1H", "15M", "5M"];
  const bars       = { "4H": 80, "1H": 100, "15M": 100, "5M": 80 };
  const results    = {};
  const errors     = {};

  await Promise.allSettled(
    timeframes.map(async tf => {
      try {
        results[tf] = await fetchCandles(asset, tf, bars[tf]);
      } catch (err) {
        errors[tf]  = err.message;
        results[tf] = [];
      }
    })
  );

  return { asset: asset.toUpperCase(), data: results, errors, fetched_at: Date.now() };
}

/**
 * Fetch funding rate + open interest from Binance Futures.
 * Returns null fields on failure (auxiliary data, non-critical).
 * @param {"BTC"|"ETH"} asset
 */
async function fetchFundingOI(asset) {
  const sym = BINANCE_SYMBOL[asset.toUpperCase()];
  if (!sym) return { funding_rate: null, open_interest: null, error: "unsupported asset" };

  const [fundingRes, oiRes] = await Promise.allSettled([
    axios.get(`${BINANCE_FAPI_URL}/premiumIndex`, { params: { symbol: sym }, timeout: 6000 }),
    axios.get(`${BINANCE_FAPI_URL}/openInterest`, { params: { symbol: sym }, timeout: 6000 }),
  ]);

  const fundingRate = fundingRes.status === "fulfilled"
    ? Number(parseFloat(fundingRes.value.data?.lastFundingRate || 0) * 100).toFixed(4)
    : null;

  const openInterest = oiRes.status === "fulfilled"
    ? Number(parseFloat(oiRes.value.data?.openInterest || 0)).toFixed(2)
    : null;

  const markPrice = fundingRes.status === "fulfilled"
    ? parseFloat(fundingRes.value.data?.markPrice || 0)
    : null;

  return {
    symbol:        sym,
    funding_rate:  fundingRate !== null ? parseFloat(fundingRate) : null,  // % (e.g. 0.0100)
    open_interest: openInterest !== null ? parseFloat(openInterest) : null, // in BTC/ETH
    mark_price:    markPrice,
    next_funding:  fundingRes.status === "fulfilled" ? fundingRes.value.data?.nextFundingTime : null,
    fetched_at:    Date.now(),
  };
}

module.exports = { fetchSnapshot, fetchCandles, fetchMultiTF, fetchFundingOI, TV_SYMBOL, TV_RESOLUTION };
