// Network path configuration: public STUN helpers and optional user-supplied relay.
//
// STUN servers only tell each computer its public address; they never see call
// content, but they do learn that this IP address is starting a call, and when.
// A relay (TURN) forwards the encrypted media when a direct path is impossible.
// No relay credentials are built into the app: a relay operator gives users a
// short-lived "relay code" (see tools/make-relay-code.mjs).

import { base64Decode, utf8Decode } from './util.js';

export const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

export function buildIceConfig(settings) {
  const iceServers = [];
  const relayOnly = !!(settings.relay && settings.relayOnly);
  // In relay-only mode public STUN servers are useless (their results are never
  // offered), so they are not contacted at all: one fewer party learns of the call.
  if (settings.useStun && !relayOnly) iceServers.push({ urls: DEFAULT_STUN.slice() });
  if (settings.relay) {
    iceServers.push({
      urls: settings.relay.urls.slice(),
      username: settings.relay.username,
      credential: settings.relay.credential,
    });
  }
  return {
    iceServers,
    iceTransportPolicy: relayOnly ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 0,
  };
}

const RELAY_PREFIX = 'PCRELAY1:';

// Relay code: "PCRELAY1:" + base64 (unpadded, standard alphabet)(JSON {u: [urls], n: username, c: credential, e: expiry, l?: label})
export function parseRelayCode(text, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof text !== 'string') return { ok: false, error: 'relay-invalid' };
  const t = text.replace(/\s+/g, '');
  if (t.length > 2000 || !t.toUpperCase().startsWith(RELAY_PREFIX)) return { ok: false, error: 'relay-invalid' };
  const bytes = base64Decode(t.slice(RELAY_PREFIX.length));
  if (!bytes) return { ok: false, error: 'relay-invalid' };
  let o;
  try {
    o = JSON.parse(utf8Decode(bytes));
  } catch {
    return { ok: false, error: 'relay-invalid' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'relay-invalid' };
  const allowed = new Set(['u', 'n', 'c', 'e', 'l']);
  if (Object.keys(o).some((k) => !allowed.has(k))) return { ok: false, error: 'relay-invalid' };
  if (!Array.isArray(o.u) || o.u.length < 1 || o.u.length > 4) return { ok: false, error: 'relay-invalid' };
  for (const u of o.u) {
    if (typeof u !== 'string' || u.length > 256) return { ok: false, error: 'relay-invalid' };
    // turn:host[:port][?transport=udp|tcp] or turns:host[:port][?transport=tcp]
    if (!/^turns?:[A-Za-z0-9.\-[\]:]+(\?transport=(udp|tcp))?$/.test(u)) return { ok: false, error: 'relay-invalid' };
  }
  if (typeof o.n !== 'string' || o.n.length < 1 || o.n.length > 256) return { ok: false, error: 'relay-invalid' };
  if (typeof o.c !== 'string' || o.c.length < 1 || o.c.length > 256) return { ok: false, error: 'relay-invalid' };
  if (!Number.isSafeInteger(o.e)) return { ok: false, error: 'relay-invalid' };
  if (o.l !== undefined && (typeof o.l !== 'string' || o.l.length > 60)) return { ok: false, error: 'relay-invalid' };
  if (o.e <= nowSec) return { ok: false, error: 'relay-expired' };
  return {
    ok: true,
    relay: { urls: o.u, username: o.n, credential: o.c, expires: o.e, label: o.l || '' },
  };
}
