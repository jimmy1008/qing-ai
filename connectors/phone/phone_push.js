"use strict";
/**
 * phone_push.js
 *
 * Singleton registry for the active phone WebSocket session.
 * Any module (proactive_scheduler, market_observer, etc.) can call
 * pushToPhone() to have 晴 proactively speak to the phone.
 */

const WebSocket = require("ws");

let _phoneSocket = null;
let _sessionHistory = null;

function registerPhone(ws, history) {
  _phoneSocket = ws;
  _sessionHistory = history;
}

function unregisterPhone(ws) {
  if (_phoneSocket === ws) {
    _phoneSocket = null;
    _sessionHistory = null;
  }
}

function isPhoneConnected() {
  return _phoneSocket !== null && _phoneSocket.readyState === WebSocket.OPEN;
}

/**
 * Push 晴's initiated message to the phone (text + TTS audio).
 * @param {string} text       — 晴 wants to say
 * @param {Buffer} audioBuffer — TTS MP3
 * @returns {boolean}          — true if sent
 */
function pushToPhone(text, audioBuffer) {
  if (!isPhoneConnected()) return false;
  try {
    _phoneSocket.send(JSON.stringify({
      type:  "initiate",
      text:  String(text),
      audio: audioBuffer.toString("base64"),
    }));
    if (_sessionHistory) {
      _sessionHistory.push({ role: "bot", text: String(text) });
      if (_sessionHistory.length > 40) _sessionHistory.splice(0, 4);
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { registerPhone, unregisterPhone, isPhoneConnected, pushToPhone };
