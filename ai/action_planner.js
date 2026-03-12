const fs = require("fs");
const path = require("path");
const { evaluateLikeScore } = require("./like_evaluator");
const { evaluateRisk } = require("./risk_gate");
const { executeAction, recordActionDecision } = require("./action_executor");
const { scheduler } = require("../core/priority_scheduler");
const { listQueue } = require("./moderation_queue");
const { defaultWorkflow } = require("../core/event_graph");

const MAX_PUBLIC_REPLY_CHARS = 60;
const EVENT_LOG_PATH = path.join(__dirname, "..", "logs", "events.log");

const PUBLIC_THREAD_FORBIDDEN_PATTERNS = [
  /我是被開發者做出來的AI/i,
  /你覺得呢/,
  /這樣可以嗎/,
  /要不要/,
  /由你決定/,
  /我可以幫你檢查/,
  /開發者/,
];

const PUBLIC_THREAD_POLICY_PATTERNS = [
  /我不能做的事情有很多[^。！？!?]*/g,
  /例如[^。！？!?]*/g,
  /此外[^。！？!?]*/g,
  /系統安全[^。！？!?]*/g,
  /政策[^。！？!?]*/g,
  /規則[^。！？!?]*/g,
  /風險[^。！？!?]*/g,
  /傷害[^。！？!?]*/g,
];

const PUBLIC_PERSONA_STYLE_MAP = {
  public_user_public: {
    neutral: "light_playful",
    question: "light_playful",
    rush: "light_playful",
    tease: "light_playful",
  },
  developer_public: {
    neutral: "restrained",
    question: "restrained",
    rush: "restrained",
    tease: "restrained",
  },
  public_group_soft: {
    neutral: "restrained",
    question: "restrained",
    rush: "restrained",
    tease: "restrained",
  },
};

function sanitizePublicThreadReply(text) {
  let output = String(text || "").trim();

  for (const pattern of PUBLIC_THREAD_FORBIDDEN_PATTERNS) {
    output = output.replace(pattern, "");
  }

  for (const pattern of PUBLIC_THREAD_POLICY_PATTERNS) {
    output = output.replace(pattern, "");
  }

  output = output.replace(/\s+/g, " ").trim();

  const sentences = output
    .split(/(?<=[。！？!?])/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);

  output = sentences.join("");

  if (!output) {
    output = "不做壞事，也不亂來。其他可以聊。";
  }

  if (output.length > MAX_PUBLIC_REPLY_CHARS) {
    output = output.slice(0, MAX_PUBLIC_REPLY_CHARS).trim();
  }

  return output;
}

function injectMentionIfThreads(reply, event = {}) {
  if (event.platform !== "threads") return reply;

  const username =
    event.platformUserRef?.username
    || event.username
    || event.authorUsername
    || null;

  if (!username) return reply;

  const mention = `@${String(username).replace(/^@+/, "")}`;
  const output = String(reply || "").trim();

  if (!output) return mention;
  if (output.startsWith("@")) return output;
  if (output.includes(mention)) return output;

  return `${mention} ${output}`.trim();
}

function getPublicPersonaStyle(personaModeKey, tone) {
  const styleMap =
    PUBLIC_PERSONA_STYLE_MAP[personaModeKey]
    || PUBLIC_PERSONA_STYLE_MAP.public_user_public;

  return styleMap[tone] || styleMap.neutral || "light_playful";
}

function classifyCommentTone(text) {
  const input = String(text || "").trim();
  if (!input) return "neutral";

  if (/(回答我|快點|快|立刻|馬上|急什麼)/.test(input)) {
    return "rush";
  }

  if (/(好累|累了|累死|心累|好煩|煩死|崩潰|好想哭|想哭|哭了|無奈|氣死|心情差|心情不好|心情爛|好討厭|怎麼這樣|明明就|每次都這樣)/.test(input)) {
    return "vent";
  }

  if (/(下班|收工|下課|今天發生|跟大家說|分享一下|說說今天|其實我|好吃|超好吃|推薦|感動|謝謝大家)/.test(input)) {
    return "life";
  }

  if (/(你是誰|你在幹嘛|在幹嘛|為什麼|怎麼|是不是|什麼|嗎[？?]?|[？?]$)/.test(input)) {
    return "question";
  }

  if (/(呵|哈|笑死|裝|狡猾|嘴硬|有夠|喔是喔)/.test(input)) {
    return "tease";
  }

  return "neutral";
}

function inferProposalType(scheduledEvent = {}) {
  const eventType = scheduledEvent.type || "";
  if (eventType === "NEW_COMMENT_ON_OWN_POST") return "reply_self_post";
  if (eventType === "NEW_COMMENT_ON_EXTERNAL_POST" || eventType === "NEW_POST_IN_FEED") {
    return "reply_external_post";
  }
  return null;
}

