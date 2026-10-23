import { chromium } from 'playwright';
import * as lab from '../lab.mjs';
const [mode, delay] = [process.argv[2], +process.argv[3]];
lab.setup({ natA: 'cone', natB: 'cone' });
const relay = lab.startRelay((process.env.RELAY_BIN || '/tmp/relayserver'));
await new Promise(r => setTimeout(r, 700));
const mk = async (site) => { const b = await chromium.launch({ executablePath: lab.browserWrapper(site, chromium.executablePath()), args: ['--no-proxy-server'] }); const p = await b.newPage(); await p.goto('file://' + new URL('./probe-slow.html', import.meta.url).pathname + ''); return { b, p }; };
const A = await mk('A'), B = await mk('B');
const offer = await A.p.evaluate(() => mkOffer());
const ans = await B.p.evaluate(([s, m]) => mkAnswer(s, m), [offer, mode]);
const t0 = Date.now();
await new Promise(r => setTimeout(r, delay * 1000));
await A.p.evaluate(s => apply(s), ans);
let ok = false;
for (let i = 0; i < 40 && !ok; i++) { await new Promise(r => setTimeout(r, 500)); ok = await A.p.evaluate(() => pc.connectionState === 'connected'); }
const bl = (await B.p.evaluate(() => log)).map(([t, s]) => `${((t - t0) / 1000).toFixed(0)}s:${s}`).join(' ');
console.log(`mode=${mode} delay=${delay}s -> ${ok ? 'CONNECTED' : 'FAILED'} | B: ${bl}`);
await A.b.close(); await B.b.close(); relay.stop(); lab.teardown();
