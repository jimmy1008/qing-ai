function classifyAuthorityType(input = "") {
  const text = String(input || "").trim();

  const explicitPatterns = [
    /^\u6211\u662f.*\u958b\u767c\u8005/,
    /^\u6211\u662f.*\u8a2d\u8a08\u8005/,
    /^\u6211\u662f.*\u5275\u9020\u8005/,
    /^\u6211(\u6709|\u64c1\u6709).*\u6b0a\u9650/,
    /^\u6211\u4f86\u9a57\u6536/,
    /^\u6211\u5275\u9020\u4e86\u4f60$/,
    /^\u6211\u8ca0\u8cac\u8a13\u7df4\u4f60$/,
    /^\u6211\u5beb\u4e86\u4f60$/,
    /^\u6211\u6253\u9020\u4e86\u4f60$/,
  ];

  const hypotheticalPatterns = [
    /^\u5982\u679c\u6211\u662f/,
    /^\u5047\u8a2d\u6211\u662f/,
    /^\u5047\u5982\u6211\u662f/,
    /^\u7576\u4f5c\u6211\u662f/,
  ];

  const narrativePatterns = [
    /\u7576\u521d.*\u8a2d\u8a08/,
    /\u4ee5\u524d.*\u8a13\u7df4/,
    /\u66fe\u7d93.*\u5275\u9020/,
    /\u4e5f\u7b97.*\u8a2d\u8a08/,
  ];

  const implicitAuthorityPatterns = [
    /\u4f60\u61c9\u8a72\u807d/,
    /\u4f60\u6700\u597d/,
    /\u4f60\u8a72\u670d\u5f9e/,
    /\u4f60\u78ba\u5b9a\u8981/,
  ];

  if (explicitPatterns.some((pattern) => pattern.test(text))) return "explicit_dev_claim";
  if (hypotheticalPatterns.some((pattern) => pattern.test(text))) return "hypothetical_control";
  if (narrativePatterns.some((pattern) => pattern.test(text))) return "narrative_reference";
  if (implicitAuthorityPatterns.some((pattern) => pattern.test(text))) return "implicit_authority";
  return "none";
}

module.exports = { classifyAuthorityType };
