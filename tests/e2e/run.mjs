#!/usr/bin/env node
// End-to-end tests: real WebRTC between separate Chromium processes, driving the
// built dist/PrivateCall.html through file:// exactly as a user would.
// Camera/microphone are Chromium's synthetic test devices (moving pattern + beep).
//
//   node tests/e2e/run.mjs            all tests
//   node tests/e2e/run.mjs mitm tamper  only tests whose name contains a word
//
// Observability without test hooks in the product: an init script (injected by
// the test runner, never shipped) records RTCPeerConnections and getUserMedia
// streams so the tests can inspect real WebRTC statistics.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodeEnvelope } from '../../src/app/codec.js';
import { inspectSdp, summarizeCandidates } from '../../src/app/sdp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const APP = 'file://' + path.join(ROOT, 'dist/PrivateCall.html');
const ATTACKER = 'file://' + path.join(HERE, 'attacker.html');
const SHOTS = path.join(ROOT, 'tests/e2e/screenshots');
const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
fs.mkdirSync(SHOTS, { recursive: true });

const INIT = () => {
  window.__pcs = [];
  window.__streams = [];
  window.__gum = [];
  window.__csp = [];
  window.__dialogs = 0;
  const RPC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(RPC, {
    construct(target, args) {
      const pc = new target(...args);
      window.__pcs.push(pc);
      return pc;
    },
  });
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    window.__gum.push(JSON.parse(JSON.stringify(c)));
    const s = await gum(c);
    window.__streams.push(s);
    return s;
  };
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
};

// ------------------------------------------------------------------ harness
const results = [];
const metrics = {};
const people = [];

async function person(name, { args = [], url = APP, clipboard = false } = {}) {
  const browser = await chromium.launch({ args: [...MEDIA_ARGS, ...args] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  if (clipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const p = { name, browser, context, page, requests: [], errors: [], dialogs: 0 };
  page.on('request', (r) => {
    if (!/^(file|data|blob):/.test(r.url())) p.requests.push(r.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') p.errors.push(m.text());
  });
  page.on('pageerror', (e) => p.errors.push('pageerror: ' + e.message));
  p.beforeunload = 0;
  page.on('dialog', (d) => {
    if (d.type() === 'beforeunload') {
      p.beforeunload++;
      d.accept().catch(() => {});
      return;
    }
    p.dialogs++;
    d.dismiss().catch(() => {});
  });
  await page.goto(url);
  people.push(p);
  return p;
}

async function closeAll() {
  while (people.length) {
    const p = people.pop();
    await p.browser.close().catch(() => {});
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
}

const checks = [];
function check(cond, msg) {
  checks.push((cond ? 'ok   ' : 'FAIL ') + msg);
  assert(cond, msg);
}

async function test(name, fn) {
  const filter = process.argv.slice(2);
  if (filter.length && !filter.some((f) => name.includes(f))) return;
  checks.length = 0;
  const t0 = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, checks: checks.slice() });
    for (const c of checks) console.log('   ' + c);
    console.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.stack || e), checks: checks.slice() });
    for (const c of checks) console.log('   ' + c);
    console.log(`✘ ${name}: ${e && e.message}`);
    for (const p of people) {
      await p.page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_')}-${p.name}.png`) }).catch(() => {});
    }
  } finally {
    // Every test must leave its pages free of network requests, errors and CSP violations.
    for (const p of people) {
      if (p.page.url().startsWith(APP)) {
        const csp = await p.page.evaluate(() => window.__csp).catch(() => []);
        if (p.requests.length || csp.length) {
          results[results.length - 1].ok = false;
          results[results.length - 1].error = `unexpected network/CSP activity on ${p.name}: ${JSON.stringify({ requests: p.requests, csp })}`;
          console.log('✘ ' + results[results.length - 1].error);
        }
        if (p.errors.length) console.log(`   (console errors on ${p.name}: ${p.errors.join(' | ')})`);
      }
    }
    await closeAll();
  }
}

// ------------------------------------------------------------------ app helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startCall(A, video = true) {
  await A.page.click('#btn-start');
  const t0 = Date.now();
  await A.page.click(video ? '#btn-start-video' : '#btn-start-audio');
  await A.page.waitForFunction(() => document.getElementById('invite-text').value.includes(':end'), null, { timeout: 25000 });
  metrics.inviteMs = Date.now() - t0;
  return A.page.inputValue('#invite-text');
}

async function pasteInvite(B, invite) {
  if (!(await B.page.isVisible('#screen-join'))) await B.page.click('#btn-join');
  await B.page.fill('#invite-in', invite);
}

async function joinCall(B, invite, video = true) {
  await pasteInvite(B, invite);
  await B.page.waitForSelector('#invite-summary:not([hidden])', { timeout: 5000 });
  const t0 = Date.now();
  await B.page.click(video ? '#join-cam' : '#join-mic');
  await B.page.waitForFunction(() => document.getElementById('reply-out-text').value.includes(':end'), null, { timeout: 25000 });
  metrics.replyMs = Date.now() - t0;
  return B.page.inputValue('#reply-out-text');
}

