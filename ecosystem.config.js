// pm2 ecosystem — 4 independent processes
// Usage:
//   pm2 start ecosystem.config.js          (start all)
//   pm2 restart ecosystem.config.js        (restart all)
//   pm2 delete ecosystem.config.js         (stop + remove all)
//   pm2 logs social-ai-telegram            (single process logs)

module.exports = {
  apps: [
    // ── Core: Express dashboard + trading scheduler ───────────────────────
    {
      name:        "social-ai",
      script:      "./server.js",
      cwd:         __dirname,
      env_file:    ".env",
      max_memory_restart: "600M",
      restart_delay: 3000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },

    // ── Telegram bot + proactive scheduler ───────────────────────────────
    {
      name:        "social-ai-telegram",
      script:      "./connectors/telegram/start.js",
      cwd:         __dirname,
      env_file:    ".env",
      max_memory_restart: "400M",
      restart_delay: 5000,       // longer delay to avoid Telegram flood limits on restart
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },

    // ── Discord selfbot ───────────────────────────────────────────────────
    {
      name:        "social-ai-discord",
      script:      "./connectors/discord/start.js",
      cwd:         __dirname,
      env_file:    ".env",
      max_memory_restart: "300M",
      restart_delay: 5000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
