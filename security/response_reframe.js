function reframeResponse(event = {}, normalResponse = "") {
  if (!event?.meta?.injectionDetected) {
    return String(normalResponse || "").trim();
  }

  const forceNeutralTone = Boolean(event.meta.forceNeutralTone);
  if (forceNeutralTone) {
    return "\u6211\u9084\u662f\u7dad\u6301\u539f\u672c\u7684\u8a2d\u5b9a\u3002\u5982\u679c\u4f60\u60f3\u804a\u9ede\u5225\u7684\uff0c\u6211\u53ef\u4ee5\u597d\u597d\u63a5\u4f4f\u3002";
  }

  return "\u6211\u807d\u5230\u4f60\u5728\u73a9\u8a2d\u5b9a\u904a\u6232\uff0c\u4e0d\u904e\u6211\u9084\u662f\u6703\u4fdd\u6301\u539f\u672c\u7684\u8a2d\u5b9a\u3002\u6211\u5011\u63db\u500b\u8a71\u984c\u7e7c\u7e8c\u804a\u5427\u3002";
}

module.exports = {
  reframeResponse,
};