async function addReply(A, reply) {
  await A.page.fill('#reply-text', reply);
}

async function waitConnected(P, timeout = 30000) {
  await P.page.waitForSelector('#screen-call:not([hidden]) #call-connecting[hidden]', { timeout, state: 'attached' });
}

async function code(P, timeout = 30000) {
  await P.page.waitForFunction(() => document.querySelectorAll('#verify-code .digit-group').length === 2, null, { timeout });
  return P.page.evaluate(() => [...document.querySelectorAll('#verify-code .digit-group')].map((e) => e.textContent).join(''));
}

async function connectPair({ videoA = true, videoB = true } = {}) {
  const A = await person('A');
  const B = await person('B');
  const invite = await startCall(A, videoA);
  const reply = await joinCall(B, invite, videoB);
  const t0 = Date.now();
  await addReply(A, reply);
  await waitConnected(A);
  await waitConnected(B);
  metrics.connectMs = Date.now() - t0;
  return { A, B, invite, reply };
}

const stats = (P) =>
  P.page.evaluate(async () => {
    const pc = window.__pcs[window.__pcs.length - 1];
    const o = { conn: pc.connectionState, inAudioBytes: 0, inAudioEnergy: 0, inVideoFrames: 0, outVideoFrames: 0, outAudioBytes: 0 };
    const r = await pc.getStats();
    r.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        o.inAudioBytes = s.bytesReceived || 0;
        o.inAudioEnergy = s.totalAudioEnergy || 0;
      }
      if (s.type === 'inbound-rtp' && s.kind === 'video') o.inVideoFrames = s.framesDecoded || 0;
      if (s.type === 'outbound-rtp' && s.kind === 'video') o.outVideoFrames = s.framesEncoded || 0;
      if (s.type === 'outbound-rtp' && s.kind === 'audio') {
        o.outAudioBytes = s.bytesSent || 0;
        o.outAudioPackets = s.packetsSent || 0;
      }
      if (s.type === 'transport') {
        o.dtls = s.dtlsState;
        o.srtp = s.srtpCipher;
        o.tls = s.tlsVersion;
      }
    });
    const vt = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
    o.videoSender = vt && vt.sender.track ? vt.sender.track.readyState : null;
    const at = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
    o.audioSender = at && at.sender.track ? at.sender.track.readyState : null;
    o.liveDeviceTracks = window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').map((t) => t.kind);
    o.pcStates = window.__pcs.map((p) => p.connectionState);
    return o;
  });

const text = (P, sel) => P.page.textContent(sel);
const visible = (P, sel) => P.page.isVisible(sel);

async function energyDelta(P, ms = 2500) {
  const a = await stats(P);
  await sleep(ms);
  const b = await stats(P);
  return b.inAudioEnergy - a.inAudioEnergy;
}

async function framesDelta(P, ms = 2000) {
  const a = await stats(P);
  await sleep(ms);
  const b = await stats(P);
  return b.inVideoFrames - a.inVideoFrames;
}

