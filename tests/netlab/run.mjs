#!/usr/bin/env node
// Network-lab tests: real PrivateCall calls between two Chromium instances, each
// running inside its own Linux network namespace behind a simulated NAT router,
// with a real STUN/TURN server (pion/turn) on a simulated public network.
//
// Requirements: Linux, root, iproute2 `ip`, iptables, openssl, and the relay
// binary built from tests/netlab/relayserver (see tests/netlab/README.md).
//
//   sudo node tests/netlab/run.mjs [name filter...]
//
// Test-only adjustments (none of these are in the product):
//  * The app's default public STUN servers (Google, Cloudflare) do not exist in the
//    lab, so an init script rewrites them to the lab STUN server (192.0.2.10).
//    Tests that model "public STUN unreachable" skip this rewrite.
//  * The lab relay uses a self-signed TLS certificate; Chromium (correctly) rejects
//    it for turns:, so the TLS test passes --ignore-certificate-errors to the
//    browser that uses it, and a separate test shows the rejection.
//  * --no-proxy-server stops the sandbox's HTTP proxy settings from leaking in
//    (Chromium tunnels TURN/TCP through a configured proxy).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lab from './lab.mjs';
import { decodeEnvelope } from '../../src/app/codec.js';
import { inspectSdp, summarizeCandidates } from '../../src/app/sdp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const APP = 'file://' + path.join(ROOT, 'dist/PrivateCall.html');
const RELAY_BIN = process.env.RELAY_BIN || '/tmp/relayserver';
const SHOTS = path.join(HERE, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const R = lab.ADDR.relay;

const INIT = (rewriteStun) => {
  window.__pcs = [];
  window.__streams = [];
  const RPC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(RPC, {
    construct(target, args) {
      const cfg = args[0] ? { ...args[0] } : {};
      if (rewriteStun && cfg.iceServers) {
        cfg.iceServers = cfg.iceServers.map((s) => ({
          ...s,
          urls: [...new Set([].concat(s.urls).map((u) => (/^stun:stun\.(l\.google|cloudflare)\.com/.test(u) ? 'stun:192.0.2.10:3478' : u)))],
        }));
      }
      const pc = new target(cfg, ...args.slice(1));
      window.__pcs.push(pc);
      return pc;
    },
  });
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await gum(c);
    window.__streams.push(s);
    return s;
  };
};

// ------------------------------------------------------------------ harness
const results = [];
const metrics = {};
const people = [];
let relay = null;
const checks = [];
function check(cond, msg) {
  checks.push((cond ? 'ok   ' : 'FAIL ') + msg);
  if (!cond) throw new Error('Assertion failed: ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function person(site, { rewriteStun = true, args = [] } = {}) {
  const browser = await chromium.launch({
    executablePath: lab.browserWrapper(site, chromium.executablePath()),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-proxy-server', ...args],
  });
  metrics.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await context.addInitScript(INIT, rewriteStun);
  const page = await context.newPage();
  const p = { name: site, browser, page, errors: [] };
  page.on('pageerror', (e) => p.errors.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(APP);
  people.push(p);
  return p;
}

async function test(name, topo, fn) {
  const filter = process.argv.slice(2);
  if (filter.length && !filter.some((f) => name.includes(f))) return;
  checks.length = 0;
  const t0 = Date.now();
  console.log(`\n▶ ${name}  [A: ${topo.natA}, B: ${topo.natB}]`);
  try {
    lab.setup(topo);
    relay = lab.startRelay(RELAY_BIN);
    await sleep(700);
    await fn();
    results.push({ name, topo, ok: true, ms: Date.now() - t0, checks: checks.slice() });
    for (const c of checks) console.log('   ' + c);
    console.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, topo, ok: false, ms: Date.now() - t0, error: String((e && e.stack) || e), checks: checks.slice() });
    for (const c of checks) console.log('   ' + c);
    console.log(`✘ ${name}: ${e && e.message}`);
    for (const p of people) await p.page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_')}-${p.name}.png`) }).catch(() => {});
  } finally {
    while (people.length) await people.pop().browser.close().catch(() => {});
    if (relay) relay.stop();
    relay = null;
    await sleep(300);
    lab.teardown();
  }
}

