let lastScrollAt = null;
let currentDriveValue = 0;

function getMoodFactor(mood) {
  switch (mood) {
    case "PLAYFUL":
      return 5;
    case "CURIOUS":
      return 3;
    case "CALM":
      return 1;
    case "TIRED":
      return -4;
    default:
      return 0;
  }
}

function computeDrive(context = {}) {
  const now = Date.now();

  const minutesSinceLastScroll = lastScrollAt
    ? (now - lastScrollAt) / 60000
    : 60;

  const idleFactor = Math.min(minutesSinceLastScroll * 0.3, 15);
  const moodFactor = getMoodFactor(context.mood);
  const silenceFactor = context.isChatSilent ? 4 : -3;
  const boredomFactor = (context.unansweredInitiations || 0) >= 2 ? 5 : 0;

  currentDriveValue = idleFactor + moodFactor + silenceFactor + boredomFactor;
  return currentDriveValue;
}

function markScrolled() {
  lastScrollAt = Date.now();
}

function getLastScrollAt() {
  return lastScrollAt;
}

function getCurrentDriveValue() {
  return currentDriveValue;
}

module.exports = {
  computeDrive,
  markScrolled,
  getLastScrollAt,
  getCurrentDriveValue,
};
