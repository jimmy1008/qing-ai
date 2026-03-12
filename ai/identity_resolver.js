const developerConfig = require("../config/developer_config");

function resolveIdentity(event = {}) {
  const connector = event.connector || "unknown";
  const userId = event.userId || event.fromId || event.senderId || null;
  const username = event.username || event.handle || null;
  const firstName = event.firstName || event.first_name || null;
  const lastName = event.lastName || event.last_name || null;
  const languageCode = event.languageCode || event.language_code || null;

  let channel = "public";
  if (event.channel === "public" || event.channel === "private" || event.channel === "group") {
    channel = event.channel;
  } else if (event.isPrivate) {
    channel = "private";
  }

  if (channel === "private" && connector !== "telegram" && connector !== "threads_dm") {
    channel = "public";
  }

  const developerProfiles = developerConfig.profile || {};
  const configuredProfile = userId ? developerProfiles[String(userId)] || null : null;

  return {
    userId,
    username: configuredProfile?.username || username,
    firstName: configuredProfile?.firstName || firstName,
    lastName: configuredProfile?.lastName || lastName,
    languageCode: configuredProfile?.language || languageCode,
    role: "public_user",
    channel,
    connector,
    developerProfile: configuredProfile,
  };
}

module.exports = { resolveIdentity };
