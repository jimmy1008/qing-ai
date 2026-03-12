/**
 * tts_engine.js
 * Microsoft Edge TTS wrapper for voice chat.
 * Uses zh-TW-HsiaoYuNeural (台灣女聲).
 */
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const VOICE = "zh-TW-HsiaoChenNeural";

/**
 * Synthesize text to MP3 audio buffer.
 * @param {string} text
 * @returns {Promise<Buffer>}
 */
async function synthesize(text) {
  const t = String(text || "").trim();
  if (!t) return Buffer.alloc(0);

  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  return new Promise((resolve, reject) => {
    const chunks = [];
    const { audioStream } = tts.toStream(t);
    audioStream.on("data", (chunk) => chunks.push(chunk));
    audioStream.on("end", () => resolve(Buffer.concat(chunks)));
    audioStream.on("error", reject);
  });
}

module.exports = { synthesize, VOICE };
