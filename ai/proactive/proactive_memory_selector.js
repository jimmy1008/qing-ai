"use strict";

function sameMonthDay(ts, nowTs) {
  const a = new Date(ts);
  const b = new Date(nowTs);
  return a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function selectProactiveCandidates(globalUserKey, episodes = [], nowTs = Date.now()) {
  const safe = episodes.filter((e) => e && e.summary);

  const anniversary = safe
    .filter((e) => e.created_at && sameMonthDay(e.created_at, nowTs) && nowTs - e.created_at > 300 * 24 * 60 * 60 * 1000)
    .slice(0, 3);

  const followups = safe
    .filter((e) => /下次|之後|待辦|想要|計畫|follow|追蹤/i.test(String(e.summary || "")))
    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
    .slice(0, 3);

  const milestoneRecalls = safe
    .filter((e) => Number(e.importance || 0) >= 0.8)
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
    .slice(0, 3);

  return { globalUserKey, anniversary, followups, milestoneRecalls };
}

module.exports = { selectProactiveCandidates };
