"use strict";

function addIdentity(target, user = {}) {
  const id = String(user.senderId || user.userId || user.fromId || "").trim();
  if (!id) return;
  if (!target[id]) {
    target[id] = {
      id,
      name: user.senderName || user.username || user.firstName || user.name || "unknown",
      role: user.role || "user",
    };
    return;
  }
  if (!target[id].name || target[id].name === "unknown") {
    target[id].name = user.senderName || user.username || user.firstName || user.name || target[id].name;
  }
  if (user.role && target[id].role !== "developer") {
    target[id].role = user.role;
  }
}

function buildIdentityMap({ event = {}, history = [], role = "public_user" } = {}) {
  const map = {};
  addIdentity(map, {
    senderId: event.userId || event.senderId || event.fromId,
    senderName: event.senderName || event.username || event.firstName,
    username: event.username,
    firstName: event.firstName,
    role: role === "developer" ? "developer" : "user",
  });

  for (const msg of history || []) {
    addIdentity(map, msg);
  }

  return map;
}

function buildParticipantsBlock(identityMap = {}) {
  const users = Object.values(identityMap);
  if (users.length === 0) return "";
  const lines = [
    "[Participants]",
    ...users.map((u, idx) => `User ${idx + 1}: ${u.name} (id:${u.id}, role:${u.role})`),
    "Each speaker is a different person. Never merge identities.",
  ];
  return lines.join("\n");
}

module.exports = {
  buildIdentityMap,
  buildParticipantsBlock,
};