function relayCode({ urls, hours = 1, label = 'lab' }) {
  return execFileSync(process.execPath, [path.join(ROOT, 'tools/make-relay-code.mjs'), ...urls.flatMap((u) => ['--url', u]), '--hours', String(hours), '--label', label], {
    env: { ...process.env, PRIVATECALL_TURN_SECRET: relay.secret },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
}

async function addRelay(P, code, relayOnly = false) {
  await P.page.click('#btn-settings');
  await P.page.fill('#set-relay', code);
  await P.page.click('#set-relay-add');
  await P.page.waitForSelector('#relay-active:not([hidden])');
  if (relayOnly) await P.page.check('#set-relay-only');
  await P.page.click('#dlg-settings button[value="done"]');
}

async function startCall(P, video = false) {
  await P.page.click('#btn-start');
  const t0 = Date.now();
  await P.page.click(video ? '#btn-start-video' : '#btn-start-audio');
  await P.page.waitForFunction(() => document.getElementById('invite-text').value.includes(':end') || !document.getElementById('start-error').hidden, null, { timeout: 45000 });
  const text = await P.page.inputValue('#invite-text');
  return { text, ms: Date.now() - t0 };
}

async function joinCall(P, invite) {
  await P.page.click('#btn-join');
  await P.page.fill('#invite-in', invite);
  await P.page.waitForSelector('#invite-summary:not([hidden])');
  const t0 = Date.now();
  await P.page.click('#join-mic');
  await P.page.waitForFunction(() => document.getElementById('reply-out-text').value.includes(':end'), null, { timeout: 45000 });
  return { text: await P.page.inputValue('#reply-out-text'), ms: Date.now() - t0 };
}

const connected = (P, timeout = 50000) => P.page.waitForSelector('#screen-call:not([hidden]) #call-connecting[hidden]', { timeout, state: 'attached' });
const code = async (P) => {
  await P.page.waitForFunction(() => document.querySelectorAll('#verify-code .digit-group').length === 2, null, { timeout: 30000 });
  return P.page.evaluate(() => [...document.querySelectorAll('#verify-code .digit-group')].map((e) => e.textContent).join(''));
};
const text = (P, sel) => P.page.textContent(sel);

const pathInfo = (P) =>
  P.page.evaluate(async () => {
    const pc = window.__pcs[window.__pcs.length - 1];
    const r = await pc.getStats();
    let pair = null;
    const remotes = [];
    r.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = r.get(s.selectedCandidatePairId);
      if (s.type === 'remote-candidate') remotes.push(s.address || s.ip);
    });
    let inAudio = 0;
    r.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') inAudio = s.totalAudioEnergy || 0;
    });
    if (!pair) return { remotes, inAudio };
    const l = r.get(pair.localCandidateId);
    const rc = r.get(pair.remoteCandidateId);
    return {
      local: `${l.candidateType}/${l.protocol}${l.relayProtocol ? '/' + l.relayProtocol : ''} ${l.address}`,
      remote: `${rc.candidateType}/${rc.protocol} ${rc.address}`,
      localType: l.candidateType,
      remoteType: rc.candidateType,
      relayProtocol: l.relayProtocol || null,
      rtt: pair.currentRoundTripTime,
      remotes,
      inAudio,
    };
  });

function inviteSummary(t) {
  return decodeEnvelope(t).then((d) => {
    const info = inspectSdp(d.payload.sdp, d.kind === 'invite' ? 'offer' : 'answer');
    return { sum: summarizeCandidates(info.candidates), addresses: info.candidates.map((c) => `${c.type}:${c.protocol}:${c.address}`) };
  });
}

async function confirmBoth(A, B) {
  await A.page.click('#btn-match');
  await B.page.click('#btn-match');
}