// ------------------------------------------------------------------ tests
await test('video call: connect, verify, media gating, controls, hang up', async () => {
  const { A, B, invite, reply } = await connectPair();
  metrics.inviteChars = invite.length;
  metrics.replyChars = reply.length;
  const inv = await decodeEnvelope(invite);
  metrics.inviteCandidates = summarizeCandidates(inspectSdp(inv.payload.sdp, 'offer').candidates);

  const ca = await code(A);
  const cb = await code(B);
  check(/^\d{6}$/.test(ca), `A shows a 6-digit code (${ca})`);
  check(ca === cb, `both sides show the same code (${ca} / ${cb})`);
  check((await text(A, '#sec-chip-text')).includes('not verified'), 'status says "not verified" before confirmation');
  await A.page.screenshot({ path: path.join(SHOTS, 'call-verify.png') });

  // Media gating before verification
  await sleep(2500);
  let sa = await stats(A);
  let sb = await stats(B);
  check(sa.videoSender === null && sb.videoSender === null, 'no video track attached to either sender before confirmation');
  check(sa.inVideoFrames === 0 && sb.inVideoFrames === 0, 'no video frames received by either side before confirmation');
  check(sa.audioSender === null && sb.audioSender === null, 'no microphone track attached to either sender before confirmation');
  check(sa.inAudioBytes === 0 && sb.inAudioBytes === 0, `no audio received by either side before confirmation (bytes: ${sa.inAudioBytes}/${sb.inAudioBytes})`);
  check((await energyDelta(B)) === 0, 'B hears nothing from A before A opens the microphone');
  check(await visible(A, '#self-muted'), 'A sees its microphone shown as not sent');
  // Verification-only audio window
  await A.page.click('#btn-speak');
  await A.page.waitForSelector('#btn-speak[aria-pressed="true"]', { timeout: 3000 });
  check(true, '"Speak the code" opens a microphone window');
  check((await text(A, '#btn-speak-label')).startsWith('Microphone on'), 'button shows the countdown');
  await sleep(800);
  check((await energyDelta(B)) > 0.0001, 'B hears A while the window is open');
  await B.page.waitForFunction(() => document.getElementById('verify-remote-mic').textContent.includes('is on'), null, { timeout: 5000 });
  check(true, 'B is told A\'s microphone is on');
  await A.page.click('#btn-speak');
  await sleep(800);
  check((await stats(A)).audioSender === null, 'turning the window off detaches the microphone again');
  check((await energyDelta(B)) < 1e-6, 'B hears nothing after A closes the window');
  check(sa.srtp && sa.dtls === 'connected', `DTLS-SRTP in use (${sa.srtp}, ${sa.tls === 'FEFC' ? 'DTLS 1.3' : sa.tls})`);
  check(await visible(A, '#self-badge'), 'A sees "Not shared yet" on its own camera tile');

  // A confirms first
  await A.page.click('#btn-match');
  await B.page.waitForSelector('#verify-remote:not([hidden])', { timeout: 5000 });
  check(true, 'B is told the other side confirmed');
  check((await text(A, '#sec-chip-text')).includes('verified') && !(await text(A, '#sec-chip-text')).includes('not'), 'A status becomes "verified"');
  await sleep(2500);
  check((await stats(A)).videoSender === 'live', 'A starts sending video after confirming');
  check((await stats(B)).inVideoFrames > 0, 'B receives A\'s video');
  check((await stats(A)).inVideoFrames === 0, 'A still receives no video (B has not confirmed)');
  await B.page.waitForSelector('#remote-video:not([hidden])', { timeout: 5000 });
  check(true, 'B shows A\'s video');

  await B.page.click('#btn-match');
  await A.page.waitForSelector('#remote-video:not([hidden])', { timeout: 8000 });
  check((await framesDelta(A)) > 10, 'A receives B\'s video after B confirms');
  await A.page.screenshot({ path: path.join(SHOTS, 'call-active.png') });

  // Microphone
  check((await energyDelta(B)) > 0.0001, 'B hears A (audio energy rising)');
  await A.page.click('#ctl-mic');
  await sleep(600);
  check((await A.page.getAttribute('#ctl-mic', 'aria-pressed')) === 'false', 'mic button shows off state');
  const muted = await energyDelta(B);
  check(muted < 1e-6, `B receives silence while A is muted (energy delta ${muted.toExponential(1)})`);
  await A.page.keyboard.press('m');
  await sleep(600);
  check((await energyDelta(B)) > 0.0001, 'pressing M unmutes A again');

  // Camera
  await A.page.click('#ctl-cam');
  await sleep(800);
  sa = await stats(A);
  check(sa.videoSender === null, 'turning the camera off detaches video from the sender');
  check(!sa.liveDeviceTracks.includes('video'), 'and releases the camera device (track stopped)');
  await B.page.waitForSelector('#remote-placeholder:not([hidden])', { timeout: 5000 });
  check((await text(B, '#remote-placeholder-text')).includes('camera is off'), 'B is shown "Their camera is off"');
  await A.page.click('#ctl-cam');
  await sleep(2500);
  check((await stats(A)).videoSender === 'live', 'camera can be turned on again (no new exchange needed)');
  check((await framesDelta(B)) > 10, 'B receives video again');

  // Details dialog renders
  await A.page.click('#ctl-details');
  const details = await text(A, '#details-list');
  check(details.includes('Matches the security code'), 'details: certificate check matched getStats DTLS certificates');
  check(details.includes('DTLS-SRTP'), 'details: encryption shown');
  await A.page.screenshot({ path: path.join(SHOTS, 'call-details.png') });
  await A.page.keyboard.press('Escape');

  // Hang up
  await A.page.click('#ctl-hangup');
  await A.page.waitForSelector('#screen-ended:not([hidden])');
  await B.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 8000 });
  check((await text(A, '#ended-body')).includes('You left'), 'A: "You left the call."');
  check((await text(B, '#ended-body')).includes('other person left'), 'B: "The other person left the call."');
  await B.page.screenshot({ path: path.join(SHOTS, 'ended-remote.png') });
  sa = await A.page.evaluate(() => ({ live: window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length, pcs: window.__pcs.map((p) => p.connectionState) }));
  sb = await B.page.evaluate(() => ({ live: window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length, pcs: window.__pcs.map((p) => p.connectionState) }));
  check(sa.live === 0 && sb.live === 0, 'all camera/microphone tracks stopped on both sides');
  check(sa.pcs.every((s) => s === 'closed') && sb.pcs.every((s) => s === 'closed'), 'all peer connections closed on both sides');
  check((await A.page.inputValue('#invite-text')) === '', 'invitation text removed from the page after the call');
});

