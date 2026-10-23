// Network lab for PrivateCall (test-only; Linux, root, iproute2, iptables).
//
// Builds a small simulated internet out of network namespaces:
//
//   hostA (192.168.1.10) ── rtrA [NAT] 203.0.113.2 ─┐
//                                                    ├── inet (router) ── relay 192.0.2.10 (STUN/TURN, pion/turn)
//   hostB (192.168.1.10) ── rtrB [NAT] 198.51.100.2 ─┘
//
// Both private LANs deliberately use the same addresses, as real home networks do.
// Each NAT router can be configured with a different behaviour (see NAT_PROFILES).
// Chromium for each person is launched *inside* hostA / hostB, so WebRTC sees only
// that host's network, exactly as on a real computer behind a home router.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PREFIX = 'pcl';
const NS = (n) => `${PREFIX}-${n}`;
export const ADDR = {
  relay: '192.0.2.10',
  wanA: '203.0.113.2',
  wanB: '198.51.100.2',
  lan: '192.168.1.10',
};
const WORK = '/tmp/pcl-netlab';

function sh(args, { ns, quiet = false } = {}) {
  const argv = ns ? ['netns', 'exec', NS(ns), ...args] : args.slice(1);
  const cmd = ns ? 'ip' : args[0];
  try {
    return execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    if (quiet) return '';
    throw new Error(`${cmd} ${argv.join(' ')}: ${e.stderr}`);
  }
}
const ip = (...a) => sh(['ip', ...a]);
const inNs = (ns, ...a) => sh(a, { ns });

export function teardown() {
  for (const n of ['hostA', 'hostB', 'rtrA', 'rtrB', 'inet', 'relay']) sh(['ip', 'netns', 'del', NS(n)], { quiet: true });
}

let tmpCounter = 0;
function link(nsA, ifA, addrA, nsB, ifB, addrB) {
  // Create with unique temporary names in the root namespace, then rename inside.
  const ta = `pcltmp${tmpCounter++}`;
  const tb = `pcltmp${tmpCounter++}`;
  ip('link', 'add', ta, 'type', 'veth', 'peer', 'name', tb);
  ip('link', 'set', ta, 'netns', NS(nsA));
  ip('link', 'set', tb, 'netns', NS(nsB));
  ip('-n', NS(nsA), 'link', 'set', ta, 'name', ifA);
  ip('-n', NS(nsB), 'link', 'set', tb, 'name', ifB);
  ip('-n', NS(nsA), 'addr', 'add', addrA, 'dev', ifA);
  ip('-n', NS(nsB), 'addr', 'add', addrB, 'dev', ifB);
  ip('-n', NS(nsA), 'link', 'set', ifA, 'up');
  ip('-n', NS(nsB), 'link', 'set', ifB, 'up');
}

// NAT behaviours (RFC 4787 terminology):
//  cone:       endpoint-independent mapping, address+port-dependent filtering
//              (Linux MASQUERADE keeps the source port; typical home router)
//  symmetric:  address+port-dependent mapping (a new random port per destination)
//  udp-blocked: no outbound UDP at all; TCP allowed (some corporate/campus networks)
//  tcp443-only: only outbound TCP to port 443 (very restrictive firewalls)
export const NAT_PROFILES = ['cone', 'symmetric', 'udp-blocked', 'tcp443-only'];

