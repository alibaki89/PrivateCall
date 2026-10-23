// Defensive inspection of SDP received from the other person.
//
// We never "munge" SDP. We only check that it is well-formed for what this app
// generates, and extract the DTLS certificate fingerprint that the browser will
// enforce during the DTLS handshake. That fingerprint is what the security code
// (SAS) is computed over, so it must be unambiguous: exactly one fingerprint,
// identical on every media section.

export const SDP_MAX_LENGTH = 20000;
const FP_ALGS = { 'sha-256': 32, 'sha-384': 48, 'sha-512': 64 };

export function inspectSdp(sdp, type) {
  const fail = (code) => ({ ok: false, error: code });
  if (typeof sdp !== 'string') return fail('sdp-type');
  if (sdp.length < 20 || sdp.length > SDP_MAX_LENGTH) return fail('sdp-size');
  // Printable ASCII and CRLF only.
  if (!/^[\x20-\x7e\r\n]*$/.test(sdp)) return fail('sdp-charset');
  if (!sdp.startsWith('v=0\r\n')) return fail('sdp-start');
  if (!sdp.endsWith('\r\n')) return fail('sdp-end');

  const lines = sdp.slice(0, -2).split('\r\n');
  const fingerprints = new Set();
  const setups = new Set();
  const kinds = [];
  const candidates = [];
  let ufrag = null;
  let pwd = null;

  for (const line of lines) {
    if (!/^[a-z]=/.test(line)) return fail('sdp-line');
    if (line.includes('\r') || line.includes('\n')) return fail('sdp-line');
    if (line.startsWith('m=')) {
      const m = /^m=(audio|video|application) \d+ [A-Z/]+( [\w-]+)+$/.exec(line);
      if (!m) return fail('sdp-media');
      kinds.push(m[1]);
    } else if (line.startsWith('a=fingerprint:')) {
      const m = /^a=fingerprint:(\S+) ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})+)$/.exec(line);
      if (!m) return fail('sdp-fingerprint');
      const alg = m[1].toLowerCase();
      const value = m[2].toUpperCase();
      if (!(alg in FP_ALGS)) return fail('sdp-fingerprint-alg');
      if (value.split(':').length !== FP_ALGS[alg]) return fail('sdp-fingerprint');
      fingerprints.add(alg + ' ' + value);
    } else if (line.startsWith('a=setup:')) {
      setups.add(line.slice(8));
    } else if (line.startsWith('a=ice-ufrag:')) {
      const v = line.slice(12);
      if (ufrag !== null && ufrag !== v) return fail('sdp-ice');
      ufrag = v;
    } else if (line.startsWith('a=ice-pwd:')) {
      const v = line.slice(10);
      if (pwd !== null && pwd !== v) return fail('sdp-ice');
      pwd = v;
    } else if (line.startsWith('a=candidate:')) {
      const c = parseCandidate(line.slice(2));
      if (c) candidates.push(c);
    }
  }

  // This app always negotiates exactly one audio, one video and one data section.
  const sorted = [...kinds].sort().join(',');
  if (sorted !== 'application,audio,video') return fail('sdp-media');
  if (fingerprints.size !== 1) return fail('sdp-fingerprint-count');
  if (setups.size !== 1) return fail('sdp-setup');
  const setup = [...setups][0];
  if (type === 'offer' && setup !== 'actpass') return fail('sdp-setup');
  if (type === 'answer' && setup !== 'active' && setup !== 'passive') return fail('sdp-setup');
  if (!ufrag || !pwd || !/^[A-Za-z0-9+/]{4,256}$/.test(ufrag) || !/^[A-Za-z0-9+/]{22,256}$/.test(pwd)) {
    return fail('sdp-ice');
  }

  const [alg, value] = [...fingerprints][0].split(' ');
  return { ok: true, fingerprint: { alg, value }, setup, candidates };
}

// Minimal candidate parser for diagnostics only; never used for security decisions.
export function parseCandidate(str) {
  const m = /^candidate:\S+ \d+ (udp|tcp) \d+ (\S+) (\d+) typ (host|srflx|prflx|relay)/i.exec(str);
  if (!m) return null;
  return { protocol: m[1].toLowerCase(), address: m[2], port: Number(m[3]), type: m[4].toLowerCase() };
}

export function summarizeCandidates(candidates) {
  const s = { host: 0, srflx: 0, relay: 0, prflx: 0, mdns: 0, tcp: 0 };
  for (const c of candidates) {
    s[c.type] = (s[c.type] || 0) + 1;
    if (c.address.endsWith('.local')) s.mdns++;
    if (c.protocol === 'tcp') s.tcp++;
  }
  return s;
}

// Canonical byte form of a fingerprint for hashing: "sha-256 AB:CD:...".
export function fingerprintString(fp) {
  return fp.alg.toLowerCase() + ' ' + fp.value.toUpperCase();
}

export function normalizeStatsFingerprint(alg, value) {
  if (typeof alg !== 'string' || typeof value !== 'string') return null;
  return alg.toLowerCase() + ' ' + value.toUpperCase();
}

// Separate the remote candidates from an SDP so they can be supplied (and
// re-supplied) with the standard addIceCandidate() API. Candidates are
// de-duplicated by transport address and attached to the first BUNDLE mid,
// which carries the single shared transport (bundlePolicy: max-bundle).
export function splitCandidates(sdp) {
  const lines = sdp.slice(0, -2).split('\r\n');
  const bundle = lines.find((l) => l.startsWith('a=group:BUNDLE '));
  let currentMid = null;
  const firstMid = bundle ? bundle.split(' ')[1] : null;
  const seen = new Set();
  const candidates = [];
  const kept = [];
  for (const line of lines) {
    if (line.startsWith('m=')) currentMid = null;
    if (line.startsWith('a=mid:')) currentMid = line.slice(6);
    if (line.startsWith('a=candidate:')) {
      const c = parseCandidate(line.slice(2));
      const key = c ? `${c.protocol} ${c.address} ${c.port} ${c.type}` : line;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ candidate: line.slice(2), sdpMid: firstMid || currentMid || '0' });
      }
      continue;
    }
    if (line === 'a=end-of-candidates') continue;
    kept.push(line);
  }
  return { sdp: kept.join('\r\n') + '\r\n', candidates };
}

// A copy of a candidate with a different foundation. Re-adding the same address
// under a new foundation makes the ICE agent start fresh connectivity checks,
// which keeps this side's router "pinhole" toward the other side open while
// waiting for them to add the reply (see session.js: refreshRemoteCandidates).
export function refreshFoundation(candidate, round) {
  return candidate.replace(/^candidate:([A-Za-z0-9+/]{1,32})/, (m, f) => `candidate:${f.slice(0, 24)}r${round}`);
}
