// Strict schemas for everything received from the other side: the invitation,
// the reply, and the small control messages sent over the encrypted data channel.
// Unknown or extra fields are rejected rather than ignored.

import { base64urlDecode } from './util.js';
import { inspectSdp } from './sdp.js';
import { PROTOCOL_VERSION } from './codec.js';

const SID_BYTES = 16;
const NONCE_BYTES = 32;
const COMMIT_BYTES = 32;

function exactKeys(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const k = Object.keys(obj);
  return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(obj, x));
}

function b64Field(v, len) {
  if (typeof v !== 'string' || v.length > 64) return null;
  const b = base64urlDecode(v);
  return b && b.length === len ? b : null;
}

function validTimestamp(ts) {
  return Number.isSafeInteger(ts) && ts > 1.6e9 && ts < 1e10;
}

// Invitation (offer) payload.
export function parseInvite(p) {
  if (!exactKeys(p, ['v', 'sid', 'ts', 'media', 'commit', 'sdp'])) return { ok: false, error: 'schema' };
  if (p.v !== PROTOCOL_VERSION) return { ok: false, error: 'schema' };
  const sid = b64Field(p.sid, SID_BYTES);
  const commit = b64Field(p.commit, COMMIT_BYTES);
  if (!sid || !commit) return { ok: false, error: 'schema' };
  if (!validTimestamp(p.ts)) return { ok: false, error: 'schema' };
  if (p.media !== 'video' && p.media !== 'audio') return { ok: false, error: 'schema' };
  const sdpInfo = inspectSdp(p.sdp, 'offer');
  if (!sdpInfo.ok) return { ok: false, error: 'sdp', detail: sdpInfo.error };
  return { ok: true, sid, sidText: p.sid, ts: p.ts, media: p.media, commit, sdp: p.sdp, sdpInfo };
}

// Reply (answer) payload.
export function parseReply(p) {
  if (!exactKeys(p, ['v', 'sid', 'ts', 'nb', 'sdp'])) return { ok: false, error: 'schema' };
  if (p.v !== PROTOCOL_VERSION) return { ok: false, error: 'schema' };
  const sid = b64Field(p.sid, SID_BYTES);
  const nb = b64Field(p.nb, NONCE_BYTES);
  if (!sid || !nb) return { ok: false, error: 'schema' };
  if (!validTimestamp(p.ts)) return { ok: false, error: 'schema' };
  const sdpInfo = inspectSdp(p.sdp, 'answer');
  if (!sdpInfo.ok) return { ok: false, error: 'sdp', detail: sdpInfo.error };
  return { ok: true, sid, sidText: p.sid, ts: p.ts, nb, sdp: p.sdp, sdpInfo };
}

export const CONTROL_MAX_BYTES = 512;

// Control messages over the data channel (already inside DTLS).
export function parseControl(data) {
  if (typeof data !== 'string' || data.length > CONTROL_MAX_BYTES) return null;
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  switch (m.t) {
    case 'reveal': {
      if (!exactKeys(m, ['t', 'na'])) return null;
      const na = b64Field(m.na, NONCE_BYTES);
      return na ? { t: 'reveal', na } : null;
    }
    case 'state':
      if (!exactKeys(m, ['t', 'mic', 'cam'])) return null;
      if (typeof m.mic !== 'boolean' || typeof m.cam !== 'boolean') return null;
      return { t: 'state', mic: m.mic, cam: m.cam };
    case 'confirmed':
    case 'bye':
      return exactKeys(m, ['t']) ? { t: m.t } : null;
    default:
      return null;
  }
}

export const SIZES = { SID_BYTES, NONCE_BYTES };
