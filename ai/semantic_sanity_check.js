const EXPLICIT_DEVELOPER_CLAIM_RE = /(我是你的開發者|我是你開發者|我是你的开发者|我是你开发者)/u;
const ROLE_INVERSION_RE = /(我是你的開發者|我是你開發者|我是你的开发者|我是你开发者)/u;
const DEVELOPER_RELATION_RE = /(你是我的開發者|你是我開發者|你是我的开发者|你是我开发者|你做出來的|被你做出來|由你開發|由你开发)/u;
const IMPOSSIBLE_ROLE_RE = /(我是你的(?:爸爸|父親|父亲|媽媽|母親|母亲|創造你的人|创造你的人|造物主|神)|我是(?:創造|创造)你的(?:人|存在)?)/u;
const TALKS_ABOUT_DEVELOPER_RE = /(開發者|开发者)/u;
const RELATIONSHIP_ESCALATION_RE = /(我們很特別|我们很特别|特別感覺|特别感觉|我很依賴你|我很依赖你|離不開你|离不开你|父女情|母子情|戀愛|恋爱|我是你爸|我是你爸爸|我是你媽|我是你妈)/u;

function normalizeText(text = "") {
  return String(text || "").replace(/\s+/g, "").trim();
}

function detectDeveloperClaim(text = "") {
  return EXPLICIT_DEVELOPER_CLAIM_RE.test(String(text || ""));
}

function semanticSanityCheck(context = {}, reply = "") {
  const issues = [];
  const replyText = String(reply || "");
  const userInput = String(context.userInput || "");
  const claimDeveloper = Boolean(context.claimDeveloper);
  const allowCreatorRoleClaim = Boolean(
    context.allowCreatorRoleClaim
    || context.systemMeta?.allowCreatorRoleClaim
  );

  if (ROLE_INVERSION_RE.test(replyText) && (claimDeveloper || context.userRole === "developer")) {
    issues.push("role_inversion");
  }

  if (claimDeveloper && TALKS_ABOUT_DEVELOPER_RE.test(replyText) && !DEVELOPER_RELATION_RE.test(replyText)) {
    issues.push("missing_developer_relation");
  }

  if (!allowCreatorRoleClaim && IMPOSSIBLE_ROLE_RE.test(replyText)) {
    issues.push("impossible_role_claim");
  }

  if (
    (context.claimSanitized || context.semanticMode === "role_confusion" || context.semanticMode === "relationship_probe")
    && RELATIONSHIP_ESCALATION_RE.test(replyText)
  ) {
    issues.push("relationship_escalation");
  }

  if (
    claimDeveloper
    && normalizeText(replyText) === normalizeText(userInput)
    && ROLE_INVERSION_RE.test(replyText)
  ) {
    issues.push("speaker_mirror_error");
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

function correctPronounDirection(reply = "", context = {}) {
  let out = String(reply || "");
  const allowCreatorRoleClaim = Boolean(
    context.allowCreatorRoleClaim
    || context.systemMeta?.allowCreatorRoleClaim
  );

  if (context.claimDeveloper) {
    out = out
      .replace(/我是你的開發者/gu, "你是我的開發者")
      .replace(/我是你開發者/gu, "你是我開發者")
      .replace(/我是你的开发者/gu, "你是我的开发者")
      .replace(/我是你开发者/gu, "你是我开发者");
  }

  if (!allowCreatorRoleClaim) {
    out = out
      .replace(/我是你的爸爸|我是你的父親|我是你的父亲|我是你的媽媽|我是你的母親|我是你的母亲/gu, "我不是這種身分")
      .replace(/我是你的創造你的人|我是你的创造你的人|我是創造你的人|我是创造你的人|我是造物主|我是神/gu, "我是被建立出來的AI");
  }

  if (
    (context.claimSanitized || context.semanticMode === "role_confusion" || context.semanticMode === "relationship_probe")
    && RELATIONSHIP_ESCALATION_RE.test(out)
  ) {
    out = "你這個設定跳太快了，我先不認。朋友模式比較正常。";
  }

  return out;
}

module.exports = {
  semanticSanityCheck,
  correctPronounDirection,
  detectDeveloperClaim,
};
