// Gathering policy, candidate handling, relay-only config, and fuzzing of every
// parser that sees attacker-controlled input. Run: node --test tests/unit/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as util from '../../src/app/util.js';
import { encodeEnvelope, decodeEnvelope } from '../../src/app/codec.js';
import { inspectSdp, splitCandidates, refreshFoundation, parseCandidate } from '../../src/app/sdp.js';
import { parseInvite, parseReply, parseControl } from '../../src/app/protocol.js';
import { parseRelayCode, buildIceConfig, DEFAULT_STUN } from '../../src/app/ice.js';
import { gatherDecision, GATHER_POLICY, relayUrlsOf } from '../../src/app/gather.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OFFER = fs.readFileSync(path.join(here, '../fixtures/chrome-offer.sdp'), 'utf8').replace(/\r?\n/g, '\r\n');
const ANSWER = fs.readFileSync(path.join(here, '../fixtures/chrome-answer.sdp'), 'utf8').replace(/\r?\n/g, '\r\n');

// Deterministic PRNG so fuzz failures are reproducible.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// ---------- gathering policy ----------
const base = { elapsedMs: 0, msSinceLastCandidate: 0, complete: false, relayUrls: [], settledRelayUrls: new Set(), attribution: true };

test('gathering: complete always finishes, cap always finishes', () => {
  assert.equal(gatherDecision({ ...base, complete: true }).done, true);
  assert.equal(gatherDecision({ ...base, elapsedMs: GATHER_POLICY.maxMs }).reason, 'cap');
  assert.equal(gatherDecision({ ...base, elapsedMs: GATHER_POLICY.maxMs, relayUrls: ['turn:x'], msSinceLastCandidate: 0 }).done, true);
});

test('gathering: never stops early just because a "useful" candidate exists (regression)', () => {
  // The previous policy stopped after 3.5 s once one srflx/relay candidate existed.
  for (const t of [1000, 3500, 5000, 10000, GATHER_POLICY.minMs - 1]) {
    assert.equal(gatherDecision({ ...base, elapsedMs: t, msSinceLastCandidate: t }).done, false, `t=${t}`);
  }
});

test('gathering: after the minimum, stops only when quiet', () => {
  const t = GATHER_POLICY.minMs + 1;
  assert.equal(gatherDecision({ ...base, elapsedMs: t, msSinceLastCandidate: 100 }).reason, 'active');
  assert.equal(gatherDecision({ ...base, elapsedMs: t, msSinceLastCandidate: GATHER_POLICY.quietMs }).reason, 'quiet');
});

test('gathering: waits for every configured relay URL to settle (when attributable)', () => {
  const t = GATHER_POLICY.minMs + GATHER_POLICY.quietMs;
  const relayUrls = ['turn:r:3478?transport=udp', 'turns:r:443?transport=tcp'];
  const st = { ...base, elapsedMs: t, msSinceLastCandidate: t, relayUrls };
  assert.equal(gatherDecision({ ...st, settledRelayUrls: new Set([relayUrls[0]]) }).reason, 'relay-pending');
  assert.equal(gatherDecision({ ...st, settledRelayUrls: new Set(relayUrls) }).done, true);
  // Browsers that do not report the server URL: fall back to the quiet rule.
  assert.equal(gatherDecision({ ...st, attribution: false }).done, true);
  // Once any relay candidate exists, a relay transport that never answers (e.g.
  // UDP blocked) must not hold things up until the cap (lab regression).
  assert.equal(gatherDecision({ ...st, settledRelayUrls: new Set([relayUrls[1]]), haveRelayCandidate: true }).done, true);
  assert.equal(gatherDecision({ ...st, settledRelayUrls: new Set([relayUrls[1]]), haveRelayCandidate: false }).reason, 'relay-pending');
  assert.deepEqual(relayUrlsOf({ iceServers: [{ urls: DEFAULT_STUN }, { urls: relayUrls }] }), relayUrls);
});

// ---------- relay-only configuration ----------
test('relay-only mode does not contact public STUN servers', () => {
  const relay = { urls: ['turn:r:3478'], username: 'u', credential: 'c' };
  const cfg = buildIceConfig({ useStun: true, relay, relayOnly: true });
  assert.equal(cfg.iceTransportPolicy, 'relay');
  assert.deepEqual(cfg.iceServers.map((s) => s.urls), [['turn:r:3478']]);
  assert.equal(buildIceConfig({ useStun: true, relay, relayOnly: false }).iceServers.length, 2);
});

// ---------- candidate splitting / refresh ----------
test('splitCandidates removes candidates, keeps SDP valid, de-duplicates', () => {
  const r = splitCandidates(OFFER);
  assert.equal(r.sdp.includes('a=candidate:'), false);
  assert.equal(inspectSdp(r.sdp, 'offer').ok, true);
  assert.equal(r.candidates.length, inspectSdp(OFFER, 'offer').candidates.length);
  const dup = OFFER.replace(/(a=candidate:[^\r]*\r\n)/, '$1$1');
  assert.equal(splitCandidates(dup).candidates.length, r.candidates.length);
  for (const c of r.candidates) assert.equal(c.sdpMid, '0');
});

