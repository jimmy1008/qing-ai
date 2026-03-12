const { getContext, getPage: getChromePageByName } = require("../chrome/browser");

const THREADS_URL = "https://www.threads.com/";

// ── Login helpers ─────────────────────────────────────────────────────────────

async function isLoggedIn(page) {
  const loggedInSelectors = [
    "article",
    "nav",
    'a[href="/"]',
    'a[href*="/home"]',
    '[aria-label*="Home"]',
  ];
  for (const selector of loggedInSelectors) {
    try {
      if (await page.locator(selector).first().count()) return true;
    } catch { /* continue */ }
  }
  return false;
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if (await loc.count()) { await loc.click(); return true; }
    } catch { /* continue */ }
  }
  return false;
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if (await loc.count()) { await loc.fill(value); return true; }
    } catch { /* continue */ }
  }
  return false;
}

async function ensureThreadsLogin(page) {
  const email    = process.env.ACCOUNT_EMAIL    || "";
  const password = process.env.ACCOUNT_PASSWORD || "";

  if (!email || !password) {
    console.log("[THREADS] credentials missing; skip auto login");
    return { attempted: false, loggedIn: await isLoggedIn(page), reason: "missing_credentials" };
  }
  if (await isLoggedIn(page)) {
    console.log("[THREADS] already logged in");
    return { attempted: false, loggedIn: true, reason: "already_logged_in" };
  }

  console.log("[THREADS] login required; attempting auto login");

  await clickFirst(page, [
    'text=Log in', 'text=登入',
    'a:has-text("Log in")', 'button:has-text("Log in")', 'button:has-text("登入")',
    'text=Continue with Instagram', 'text=使用 Instagram 繼續',
  ]);
  await page.waitForTimeout(1500);

  await fillFirst(page, [
    'input[name="username"]', 'input[name="email"]',
    'input[autocomplete="username"]', 'input[type="text"]', 'input[type="email"]',
  ], email);

  await fillFirst(page, [
    'input[name="password"]', 'input[autocomplete="current-password"]', 'input[type="password"]',
  ], password);

  await clickFirst(page, [
    'button:has-text("Log in")', 'button:has-text("登入")',
    'div[role="button"]:has-text("Log in")', 'div[role="button"]:has-text("登入")',
  ]);

  try { await page.waitForLoadState("domcontentloaded", { timeout: 15000 }); } catch {}
  await page.waitForTimeout(3000);

  const loggedIn = await isLoggedIn(page);
  console.log(`[THREADS] auto login ${loggedIn ? "succeeded" : "not confirmed"}`);
  return { attempted: true, loggedIn, reason: loggedIn ? "login_success" : "login_unconfirmed" };
}

// ── Public API ────────────────────────────────────────────────────────────────

let _threadsInitDone = false;

async function getThreadsContext() {
  const ctx = await getContext();
  if (!_threadsInitDone) {
    _threadsInitDone = true;
    // Navigate main Threads tab and ensure login (non-blocking for callers)
    initThreadsPage().catch(err => console.error("[THREADS] init error:", err.message));
  }
  return ctx;
}

async function getNamedPage(name) {
  const page = await getChromePageByName(`threads_${name}`);
  return page;
}

// Called once at startup to open the Threads tab and ensure login
async function initThreadsPage() {
  const page = await getChromePageByName("threads_main");
  console.log("[THREADS] goto", THREADS_URL);
  await page.goto(THREADS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await ensureThreadsLogin(page);
  return page;
}

async function closeThreadsContext() {
  // No-op — unified Chrome context is shared; close from browser.js if needed
}

module.exports = {
  getThreadsContext,
  getNamedPage,
  closeThreadsContext,
  initThreadsPage,
};
