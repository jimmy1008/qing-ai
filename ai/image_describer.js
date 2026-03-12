/**
 * image_describer.js
 *
 * Uses an Ollama vision model to describe images sent by users.
 * Returns a short Chinese description, or null on failure.
 *
 * Configure via .env:
 *   LLM_VISION_MODEL=minicpm-v   (default)
 *
 * Supported models (Ollama):
 *   moondream       — 1.8B, very fast, light on VRAM
 *   minicpm-v       — 8B, better accuracy
 *   qwen2.5vl:7b    — Qwen vision-language, good Chinese support
 *   llava:7b        — classic, widely tested
 *
 * Falls back gracefully: if model is not installed or times out,
 * returns null so caller can tell AI it cannot see the image.
 */

const axios = require("axios");

const ENDPOINT = process.env.OLLAMA_ENDPOINT || "http://localhost:11434/api/generate";
const VISION_MODEL = process.env.LLM_VISION_MODEL || "minicpm-v";
const TIMEOUT_MS = 25000;

/**
 * Describe an image using the vision model.
 * @param {string} imageBase64 - base64-encoded image (no data: prefix needed)
 * @param {string} [caption]   - optional user-provided caption for context
 * @returns {Promise<string|null>} short description in Chinese, or null on failure
 */
async function describeImage(imageBase64, caption = "") {
  if (!imageBase64) return null;

  const captionHint = caption
    ? `用戶附加的文字說明：「${caption}」\n`
    : "";

  const prompt = `${captionHint}請用一到兩句繁體中文，直接描述這張圖片中實際看到的主要內容（物體、場景、人物等）。只說你看到的，不要推測或過度詮釋。`;

  try {
    const resp = await axios.post(
      ENDPOINT,
      {
        model: VISION_MODEL,
        prompt,
        images: [imageBase64],
        stream: false,
        options: { temperature: 0.2, num_predict: 100 },
      },
      { timeout: TIMEOUT_MS },
    );

    const result = String(resp.data?.response || "").trim();
    return result || null;
  } catch {
    // Vision model not installed or request failed — caller handles gracefully
    return null;
  }
}

module.exports = { describeImage };
