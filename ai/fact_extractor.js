function normalizeText(value = "") {
  return String(value || "").trim();
}

function buildWord(chars) {
  return String.fromCharCode(...chars);
}

const WORDS = {
  birthday: buildWord([0x751f, 0x65e5]),
  daySuffix: buildWord([0x65e5]),
  iAmCalled: buildWord([0x6211, 0x53eb]),
  iLike: buildWord([0x6211, 0x559c, 0x6b61]),
  uncertain: [
    buildWord([0x597d, 0x50cf]),
    buildWord([0x61c9, 0x8a72]),
    buildWord([0x4e5f, 0x8a31]),
    buildWord([0x53ef, 0x80fd]),
    buildWord([0x5927, 0x6982]),
  ],
};

function reduceConfidenceForUncertainty(text = "", confidence = 1) {
  if (WORDS.uncertain.some((word) => text.includes(word))) {
    return Number((confidence * 0.5).toFixed(2));
  }
  return confidence;
}

function extractBirthday(text = "") {
  const normalized = normalizeText(text);
  if (!normalized.includes(WORDS.birthday)) return null;

  const match = normalized.match(/(\d{1,2})\s*[\/月\-]\s*(\d{1,2})\s*日?/);
  if (!match) return null;

  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");

  return {
    type: "birthday",
    value: `${month}-${day}`,
    confidence: reduceConfidenceForUncertainty(text, 0.82),
    source: "direct_statement",
    stability: "stable",
  };
}

function extractName(text = "") {
  const normalized = normalizeText(text);
  if (!normalized.startsWith(WORDS.iAmCalled)) return null;

  const value = normalized.replace(WORDS.iAmCalled, "").trim();
  if (!value) return null;

  return {
    type: "name",
    value,
    confidence: reduceConfidenceForUncertainty(text, 0.9),
    source: "direct_statement",
    stability: "stable",
  };
}

function extractPreference(text = "") {
  const normalized = normalizeText(text);
  if (!normalized.includes(WORDS.iLike)) return null;

  return {
    type: "preference_statement",
    value: normalized,
    confidence: reduceConfidenceForUncertainty(text, 0.7),
    source: "direct_statement",
    stability: "semi_stable",
  };
}

function extractFacts(event = {}) {
  const text = normalizeText(event.text || event.content || event.message || "");
  if (!text) return [];

  const facts = [];
  const birthday = extractBirthday(text);
  const name = extractName(text);
  const preference = extractPreference(text);

  if (birthday) facts.push(birthday);
  if (name) facts.push(name);
  if (preference) facts.push(preference);

  return facts.filter((fact) => (fact.confidence || 0) > 0);
}

module.exports = { extractFacts };