async function audioFlows(P) {
  const a = (await pathInfo(P)).inAudio;
  await sleep(2000);
  return (await pathInfo(P)).inAudio - a > 0.0001;
}

// ------------------------------------------------------------------ tests

await test('home NATs: direct connection through STUN', { natA: 'cone', natB: 'cone' }, async () => {
  const A = await person('A');
  const B = await person('B');
  const inv = await startCall(A);
  const invSum = await inviteSummary(inv.text);
  check(invSum.sum.srflx >= 1, `invitation has a public (srflx) address: ${invSum.addresses.join(', ')}`);
  check(inv.ms < 5000, `invitation ready in ${(inv.ms / 1000).toFixed(1)} s (servers reachable, gathering completes quickly)`);
  metrics.coneInviteMs = inv.ms;
  const rep = await joinCall(B, inv.text);
  await A.page.fill('#reply-text', rep.text);
  await connected(A);
  await connected(B);
  const p = await pathInfo(A);
  check(p.localType === 'srflx' || p.remoteType === 'srflx' || p.localType === 'prflx' || p.remoteType === 'prflx', `direct path through both NATs: ${p.local} ⇄ ${p.remote}`);
  check((await code(A)) === (await code(B)), 'codes match');
  await confirmBoth(A, B);
  check(await audioFlows(B), 'audio flows after verification');
  const d = await (async () => {
    await A.page.click('#ctl-details');
    return text(A, '#details-list');
  })();
  check(d.includes('Direct between your computers'), 'details show a direct route');
});

await test('symmetric NATs, no relay: fails clearly', { natA: 'symmetric', natB: 'symmetric' }, async () => {
  const A = await person('A');
  const B = await person('B');
  const inv = await startCall(A);
  const rep = await joinCall(B, inv.text);
  const t0 = Date.now();
  await A.page.fill('#reply-text', rep.text);
  await A.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 60000 });
  metrics.symmetricFailMs = Date.now() - t0;
  check((await text(A, '#ended-title')) === 'Couldn’t connect', `A sees "Couldn’t connect" after ${(metrics.symmetricFailMs / 1000).toFixed(0)} s`);
  check((await text(A, '#ended-diag')).includes('public address'), 'diagnostics: ' + (await text(A, '#ended-diag')));
  await A.page.screenshot({ path: path.join(SHOTS, 'symmetric-fail.png') });
});

await test('symmetric NATs, relay on one side (TURN/UDP)', { natA: 'symmetric', natB: 'symmetric' }, async () => {
  const A = await person('A');
  const B = await person('B');
  await addRelay(A, relayCode({ urls: [`turn:${R}:3478?transport=udp`] }));
  const inv = await startCall(A);
  check((await inviteSummary(inv.text)).sum.relay >= 1, 'invitation contains a relay candidate');
  check(!inv.text.includes(':lab') && !inv.text.includes(relay.secret), 'relay credentials are not inside the invitation');
  const rep = await joinCall(B, inv.text);
  await A.page.fill('#reply-text', rep.text);
  await connected(A);
  await connected(B);
  const p = await pathInfo(A);
  check(p.localType === 'relay', `connected through the relay: ${p.local} ⇄ ${p.remote}`);
  check((await code(A)) === (await code(B)), 'codes match (relay is not in the middle of the encryption)');
  await confirmBoth(A, B);
  check(await audioFlows(B), 'audio flows');
});

await test('UDP blocked on one side, relay over TCP', { natA: 'udp-blocked', natB: 'cone' }, async () => {
  const A = await person('A');
  const B = await person('B');
  await addRelay(A, relayCode({ urls: [`turn:${R}:3478?transport=udp`, `turn:${R}:3478?transport=tcp`] }));
  const inv = await startCall(A);
  metrics.udpBlockedRelayInviteMs = inv.ms;
  const s = await inviteSummary(inv.text);
  check(s.sum.relay >= 1, `invitation contains a relay candidate (${s.addresses.join(', ')}); ready after ${(inv.ms / 1000).toFixed(1)} s`);
  const rep = await joinCall(B, inv.text);
  await A.page.fill('#reply-text', rep.text);
  await connected(A);
  await connected(B);
  const p = await pathInfo(A);
  check(p.localType === 'relay' && p.relayProtocol === 'tcp', `A reaches the relay over TCP: ${p.local} ⇄ ${p.remote}`);
  await confirmBoth(A, B);
  check(await audioFlows(B), 'audio flows');
});

