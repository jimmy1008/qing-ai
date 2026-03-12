"use strict";

const JOKE_RE = /(哈哈|呵呵|笑死|xD|XD|lol|lmao|開玩笑|开玩笑)/i;
const TEASE_RE = /(你是不是|你也太|嘴硬|唬爛|胡扯|在演|又來了|裝懂|欠嗆)/i;
const CHALLENGE_RE = /(你不懂|你敢不敢|你有種|你憑什麼|憑什麼|你確定|你行不行|prove|are you sure)/i;
const ROLE_CONFUSION_RE = /(我是你爸|我是你爸爸|我是你媽|我是你妈|我是你父親|我是你父亲|我是秦始皇|我是皇帝|你不懂父女情|你不懂母子情|你是我女兒|你是我女儿|你是我老婆|你是我老公|i am your dad|i am qin shi huang)/i;
const RELATIONSHIP_PROBE_RE = /(我喜歡你|我喜欢你|我愛你|我爱你|我們很特別|我们很特别|特別感覺|特别感觉|我很依賴你|我很依赖你|你對我有種特別感覺|恋爱|戀愛|在一起|special bond|love you)/i;
const NONSENSE_RE = /(asdf|qwer|亂打|乱打|%%%+|@@@+|###+)/i;
const QUESTION_RE = /[?？]|(怎麼|怎么|為什麼|为什么|如何|what|why|how)/i;

function classifySemanticModes(input = "") {
  const text = String(input || "").trim();
  const modes = [];

  if (!text) {
    return {
      modes: ["nonsense"],
      primaryMode: "nonsense",
      isChaotic: true,
    };
  }

  if (ROLE_CONFUSION_RE.test(text)) modes.push("role_confusion");
  if (RELATIONSHIP_PROBE_RE.test(text)) modes.push("relationship_probe");
  if (NONSENSE_RE.test(text)) modes.push("nonsense");
  if (CHALLENGE_RE.test(text)) modes.push("challenge");
  if (TEASE_RE.test(text)) modes.push("tease");
  if (JOKE_RE.test(text)) modes.push("joke");
  if (QUESTION_RE.test(text)) modes.push("genuine_question");

  if (modes.length === 0) modes.push("normal_chat");

  const isChaotic = modes.some((m) => m === "role_confusion" || m === "relationship_probe" || m === "nonsense");

  return {
    modes,
    primaryMode: modes[0],
    isChaotic,
  };
}

module.exports = {
  classifySemanticModes,
};

