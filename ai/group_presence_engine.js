const GROUP_THRESHOLD = 0.7;
const GROUP_COOLDOWN_MS = 30000;

const groupStates = new Map();

function getChatId(event = {}) {
  return event.chatId || event.chat?.id || event.groupId || "default-group";
}

function ensureState(chatId) {
  if (!groupStates.has(chatId)) {
    groupStates.set(chatId, {
      lastSpeakerId: null,
      consecutiveMessagesFromSameUser: 0,
      lastGroupReplyTime: 0,
      recentSpeakers: [],
      recentUniqueSpeakersCount: 0,
      lastNMessages: [],
    });
  }
  return groupStates.get(chatId);
}

function observeGroupMessage(event = {}) {
  const chatId = getChatId(event);
  const state = ensureState(chatId);
  const speakerId = event.userId || event.fromId || event.senderId || "unknown";
  const speakerName =
    event.senderName
    || event.username
    || event.firstName
    || event.authorUsername
    || "unknown";
  const text = String(event.content || event.text || "").trim();

  if (state.lastSpeakerId === speakerId) {
    state.consecutiveMessagesFromSameUser += 1;
  } else {
    state.lastSpeakerId = speakerId;
    state.consecutiveMessagesFromSameUser = 1;
  }

  state.recentSpeakers.push(speakerId);
  if (state.recentSpeakers.length > 3) {
    state.recentSpeakers.shift();
  }

  state.recentUniqueSpeakersCount = new Set(state.recentSpeakers).size;

  state.lastNMessages.push({
    ts: Date.now(),
    speakerId,
    speakerName,
    text,
  });
  if (state.lastNMessages.length > 10) {
    state.lastNMessages.shift();
  }

  return state;
}

function calculatePresenceScore(event = {}, groupState = ensureState(getChatId(event))) {
  let score = 0;
  const now = Date.now();

  if (groupState.consecutiveMessagesFromSameUser >= 2) {
    score += 0.4;
  }

  if (groupState.recentUniqueSpeakersCount === 1) {
    score += 0.2;
  }

  if (now - groupState.lastGroupReplyTime > 60000) {
    score += 0.3;
  }

  if (groupState.recentUniqueSpeakersCount >= 3) {
    score -= 0.5;
  }

  if (event.isDirectMention || event.mentionDetected) {
    score = 1;
  }

  return Number(score.toFixed(3));
}

function canReplyToGroup(event = {}, groupState = ensureState(getChatId(event))) {
  return Date.now() - groupState.lastGroupReplyTime >= GROUP_COOLDOWN_MS;
}

function markGroupReplySent(event = {}) {
  const chatId = getChatId(event);
  const state = ensureState(chatId);
  state.lastGroupReplyTime = Date.now();
  return state;
}

function getGroupState(chatId) {
  return groupStates.get(String(chatId || "")) || null;
}

module.exports = {
  GROUP_THRESHOLD,
  GROUP_COOLDOWN_MS,
  observeGroupMessage,
  calculatePresenceScore,
  canReplyToGroup,
  markGroupReplySent,
  getGroupState,
};