await test('only TCP 443 allowed, relay over TLS (valid-certificate stand-in)', { natA: 'tcp443-only', natB: 'symmetric' }, async () => {
  const A = await person('A', { args: ['--ignore-certificate-errors'] });
  const B = await person('B');
  await addRelay(A, relayCode({ urls: [`turns:${R}:443?transport=tcp`] }));
  const inv = await startCall(A);
  const s = await inviteSummary(inv.text);
  check(s.sum.relay >= 1, `invitation contains a relay candidate (${s.addresses.join(', ')})`);
  const rep = await joinCall(B, inv.text);
  await A.page.fill('#reply-text', rep.text);
  await connected(A);
  await connected(B);
  const p = await pathInfo(A);
  check(p.localType === 'relay' && p.relayProtocol === 'tls', `A reaches the relay over TLS on port 443: ${p.local}`);
  await confirmBoth(A, B);
  check(await audioFlows(B), 'audio flows');
});

await test('relay over TLS with an untrusted certificate is refused', { natA: 'tcp443-only', natB: 'cone' }, async () => {
  const A = await person('A');
  await addRelay(A, relayCode({ urls: [`turns:${R}:443?transport=tcp`] }), true);
  await startCall(A);
  check(!(await A.page.isHidden('#start-error')), 'relay-only invitation is not produced');
  check((await text(A, '#start-error')).includes('relay server couldn’t be reached'), 'user sees "relay server couldn’t be reached" (Chromium validates the TLS certificate)');
});

await test('relay-only mode hides both addresses', { natA: 'cone', natB: 'cone' }, async () => {
  const A = await person('A');
  const B = await person('B');
  await addRelay(A, relayCode({ urls: [`turn:${R}:3478?transport=udp`] }), true);
  const inv = await startCall(A);
  const s = await inviteSummary(inv.text);
  check(s.sum.host === 0 && s.sum.srflx === 0 && s.sum.relay >= 1, `invitation contains only relay addresses (${s.addresses.join(', ')})`);
  check(!inv.text.includes(lab.ADDR.lan) && !(await decodeEnvelope(inv.text)).payload.sdp.includes(lab.ADDR.wanA), 'neither A\'s private nor public address appears in the invitation');
  const servers = await A.page.evaluate(() => window.__pcs[window.__pcs.length - 1].getConfiguration().iceServers.map((x) => [].concat(x.urls).join(',')));
  check(servers.every((u) => u.startsWith('turn')), `public STUN servers are not contacted in relay-only mode (${servers.join(' | ')})`);
  const rep = await joinCall(B, inv.text);
  await A.page.fill('#reply-text', rep.text);
  await connected(A);
  await connected(B);
  await sleep(1500);
  const pb = await pathInfo(B);
  check(!pb.remotes.includes(lab.ADDR.wanA) && !pb.remotes.includes(lab.ADDR.lan), `B never learns A\'s addresses (B saw: ${[...new Set(pb.remotes)].join(', ')})`);
  check(pb.remotes.includes(R), 'B only sees the relay address for A');
});

await test('public STUN unreachable (helper servers blocked), no relay', { natA: 'cone', natB: 'cone' }, async () => {
  const A = await person('A', { rewriteStun: false });
  const B = await person('B', { rewriteStun: false });
  const inv = await startCall(A);
  metrics.stunUnreachableInviteMs = inv.ms;
  check(inv.ms >= 14000 && inv.ms <= 31000, `invitation still produced, after ${(inv.ms / 1000).toFixed(1)} s (minimum wait, then quiet period)`);
  check(await A.page.isVisible('#preview') , 'preview shown while waiting');
  const s = await inviteSummary(inv.text);
  check(s.sum.srflx === 0, 'no public address could be learned');
  const rep = await joinCall(B, inv.text);
  await A.page.fill('#reply-text', rep.text);
  await A.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 60000 });
  check((await text(A, '#ended-diag')).includes('helper servers couldn’t be reached'), 'diagnostics: ' + (await text(A, '#ended-diag')));
});

