"use strict";
// chart_viewer.js
// Opens TradingView chart in Chrome (unified browser), takes screenshot.
// Uses ONE persistent named page per pair — no extra login tabs.

const { getPage, getContext, ensureTradingViewLogin } = require("../../../connectors/chrome/browser");

// One-time login attempt per process run — avoids repeated login flows
let _tvLoginAttempted = false;

const CHART_URLS = {
  BTC: "https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT&interval=60",
  ETH: "https://www.tradingview.com/chart/?symbol=BINANCE%3AETHUSDT&interval=60",
  SOL: "https://www.tradingview.com/chart/?symbol=BINANCE%3ASOLUSDT&interval=60",
};

/**
 * Open (or refresh) TradingView chart in Chrome.
 * Returns { screenshotB64, url, pair } — or throws on failure.
 * Uses a single persistent page per pair to avoid tab proliferation.
 */
async function openChart(pair = "BTC", interval = "60") {
  const key  = String(pair).toUpperCase().replace(/USDT$/i, "");
  const base = CHART_URLS[key] || CHART_URLS.BTC;
  const url  = base.replace("interval=60", `interval=${interval}`);

  // Attempt TradingView login once per process if credentials exist and not yet attempted.
  // Close the login tab afterwards to keep only the chart tab visible.
  if (!_tvLoginAttempted && (process.env.GOOGLE_EMAIL || "").trim()) {
    try {
      const ok = await ensureTradingViewLogin();
      _tvLoginAttempted = !!ok; // only mark done if login actually succeeded
      // Close the "tradingview" login page — session is now stored in the Chrome profile.
      const ctx = await getContext();
      const pages = ctx.pages();
      for (const p of pages) {
        const u = p.url();
        if (u.includes("tradingview.com") && !u.includes("chart")) {
          await p.close().catch(() => {});
        }
      }
    } catch (e) { console.warn("[chart_viewer] TV login failed:", e.message); }
  }

  // One page per pair — reused across calls
  const page = await getPage(`tv_${key}`);

  const currentUrl = page.url();
  const onChart    = currentUrl.includes("tradingview.com/chart") &&
                     currentUrl.toUpperCase().includes(key);

  if (!onChart) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  // Wait for chart canvas to render
  try {
    await page.waitForSelector("canvas", { timeout: 18000 });
    await page.waitForTimeout(3000);
  } catch { /* proceed anyway */ }

  // Dismiss any overlay dialogs
  try { await page.keyboard.press("Escape"); } catch {}
  try {
    const closeBtn = page.locator('[data-name="close"], [aria-label="Close"]').first();
    if (await closeBtn.count()) await closeBtn.click();
  } catch {}

  await page.waitForTimeout(400);

  const screenshotB64 = (await page.screenshot({ type: "jpeg", quality: 75 })).toString("base64");
  const finalUrl      = page.url();

  return { screenshotB64, url: finalUrl, pair: key };
}

module.exports = { openChart };
