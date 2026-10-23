# PrivateCall — architecture, threat model and design decisions

## 1. What was built

`dist/PrivateCall.html` is a single 146 KB file that runs from `file://` with no
network fetches of its own. It makes one-to-one voice or video calls using the
browser's WebRTC stack. Two people connect by exchanging one *invitation* and one
*reply* as text or as a `.txt` file. Then each person reads a 6-digit security
code aloud. Matching codes show that no one substituted the encryption keys in
transit.

```
 Person A (starts)                 any chat / email / USB stick            Person B (joins)
 ──────────────────                 ────────────────────────────           ────────────────
 open camera/mic
 new ECDSA certificate, PeerConnection
 gather ICE candidates (non-trickle)
 invitation = {sid, commit=H(sid,nA), offer SDP}  ───────────────────────►  validate, show "Video call invitation"
                                                                            open camera/mic (after a click)
                                                                            new certificate, set offer, answer
                                    ◄───────────────────────  reply = {sid, nB, answer SDP}
 validate (sid must match, single use)
 ICE connectivity checks ───────────── direct UDP/TCP, or via TURN relay ─────────────
 DTLS handshake (fingerprints enforced by the browser)  →  SRTP media + SCTP data channel
 over the data channel: A reveals nA ─────────────────────────────────────►  check H(sid,nA) == commit
 both show code = H(sid, fp_offer, fp_answer, nA, nB) mod 10^6
 nothing is sent until each person confirms, except their own 30 s "Turn on microphone" window
```

### Source layout

| Path | Role |
|---|---|
| `src/app/util.js` | bytes, strict base64, SHA-256, length-prefixed hashing input, bounded inflate |
| `src/app/codec.js` | text envelope (`PrivateCall.invite.v1: … :end`), versioning, checksum, size limits |
| `src/app/sdp.js` | defensive SDP inspection: exactly one DTLS fingerprint, expected m-lines, roles |
| `src/app/protocol.js` | strict schemas for invitation, reply and data-channel control messages |
| `src/app/sas.js` | commitment and short authentication string (security code) |
| `src/app/ice.js` | STUN defaults, relay-code parsing, `RTCConfiguration` |
| `src/app/gather.js` | when to stop gathering candidates (pure, unit-tested policy) |
| `src/app/media.js` | getUserMedia with friendly errors, codec preferences, sender tuning, level meter |
| `src/app/session.js` | `CallSession`: the call state machine; owns every resource and secret |
| `src/app/i18n.js` | all interface text, locale and direction switching |
| `src/app/main.js` | UI controller; DOM is only ever written with `textContent` |
| `src/index.html`, `src/styles.css` | markup template and styles (logical CSS properties for RTL) |
| `build.mjs` | zero-dependency deterministic build, CSP hashing, SHA256SUMS |
| `tools/make-relay-code.mjs` | for relay operators: short-lived TURN credentials as a "relay code" |
| `tests/unit/` | node:test suite for the security-critical modules (14 tests) |
| `tests/e2e/` | Playwright suite driving real calls between separate Chromium processes, including an active-interception harness |
| `tests/netlab/` | network lab: Chromium behind simulated NAT routers in Linux network namespaces, real STUN/TURN (pion/turn) |

## 2. Critique of the specification (what I changed and why)

1. **"Avoid exposing network information" conflicts with "no server".** Without a
   signaling or relay server, the invitation *must* carry ICE candidates
   (network addresses), and a direct call *must* reveal each side's public IP to
   the other. I kept it serverless and disclosed this plainly. I also added
   an optional **relay-only mode** (needs a relay), which hides your IP from the
   other person and from the invitation channel.

