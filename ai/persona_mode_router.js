const { PERSONA_MODES } = require("./persona_modes");

function resolvePersonaMode(event = {}, identityMemory = null) {
  if (event.forcePersonaMode) return event.forcePersonaMode;
  if (event.meta?.forcePersonaMode) return event.meta.forcePersonaMode;

  const channel = event.channel || "public";

  if (identityMemory?.longTerm?.role === "developer") {
    if (channel === "private") return "developer_private_soft";
    if (channel === "group" || channel === "public") return "developer_public";
  }

  if (channel === "group") return "public_group_soft";
  return "public_user_public";
}

function pickPersonaMode(identity = {}, identityMemory = null, event = {}) {
  return resolvePersonaMode(
    {
      channel: event.channel || identity.channel || "public",
      forcePersonaMode: event.forcePersonaMode,
      meta: event.meta || {},
    },
    identityMemory,
  );
}

function getPersonaModeConfig(modeKey) {
  return PERSONA_MODES[modeKey] || PERSONA_MODES.public_user_public;
}

module.exports = { pickPersonaMode, getPersonaModeConfig, resolvePersonaMode };