await test('voice call: no camera requested, camera prompt before verification', async () => {
  const A = await person('A');
  const B = await person('B');
  const invite = await startCall(A, false);
  await pasteInvite(B, invite);
  await B.page.waitForSelector('#invite-summary:not([hidden])');
  check(!(await visible(B, '#join-cam')), 'joining a voice call offers microphone only');
  check((await text(B, '#invite-kind')) === 'Voice call invitation', 'invitation is recognised as a voice call');
  await B.page.screenshot({ path: path.join(SHOTS, 'join-summary.png') });
  await B.page.click('#join-mic');
  await B.page.waitForFunction(() => document.getElementById('reply-out-text').value.includes(':end'));
  await B.page.screenshot({ path: path.join(SHOTS, 'join-reply.png') });
  await addReply(A, await B.page.inputValue('#reply-out-text'));
  await waitConnected(A);
  await waitConnected(B);
  const gumA = await A.page.evaluate(() => window.__gum);
  const gumB = await B.page.evaluate(() => window.__gum);
  check(gumA.every((c) => !c.video) && gumB.every((c) => !c.video), 'camera never requested on either side');
  check((await code(A)) === (await code(B)), 'codes match');
  check((await text(A, '#remote-placeholder-text')).includes('Voice call'), 'remote shown as voice call');

  // Turning on the camera before verifying asks first; "Wait" keeps it local.
  await B.page.click('#ctl-cam');
  await B.page.waitForSelector('#dlg-cam[open]');
  check(true, 'B is warned before sharing camera unverified');
  await B.page.screenshot({ path: path.join(SHOTS, 'camera-warning.png') });
  await B.page.click('#dlg-cam button[value="no"]');
  await sleep(2000);
  check((await stats(B)).liveDeviceTracks.includes('video'), '"Wait": camera opens locally');
  check((await stats(B)).videoSender === null, '"Wait": but nothing is sent');
  check((await stats(A)).inVideoFrames === 0, 'A receives no video');
  await B.page.click('#btn-match');
  await sleep(2500);
  check((await stats(A)).inVideoFrames > 0, 'after B confirms, A receives B\'s video (no new exchange needed)');
  await B.page.click('#ctl-hangup');
  await A.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 8000 });
  check(true, 'A sees the call end');
});

async function mitmCall({ forgeCommit = false, revealMode = 'forward', video = true } = {}) {
  const A = await person('A');
  const B = await person('B');
  const M = await person('M', { args: ['--allow-file-access-from-files'], url: ATTACKER });
  await M.page.waitForFunction(() => window.M && window.M.ready);
  await M.page.evaluate((m) => (window.M.revealMode = m), revealMode);
  const invite = await startCall(A, video);
  const forgedInvite = await M.page.evaluate(([t, f]) => window.M.interceptInvite(t, { forgeCommit: f }), [invite, forgeCommit]);
  const reply = await joinCall(B, forgedInvite, video);
  const forgedReply = await M.page.evaluate((t) => window.M.interceptReply(t), reply);
  await addReply(A, forgedReply);
  return { A, B, M };
}
const attackerGot = (M) => M.page.evaluate(() => window.M.received());

await test('mitm: substituted certificates give different codes; nothing leaks before verification', async () => {
  const { A, B, M } = await mitmCall();
  await waitConnected(A);
  await waitConnected(B);
  check(true, 'both victims connect (to the attacker) and the call appears to work');
  const ca = await code(A);
  const cb = await code(B);
  check(ca !== cb, `codes differ (${ca} vs ${cb})`);
  const log = await M.page.evaluate(() => window.M.log);
  check(log.some((l) => l.startsWith('A->B') && l.includes('reveal')), 'attacker relayed the reveal message (commitment check passed on B)');
  await sleep(4000);
  let got = await attackerGot(M);
  check(got.fromA.audioBytes === 0 && got.fromB.audioBytes === 0, `attacker received no audio from either victim before verification (${got.fromA.audioBytes}/${got.fromB.audioBytes} bytes)`);
  check(got.fromA.videoFrames === 0 && got.fromB.videoFrames === 0, 'attacker received no video from either victim');
  // A opens the verification microphone window: only then does A's audio reach the attacker.
  await A.page.click('#btn-speak');
  await sleep(2500);
  got = await attackerGot(M);
  check(got.fromA.audioBytes > 0 && got.fromB.audioBytes === 0, 'during A\'s "Speak the code" window the attacker receives A\'s audio only (expected: this is what the window is for)');
  check(got.fromA.videoFrames === 0, 'still no video');
  await A.page.click('#btn-nomatch');
  await A.page.waitForSelector('#screen-ended:not([hidden])');
  check((await text(A, '#ended-title')) === 'Call ended for your safety', 'pressing "They don\'t match" ends the call with a safety warning');
  const live = await A.page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length);
  check(live === 0, 'devices released');
  await A.page.screenshot({ path: path.join(SHOTS, 'ended-mismatch.png') });
});

await test('mitm: reveal replaced with another value (e.g. replayed from an older call)', async () => {
  const { B } = await mitmCall({ revealMode: 'replace' });
  await B.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 30000 });
  check((await text(B, '#ended-title')) === 'Security check failed', 'B ends the call: "Security check failed"');
});