2. **Outgoing media before verification (revised in 1.1).** Version 1.0 sent
   audio immediately so people could read the code aloud. Version 1.1 sends
   **nothing** before the local user confirms the code: the microphone and
   camera tracks are not attached to their RTP senders at all. To read the code
   aloud, the user opens a **30-second microphone window** ("Turn on microphone"; called "Speak the code" in 1.1), and only during
   that window does their microphone reach the other side. Alternatively they
   can compare the code by text in another app and never open the microphone.
   After an explicit warning, the user can choose "Talk without checking".
   Reasoning: unintended disclosure happens when people start chatting before
   checking. A deliberate, time-limited window keeps the spoken check easy while
   making everything else opt-in. Lab result: an interceptor received 0 bytes of
   audio and 0 video frames before verification, and only the speaker's audio
   during their window.

3. **"Authenticate the remote endpoint" vs. no identities.** A short
   authentication string proves that *no one is in the middle of this session*.
   It does not prove *who the other person is*. People establish that by
   recognising each other. The UI and the docs never claim more than this.
   Persistent device identities were considered and rejected for v1 (see §5).

4. **"Several straightforward steps" vs. mobile/reconnect expectations.** With
   manual signaling, an ICE restart or renegotiation needs another manual
   exchange. So v1 does not pretend to reconnect. A short network blip recovers
   on its own (ICE consent freshness). A real loss ends the call with a clear
   "start a new call" screen.

5. **Single-file `file://` is achievable, but only with care.** Chromium treats
   `file://` as a secure context: WebCrypto, `getUserMedia`, the async clipboard
   API, `CompressionStream` and downloads all work, which I verified. Two
   `file://` specifics shaped the design. First, all `file://` pages share one
   `localStorage` in Chromium, so the app stores **nothing** persistently.
   Second, a meta-tag CSP is the only hardening layer available, so it is strict
   and hash-based.

6. **Telegram's 4 096-character limit matters.** A raw SDP is about 6 KB. Using the
   standard `setCodecPreferences` API (no SDP editing) plus `deflate-raw` and
   base64, a full invitation is about **1 880 characters**. That fits in one chat
   message.

## 3. Threat model

**Assets:** call content (audio/video). Secondary: the fact of the call, its
timing, the participants' IP addresses, camera/mic access.

| Adversary | Capability | Outcome with PrivateCall |
|---|---|---|
| Passive network eavesdropper (ISP, Wi‑Fi, state) | Sees all packets | Sees an encrypted DTLS-SRTP flow, IPs, timing and packet sizes. Cannot read content. |
| Active network attacker without signaling access | Injects, blocks, redirects packets | Cannot complete DTLS without the private key matching the fingerprint in the signaling. Can block the call (DoS). |
| Controls the invitation channel (compromised chat app, email) | Reads and rewrites the invitation/reply | Can mount a person-in-the-middle by swapping certificates. **Detected** when users compare codes and the attacker cannot alter the comparison: matching by chance is 1 in 10⁶ per attempt (commitment prevents searching). Receives no media before a user confirms, except during that user's 30-second microphone window. Learns IP addresses and call timing. |
| Same, plus real-time speech manipulation | Alters the digits each person hears | **May defeat a spoken comparison** (§4.2b). Comparing the code by text through an independent trusted app is the defence; the UI offers it. |
| Same, but forges the commitment | | Joining side ends the call automatically ("Security check failed"). Tested. |
| Malicious STUN/TURN operator | Sees metadata, can drop/relay packets | Cannot decrypt (end-to-end DTLS). Can observe IPs, timing, volume; can deny service. |
| Malicious or crafted invitation file | Arbitrary input to the parser | Bounded sizes, strict base64, bounded decompression, exact-key JSON schemas, structural SDP checks; nothing rendered as HTML; CSP blocks script injection and network exfiltration (`connect-src 'none'`). |
| The other participant | Legitimate peer | Can record the call and learns your IP on a direct path. Out of scope (use relay-only mode to hide IP). |
| Compromised endpoint (malware, malicious extension) | Full control of the browser | **Not defended.** No browser app can protect against this. |
| Tampered distribution of `PrivateCall.html` | Replaces the app | Not defended in-app. A tampered file can do anything. Mitigation: SHA-256 published with each release, reproducible build, obtain from a trusted person. |

