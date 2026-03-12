const path = require("path");
const { chromium } = require("playwright");

let persistentContext = null;
let launching = false;
const THREADS_URL = "https://www.threads.com/";

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
      if (await page.locator(selector).first().count()) {
        return true;
      }
    } catch {
      // ignore selector errors and continue probing
    }
  }

  return false;
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.click();
        return true;
      }
    } catch {
      // continue
    }
  }
  return false;
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.fill(value);
        return true;
      }
    } catch {
      // continue
    }
  }
  return false;
}

async function ensureThreadsLogin(page) {
  const email = process.env.ACCOUNT_EMAIL || "";
  const password = process.env.ACCOUNT_PASSWORD || "";

  if (!email || !password) {
    console.log("[THREADS EXECUTOR] credentials missing; skip auto login");
    return { attempted: false, loggedIn: await isLoggedIn(page), reason: "missing_credentials" };
  }

  if (await isLoggedIn(page)) {
    console.log("[THREADS EXECUTOR] already logged in");
    return { attempted: false, loggedIn: true, reason: "already_logged_in" };
  }

  console.log("[THREADS EXECUTOR] login required; attempting auto login");

  await clickFirst(page, [
    'text=Log in',
    'text=?�入',
    'a:has-text("Log in")',
    'button:has-text("Log in")',
    'button:has-text("?�入")',
    'text=Continue with Instagram',
    'text=使用 Instagram 繼�?',
  ]);

  await page.waitForTimeout(1500);

  await fillFirst(page, [
    'input[name="username"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
    'input[type="email"]',
  ], email);

  await fillFirst(page, [
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    'input[type="password"]',
  ], password);

  await clickFirst(page, [
    'button:has-text("Log in")',
    'button:has-text("?�入")',
    'div[role="button"]:has-text("Log in")',
    'div[role="button"]:has-text("?�入")',
  ]);

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  } catch {
    // continue and probe final state
  }

  await page.waitForTimeout(3000);

  const loggedIn = await isLoggedIn(page);
  console.log(`[THREADS EXECUTOR] auto login ${loggedIn ? "succeeded" : "not confirmed"}`);
  return {
    attempted: true,
    loggedIn,
    reason: loggedIn ? "login_success" : "login_unconfirmed",
  };
}

async function getThreadsContext() {
  if (persistentContext) return persistentContext;
  if (launching) {
    while (launching && !persistentContext) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return persistentContext;
  }

  launching = true;

  try {
    const userDataDir = path.join(__dirname, "threads_profile");
    console.log("[THREADS EXECUTOR] launch persistent browser");

    persistentContext = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      slowMo: 300,
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
      ],
      viewport: null,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });

    // Close any stale tabs left open from a previous crash
    const existingPages = persistentContext.pages();
    for (let i = existingPages.length - 1; i >= 1; i--) {
      await existingPages[i].close().catch(() => {});
    }

    const page = existingPages[0] || await persistentContext.newPage();
    console.log(`[THREADS EXECUTOR] goto ${THREADS_URL}`);
    await page.goto(THREADS_URL, { waitUntil: "domcontentloaded" });
    await ensureThreadsLogin(page);
    return persistentContext;
  } finally {
    launching = false;
  }
}

// Named persistent pages — opened once, never closed proactively.
const namedPages = {};

async function getNamedPage(name) {
  const context = await getThreadsContext();
  if (namedPages[name] && !namedPages[name].isClosed()) {
    return namedPages[name];
  }
  const page = await context.newPage();
  namedPages[name] = page;
  return page;
}

async function closeThreadsContext() {
  if (!persistentContext) return;
  await persistentContext.close();
  persistentContext = null;
}

module.exports = {
  getThreadsContext,
  getNamedPage,
  closeThreadsContext,
};