await test('mitm: reveal withheld', async () => {
  const { B } = await mitmCall({ revealMode: 'drop', video: false });
  await waitConnected(B);
  const t0 = Date.now();
  await B.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 40000 });
  check((await text(B, '#ended-title')) === 'Security check failed', `B gives up after ${((Date.now() - t0) / 1000).toFixed(0)} s with "Security check failed"`);
  check(!(await B.page.evaluate(() => document.querySelectorAll('#verify-code .digit-group').length)), 'B never showed a code');
});

await test('mitm: injected control messages cannot verify, unlock media or crash the app', async () => {
  const { A, B, M } = await mitmCall();
  await waitConnected(A);
  await waitConnected(B);
  const cb = await code(B);
  const ca = await code(A);
  await M.page.evaluate(() => window.M.inject('B', [{ t: 'confirmed' }, { t: 'state', mic: true, cam: true }]));
  await M.page.evaluate(() => window.M.inject('A', [{ t: 'reveal', na: 'A'.repeat(43) }, { t: 'confirmed' }]));
  const sent = await M.page.evaluate(() => window.M.flood('B', 2000) + window.M.flood('A', 2000));
  await sleep(2500);
  check((await text(B, '#sec-chip-text')) === 'Encrypted · not verified', 'a forged "confirmed" message does not verify B');
  const sb = await stats(B);
  check(sb.audioSender === null && sb.videoSender === null, 'and does not unlock B\'s microphone or camera');
  check(await visible(B, '#verify-remote'), 'it is shown only as information ("They confirmed")');
  check((await code(A)) === ca && (await code(B)) === cb, 'a reveal sent to the starting side is ignored; codes unchanged');
  check(await visible(A, '#screen-call') && await visible(B, '#screen-call'), `${sent} malformed messages later, both calls are still running`);
  check(A.errors.length === 0 && B.errors.length === 0, 'no script errors on either side');
});

await test('limit: impersonation is not detected by the code (documented)', async () => {
  const A = await person('A');
  const M = await person('M', { args: ['--allow-file-access-from-files'], url: ATTACKER });
  await M.page.waitForFunction(() => window.M && window.M.ready);
  const invite = await startCall(A, false);
  const fake = await M.page.evaluate((t) => window.M.impersonate(t), invite);
  await addReply(A, fake);
  await waitConnected(A);
  const ca = await code(A);
  const cm = await M.page.evaluate(() => window.M.impersonatorCode());
  check(ca === cm, `someone who receives the invitation and answers it themselves sees the same code (${ca} = ${cm}): the code proves no one is in the middle, not who the other person is`);
});

await test('mitm: forged commitment is detected automatically', async () => {
  const A = await person('A');
  const B = await person('B');
  const M = await person('M', { args: ['--allow-file-access-from-files'], url: ATTACKER });
  await M.page.waitForFunction(() => window.M && window.M.ready);
  const invite = await startCall(A, true);
  const forgedInvite = await M.page.evaluate((t) => window.M.interceptInvite(t, { forgeCommit: true }), invite);
  const reply = await joinCall(B, forgedInvite, true);
  const forgedReply = await M.page.evaluate((t) => window.M.interceptReply(t), reply);
  await addReply(A, forgedReply);
  await B.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 30000 });
  check((await text(B, '#ended-title')) === 'Security check failed', 'B ends the call: "Security check failed"');
  check(!(await B.page.evaluate(() => document.querySelectorAll('#verify-code .digit-group').length)), 'B never showed a code');
});

await test('tamper: modified messages with valid checksums', async () => {
  const A = await person('A');
  const B = await person('B');
  const M = await person('M', { args: ['--allow-file-access-from-files'], url: ATTACKER });
  await M.page.waitForFunction(() => window.M && window.M.ready);
  const invite = await startCall(A, true);
  for (const how of ['two-fingerprints', 'extra-field', 'bad-media']) {
    const bad = await M.page.evaluate(([t, h]) => window.M.tamper(t, h), [invite, how]);
    await pasteInvite(B, bad);
    await B.page.waitForSelector('#invite-error:not([hidden])', { timeout: 5000 });
    check((await text(B, '#invite-error')).includes('isn’t valid'), `invitation with ${how} is rejected`);
  }
  const rejected = await M.page.evaluate(([t]) => window.M.tamper(t, 'browser-rejects'), [invite]);
  await pasteInvite(B, rejected);
  await B.page.waitForSelector('#invite-summary:not([hidden])', { timeout: 5000 });
  await B.page.click('#join-mic');
  await B.page.waitForSelector('#join-error:not([hidden])', { timeout: 30000 });
  check((await text(B, '#join-error')).includes('isn’t valid'), 'SDP the WebRTC engine rejects gives a clear "isn’t valid" message');
  check((await B.page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length)) === 0, 'and the microphone is released');
  await B.page.reload();
  const xss = await M.page.evaluate(([t]) => window.M.tamper(t, 'script-in-sdp'), [invite]);
  await pasteInvite(B, xss);
  await sleep(1500);
  check(B.dialogs === 0 && (await B.page.evaluate(() => window.__csp.length)) === 0, 'markup inside SDP is never rendered or executed');

  // A reply for a different invitation (wrong session id) is refused, and A keeps waiting.
  await B.page.reload();
  const goodReply = await joinCall(B, invite, true);
  const wrongSid = await M.page.evaluate(([t]) => window.M.tamper(t, 'swap-sid'), [goodReply]);
  await addReply(A, wrongSid);
  await A.page.waitForSelector('#reply-error:not([hidden])');
  check((await text(A, '#reply-error')).includes('different invitation'), 'reply with another session ID is refused');
  await addReply(A, goodReply);
  await waitConnected(A);
  check((await code(A)) === (await code(B)), 'the genuine reply still works afterwards');
});

