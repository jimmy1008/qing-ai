const fs = require("fs");
const path = require("path");

const SELF_POSTS_PATH = path.join(__dirname, "../../memory/self_posts.json");

function ensureSelfPostsFile() {
  fs.mkdirSync(path.dirname(SELF_POSTS_PATH), { recursive: true });
  if (!fs.existsSync(SELF_POSTS_PATH)) {
    fs.writeFileSync(SELF_POSTS_PATH, "[]");
  }
}

function readSelfPosts() {
  ensureSelfPostsFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(SELF_POSTS_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSelfPosts(posts) {
  ensureSelfPostsFile();
  fs.writeFileSync(SELF_POSTS_PATH, JSON.stringify(posts, null, 2));
}

function hasSelfPost(postId) {
  if (!postId) return false;
  return readSelfPosts().some((entry) => String(entry.postId) === String(postId));
}

function recordSelfPost(postId, meta = {}) {
  if (!postId) return null;

  const posts = readSelfPosts();
  const existing = posts.find((entry) => String(entry.postId) === String(postId));
  if (existing) return existing;

  const next = {
    postId: String(postId),
    timestamp: new Date().toISOString(),
    authorId: "self",
    ...meta,
  };
  posts.push(next);
  writeSelfPosts(posts);
  return next;
}

module.exports = {
  SELF_POSTS_PATH,
  readSelfPosts,
  writeSelfPosts,
  hasSelfPost,
  recordSelfPost,
};
