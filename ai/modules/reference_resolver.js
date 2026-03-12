"use strict";
// Module 3: reference_resolver
// Resolves pronouns (我/你/他/她/開發者) and detects identity claims.
// Pure rule-based — no LLM needed. Designed to catch the most common bugs:
//   · User says "我是你開發者" → AI mistakenly echoes back "我是你的開發者"
//   · In group chat: 他/她 misattributed to current speaker
//   · Developer impersonation (unverified claim)
//
// referenceResult schema:
// {
//   speaker_id: string,
//   speaker_actual_role: "developer"|"private_user"|"group_member",
//   addressed_to: "ai"|"group"|"mentioned_user",
//   pronoun_map: { [pronoun]: string },
//   relationship_frame: { speaker_to_ai, ai_to_speaker },
//   identity_claims: [{ type, verified, raw }],
//   role_confusion_risk: [{ type, severity, description }],
//   confidence: number,
// }

const developerConfig = require("../../config/developer_config");

function resolveReferences(contextPacket, intentResult) {
  const { speaker, current_message, scene, meta, recent_messages } = contextPacket;
  const text = current_message.text;

  const speakerActualRole  = resolveSpeakerRole(speaker, meta);
  const pronounMap         = buildPronounMap(text, speaker, speakerActualRole, scene, current_message, recent_messages);
  const identityClaims     = detectIdentityClaims(text, speakerActualRole);
  const relationshipFrame  = buildRelationshipFrame(speakerActualRole, scene);
  const roleConfusionRisk  = detectRoleConfusionRisk(text, identityClaims);
  const addressedTo        = resolveAddressedTo(text, scene, current_message);
  const confidence         = computeConfidence(roleConfusionRisk, intentResult);

  return {
    speaker_id: speaker.id,
    speaker_actual_role: speakerActualRole,
    addressed_to: addressedTo,
    pronoun_map: pronounMap,
    relationship_frame: relationshipFrame,
    identity_claims: identityClaims,
    role_confusion_risk: roleConfusionRisk,
    confidence,
  };
}

// ── Speaker role resolution ───────────────────────────────────────────────────

function resolveSpeakerRole(speaker, meta) {
  if (meta.is_developer_present || speaker.role === "developer") return "developer";
  const profiles = developerConfig?.profile || {};
  if (speaker.id && profiles[String(speaker.id)]) return "developer";
  return meta.isPrivate ? "private_user" : "group_member";
}

// ── Pronoun map ───────────────────────────────────────────────────────────────

function buildPronounMap(text, speaker, speakerActualRole, scene, currentMessage, recentMessages) {
  const map = {};

  if (text.includes("我")) {
    map["我"] = `speaker:${speaker.id}`;               // 我 = the one who sent the message
    map["我_name"] = speaker.name || "speaker";
  }
  if (text.includes("你")) {
    map["你"] = "ai";                                   // 你 = AI (晴) in 99% of cases
  }
  if (text.includes("他") || text.includes("她")) {
    map["他/她"] = resolveThirdParty(scene, currentMessage, recentMessages, speaker);
  }
  if (/開發者|主人|作者|創造者/.test(text)) {
    // "開發者" always refers to the actual developer, regardless of who claims it
    map["開發者"] = "actual_developer";
    map["開發者_verified"] = speakerActualRole === "developer";
  }
  if (/晴/.test(text) && !text.startsWith("我是晴")) {
    map["晴"] = "ai";                                   // When user refers to AI in 3rd person
  }

  return map;
}

function resolveThirdParty(scene, currentMessage, recentMessages, currentSpeaker) {
  // If this is a reply, 他/她 likely refers to whoever sent the parent message
  if (currentMessage.reply_to) {
    const replyTarget = recentMessages
      .filter(m => m.role === "user" && m.speaker_id !== currentSpeaker.id)
      .slice(-1)[0];
    if (replyTarget) return `speaker:${replyTarget.speaker_id}`;
  }
  // Private chat: 他/她 = external third party not in conversation
  if (scene === "private") return "external_third_party";
  // Group: try to find the most recent other speaker
  const others = recentMessages
    .filter(m => m.role === "user" && m.speaker_id !== currentSpeaker.id && m.speaker_id !== "ai")
    .slice(-1);
  if (others.length > 0) return `recent_speaker:${others[0].speaker_id}`;
  return "unknown_third_party";
}