function configureNat(rtr, wanIf, profile) {
  const ipt = (...a) => inNs(rtr, 'iptables', ...a);
  ipt('-t', 'nat', '-F');
  ipt('-F', 'FORWARD');
  ipt('-F', 'INPUT');
  ipt('-P', 'FORWARD', 'DROP');
  // Like real home routers: unsolicited traffic to the router itself from the WAN
  // is silently dropped (no ICMP errors, and no conntrack entries that would
  // collide with later NAT mappings).
  ipt('-A', 'INPUT', '-i', wanIf, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT');
  ipt('-A', 'INPUT', '-i', wanIf, '-j', 'DROP');
  // Replies to connections started from the LAN are allowed back in (stateful firewall).
  ipt('-A', 'FORWARD', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT');
  if (profile === 'cone') {
    ipt('-A', 'FORWARD', '-i', 'lan', '-j', 'ACCEPT');
    ipt('-t', 'nat', '-A', 'POSTROUTING', '-o', wanIf, '-j', 'MASQUERADE');
  } else if (profile === 'symmetric') {
    ipt('-A', 'FORWARD', '-i', 'lan', '-j', 'ACCEPT');
    ipt('-t', 'nat', '-A', 'POSTROUTING', '-o', wanIf, '-j', 'MASQUERADE', '--random-fully');
  } else if (profile === 'udp-blocked') {
    ipt('-A', 'FORWARD', '-i', 'lan', '-p', 'tcp', '-j', 'ACCEPT');
    ipt('-t', 'nat', '-A', 'POSTROUTING', '-o', wanIf, '-j', 'MASQUERADE');
  } else if (profile === 'tcp443-only') {
    ipt('-A', 'FORWARD', '-i', 'lan', '-p', 'tcp', '--dport', '443', '-j', 'ACCEPT');
    ipt('-t', 'nat', '-A', 'POSTROUTING', '-o', wanIf, '-j', 'MASQUERADE');
  } else {
    throw new Error('unknown NAT profile ' + profile);
  }
}

export function setup({ natA = 'cone', natB = 'cone' } = {}) {
  teardown();
  for (const n of ['hostA', 'hostB', 'rtrA', 'rtrB', 'inet', 'relay']) {
    ip('netns', 'add', NS(n));
    ip('-n', NS(n), 'link', 'set', 'lo', 'up');
  }
  // Core "internet"
  link('inet', 'toA', '203.0.113.1/30', 'rtrA', 'wan', `${ADDR.wanA}/30`);
  link('inet', 'toB', '198.51.100.1/30', 'rtrB', 'wan', `${ADDR.wanB}/30`);
  link('inet', 'toR', '192.0.2.1/24', 'relay', 'eth0', `${ADDR.relay}/24`);
  inNs('inet', 'sysctl', '-q', '-w', 'net.ipv4.ip_forward=1');
  ip('-n', NS('relay'), 'route', 'add', 'default', 'via', '192.0.2.1');
  // Home networks (identical private addressing on both sides)
  for (const [site, wanGw] of [['A', '203.0.113.1'], ['B', '198.51.100.1']]) {
    const rtr = 'rtr' + site;
    link(rtr, 'lan', '192.168.1.1/24', 'host' + site, 'eth0', `${ADDR.lan}/24`);
    inNs(rtr, 'sysctl', '-q', '-w', 'net.ipv4.ip_forward=1');
    ip('-n', NS(rtr), 'route', 'add', 'default', 'via', wanGw);
    ip('-n', NS('host' + site), 'route', 'add', 'default', 'via', '192.168.1.1');
  }
  configureNat('rtrA', 'wan', natA);
  configureNat('rtrB', 'wan', natB);
}

export function setNat(site, profile) {
  configureNat('rtr' + site, 'wan', profile);
  inNs('rtr' + site, 'sh', '-c', 'command -v conntrack >/dev/null && conntrack -F || true');
}

// Relay (STUN + TURN over UDP/TCP 3478 and TLS 443), running in the "relay" namespace.
export function startRelay(binary) {
  fs.mkdirSync(WORK, { recursive: true });
  const secret = crypto.randomBytes(24).toString('base64');
  const cert = path.join(WORK, 'relay.crt');
  const key = path.join(WORK, 'relay.key');
  if (!fs.existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert,
      '-days', '2', '-subj', '/CN=relay.privatecall.test', '-addext', `subjectAltName=IP:${ADDR.relay}`], { stdio: 'ignore' });
  }
  const log = fs.openSync(path.join(WORK, 'relay.log'), 'w');
  const proc = spawn('ip', ['netns', 'exec', NS('relay'), binary, '-public-ip', ADDR.relay, '-port', '3478', '-tls-port', '443', '-cert', cert, '-key', key],
    { env: { ...process.env, TURN_SECRET: secret }, stdio: ['ignore', log, log] });
  return { proc, secret, logFile: path.join(WORK, 'relay.log'), stop: () => proc.kill('SIGTERM') };
}

// A wrapper "browser executable" that runs Chromium inside a namespace. Playwright
// talks to it over inherited pipes, so no network path to the test runner exists.
export function browserWrapper(site, chromiumPath) {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, `chromium-${site}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\nexec ip netns exec ${NS('host' + site)} "${chromiumPath}" "$@"\n`, { mode: 0o755 });
  return file;
}

// Packet counters on a NAT router's WAN interface (to prove what crossed it).
export function wanCounters(site) {
  const out = inNs('rtr' + site, 'iptables', '-t', 'nat', '-L', 'POSTROUTING', '-v', '-n', '-x');
  return out;
}
