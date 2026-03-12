const DEV_TELEGRAM_ID = Number(process.env.DEV_TELEGRAM_ID || 5686223888);
const DEV_USERNAME = process.env.DEV_USERNAME || "driven09";

module.exports = {
  telegram: {
    ids: [DEV_TELEGRAM_ID],
  },
  threads: {
    ids: [],
  },
  profile: {
    [DEV_TELEGRAM_ID]: {
      username: DEV_USERNAME,
      firstName: "\u5148\u5929\u8ce3\u98db\u8056\u9ad4",
      lastName: "\u4e00\u6a2a",
      language: "zh-hant",
    },
  },
};
