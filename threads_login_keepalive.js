const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const userDataDir = path.join(
    __dirname,
    "connectors",
    "threads_browser",
    "threads_profile"
  );

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 300,
    args: [
      "--window-position=3072,191",
      "--window-size=1536,816",
      "--disable-blink-features=AutomationControlled"
    ],
    viewport: { width: 1536, height: 816 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto("https://www.threads.net/", { waitUntil: "domcontentloaded" });
  console.log("[THREADS LOGIN] persistent browser opened on secondary display");

  context.on("close", () => {
    process.exit(0);
  });
})();
