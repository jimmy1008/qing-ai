function applyPostProcess(reply, context) {
  if (!reply) return "";
  if (!context.isDilemma || context.hasSevereCrisis) return reply;

  const empathyPattern = /(我懂|我理解|聽起來|感覺你|這很不容易)/;
  const soothePattern = /(慢慢來|先別急|沒關係|你可以|先休息一下)/;
  const questionEnd = /[？?]\s*$/;

  const isSkeleton =
    empathyPattern.test(reply) &&
    soothePattern.test(reply) &&
    questionEnd.test(String(reply).trim());

  if (!isSkeleton) return reply;

  return String(reply).replace(/[？?]\s*$/, "。");
}

module.exports = { applyPostProcess };