## 4. The security-code protocol (reassessed in 1.1)

### 4.1 Protocol

Standard primitives only: SHA-256 (WebCrypto), the browser's ECDSA P-256 DTLS
certificates, DTLS 1.2/1.3 with ECDHE (forward secrecy), SRTP. There is no
custom encryption. The only protocol logic is the *binding* below, adapted from
ZRTP's hash commitment (RFC 6189 §4.4.1.1) and short authentication string (§7).
The protocol is unchanged in 1.1 (still `v1`), so 1.0 and 1.1 interoperate.

* **Offerer (A)** draws `sid` (16 random bytes) and `nA` (32 random bytes) and
  sends `commit = SHA-256(LP("PrivateCall commit v1", sid, nA))` in the invitation,
  along with its offer SDP (which contains A's certificate fingerprint `fpO`).
* **Answerer (B)** draws `nB` (32 bytes) and returns it with its answer SDP (`fpA`).
* After DTLS completes (so both certificates are now fixed), A sends `nA` over
  the encrypted data channel. B checks it against `commit`. On a mismatch, or if
  it doesn't arrive within 20 s, B ends the call.
* Both display `SAS = SHA-256(LP("PrivateCall SAS v1", sid, fpO, fpA, nA, nB))[0..8] mod 10⁶`.
  `LP` = 4-byte length prefix per field, so field boundaries can't shift.

### 4.2 Two different attackers: keep them apart

**(a) Key-search / guessing attacker** (controls the invitation channel and the
network, but cannot alter what people *say or see* in the comparison).
Without the commitment, the party that sends last could generate certificates
until both sides showed the same 6 digits (about 10⁶ key generations, minutes of
work). With the commitment, everything the interceptor sends to either side is
fixed before it learns `nA` (256 random bits), so A's code is unpredictable to
it. The two codes collide with probability 10⁻⁶ per attempt, and each attempt
is a visible call that the users must accept. *Status:* this is protocol reasoning
(it mirrors ZRTP). It has not been formally verified or independently reviewed.
Tests exercise concrete attacker strategies: substitution with forwarded
commitment, forged commitment, replaced/replayed reveal, and withheld reveal.

**(b) Real-time media-manipulation attacker** (sits in the middle *and* can alter
the audio or video it relays: splicing, voice conversion, synthesis). If the code
is compared by voice over the same call, this attacker can replace the digits
each person hears with the digits shown on the other screen. The 10⁻⁶ figure
says nothing about this attacker. Its success depends on the human comparison,
not on the cryptography. This is a documented, practical attack class:

* RFC 8826 (WebRTC security considerations) §4.3.2.2 notes that SAS does not
  offer a practical solution against a compromised calling service, and that
  voice cloning makes spoken comparison weaker.
* Shirvanian & Saxena, "Wiretapping via Mimicry" (ACM CCS 2014), built
  voice-imitation person-in-the-middle attacks against crypto-phone SAS
  comparison, including short numeric codes. Automated speaker verification
  failed to detect them.

So, honestly: **spoken comparison over the call protects against interceptors
who cannot manipulate speech in real time. It may not protect against a
well-resourced one.**

### 4.3 What 1.1 does about (b)

Each item uses established mechanisms, not new cryptography.

1. **Compare in a different app (stronger option, now in the code panel).** The
   code is also offered by text: "Copy code", to send through *a different app you
   trust than the one used for the invitation*. An attacker must then also
   control that second channel. This is the out-of-band verification RFC 8826
   §4.3.2 points to. Its strength is exactly the independence and integrity of
   that second channel, which the UI says plainly.
2. **Each person reads half.** The panel tells each person, with the actual
   digits, what to say ("say: 998"; the starter has the first three digits, the
   joiner the last three) and what to expect to hear. Both directions of
   speech must be manipulated consistently. This raises the bar slightly; it is
   not a defence against a capable synthesizer.
3. **Nothing is sent before confirmation except the deliberate speaking window**
   (§2.2). Even an attacker who defeats the comparison receives nothing until a
   user says "match". Before that, it gets only what was said while "Speak the
   code" was on.
4. **Only the local button verifies.** Forged "they confirmed" messages are shown
   as information and change nothing. Tested with injected messages.

### 4.4 Stronger options considered and not implemented

| Option | Why not (now) |
|---|---|
| Longer code (8–10 digits, word lists) | Guessing is already 10⁻⁶ per attempt. Length does not help against attacker (b), and longer codes are compared less carefully. |
| PAKE (e.g. CPace, SPAKE2) with a word agreed in person | The right primitive for "we share a short secret". But WebCrypto offers no PAKE and no hash-to-curve, so it would need hand-written elliptic-curve code: unreviewed custom cryptography, which the brief excludes. Revisit with an audited, dependency-free implementation. |
| HMAC of the fingerprints with a pre-shared secret | A human-memorable secret falls to an offline dictionary attack by whoever sees the invitation. A high-entropy secret is a key-distribution and storage problem (nothing can be stored safely on `file://`). |
| Third-party identity (RFC 8827 IdP) | Needs identity-provider infrastructure; contrary to the serverless design. |
| Key continuity (remember the peer's key) | Needs persistent storage that `file://` can't protect, and RFC 8826 §4.3.2.1 notes that users click through key-change warnings. |

### 4.5 Binding the code to the real session (unchanged)

* The SAS is computed over the exact `a=fingerprint` values the browser enforces
  in the DTLS handshake. SDP inspection rejects any SDP whose media sections carry
  more than one distinct fingerprint, so the code can't be computed over a
  different fingerprint from the one in use.
* Our own SDP fingerprint is checked against the certificate we generated
  (`getFingerprints`, where available).
* After connecting, the app reads the *actual* local and remote DTLS certificates
  from `getStats()` and ends the call if they differ from the fingerprints the code
  was computed over. This is defence in depth (browsers already enforce it).
  Chromium reports these stats; Firefox may not, and then the details panel says
  "Not reported by this browser".
* `sid` is in both the commitment and the SAS. The offerer accepts exactly one
  reply, and only for its own `sid`.

## 5. Key design decisions and trade-offs

* **WebRTC, unmodified.** DTLS-SRTP, Opus, VP8/VP9/H.264, congestion control,
  echo cancellation and noise suppression all come from the browser.
  No media is processed in JavaScript.
* **Non-trickle ICE, reliability first (revised in 1.1).** Version 1.0 stopped
  gathering 3.5 s after the first "useful" candidate, which could drop relay
  candidates (e.g. TURN over TLS) on slow links. Version 1.1 waits for the browser
  to report gathering complete. Measured in the lab: that takes 0.1–0.4 s when the
  servers are reachable, 26 s when a STUN name doesn't resolve, and 40 s when UDP
  is blocked. Since unreachable servers can never contribute, 1.1 stops only after
  **15 s minimum and 4 s without new candidates**, never while no relay candidate exists yet and a configured relay URL is still
  pending (Chromium reports which server each candidate or error came from),
  and in any case after **30 s** (`src/app/gather.js`, unit-tested). The person
  sees "Checking which network routes work…" after 4 s.
* **Always negotiate audio + video + data.** A voice call is just a call that
  starts with the camera off. Either person can turn the camera on later without
  another exchange (`replaceTrack`). The camera is never opened unless clicked.
* **Codec restriction through `setCodecPreferences`:** Opus (+RED), VP8, VP9
  profile 0, H.264 constrained-baseline. Interoperable, hardware-friendly, and
  it shrinks the invitation by about 35 %. If the API is missing, browser
  defaults are used.
* **Audio first:** audio sender priority `high`, video capped at 1.5 Mbit/s with
  `low` priority, 720p30 as a ceiling. The browser's congestion control adapts
  downwards from there.
* **No persistent device identity (v1).** Persistent keys would give "same person
  as last time" continuity (like Signal safety numbers). But on `file://`,
  `localStorage` is shared with every local HTML file in Chromium, and
  non-extractable WebCrypto keys in IndexedDB have the same exposure. Portability
  (a single file on a USB stick) would also suffer. Per-call SAS gives
  equivalent protection when users compare codes. It is listed as a future
  option with a proper storage design.
* **Zero runtime dependencies; zero build dependencies.** The build script joins
  modules under rules it enforces (static imports only, unique top-level names,
  no dynamic code). The output is readable, not minified, so anyone can audit
  what they run.
* **Strict CSP from a meta tag:** `default-src 'none'`, scripts and styles by
  SHA-256 hash only, `connect-src 'none'` (no fetch/XHR/WebSocket exfiltration
  path), `form-action`/`base-uri` `'none'`, and Trusted Types `'none'` (no
  string-to-HTML sinks allowed at all in Chromium).
* **No TURN secrets in the file.** Relays are added by pasting a short-lived
  *relay code* produced by the relay operator with `tools/make-relay-code.mjs`
  (coturn `use-auth-secret` scheme). Codes expire; the shared secret never leaves
  the operator.

## 6. Connectivity strategy

1. Host candidates (mDNS-obfuscated where the browser does that) cover the
   same-LAN case.
2. Two public STUN servers (Google, Cloudflare) give server-reflexive candidates.
   These work through common home-router NATs (lab: port-restricted cone ⇄
   port-restricted cone connects directly). They can be switched off, and they
   are **not contacted at all in relay-only mode** (new in 1.1).
3. An optional user-supplied TURN relay (UDP, TCP, or TLS on 443) covers
   symmetric NATs, UDP-blocked networks, TCP/443-only firewalls, and "hide my IP".
   One side having a relay is enough (lab-tested). Chromium **validates the TURN/TLS
   server certificate**, so `turns:` needs a hostname with a publicly trusted
   certificate (lab: a self-signed relay is refused, and the app reports it).
   Chromium also sends TURN/TCP through a configured HTTP proxy.
4. **Keeping the exchange alive (new in 1.1).** Manual signaling means minutes can
   pass between the reply being created and being added. In the lab, through
   typical port-restricted home NATs (Linux conntrack: 30 s for unanswered UDP),
   calls **failed when the reply was added more than ~40 s after creation**. The
   joiner's connectivity checks had stopped, so its router dropped the
   starter's checks. Fix: the joining side supplies the offer's candidates through
   the standard `addIceCandidate()` API instead of inside the SDP. Until connected
   (at most 15 min), it re-supplies them every 15 s under fresh ICE foundations,
   which restarts its checks toward the same addresses and keeps its pinhole open.
   No new information is revealed (same addresses), and the security binding is
   unaffected (fingerprints are not involved). Lab result: gaps of 90 s and 200 s
   connect. Also, before the first connection, a browser-reported ICE "failed" is
   no longer treated as final (Chromium recovers from it). The starter gives up
   45 s after adding the reply.
5. Failure handling: the offerer gives up 45 s after adding the reply, with a
   diagnostics summary. The joiner gives up after 15 min. During a call, a
   disconnection ends the call when the browser reports it failed, or after 30 s
   at most (lab: an 8 s outage recovered; a longer one ended after ~17 s).

**Not claimed:** any ability to bypass Iranian (or other) filtering. The lab
models NAT types and simple port/protocol blocking. It does not model DPI,
protocol fingerprinting, IP blocklists, throttling or shutdowns. Nothing has
been field-tested in Iran.
