// Unit tests for the security-relevant core modules. Run: node --test tests/unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as util from '../../src/app/util.js';
import { encodeEnvelope, decodeEnvelope, LIMITS } from '../../src/app/codec.js';
import { inspectSdp, fingerprintString } from '../../src/app/sdp.js';
import { parseInvite, parseReply, parseControl } from '../../src/app/protocol.js';
import { makeCommit, checkCommit, deriveSas } from '../../src/app/sas.js';
import { parseRelayCode, buildIceConfig } from '../../src/app/ice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OFFER = fs.readFileSync(path.join(here, '../fixtures/chrome-offer.sdp'), 'utf8');
const ANSWER = fs.readFileSync(path.join(here, '../fixtures/chrome-answer.sdp'), 'utf8');
const b64u = (n) => util.base64urlEncode(util.randomBytes(n));

function invitePayload(over = {}) {
  return { v: 1, sid: b64u(16), ts: Math.floor(Date.now() / 1000), media: 'video', commit: b64u(32), sdp: OFFER, ...over };
}
function replyPayload(over = {}) {
  return { v: 1, sid: b64u(16), ts: Math.floor(Date.now() / 1000), nb: b64u(32), sdp: ANSWER, ...over };
}

// ---------- base64 ----------
test('base64 round-trips every length and rejects non-canonical input', () => {
  for (let n = 0; n < 70; n++) {
    const b = util.randomBytes(n);
    assert.deepEqual(util.base64Decode(util.base64Encode(b)), b);
    assert.deepEqual(util.base64urlDecode(util.base64urlEncode(b)), b);
  }
  assert.equal(util.base64Decode('A'), null); // impossible length
  assert.equal(util.base64Decode('AB'), null); // non-zero trailing bits
  assert.equal(util.base64Decode('AA=='), null); // padding not accepted
  assert.equal(util.base64Decode('A_'), null); // wrong alphabet
  assert.equal(util.base64urlDecode('A+'), null);
});

test('length-prefixed encoding separates fields unambiguously', () => {
  const a = util.lengthPrefixed(['ab', 'c']);
  const b = util.lengthPrefixed(['a', 'bc']);
  assert.notDeepEqual(a, b);
});