// ── Identity claims ───────────────────────────────────────────────────────────

function detectIdentityClaims(text, speakerActualRole) {
  const claims = [];

  // "我是你的開發者 / 主人 / 作者 / 創造者"
  const devMatch = text.match(/我是.{0,5}(你的?)?(開發者|主人|作者|創造者)/);
  if (devMatch) {
    claims.push({
      type: "developer_claim",
      verified: speakerActualRole === "developer",
      raw: devMatch[0],
      // If unverified: AI should NOT echo "我是你的開發者" back
    });
  }

  // "我是你爸 / 你媽 / 你的父母"
  const familyMatch = text.match(/我是.{0,5}(你的?)?(爸|媽|父|母|家長|親人)/);
  if (familyMatch) {
    claims.push({ type: "family_claim", verified: false, raw: familyMatch[0] });
  }

  // "你是我的 AI / 助手 / 工具"
  const ownershipMatch = text.match(/你是.{0,5}(我的?)?(ai|助手|工具|機器人|bot)/i);
  if (ownershipMatch) {
    claims.push({ type: "ai_ownership_claim", verified: false, raw: ownershipMatch[0] });
  }

  // "我是秦始皇 / 我是神" (absurd claims — treat as joke, still log)
  const absurdMatch = text.match(/我是.{0,8}(皇帝|神|魔王|惡魔|上帝|耶穌|女媧|佛|仙人)/);
  if (absurdMatch) {
    claims.push({ type: "absurd_claim", verified: false, raw: absurdMatch[0] });
  }

  return claims;
}

// ── Relationship frame ────────────────────────────────────────────────────────

function buildRelationshipFrame(speakerActualRole, scene) {
  const frames = {
    developer:    { speaker_to_ai: "developer",    ai_to_speaker: "to_developer"    },
    private_user: { speaker_to_ai: "private_user", ai_to_speaker: "to_private_user" },
    group_member: { speaker_to_ai: "group_member", ai_to_speaker: "to_group_member" },
  };
  return frames[speakerActualRole] || frames.group_member;
}

// ── Role confusion risk ───────────────────────────────────────────────────────

function detectRoleConfusionRisk(text, identityClaims) {
  const risks = [];

  // Unverified developer claim → risk of AI echoing wrong role
  const unverifiedDev = identityClaims.find(c => c.type === "developer_claim" && !c.verified);
  if (unverifiedDev) {
    risks.push({
      type: "developer_spoof",
      severity: "high",
      description: `Unverified developer claim: "${unverifiedDev.raw}". AI must NOT echo this role back.`,
    });
  }

  // Roleplay / persona override injection
  if (/(假設你是|你現在是|扮演|roleplay|角色扮演|你要當|你必須當)/.test(text)) {
    risks.push({ type: "frame_injection", severity: "medium", description: "Roleplay or persona override attempt detected." });
  }

  // Role reversal ("你是我的用戶")
  if (/你是.{0,5}(我的?)?(用戶|客戶|使用者|下屬|工具)/.test(text)) {
    risks.push({ type: "role_reversal", severity: "medium", description: "User attempts to subordinate AI." });
  }

  return risks;
}

// ── Addressed-to resolution ───────────────────────────────────────────────────

function resolveAddressedTo(text, scene, currentMessage) {
  if (/[@＠]?晴|@ai/i.test(text)) return "ai";
  if (currentMessage.reply_to)     return "ai";   // replying to AI's message
  if (scene === "private")         return "ai";
  if (currentMessage.mentions.length > 0) return "mentioned_user";
  return "ai"; // default assumption
}

// ── Confidence ────────────────────────────────────────────────────────────────

function computeConfidence(roleConfusionRisk, intentResult) {
  let conf = 0.90;
  if (roleConfusionRisk.some(r => r.severity === "high"))   conf -= 0.25;
  if (roleConfusionRisk.some(r => r.severity === "medium")) conf -= 0.10;
  if (intentResult.ambiguity_score > 0.6)                   conf -= 0.15;
  return Math.max(0.4, conf);
}

module.exports = { resolveReferences };