await test('UDP blocked, relay configured: gathering waits for the relay, not the dead STUN', { natA: 'udp-blocked', natB: 'cone' }, async () => {
  const A = await person('A', { rewriteStun: false });
  await addRelay(A, relayCode({ urls: [`turn:${R}:3478?transport=udp`, `turn:${R}:3478?transport=tcp`, `turns:${R}:443?transport=tcp`] }));
  const inv = await startCall(A);
  const s = await inviteSummary(inv.text);
  metrics.mixedRelayInviteMs = inv.ms;
  check(s.addresses.some((a) => a.startsWith('relay')), `relay candidate included (${s.addresses.join(', ')})`);
  check(inv.ms < 20000, `finished in ${(inv.ms / 1000).toFixed(1)} s, not held to the 30 s cap by the relay transport that can never answer (UDP)`);
});

await test('connection blip of 8 s recovers; outage of 40 s ends the call', { natA: 'cone', natB: 'cone' }, async () => {
  const A = await person('A');
  const B = await person('B');
  const inv = await startCall(A);
  const rep = await joinCall(B, inv.text);
  await A.page.fill('#reply-text', rep.text);
  await connected(A);
  await connected(B);
  await confirmBoth(A, B);
  const block = () => execFileSync('ip', ['netns', 'exec', 'pcl-rtrA', 'iptables', '-I', 'FORWARD', '1', '-j', 'DROP']);
  const unblock = () => execFileSync('ip', ['netns', 'exec', 'pcl-rtrA', 'iptables', '-D', 'FORWARD', '1']);
  block();
  await A.page.waitForSelector('#call-banner:not([hidden])', { timeout: 15000 });
  check((await text(A, '#call-banner')).includes('unstable'), 'A shows "Connection unstable. Trying to recover…"');
  await sleep(3000);
  unblock();
  await A.page.waitForSelector('#call-banner', { state: 'hidden', timeout: 20000 });
  check(true, 'after the network returns, the banner clears');
  check(await audioFlows(B), 'and audio flows again without a new exchange');
  block();
  const t0 = Date.now();
  await A.page.waitForSelector('#screen-ended:not([hidden])', { timeout: 90000 });
  check((await text(A, '#ended-title')) === 'Connection lost', `a long outage ends with "Connection lost" after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  unblock();
});

for (const delay of [90, 200]) {
  await test(`slow exchange through home NATs: reply added after ${delay} s`, { natA: 'cone', natB: 'cone' }, async () => {
    const timeouts = execFileSync('ip', ['netns', 'exec', 'pcl-rtrA', 'sh', '-c', 'cat /proc/sys/net/netfilter/nf_conntrack_udp_timeout /proc/sys/net/netfilter/nf_conntrack_udp_timeout_stream 2>/dev/null || echo n/a']).toString().trim().split('\n').join('/');
    const A = await person('A');
    const B = await person('B');
    const inv = await startCall(A);
    const rep = await joinCall(B, inv.text);
    await sleep(delay * 1000);
    await A.page.fill('#reply-text', rep.text);
    let ok = true;
    try {
      await connected(A, 50000);
    } catch {
      ok = false;
    }
    metrics[`slow${delay}`] = ok ? 'connected' : 'failed';
    check(ok, `connected after a ${delay} s gap (router UDP conntrack timeouts: ${timeouts} s)`);
  });
}

// ------------------------------------------------------------------ report
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} network-lab tests passed`);
console.log('metrics:', JSON.stringify(metrics));
fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify({ date: new Date().toISOString(), browser: 'Chromium ' + metrics.browserVersion, metrics, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