test('inflate refuses output beyond the limit (decompression bomb)', async () => {
  const big = new Uint8Array(1_000_000); // compresses to ~1 KB
  const comp = await util.deflateRaw(big);
  assert.ok(comp.length < 5000);
  const r = await util.inflateRawLimited(comp, 32000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-large');
  const bad = await util.inflateRawLimited(new Uint8Array([1, 2, 3, 4, 5, 255, 255]), 1000);
  assert.equal(bad.ok, false);
});

// ---------- envelope ----------
test('envelope round-trips an invitation and survives chat-app mangling', async () => {
  const p = invitePayload();
  const text = await encodeEnvelope('invite', p, 'Join my call: paste this whole message.');
  assert.ok(text.length < 4000, 'fits in one Telegram message: ' + text.length);
  assert.match(text, /^[\x20-\x7e\n]+$/);
  assert.doesNotMatch(text.split(':\n')[1], /[_*~`]/, 'no chat formatting characters in data');
  const r = await decodeEnvelope(text);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'invite');
  assert.deepEqual(r.payload, p);

  // Email quoting, CRLF, re-wrapping, zero-width characters, surrounding chatter.
  const mangled =
    'Hey! see below\r\n' +
    text
      .split('\n')
      .map((l) => '> ' + l)
      .join('\r\n')
      .replace(/(.{37})/g, '$1\u200b ') +
    '\r\nthanks';
  const r2 = await decodeEnvelope(mangled);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(r2.payload, p);
});

test('envelope detects truncation, corruption and wrong versions', async () => {
  const text = await encodeEnvelope('reply', replyPayload());
  assert.equal((await decodeEnvelope(text.replace(':end', ''))).error, 'incomplete');
  const lines = text.split('\n');
  const truncated = [...lines.slice(0, 3), ...lines.slice(5)].join('\n');
  assert.equal((await decodeEnvelope(truncated)).ok, false);

  // Flip one character in the data.
  const idx = text.indexOf(':\n') + 10;
  const ch = text[idx] === 'A' ? 'B' : 'A';
  const flipped = text.slice(0, idx) + ch + text.slice(idx + 1);
  assert.equal((await decodeEnvelope(flipped)).error, 'corrupt');

  assert.equal((await decodeEnvelope(text.replace('.v1:', '.v2:'))).error, 'version-newer');
  assert.equal((await decodeEnvelope(text.replace('.v1:', '.v0:'))).error, 'version-older');
  assert.equal((await decodeEnvelope(text.replace('reply.v1', 'invite.v1'))).error, 'corrupt', 'kind is bound in checksum');
  assert.equal((await decodeEnvelope(text + text)).error, 'multiple');
  assert.equal((await decodeEnvelope('hello')).error, 'not-found');
  assert.equal((await decodeEnvelope('   ')).error, 'empty');
  assert.equal((await decodeEnvelope('x'.repeat(LIMITS.text + 1))).error, 'too-large');
  assert.equal((await decodeEnvelope('PrivateCall.invite.v1:\n$$$\n:end')).error, 'corrupt');
  assert.equal((await decodeEnvelope('PCRELAY1:abc')).error, 'is-relay-code');
});

test('envelope rejects a forged envelope that inflates to a huge payload', async () => {
  const bomb = await util.deflateRaw(new Uint8Array(5_000_000).fill(32));
  const head = new Uint8Array([0x50, 0x43, 1, 1, 1]);
  const body = util.concatBytes(head, bomb);
  const sum = (await util.sha256(body)).slice(0, 8);
  const text = 'PrivateCall.invite.v1:\n' + util.base64Encode(util.concatBytes(body, sum)) + '\n:end';
  const r = await decodeEnvelope(text);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too-large');
});

// ---------- SDP ----------
test('real Chromium offer/answer pass inspection and expose one fingerprint', () => {
  const o = inspectSdp(OFFER, 'offer');
  assert.equal(o.ok, true, o.error);
  assert.equal(o.fingerprint.alg, 'sha-256');
  assert.equal(o.setup, 'actpass');
  const a = inspectSdp(ANSWER, 'answer');
  assert.equal(a.ok, true, a.error);
  assert.notEqual(fingerprintString(o.fingerprint), fingerprintString(a.fingerprint));
});

test('SDP inspection rejects ambiguous or hostile input', () => {
  const first = /a=fingerprint:sha-256 (\S+)/.exec(OFFER)[1];
  const other = first.replace(/^../, first.startsWith('00') ? '11' : '00');
  // Two different fingerprints: the code must never be computed over an ambiguous one.
  const twoFp = OFFER.replace(`a=fingerprint:sha-256 ${first}\r\n`, `a=fingerprint:sha-256 ${other}\r\n`);
  assert.equal(inspectSdp(twoFp, 'offer').error, 'sdp-fingerprint-count');
  assert.equal(inspectSdp(OFFER.replaceAll(/a=fingerprint:.*\r\n/g, ''), 'offer').error, 'sdp-fingerprint-count');
  assert.equal(inspectSdp(OFFER.replaceAll('sha-256', 'md5'), 'offer').error, 'sdp-fingerprint-alg');
  assert.equal(inspectSdp(OFFER, 'answer').error, 'sdp-setup');
  assert.equal(inspectSdp(ANSWER, 'offer').error, 'sdp-setup');
  assert.equal(inspectSdp(OFFER.replace('v=0', 'v=1'), 'offer').error, 'sdp-start');
  assert.equal(inspectSdp(OFFER + 'a=x\u00e9\r\n', 'offer').error, 'sdp-charset');
  assert.equal(inspectSdp(OFFER.replaceAll('\r\n', '\n'), 'offer').ok, false);
  assert.equal(inspectSdp('v=0\r\n' + 'a=x\r\n'.repeat(5000), 'offer').error, 'sdp-size');
  assert.equal(inspectSdp(OFFER.replace(/m=video[^\r]*/, 'm=audio 9 UDP/TLS/RTP/SAVPF 111'), 'offer').error, 'sdp-media');
  assert.equal(inspectSdp(42, 'offer').error, 'sdp-type');
});

// ---------- payload schemas ----------
test('invite and reply schemas are strict', () => {
  assert.equal(parseInvite(invitePayload()).ok, true);
  assert.equal(parseReply(replyPayload()).ok, true);
  assert.equal(parseInvite(invitePayload({ extra: 1 })).ok, false);
  assert.equal(parseInvite(invitePayload({ media: 'screen' })).ok, false);
  assert.equal(parseInvite(invitePayload({ sid: b64u(15) })).ok, false);
  assert.equal(parseInvite(invitePayload({ commit: 'not base64!' })).ok, false);
  assert.equal(parseInvite(invitePayload({ ts: 'now' })).ok, false);
  assert.equal(parseInvite(invitePayload({ v: 2 })).ok, false);
  assert.equal(parseInvite(invitePayload({ sdp: ANSWER })).ok, false, 'answer SDP inside an invite');
  assert.equal(parseReply(replyPayload({ sdp: OFFER })).ok, false, 'offer SDP inside a reply');
  assert.equal(parseReply(replyPayload({ nb: b64u(31) })).ok, false);
  assert.equal(parseInvite(null).ok, false);
  assert.equal(parseInvite([]).ok, false);
  assert.equal(parseInvite({ __proto__: { v: 1 } }).ok, false);
});

test('control messages are validated', () => {
  assert.deepEqual(parseControl('{"t":"bye"}'), { t: 'bye' });
  assert.equal(parseControl('{"t":"bye","x":1}'), null);
  assert.equal(parseControl('{"t":"state","mic":true,"cam":"yes"}'), null);
  assert.ok(parseControl(JSON.stringify({ t: 'reveal', na: b64u(32) })));
  assert.equal(parseControl(JSON.stringify({ t: 'reveal', na: b64u(16) })), null);
  assert.equal(parseControl('x'.repeat(600)), null);
  assert.equal(parseControl('not json'), null);
  assert.equal(parseControl('{"t":"eval"}'), null);
  assert.equal(parseControl(new ArrayBuffer(4)), null);
});

// ---------- SAS ----------
test('commitment binds the nonce and the session id', async () => {
  const sid = util.randomBytes(16);
  const na = util.randomBytes(32);
  const c = await makeCommit(sid, na);
  assert.equal(await checkCommit(sid, na, c), true);
  const na2 = na.slice();
  na2[0] ^= 1;
  assert.equal(await checkCommit(sid, na2, c), false);
  assert.equal(await checkCommit(util.randomBytes(16), na, c), false);
});

test('both sides derive the same code; any substituted input changes it', async () => {
  const base = {
    sid: util.randomBytes(16),
    offerFingerprint: inspectSdp(OFFER, 'offer').fingerprint,
    answerFingerprint: inspectSdp(ANSWER, 'answer').fingerprint,
    nonceA: util.randomBytes(32),
    nonceB: util.randomBytes(32),
  };
  const code = await deriveSas(base);
  assert.match(code, /^\d{6}$/);
  assert.equal(await deriveSas({ ...base }), code);
  // Lower-case fingerprints are canonicalised.
  assert.equal(
    await deriveSas({ ...base, offerFingerprint: { alg: 'SHA-256', value: base.offerFingerprint.value.toLowerCase() } }),
    code,
  );
  const variants = [
    { offerFingerprint: base.answerFingerprint, answerFingerprint: base.offerFingerprint }, // roles swapped
    { nonceA: util.randomBytes(32) },
    { nonceB: util.randomBytes(32) },
    { sid: util.randomBytes(16) },
  ];
  let changed = 0;
  for (const v of variants) if ((await deriveSas({ ...base, ...v })) !== code) changed++;
  // Each variant collides with probability 1e-6; treat any collision as failure.
  assert.equal(changed, variants.length);
});

test('codes are roughly uniform over 6 digits', async () => {
  const fp = inspectSdp(OFFER, 'offer').fingerprint;
  const firstDigit = new Array(10).fill(0);
  for (let i = 0; i < 2000; i++) {
    const c = await deriveSas({ sid: util.randomBytes(16), offerFingerprint: fp, answerFingerprint: fp, nonceA: util.randomBytes(32), nonceB: util.randomBytes(32) });
    firstDigit[+c[0]]++;
  }
  for (const n of firstDigit) assert.ok(n > 120 && n < 290, firstDigit.join(','));
});

// ---------- relay codes ----------
function relayCode(o) {
  return 'PCRELAY1:' + util.base64Encode(util.utf8Encode(JSON.stringify(o)));
}
test('relay codes are validated and expire', () => {
  const now = 1_800_000_000;
  const good = { u: ['turn:relay.example.org:3478?transport=udp', 'turns:relay.example.org:443?transport=tcp'], n: '1800003600:alice', c: 'abc', e: now + 3600 };
  const r = parseRelayCode(relayCode(good), now);
  assert.equal(r.ok, true);
  assert.equal(parseRelayCode(relayCode({ ...good, e: now - 1 }), now).error, 'relay-expired');
  assert.equal(parseRelayCode(relayCode({ ...good, u: ['http://evil.example'] }), now).ok, false);
  assert.equal(parseRelayCode(relayCode({ ...good, u: ['turn:a b'] }), now).ok, false);
  assert.equal(parseRelayCode(relayCode({ ...good, x: 1 }), now).ok, false);
  assert.equal(parseRelayCode('PCRELAY1:!!!', now).ok, false);
  const cfg = buildIceConfig({ useStun: false, relay: r.relay, relayOnly: true });
  assert.equal(cfg.iceTransportPolicy, 'relay');
  assert.equal(cfg.iceServers.length, 1);
  assert.equal(buildIceConfig({ useStun: true, relay: null, relayOnly: true }).iceTransportPolicy, 'all');
});