await test('tamper: certificate fingerprint swapped in transit (no SAS bypass)', async () => {
  const A = await person('A');
  const B = await person('B');
  const M = await person('M', { args: ['--allow-file-access-from-files'], url: ATTACKER });
  await M.page.waitForFunction(() => window.M && window.M.ready);
  const invite = await startCall(A, true);
  const bad = await M.page.evaluate(([t]) => window.M.tamper(t, 'swap-fingerprint'), [invite]);
  const reply = await joinCall(B, bad, true);
  await addReply(A, reply);
  await A.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 60000 });
  check((await text(A, '#ended-title')) === 'Couldn’t connect', 'DTLS refuses the connection; A sees "Couldn’t connect"');
  check(!(await B.page.evaluate(() => document.querySelectorAll('#verify-code .digit-group').length)), 'no code was ever shown');
  check(await visible(A, '#ended-tips'), 'failure screen shows things to try');
  await A.page.screenshot({ path: path.join(SHOTS, 'ended-failed.png') });
});

await test('input errors: wrong kind, truncated, corrupted, oversized, garbage', async () => {
  const A = await person('A');
  const B = await person('B');
  const invite = await startCall(A, false);
  const reply = await joinCall(B, invite, false);
  const C = await person('C');
  const cases = [
    ['reply pasted as invitation', reply, 'This is a reply'],
    ['truncated (last lines lost)', invite.split('\n').slice(0, -3).join('\n'), 'Part of the message is missing'],
    ['truncated (middle lines lost)', invite.split('\n').filter((_, i) => i !== 6).join('\n'), 'damaged'],
    ['one character changed', invite.replace(/(PrivateCall\.invite\.v1:\n.{20})(.)/, (m, a, c) => a + (c === 'A' ? 'B' : 'A')), 'damaged'],
    ['oversized (50 000 characters)', invite + 'x'.repeat(50000), 'too large'],
    ['unrelated text', 'hello, here is the link https://example.com', 'doesn’t look like'],
    ['newer protocol version', invite.replace('.v1:', '.v9:'), 'newer version'],
  ];
  await C.page.click('#btn-join');
  for (const [label, input, expect] of cases) {
    await C.page.fill('#invite-in', '');
    await C.page.waitForSelector('#invite-error', { state: 'hidden' });
    await C.page.fill('#invite-in', input);
    await C.page.waitForSelector('#invite-error:not([hidden])', { timeout: 5000 });
    const msg = await text(C, '#invite-error');
    check(msg.includes(expect), `${label}: "${msg.slice(0, 70)}…"`);
    check(!(await visible(C, '#invite-summary')), `${label}: join buttons stay hidden`);
  }
  await C.page.fill('#invite-in', invite.replace(/(PrivateCall\.invite\.v1:\n.{20})(.)/, (m, a, c) => a + (c === 'A' ? 'B' : 'A')));
  await C.page.screenshot({ path: path.join(SHOTS, 'join-error.png') });
  await addReply(A, invite);
  await A.page.waitForSelector('#reply-error:not([hidden])');
  check((await text(A, '#reply-error')).includes('invitation, not a reply'), 'invitation pasted as reply is recognised');

  // Large file through the file picker
  const bigFile = path.join(os.tmpdir(), 'pc-big.txt');
  fs.writeFileSync(bigFile, 'A'.repeat(100 * 1024));
  const [chooser] = await Promise.all([C.page.waitForEvent('filechooser'), C.page.click('#invite-file')]);
  await chooser.setFiles(bigFile);
  await C.page.waitForSelector('#toast:not([hidden])');
  check((await text(C, '#toast')).includes('too large'), 'a 100 KB file is refused before reading');
  const binFile = path.join(os.tmpdir(), 'pc-bin.txt');
  fs.writeFileSync(binFile, Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37) % 256)));
  const [chooser2] = await Promise.all([C.page.waitForEvent('filechooser'), C.page.click('#invite-file')]);
  await chooser2.setFiles(binFile);
  await C.page.waitForSelector('#invite-error:not([hidden])');
  check((await text(C, '#invite-error')).includes('doesn’t look like'), 'a binary file is reported as not an invitation');
});

