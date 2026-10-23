import * as lab from '../lab.mjs';
import { execFileSync } from 'node:child_process';
lab.setup({ natA: 'cone' });
const relay = lab.startRelay((process.env.RELAY_BIN || '/tmp/relayserver'));
await new Promise(r => setTimeout(r, 800));
const js = `const s=require('net').connect(3478,'192.0.2.10',()=>{console.log('tcp ok');s.end()});s.on('error',e=>console.log('tcp err',e.message));
const t=require('tls').connect({port:443,host:'192.0.2.10',rejectUnauthorized:false},()=>{console.log('tls ok',t.getProtocol());t.end()});t.on('error',e=>console.log('tls err',e.message));`;
try { console.log(execFileSync('ip', ['netns','exec','pcl-hostA', process.execPath, '-e', js], {timeout: 8000}).toString()); } catch(e) { console.log('fail', e.message, String(e.stdout)) }
relay.stop(); lab.teardown();
