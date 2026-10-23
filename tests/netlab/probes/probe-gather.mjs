import { chromium } from 'playwright';
import crypto from 'node:crypto';
import * as lab from '../lab.mjs';
lab.setup({ natA: process.argv[2] || 'cone', natB: 'cone' });
const relay = lab.startRelay((process.env.RELAY_BIN || '/tmp/relayserver'));
await new Promise(r => setTimeout(r, 800));
const exp = Math.floor(Date.now()/1000) + 3600, user = `${exp}:probe`;
const cred = crypto.createHmac('sha1', relay.secret).update(user).digest('base64');
const browser = await chromium.launch({ executablePath: lab.browserWrapper('A', chromium.executablePath()), args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--no-proxy-server'] });
const page = await browser.newPage();
await page.goto('file://' + new URL('./probe-slow.html', import.meta.url).pathname + '');
const R = '192.0.2.10';
const configs = {
  'default-google-stun (unreachable)': [{ urls: ['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478'] }],
  'lab stun': [{ urls: [`stun:${R}:3478`] }],
  'lab turn udp+tcp+tls': [{ urls: [`stun:${R}:3478`] }, { urls: [`turn:${R}:3478?transport=udp`, `turn:${R}:3478?transport=tcp`, `turns:${R}:443?transport=tcp`], username: user, credential: cred }],
  'lab turns only': [{ urls: [`turns:${R}:443?transport=tcp`], username: user, credential: cred }],
};
for (const [name, iceServers] of Object.entries(configs)) {
  const r = await page.evaluate(async (iceServers) => {
    const pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel('x');
    const t0 = performance.now(); const cands = []; const errs = [];
    pc.onicecandidate = e => e.candidate && e.candidate.candidate && cands.push([Math.round(performance.now()-t0), e.candidate.type, e.candidate.relayProtocol || '', "url=" + e.url + " curl=" + e.candidate.url]);
    pc.onicecandidateerror = e => errs.push([Math.round(performance.now()-t0), e.url, e.errorCode, e.errorText]);
    await pc.setLocalDescription();
    await new Promise(r => { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 90000); });
    const done = Math.round(performance.now()-t0); pc.close();
    return { done, cands, errs };
  }, iceServers);
  console.log(`\n== ${name}: complete after ${r.done} ms`); r.cands.forEach(c => console.log('  cand', JSON.stringify(c))); r.errs.forEach(e => console.log('  err ', JSON.stringify(e)));
}
await browser.close(); relay.stop(); lab.teardown();
