"use strict";

const MILESTONE_THRESHOLD = Number(process.env.EPISODIC_MILESTONE_THRESHOLD || 0.8);
const DEFAULT_CAPS = {
  milestone: Number(process.env.EPISODIC_MILESTONE_CAP || 50),
  normal: Number(process.env.EPISODIC_NORMAL_CAP || 150),
};

function splitByTier(episodes = []) {
  const milestone = [];
  const normal = [];
  for (const ep of episodes) {
    if (Number(ep.importance || 0) >= MILESTONE_THRESHOLD) milestone.push(ep);
    else normal.push(ep);
  }
  return { milestone, normal };
}

function rankEpisodes(a, b) {
  const imp = (Number(b.importance || 0) - Number(a.importance || 0));
  if (imp !== 0) return imp;
  return Number(b.created_at || 0) - Number(a.created_at || 0);
}

function enforceTierCaps({ milestone = [], normal = [] }, caps = DEFAULT_CAPS) {
  const ms = [...milestone].sort(rankEpisodes);
  const nm = [...normal].sort(rankEpisodes);

  const dropped = {
    milestone: Math.max(ms.length - caps.milestone, 0),
    normal: Math.max(nm.length - caps.normal, 0),
  };

  return {
    milestone: ms.slice(0, caps.milestone),
    normal: nm.slice(0, caps.normal),
    dropped,
  };
}

module.exports = {
  MILESTONE_THRESHOLD,
  DEFAULT_CAPS,
  splitByTier,
  enforceTierCaps,
};
