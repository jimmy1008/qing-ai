/**
 * TG Notifier — send-only Telegram client for system alerts.
 * Does NOT use polling (won't conflict with bot.js).
 */
const TelegramBot = require("node-telegram-bot-api");

let _client = null;

function getClient() {
  if (!_client && process.env.TG_TOKEN) {
    _client = new TelegramBot(process.env.TG_TOKEN);
  }
  return _client;
}

async function notifySuperAdmin(text) {
  const chatId = process.env.SUPERADMIN_TG_CHAT_ID;
  if (!chatId) {
    console.warn("[NOTIFIER] SUPERADMIN_TG_CHAT_ID not set — L3 notification skipped");
    return;
  }
  const client = getClient();
  if (!client) {
    console.warn("[NOTIFIER] TG_TOKEN not set — L3 notification skipped");
    return;
  }
  try {
    await client.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[NOTIFIER] Failed to send TG notification:", err.message);
  }
}

module.exports = { notifySuperAdmin };
