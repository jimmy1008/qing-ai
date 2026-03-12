"use strict";
// chart_viewer.js
// Opens TradingView chart in Chrome (via unified chrome/browser.js),
// auto-logins via Google, takes screenshot, returns base64 JPEG.

const { getPage, ensureTradingViewLogin } = require("../../../connectors/chrome/browser");

const CHART_URLS = {
  BTC: "https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT&interval=60",
  ETH: "https://www.tradingview.com/chart/?symbol=BINANCE%3AETHUSDT&interval=60",
  SOL: "https://www.tradingview.com/chart/?symbol=BINANCE%3ASOLUSDT&interval=60",
};

let _tvLoginDone = false;

/**
 * Open a TradingView chart in Chrome, wait for render, return screenshot as base64 JPEG.
 * @param {"BTC"|"ETH"|"SOL"} pair
 * @param {"1"|"5"|"15"|"60"|"240"|"D"} interval
 * @returns {Promise<string>} base64 JPEG
 */
async function openChart(pair = "BTC", interval = "60") {
  const key  = String(pair).toUpperCase().replace(/USDT$/i, "");
  const base = CHART_URLS[key] || CHART_URLS.BTC;
  const url  = base.replace("interval=60", `interval=${interval}`);

  // Ensure TradingView session on first call
  if (!_tvLoginDone) {
    await ensureTradingViewLogin().catch(() => {});
    _tvLoginDone = true;
  }

  const page = await getPage(`tv_${key}`);

  const currentUrl = page.url();
  const needsNav   = !currentUrl.includes("tradingview.com/chart") ||
                     !currentUrl.includes(key + "USDT");

  if (needsNav) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  // Wait for chart canvas
  try {
    await page.waitForSelector("canvas", { timeout: 18000 });
    await page.waitForTimeout(3500);
  } catch { /* proceed anyway */ }

  // Dismiss dialogs
  try { await page.keyboard.press("Escape"); } catch {}
  try {
    const closeBtn = page.locator('[data-name="close"], [aria-label="Close"], .close-button').first();
    if (await closeBtn.count()) await closeBtn.click();
  } catch {}

  await page.waitForTimeout(500);

  const buf = await page.screenshot({ type: "jpeg", quality: 80 });
  return buf.toString("base64");
}

module.exports = { openChart };