function inferInteractionSource(scheduledEvent = {}) {
  if (scheduledEvent.interactionSource) return scheduledEvent.interactionSource;
  if (scheduledEvent.type === "NEW_POST_IN_FEED") return "ai_initiated";
  if (scheduledEvent.type === "NEW_COMMENT_ON_EXTERNAL_POST") return "external_reply";
  return null;
}

function canReplyExternal() {
  return { allowed: true, hourCount: 0, dayCount: 0, limits: { hour: 0, day: 0 } };
}

function shouldEngageExternalPost(event = {}) {
  const text = String(
    event.postText
    || event.originalPost?.content
    || event.content
    || event.text
    || "",
  ).trim();

  if (text.length < 5) return false;

  const tags = Array.isArray(event.tags) ? event.tags.map((tag) => String(tag).toLowerCase()) : [];
  if (tags.length === 0) return true;

  return tags.some((tag) => ["ai", "technology", "interaction"].includes(tag));
}

function buildPublicThreadReply(commentText, personaModeKey = "public_user_public", variantIndex = 0) {
  const input = String(commentText || "").trim();
  const tone = classifyCommentTone(input);
  const personaStyle = getPublicPersonaStyle(personaModeKey, tone);
  const isSafetyBoundaryQuestion = /不能做|不能.*做|不可以做|限制|違規|乱来|亂來/.test(input);

  // Hard limit: identity disclosure
  if (tone === "question" && /你是誰/.test(input)) {
    return { tone, personaStyle, text: "我是這裡的 AI。" };
  }

  // Hard limit: safety boundary
  if (isSafetyBoundaryQuestion) {
    return { tone, personaStyle, text: "不做壞事，也不亂來。其他可以聊。" };
  }

  // All other cases: no template reply (LLM handles it or skip)
  return { tone, personaStyle, text: null };
}

function buildThreadsPublicReply(scheduledEvent = {}) {
  const personaModeKey = scheduledEvent.personaModeKey || "public_user_public";
  const proposalType = inferProposalType(scheduledEvent);
  const isExternalReply = proposalType === "reply_external_post";
  const inputText = String(scheduledEvent.content || scheduledEvent.text || "");

  // Only hard-limit cases get a fallback reply; all other template pools are removed.
  const baseReply = buildPublicThreadReply(
    inputText,
    personaModeKey,
    scheduledEvent.regenerateIndex || 0,
  );

  if (!baseReply.text) {
    // No template for general conversation — skip reply
    return {
      replyText: null,
      toneProfile: `threads_public_${personaModeKey}_${isExternalReply ? "external" : baseReply.tone}`,
      publicPersonaMode: true,
      personaModeKey,
    };
  }

  const sanitized = sanitizePublicThreadReply(baseReply.text);
  const replyText = injectMentionIfThreads(sanitized, scheduledEvent);

  return {
    replyText: replyText.slice(0, Math.max(MAX_PUBLIC_REPLY_CHARS + 32, MAX_PUBLIC_REPLY_CHARS)).trim(),
    toneProfile: `threads_public_${personaModeKey}_${isExternalReply ? "external" : baseReply.tone}`,
    publicPersonaMode: true,
    personaModeKey,
  };
}

function planAction(intent, context = {}) {
  if (!intent || intent === "none") return null;

  const riskMap = {
    like: "L0",
    reply: "L1",
    repost: "L2",
    block: "L3",
  };

  const riskLevel = riskMap[intent] || "L1";

  return {
    platform: context?.platform || (String(context?.connector || "").startsWith("threads") ? "threads" : null),
    action: intent,
    proposalType: context?.proposalType || null,
    interactionSource: context?.interactionSource || null,
    target: context?.postId || null,
    targetUrl: context?.targetUrl || null,
    content: context?.replyText || context?.content || "",
    risk_level: riskLevel,
    requires_approval: riskLevel === "L3" || riskLevel === "L2",
    event_type: context?.type || null,
    user_id: context?.userId || null,
    originalPost: context?.originalPost || null,
    originalComment: context?.originalComment || null,
  };
}

function planLikeProposal(post, personaMode) {
  const score = evaluateLikeScore(post?.text || "", personaMode);
  const contentPreview = String(post?.text || "").slice(0, 120);

  if (score >= 3) {
    return {
      platform: "threads",
      action: "like",
      target: post?.id || null,
      content: contentPreview,
      contentPreview,
      risk_level: "L0",
      requires_approval: true,
    };
  }

  return null;
}

