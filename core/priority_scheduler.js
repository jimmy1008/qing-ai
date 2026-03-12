const PRIORITY_MAP = {
  NEW_DM: 100,
  NEW_COMMENT_ON_OWN_POST: 80,
  MENTION: 70,
  NEW_COMMENT_ON_EXTERNAL_POST: 60,
  NEW_POST_IN_FEED: 40,
};

const COOLDOWN = {
  NEW_POST_IN_FEED: [5, 20],
  NEW_COMMENT_ON_OWN_POST: [1, 3],
  NEW_COMMENT_ON_EXTERNAL_POST: [2, 5],
  NEW_DM: [0, 0],
  MENTION: [0, 1],
};

function getCooldown(type) {
  const [min, max] = COOLDOWN[type] || [0, 0];
  if (min === 0 && max === 0) return 0;
  const minutes = Math.random() * (max - min) + min;
  return Math.round(minutes * 60 * 1000);
}

class PriorityScheduler {
  constructor() {
    this.queue = [];
  }

  sortQueue() {
    this.queue.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.timestamp - b.timestamp;
    });
  }

  enqueue(event, options = {}) {
    const now = options.now || Date.now();
    const priority = PRIORITY_MAP[event.type] || 0;
    const cooldownMs = options.skipCooldown ? 0 : getCooldown(event.type);

    const item = {
      ...event,
      priority,
      timestamp: event.timestamp || now,
      nextAvailableAt: options.nextAvailableAt || now + cooldownMs,
      cooldownMs,
    };

    this.queue.push(item);
    this.sortQueue();
    return item;
  }

  nextReady(now = Date.now()) {
    this.sortQueue();
    const index = this.queue.findIndex((item) => item.nextAvailableAt <= now);
    if (index === -1) return null;
    return this.queue.splice(index, 1)[0];
  }

  next(now = Date.now()) {
    return this.nextReady(now);
  }

  hasPending(now = Date.now()) {
    return this.queue.some((item) => item.nextAvailableAt <= now);
  }

  getQueue() {
    return [...this.queue];
  }

  reset() {
    this.queue = [];
  }
}

module.exports = {
  PRIORITY_MAP,
  COOLDOWN,
  getCooldown,
  PriorityScheduler,
  scheduler: new PriorityScheduler(),
};
