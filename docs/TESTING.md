# PrivateCall — validation plan and results (version 1.2)

This report separates three kinds of evidence:

* **Automated results**: what the tests actually observed.
* **Reasoning**: what follows from the design but is not tested.
* **Unverified**: what still needs real hardware, real networks or other browsers.

## 1. Environments actually used

* Linux sandbox, **Chromium 153.0.8010.12** (Playwright build), Node.js 22.
  Every "person" is a separate Chromium process opening `dist/PrivateCall.html`
  via `file://`, with Chromium's synthetic camera (test pattern) and microphone (beep).
* **Same-machine suite** (`tests/e2e/`): all processes on one host. Outbound STUN
  is unreachable here, so only host candidates exist.
* **Network lab** (`tests/netlab/`): each Chromium runs in its own Linux network
  namespace behind a simulated NAT router (iptables). Both "home" LANs use the same
  private addresses. A real STUN/TURN server (pion/turn v4.1.4; UDP/TCP 3478,
  TLS 443) sits on a simulated public network. Routers drop unsolicited WAN
  traffic, as home routers do. See `tests/netlab/README.md` for what the lab
  does *not* model.
* **Not available:** Firefox (download blocked), Edge, Windows, macOS, real
  networks, latency/loss emulation (`tc`/netem could not be built).

## 2. Automated results — all passing

| Suite | Tests | Checks | Result |
|---|---|---|---|
| Unit + fuzz (`npm test`) | 24 | about 10 000 fuzz inputs included | 24/24 ✔ |
| Same-machine e2e (`npm run test:e2e`) | 20 | 129 | 20/20 ✔ |
| Network lab (`npm run test:netlab`) | 12 | 38 | 12/12 ✔ |
| Cross-version calls (one-off script): 1.0 ⇄ 1.2 and 1.1 ⇄ 1.2 | 4 directions | codes match | ✔ |

All suites ran in full on the final 1.2.0 build (SHA-256 in `dist/SHA256SUMS`)
after the last code change. The interface was restyled in 1.2, so these runs are
also the regression check for the new markup. The raw data is in `tests/e2e/results.json` and
`tests/netlab/results.json`, and screenshots are in `tests/*/screenshots/`.
Every e2e test also fails if the app makes any HTTP request or triggers any CSP
violation; none occurred.

### 2.1 Pre-verification media (new behaviour)
| Check (same machine, via WebRTC stats) | Result |
|---|---|
| Before confirmation: no microphone or camera track attached to either sender; 0 audio bytes and 0 video frames received by either side | ✔ |
| "Turn on microphone" (code panel) attaches the microphone; the other side hears it and is told "Their microphone is on"; turning it off detaches it again (silence measured) | ✔ |
| Each side's audio and video start only after *that* side confirms | ✔ |
| "Wait" on the camera warning keeps video local; nothing is sent | ✔ |
| **At an active interceptor:** 0 audio bytes and 0 video frames from either victim before verification; during A's speaking window, only A's audio | ✔ |

### 2.2 Active interception and protocol abuse
| Attack (attacker harness in a third browser) | Result |
|---|---|
| Certificate substitution in both messages, forwarded commitment, data channel and media relayed | Codes differ ✔; "Codes don't match" ends the call with a safety warning ✔ |
| Forged commitment | Joiner ends: "Security check failed"; no code shown ✔ |
| Reveal replaced with a different (e.g. replayed) value | Joiner ends: "Security check failed" ✔ |
| Reveal withheld | Joiner ends after 20 s; no code shown ✔ |
| Forged "confirmed" + fake state message injected | Joiner stays "not verified"; mic and camera stay detached; shown only as information ✔ |
| Reveal injected toward the starting side | Ignored; codes unchanged ✔ |
| 4 000 malformed control messages (bad JSON, unknown types, oversized, binary, `__proto__`) | Both calls keep running; no script errors ✔ |
| **Impersonation** (attacker answers the invitation itself) | Codes **match**, as expected. This test documents the limit: the code proves no one is in the middle, not who the peer is ✔ |
| Fingerprint swapped consistently in the invitation | DTLS refuses; "Couldn't connect"; no code ✔ |
| Re-encoded invitations: two fingerprints / extra field / bad media type | Rejected ✔ |
| SDP that passes PrivateCall's checks but the browser engine rejects | "This message isn't valid"; microphone released ✔ |
| Markup in SDP | Never rendered or executed ✔ |
| Reply for another session; invitation reused; old reply against a new invitation | Refused ✔ |
| Truncated, corrupted, oversized, unrelated, newer-version, binary and 100 KB inputs | Specific message each ✔ |
| Fuzzing: envelope (1 500 mutations), schemas (5 000 structured-garbage objects), SDP (4 000 line mutations), relay codes | No exceptions; every accepted SDP has exactly one fingerprint ✔ |

**Not tested:** an attacker that *manipulates speech* to defeat a spoken
comparison. This is a known, practical attack class (`ARCHITECTURE.md` §4.2b).
The defence offered is comparison by text through a separate app; its strength
depends on that app and was not tested.