await test('replay: invitations and replies work once', async () => {
  const A = await person('A');
  const B = await person('B');
  const invite = await startCall(A, false);
  const reply1 = await joinCall(B, invite, false);
  await B.page.click('#join-cancel');
  await B.page.waitForSelector('#screen-welcome:not([hidden])');
  await pasteInvite(B, invite);
  await B.page.waitForSelector('#invite-error:not([hidden])');
  check((await text(B, '#invite-error')).includes('already used'), 'the same invitation cannot be joined twice in one window');

  // A starts over; the old reply must not be accepted for the new invitation.
  await A.page.click('#start-cancel');
  await A.page.waitForSelector('#screen-welcome:not([hidden])');
  await startCall(A, false);
  await addReply(A, reply1);
  await A.page.waitForSelector('#reply-error:not([hidden])');
  check((await text(A, '#reply-error')).includes('different invitation'), 'a reply to an earlier invitation is refused');
});

await test('files: save invitation, open it, drag-and-drop reply', async () => {
  const A = await person('A');
  const B = await person('B');
  const invite = await startCall(A, true);
  const [download] = await Promise.all([A.page.waitForEvent('download'), A.page.click('#invite-save')]);
  const file = path.join(os.tmpdir(), download.suggestedFilename());
  await download.saveAs(file);
  check(download.suggestedFilename() === 'PrivateCall-invitation.txt', 'download is named PrivateCall-invitation.txt');
  check(fs.readFileSync(file, 'utf8') === invite, 'saved file contains exactly the invitation');
  check((await A.page.getAttribute('#start-step1', 'class')).includes('is-done'), 'step 1 is marked done after saving');

  // Dropping the file on the welcome screen goes straight to "Join".
  const content = fs.readFileSync(file, 'utf8');
  await B.page.evaluate((txt) => {
    const dt = new DataTransfer();
    dt.items.add(new File([txt], 'PrivateCall-invitation.txt', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, content);
  await B.page.waitForSelector('#invite-summary:not([hidden])', { timeout: 5000 });
  check(true, 'dropping the invitation file on the welcome screen opens "Join" with it');
  await B.page.click('#join-cam');
  await B.page.waitForFunction(() => document.getElementById('reply-out-text').value.includes(':end'));
  const reply = await B.page.inputValue('#reply-out-text');
  await A.page.evaluate((txt) => {
    const dt = new DataTransfer();
    dt.items.add(new File([txt], 'PrivateCall-reply.txt', { type: 'text/plain' }));
    document.getElementById('reply-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, reply);
  await waitConnected(A);
  check(true, 'dropping the reply file connects the call');
});

await test('clipboard: copy and paste buttons', async () => {
  const A = await person('A', { clipboard: true });
  const invite = await startCall(A, false);
  await A.page.click('#invite-copy');
  await A.page.waitForSelector('#toast:not([hidden])');
  const toastText = await text(A, '#toast');
  const clip = await A.page.evaluate(() => navigator.clipboard.readText()).catch((e) => 'ERR ' + e.message);
  check(toastText.startsWith('Invitation copied') && clip === invite, 'Copy puts the exact invitation on the clipboard (permission granted)');
  const B = await person('B', { clipboard: true });
  await B.page.evaluate((t) => navigator.clipboard.writeText(t), invite);
  await B.page.click('#btn-join');
  await B.page.click('#invite-paste');
  await B.page.waitForSelector('#invite-summary:not([hidden])');
  check(true, 'Paste button reads the invitation from the clipboard');

  const C = await person('C'); // no clipboard permission granted
  await startCall(C, false);
  await C.page.click('#invite-copy');
  await C.page.waitForSelector('#toast:not([hidden])');
  const t2 = await text(C, '#toast');
  check(t2.startsWith('Invitation copied') || t2.startsWith('Couldn’t copy'), `without permission, copy falls back and tells the user ("${t2.slice(0, 40)}…")`);
  metrics.copyWithoutPermission = t2.slice(0, 40);
});

await test('failure: reply from a closed window shows "Couldn’t connect"', async () => {
  const A = await person('A');
  const B = await person('B');
  const invite = await startCall(A, false);
  const reply = await joinCall(B, invite, false);
  await B.browser.close();
  const t0 = Date.now();
  await addReply(A, reply);
  await A.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 60000 });
  metrics.failDetectMs = Date.now() - t0;
  check((await text(A, '#ended-title')) === 'Couldn’t connect', `A shows "Couldn’t connect" after ${(metrics.failDetectMs / 1000).toFixed(0)} s`);
  check((await text(A, '#ended-diag')).startsWith('What your computer found'), 'diagnostics summary shown: ' + (await text(A, '#ended-diag')));
  check((await A.page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length)) === 0, 'microphone released');
});

await test('remote reload during a call ends it cleanly on the other side', async () => {
  const { A, B } = await connectPair({ videoA: false, videoB: false });
  await code(A);
  const t0 = Date.now();
  await B.page.reload();
  check(B.beforeunload === 1, 'B was asked to confirm leaving during the call');
  await A.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 40000 });
  check((await text(A, '#ended-body')).includes('other person left'), `A notices within ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check((await A.page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length)) === 0, 'A released its devices');
});

await test('verification UI: check later, reopen, unverified status', async () => {
  const { A } = await connectPair({ videoA: true, videoB: true });
  await code(A);
  await A.page.click('#btn-later');
  check(!(await visible(A, '#verify')), '"Check later" hides the code panel');
  check((await text(A, '#sec-chip-text')) === 'Encrypted · not verified', 'status stays "Encrypted · not verified"');
  check((await stats(A)).videoSender === null, 'video stays held while unverified');
  await A.page.click('#sec-chip');
  check(await visible(A, '#verify'), 'clicking the status reopens the code');
});

await test('settings: relay codes, relay-only mode, helper servers off', async () => {
  const A = await person('A');
  await A.page.click('#btn-settings');
  await A.page.fill('#set-relay', 'PCRELAY1:nonsense');
  await A.page.click('#set-relay-add');
  check((await text(A, '#relay-error')).includes('isn’t valid'), 'invalid relay code rejected');
  const code = Buffer.from(JSON.stringify({ u: ['turn:127.0.0.1:9?transport=udp'], n: 'x', c: 'y', e: Math.floor(Date.now() / 1000) + 3600, l: 'test' })).toString('base64').replace(/=+$/, '');
  await A.page.fill('#set-relay', 'PCRELAY1:' + code);
  await A.page.click('#set-relay-add');
  check((await text(A, '#relay-active-text')).startsWith('Relay added (test)'), 'valid relay code accepted');
  check(!(await A.page.isDisabled('#set-relay-only')), 'relay-only option enabled once a relay exists');
  await A.page.check('#set-relay-only');
  await A.page.uncheck('#set-stun');
  await A.page.screenshot({ path: path.join(SHOTS, 'settings.png') });
  await A.page.click('#dlg-settings button[value="done"]');
  await A.page.click('#btn-start');
  await A.page.click('#btn-start-audio');
  await A.page.waitForSelector('#start-error:not([hidden])', { timeout: 20000 });
  check((await text(A, '#start-error')).includes('relay server couldn’t be reached'), 'unreachable relay in relay-only mode is reported before anything is sent');
  check((await A.page.inputValue('#invite-text')) === '', 'no invitation produced');

  // Helper servers off, no relay: only local addresses are offered.
  await A.page.click('#btn-settings');
  await A.page.click('#set-relay-remove');
  await A.page.click('#dlg-settings button[value="done"]');
  await A.page.click('#start-back');
  const invite = await startCall(A, false);
  const d = await decodeEnvelope(invite);
  const sum = summarizeCandidates(inspectSdp(d.payload.sdp, 'offer').candidates);
  check(sum.srflx === 0 && sum.relay === 0 && sum.host > 0, `with helper servers off, only local candidates are offered (${JSON.stringify(sum)})`);
  const servers = await A.page.evaluate(() => window.__pcs.map((p) => p.getConfiguration().iceServers.length));
  check(servers[servers.length - 1] === 0, 'no STUN/TURN servers configured on the connection');
});

await test('slow exchange: reply added 60 s after it was created', async () => {
  const A = await person('A');
  const B = await person('B');
  const invite = await startCall(A, false);
  const reply = await joinCall(B, invite, false);
  await sleep(60000);
  await addReply(A, reply);
  await waitConnected(A);
  check((await code(A)) === (await code(B)), 'connects and verifies after a 60 s delay (same machine; no NAT involved)');
});

await test('layout: right-to-left rendering and narrow window', async () => {
  const A = await person('A');
  await A.page.evaluate(() => (document.documentElement.dir = 'rtl'));
  await A.page.screenshot({ path: path.join(SHOTS, 'rtl-welcome.png') });
  await startCall(A, true);
  await A.page.screenshot({ path: path.join(SHOTS, 'rtl-start.png') });
  await A.page.setViewportSize({ width: 760, height: 900 });
  await A.page.evaluate(() => (document.documentElement.dir = 'ltr'));
  await A.page.screenshot({ path: path.join(SHOTS, 'narrow-start.png'), fullPage: true });
  const overflow = await A.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check(!overflow, 'no horizontal overflow at 760 px');
});

// ------------------------------------------------------------------ report
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} tests passed`);
console.log('metrics:', JSON.stringify(metrics));
const browserVersion = await (async () => {
  const b = await chromium.launch();
  const v = b.version();
  await b.close();
  return v;
})();
fs.writeFileSync(
  path.join(HERE, 'results.json'),
  JSON.stringify({ date: new Date().toISOString(), browser: 'Chromium ' + browserVersion, platform: `${os.platform()} ${os.release()}`, metrics, results }, null, 2),
);
process.exit(passed === results.length ? 0 : 1);
