const { ROLE_SUPERADMIN, ROLE_MODERATOR } = require("./roles");

function buildTeamTokens() {
  const mapping = {};
  if (process.env.SUPERADMIN_TOKEN) {
    mapping[process.env.SUPERADMIN_TOKEN] = ROLE_SUPERADMIN;
  }
  if (process.env.MODERATOR_TOKEN_1) {
    mapping[process.env.MODERATOR_TOKEN_1] = ROLE_MODERATOR;
  }
  if (process.env.MODERATOR_TOKEN_2) {
    mapping[process.env.MODERATOR_TOKEN_2] = ROLE_MODERATOR;
  }
  return mapping;
}

function requireAuth(req, res, next) {
  const token = req.headers["x-team-token"] || req.query?.teamToken;
  const role = buildTeamTokens()[token];

  if (!role) {
    return res.status(403).json({ error: "Unauthorized — token invalid" });
  }

  req.userRole = role;
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (req.userRole !== ROLE_SUPERADMIN) {
    return res.status(403).json({ error: "Forbidden — superadmin required" });
  }
  return next();
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
};