test('refreshFoundation changes only the foundation', () => {
  const c = 'candidate:4010479258 1 udp 2113937151 192.0.2.1 46137 typ srflx raddr 0.0.0.0 rport 0 generation 0';
  const r = refreshFoundation(c, 7);
  assert.equal(r, 'candidate:4010479258r7 1 udp 2113937151 192.0.2.1 46137 typ srflx raddr 0.0.0.0 rport 0 generation 0');
  assert.deepEqual(parseCandidate(r), parseCandidate(c));
  const long = 'candidate:' + 'a'.repeat(32) + ' 1 udp 1 192.0.2.1 1 typ host';
  assert.match(refreshFoundation(long, 99), /^candidate:a{24}r99 /);
});

// ---------- fuzzing ----------
test('fuzz: mutated envelopes never throw and never yield an invalid accepted payload', async () => {
  const rnd = prng(0xc0ffee);
  const inviteText = await encodeEnvelope('invite', { v: 1, sid: util.base64urlEncode(util.randomBytes(16)), ts: 1800000000, media: 'video', commit: util.base64urlEncode(util.randomBytes(32)), sdp: OFFER });
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/:.\n >​';
  let accepted = 0;
  for (let i = 0; i < 1500; i++) {
    let t = inviteText;
    const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const pos = Math.floor(rnd() * t.length);
      const op = rnd();
      if (op < 0.4) t = t.slice(0, pos) + alphabet[Math.floor(rnd() * alphabet.length)] + t.slice(pos + 1);
      else if (op < 0.7) t = t.slice(0, pos) + t.slice(pos + 1 + Math.floor(rnd() * 20));
      else t = t.slice(0, pos) + alphabet[Math.floor(rnd() * alphabet.length)] + t.slice(pos);
    }
    const r = await decodeEnvelope(t);
    if (r.ok) {
      accepted++;
      // Accepted only if the data is byte-identical (whitespace/quote changes are tolerated).
      const p = parseInvite(r.payload);
      assert.equal(p.ok, true);
    }
  }
  assert.ok(accepted < 1500);
});

test('fuzz: structured garbage into every schema parser never throws', () => {
  const rnd = prng(42);
  const values = [null, true, 0, -1, 1e308, NaN, '', 'x', 'A'.repeat(100000), [], {}, [1, 2], { a: 1 }, '__proto__', 'constructor', '\u0000', '<script>'];
  const pick = () => values[Math.floor(rnd() * values.length)];
  const keysInvite = ['v', 'sid', 'ts', 'media', 'commit', 'sdp', 'extra', '__proto__'];
  for (let i = 0; i < 5000; i++) {
    const o = {};
    for (const k of keysInvite) if (rnd() < 0.7) o[k] = pick();
    if (rnd() < 0.3) o.sdp = OFFER;
    if (rnd() < 0.3) o.v = 1;
    assert.doesNotThrow(() => parseInvite(o));
    assert.doesNotThrow(() => parseReply(o));
    assert.equal(parseInvite(o).ok && typeof o.sdp !== 'string', false);
    assert.doesNotThrow(() => parseControl(JSON.stringify(o)));
    assert.doesNotThrow(() => parseControl(pick()));
    assert.doesNotThrow(() => parseRelayCode(typeof pick() === 'string' ? 'PCRELAY1:' + pick() : pick()));
  }
});

test('fuzz: line-level SDP mutations never throw; accepted SDP always has exactly one fingerprint', () => {
  const rnd = prng(7);
  const lines = OFFER.slice(0, -2).split('\r\n');
  const pool = ANSWER.slice(0, -2).split('\r\n').concat(['a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), 'a=setup:active', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=ice-ufrag:x', 'garbage', '']);
  let accepted = 0;
  for (let i = 0; i < 4000; i++) {
    const l = lines.slice();
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const pos = Math.floor(rnd() * l.length);
      const op = rnd();
      if (op < 0.33) l.splice(pos, 1);
      else if (op < 0.66) l.splice(pos, 0, pool[Math.floor(rnd() * pool.length)]);
      else l[pos] = pool[Math.floor(rnd() * pool.length)];
    }
    const sdp = l.join('\r\n') + '\r\n';
    let r;
    assert.doesNotThrow(() => {
      r = inspectSdp(sdp, 'offer');
    });
    if (r.ok) {
      accepted++;
      const fps = new Set(sdp.split('\r\n').filter((x) => x.startsWith('a=fingerprint:')).map((x) => x.toUpperCase()));
      assert.equal(fps.size, 1);
    }
    assert.doesNotThrow(() => splitCandidates(sdp));
  }
  assert.ok(accepted > 0 && accepted < 4000);
});