### 2.3 Network lab
| Topology (A ⇄ B) | Setup | Result |
|---|---|---|
| home NAT ⇄ home NAT | STUN only | Direct srflx ⇄ srflx path; invitation in 0.3 s; audio after verification ✔ |
| symmetric ⇄ symmetric | no relay | "Couldn't connect" after 46 s, with diagnostics ✔ (expected failure) |
| symmetric ⇄ symmetric | relay code on A only (TURN/UDP) | Connected via relay; codes match ✔ |
| UDP-blocked ⇄ home NAT | relay on A (TURN/UDP + TCP) | Connected; A reaches the relay over TCP ✔ |
| TCP-443-only ⇄ symmetric | relay on A (TURNS/443) | Connected over TLS ✔ (certificate checks disabled as a stand-in for a trusted certificate) |
| TCP-443-only, relay-only mode | TURNS with a self-signed certificate | Refused by Chromium; user sees "relay server couldn't be reached" ✔ |
| home NAT ⇄ home NAT | relay-only mode on A | Invitation has only the relay address; B's own stats show only the relay for A; no STUN servers configured ✔ |
| home NAT ⇄ home NAT | public STUN unreachable, no relay | Invitation after 15.2 s; call fails with "helper servers couldn't be reached" ✔ |
| UDP-blocked, relay configured (UDP, TCP, TLS URLs) | gathering | Relay over TCP included; done at 15.1 s, not held to the 30 s cap ✔ |
| home NAT ⇄ home NAT | 8 s outage, then 40 s outage | Recovers from 8 s without a new exchange; 40 s ends with "Connection lost" ✔ |
| home NAT ⇄ home NAT | **reply added 90 s and 200 s after creation** | Both connect ✔. In 1.0 this failed beyond ~40 s (measured with a probe: 35 s connects, 50 s fails). |

Router UDP conntrack timeouts in the lab are 30 s (unanswered) and 120 s
(established), the Linux defaults.

### 2.4 Regressions found and fixed during this iteration
1. **Early gathering stop** (1.0) could omit candidates. Replaced with the
   reliability-first policy; unit-tested.
2. **Slow exchanges failed** through port-restricted NATs (measured). Fixed by
   re-supplying candidates (§2.3).
3. **Policy over-waited** when a relay transport could never answer (UDP blocked):
   the 30 s cap was hit. Found by the lab and fixed: once any relay candidate
   exists, the policy no longer waits for the others.
4. **Browser-rejected SDP** gave a generic message and left the error unshown on
   the join screen. Fixed and tested.
5. **Lab realism:** routers that answered unsolicited WAN packets made home-NAT
   calls fail through a conntrack collision. The lab now models typical routers
   (drop silently). Routers that *do* answer may still cause this in the real world.

### 2.5 Call quality and latency (1.2)

Measured in a local call between two app instances (Chromium, synthetic devices,
both sides verified, 20 s in), from the receiver's WebRTC statistics:

| Quantity | Value |
|---|---|
| Audio codec in use | Opus (RED was negotiated but not used) |
| Audio receive buffering (jitter buffer) | ~32 ms; target 22 ms (browser minimum) |
| Audio playout delay | 30 ms |
| Video decode time | ~1 ms per frame (VP8) |
| Send-side packet delay | 0 ms |

**Conclusion.** In this setting the app adds no buffering beyond the browser's
minimum, and no configuration problem was found: codecs, sender priorities and
constraints were reviewed. The delay noticed in the real call is therefore most
likely caused by:
* the network path: round-trip time, relay use, or TCP relay transport;
* jitter, which makes the browser grow its buffer;
* audio hardware, e.g. Bluetooth headsets.

This **could not be verified**: packet loss, jitter and delay could not be emulated
here. To find the cause, read **Details** during a delayed call. It shows
round-trip time, route and transport, audio buffering and loss. Also note the
headsets used. `chrome://webrtc-internals` gives the full picture.

### 2.6 Interface review (1.2)
Every screen was checked from screenshots in both roles:
* welcome, start, join, invitation, reply;
* code check for the caller and for the joiner, with the halves correctly
  mirrored (the caller says the first three digits, the joiner the last three);
* the open-microphone state, active call, Details, ended (normal and
  safety-warning), Settings and About;
* right-to-left layout.

## 3. Reasoning, not tests
* The 10⁻⁶-per-attempt bound for an interceptor that cannot alter the comparison
  (ZRTP-style commitment argument).
* Forward secrecy (DTLS ECDHE, ephemeral certificates).
* That re-supplying candidates reveals nothing new (same addresses) and does not
  affect the security binding (fingerprints are not involved).

## 4. Still unverified — manual test matrix

| # | Scenario | What to check |
|---|---|---|
| M1 | Chrome ⇄ Chrome, two computers, same Wi‑Fi | Connects; codes match; audio/video quality; CPU |
| M2 | Different home networks; reply added after 2, 5 and 10 min | Connects (validates the lab result on real routers) |
| M3 | Mobile hotspot / CGNAT | Connects, or fails clearly |
| M4 | Real relay with a publicly trusted certificate (TURN UDP/TCP, TURNS 443) | Connects; relay-only hides addresses |
| M5 | Firefox ⇄ Firefox, Firefox ⇄ Chrome, both directions, from disk | `file://` permissions; codes match; slow exchange with a Firefox joiner |
| M6 | Edge ⇄ Chrome | As M1 |
| M7 | Invitation and reply through Telegram, WhatsApp, Signal and Gmail | Text survives; files survive |
| M8 | Network switch mid-call (Wi‑Fi → mobile) | Ends cleanly ("Connection lost") |
| M9 | Real devices: echo cancellation, camera light | Camera light off when the camera is off, before confirmation, and on hang-up |
| M10 | Iran ⇄ abroad | Default STUN reachability, direct UDP, TURNS/443. **No connectivity claims before this.** |
| M11 | Screen readers (NVDA, VoiceOver) | Complete a call, including the verification panel |
| M12 | Usability: do people compare codes, and use the text option? | Small user study |
| M13 | 60-minute call | Memory stable; no leaked peer connections or audio contexts |