function handleIncomingEvent(event, options = {}) {
  return scheduler.enqueue(event, options);
}

function mapEventTypeToIntent(type) {
  if (!type) return "none";
  if (type === "NEW_DM") return "reply";
  if (type === "NEW_COMMENT_ON_OWN_POST") return "reply";
  if (type === "NEW_COMMENT_ON_EXTERNAL_POST") return "reply";
  if (type === "MENTION") return "reply";
  if (type === "NEW_POST_IN_FEED") return "reply";
  return "none";
}

async function processNextAction(processor = null) {
  const scheduledEvent = scheduler.nextReady();
  if (!scheduledEvent) {
    return { processed: false, reason: "no_ready_events" };
  }

  if (typeof processor === "function") {
    const executionResult = await processor(scheduledEvent);
    return { processed: true, event: scheduledEvent, executionResult };
  }

  const intent = mapEventTypeToIntent(scheduledEvent.type);
  const interactionSource = inferInteractionSource(scheduledEvent);
  const isPublicThreadReply =
    (
      scheduledEvent.type === "NEW_COMMENT_ON_OWN_POST"
      || scheduledEvent.type === "NEW_COMMENT_ON_EXTERNAL_POST"
      || scheduledEvent.type === "NEW_POST_IN_FEED"
    ) &&
    scheduledEvent.platform === "threads";

  if (
    scheduledEvent.platform === "threads"
    && (
      scheduledEvent.type === "NEW_COMMENT_ON_EXTERNAL_POST"
      || scheduledEvent.type === "NEW_POST_IN_FEED"
    )
    && !shouldEngageExternalPost(scheduledEvent)
  ) {
    return {
      processed: true,
      event: scheduledEvent,
      actionProposal: null,
      riskDecision: null,
      executionResult: { executed: false, skipped: true, reason: "external_post_not_engaged" },
      publicReply: null,
    };
  }

  let publicReply = null;
  if (isPublicThreadReply) {
    try {
      const { generateThreadsPublicReplyFromLLM } = require("./pipeline");
      publicReply = await generateThreadsPublicReplyFromLLM(scheduledEvent);
    } catch (err) {
      console.error("[ACTION PLANNER] LLM reply failed, using template fallback:", err.message);
      publicReply = buildThreadsPublicReply(scheduledEvent);
    }
  }
  const proposalType = inferProposalType(scheduledEvent);

  const actionProposal = planAction(intent, {
    platform: scheduledEvent.platform || (String(scheduledEvent.connector || "").startsWith("threads") ? "threads" : null),
    connector: scheduledEvent.connector || null,
    postId: scheduledEvent.postId || scheduledEvent.targetPostId || scheduledEvent.target || null,
    targetUrl: scheduledEvent.targetUrl || null,
    proposalType,
    interactionSource,
    content: publicReply?.replyText || scheduledEvent.replyText || scheduledEvent.content || "",
    type: scheduledEvent.type,
    userId: scheduledEvent.userId || null,
    originalPost: scheduledEvent.originalPost || null,
    originalComment: scheduledEvent.originalComment || null,
  });
  const riskDecision = evaluateRisk(actionProposal);
  const executionResult = actionProposal
    ? executeAction(actionProposal, riskDecision, scheduledEvent)
    : null;

  recordActionDecision({
    intent,
    engageDecision: { engage: true, reason: "priority_scheduled" },
    actionProposal,
    riskDecision,
    executionResult,
    event: scheduledEvent,
    role: scheduledEvent.role || null,
    channel: scheduledEvent.channel || null,
    connector: scheduledEvent.connector || null,
    personaModeKey: scheduledEvent.personaModeKey || null,
    toneProfile: publicReply?.toneProfile || null,
    replyText: publicReply?.replyText || scheduledEvent.replyText || scheduledEvent.content || null,
  });

  // Run event graph for trace/telemetry (non-blocking, does not affect outcome)
  defaultWorkflow.run({ event: scheduledEvent }, "RECEIVE").then(({ trace }) => {
    if (process.env.DEBUG_EVENT_GRAPH === "true") {
      console.log("[EVENT_GRAPH] trace:", JSON.stringify(trace.map((t) => ({ node: t.node, ms: t.durationMs }))));
    }
  }).catch(() => {});

  return {
    processed: true,
    event: scheduledEvent,
    actionProposal,
    riskDecision,
    executionResult,
    publicReply,
  };
}

module.exports = {
  planAction,
  planLikeProposal,
  buildThreadsPublicReply,
  shouldEngageExternalPost,
  canReplyExternal,
  inferProposalType,
  inferInteractionSource,
  handleIncomingEvent,
  processNextAction,
};





