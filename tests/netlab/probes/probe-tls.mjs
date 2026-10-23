import { chromium } from 'playwright';
import crypto from 'node:crypto';
import * as lab from '../lab.mjs';
lab.setup({ natA: 'cone' });
const relay = lab.startRelay((process.env.RELAY_BIN || '/tmp/relayserver'));
await new Promise(r => setTimeout(r, 800));
const exp = Math.floor(Date.now()/1000) + 3600, user = `${exp}:probe`;
const cred = crypto.createHmac('sha1', relay.secret).update(user).digest('base64');
for (const [label, extra, url] of [
  ['ip literal', [], 'turns:192.0.2.10:443?transport=tcp'],
  ['ip literal + ignore-cert-errors', ['--ignore-certificate-errors'], 'turns:192.0.2.10:443?transport=tcp'],
  ['hostname + ignore-cert-errors', ['--ignore-certificate-errors', '--host-resolver-rules=MAP relay.privatecall.test 192.0.2.10'], 'turns:relay.privatecall.test:443?transport=tcp'],
]) {
  const browser = await chromium.launch({ executablePath: lab.browserWrapper('A', chromium.executablePath()), args: ['--no-proxy-server', ...extra] });
  const page = await browser.newPage();
  await page.goto('file://' + new URL('./probe-slow.html', import.meta.url).pathname + '');
  const r = await page.evaluate(async ([url, user, cred]) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: [url], username: user, credential: cred }] });
    pc.createDataChannel('x'); const out = [];
    pc.onicecandidate = e => e.candidate && e.candidate.candidate && out.push(e.candidate.type + '/' + (e.candidate.relayProtocol||''));
    pc.onicecandidateerror = e => out.push('ERR ' + e.errorCode + ' ' + e.errorText);
    await pc.setLocalDescription();
    await new Promise(r => { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 20000); });
    pc.close(); return out;
  }, [url, user, cred]);
  console.log(label, '=>', r.join(', '));
  await browser.close();
}
relay.stop(); console.log(require_log()); lab.teardown();
function require_log() { return '' }
