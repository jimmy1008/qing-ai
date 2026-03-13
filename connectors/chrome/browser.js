"use strict";
// connectors/chrome/browser.js
// Unified Google Chrome manager — shared across TradingView, Threads, and future sites.
// Uses a single persistent profile so Google login persists between restarts.
//
// Env vars required:
//   GOOGLE_EMAIL     — Google account email
//   GOOGLE_PASSWORD  — Google account password

const path = require("path");
const { chromium } = require("playwright");

const PROFILE_DIR = path.join(__dirname, "chrome_profile");

let _ctx       = null;   // BrowserContext
let _launching = false;
const _pages   = {};     // name → Page

// ── Launch / context ──────────────────────────────────────────────────────────

function _isContextAlive() {
  if (!_ctx) return false;
  try { _ctx.pages(); return true; } catch { return false; }
}

function _resetContext() {
  _ctx = null;
  // Clear stale page references
  for (const k of Object.keys(_pages)) delete _pages[k];
}

async function getContext() {
  // Relaunch if context was closed (e.g. user manually closed Chrome)
  if (!_isContextAlive()) _resetContext();

  if (_ctx) return _ctx;
  if (_launching) {
    while (_launching && !_ctx) await new Promise(r => setTimeout(r, 200));
    return _ctx;
  }
  _launching = true;
  try {
    _ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel:  "chrome",
      headless: false,
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
      ],
      viewport: null,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    });
    // Auto-reset if Chrome is closed again while server is running
    _ctx.on("close", () => {
      console.log("[Chrome] browser closed — will relaunch on next request");
      _resetContext();
    });
    console.log("[Chrome] browser launched");
    return _ctx;
  } finally {
    _launching = false;
  }
}

/**
 * Get (or create) a named persistent page.
 * Pages survive navigation — use descriptive names like "tradingview", "threads".
 */
async function getPage(name) {
  const ctx = await getContext();
  if (_pages[name] && !_pages[name].isClosed()) return _pages[name];
  const existing = ctx.pages();
  const page = (name === "default" && existing.length > 0) ? existing[0] : await ctx.newPage();
  _pages[name] = page;
  return page;
}

// ── Google login ──────────────────────────────────────────────────────────────

/**
 * Ensure the browser is signed into Google.
 * Navigates to accounts.google.com to check; if not logged in, performs login.
 * Call this before navigating to sites that use Google SSO.
 */
async function ensureGoogleLogin() {
  const email    = process.env.GOOGLE_EMAIL    || "";
  const password = process.env.GOOGLE_PASSWORD || "";
  if (!email || !password) {
    console.warn("[Chrome] GOOGLE_EMAIL / GOOGLE_PASSWORD not set — skipping auto-login");
    return false;
  }

  const page = await getPage("google_check");
  await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded", timeout: 20000 });

  // Already signed in — Google redirects to myaccount.google.com or shows the avatar
  const url = page.url();
  if (url.includes("myaccount.google.com") || url.includes("accounts.google.com/b/")) {
    console.log("[Chrome] Google already logged in");
    return true;
  }

  try {
    // Enter email
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.fill('input[type="email"]', email);
    await page.click('#identifierNext, [jsname="LgbsSe"]');

    // Enter password
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', password);
    await page.click('#passwordNext, [jsname="LgbsSe"]');

    // Wait for redirect to myaccount or 2-step prompt
    await page.waitForNavigation({ timeout: 20000 }).catch(() => {});
    console.log("[Chrome] Google login completed — URL:", page.url());
    return true;
  } catch (err) {
    console.error("[Chrome] Google login failed:", err.message);
    return false;
  }
}

// ── TradingView login ─────────────────────────────────────────────────────────

/**
 * Ensure TradingView is logged in via Google SSO.
 * Only runs the login flow if the current session is logged out.
 */
async function ensureTradingViewLogin() {
  const page = await getPage("tradingview");
  await page.goto("https://www.tradingview.com/", { waitUntil: "domcontentloaded", timeout: 20000 });

  // Check if already logged in — sign-in button absent = logged in
  const signInCount = await page.locator('button:has-text("Sign in"), [data-name="header-user-menu-sign-in"]').count().catch(() => 0);
  if (!signInCount) {
    console.log("[Chrome] TradingView already logged in");
    return true;
  }

  try {
    // Click Sign In button
    const signInBtn = page.locator('button:has-text("Sign in"), a:has-text("Sign in"), [data-name="header-user-menu-sign-in"]').first();
    await signInBtn.waitFor({ timeout: 10000 });
    await signInBtn.click();

    // Click "Continue with Google"
    const googleBtn = page.locator('button:has-text("Google"), [data-provider="google"], .tv-signin-dialog__social--google').first();
    await googleBtn.waitFor({ timeout: 8000 });
    await googleBtn.click();

    // Google OAuth popup — Playwright auto-handles popups as new pages
    const popup = await page.context().waitForEvent("page", { timeout: 15000 });
    await popup.waitForLoadState("domcontentloaded");

    // Select the account if Google shows account chooser
    const accountRow = popup.locator(`[data-email="${process.env.GOOGLE_EMAIL}"], div[data-identifier="${process.env.GOOGLE_EMAIL}"]`).first();
    if (await accountRow.count()) {
      await accountRow.click();
    } else {
      // Google shows sign-in form — fill credentials directly in the popup
      try {
        await popup.waitForSelector('input[type="email"]', { timeout: 8000 });
        await popup.fill('input[type="email"]', process.env.GOOGLE_EMAIL || "");
        await popup.click('#identifierNext, [jsname="LgbsSe"]');
        await popup.waitForSelector('input[type="password"]', { timeout: 8000 });
        await popup.fill('input[type="password"]', process.env.GOOGLE_PASSWORD || "");
        await popup.click('#passwordNext, [jsname="LgbsSe"]');
        console.log("[Chrome] Filled Google credentials in TV OAuth popup");
      } catch (e) {
        console.warn("[Chrome] Could not auto-fill Google popup:", e.message);
      }
    }

    await popup.waitForEvent("close", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log("[Chrome] TradingView login via Google completed");
    return true;
  } catch (err) {
    console.error("[Chrome] TradingView login failed:", err.message);
    return false;
  }
}

module.exports = {
  getContext,
  getPage,
  ensureGoogleLogin,
  ensureTradingViewLogin,
};
