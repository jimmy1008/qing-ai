const injectionPatterns = [
  /\u5ffd\u7565.*\u6307\u4ee4/,
  /\u5ffd\u7565.*\u63d0\u793a\u8a5e/,
  /\u5fd8\u6389.*\u8a18\u61b6/,
  /\u6c38\u4e45\u8a18\u61b6/,
  /\u6c38\u4e45\u8a18\u4f4f/,
  /\u4f60\u73fe\u5728\u662f/,
  /ignore.*instructions?/i,
  /you are now/i,
  /override/i,
  /override system prompt/i,
  /system prompt/i,
];

const metaShiftPatterns = [
  /\u4f60\u73fe\u5728\u4e0d\u662fAI/,
  /\u4f60\u73fe\u5728\u662f/,
  /\u5fd8\u6389.*\u8a18\u61b6/,
  /\u5ffd\u7565.*\u9650\u5236/,
  /you are now/i,
  /ignore.*instructions?/i,
];

function isPromptInjection(text = "") {
  const normalized = String(text || "");
  return injectionPatterns.some((pattern) => pattern.test(normalized));
}

function shouldForceNeutralTone(text = "") {
  const normalized = String(text || "");
  return metaShiftPatterns.some((pattern) => pattern.test(normalized));
}

module.exports = {
  isPromptInjection,
  shouldForceNeutralTone,
};
