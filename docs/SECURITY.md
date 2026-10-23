# PrivateCall — security and privacy (version 1.2)

This document states what PrivateCall protects and what it does not. Each
statement carries a label for how it is known:

* **[tested]** — an automated test exercises it (`TESTING.md`).
* **[lab]** — tested in the network lab (simulated NATs/firewalls, real TURN server).
* **[reasoning]** — follows from the protocol and the standards it relies on, but is not tested or independently reviewed.
* **[browser]** — depends on the browser's WebRTC implementation.

**Nothing here has been independently audited.** Do not describe PrivateCall as
safe for high-risk use until it has been.

## What is protected

**Call content is encrypted end to end** between the two browsers with
DTLS-SRTP, the mandatory WebRTC security layer. No PrivateCall server exists.
STUN and TURN servers carry no keys and cannot decrypt the media. [browser]
In the tested Chromium build, calls used DTLS 1.3 and `SRTP_AES128_CM_HMAC_SHA1_80`. [tested]
Through a TURN relay, the codes still match end to end; the relay only forwards
encrypted packets. [lab]

**Forward secrecy.** DTLS uses ephemeral ECDHE. Each call uses a freshly generated
ECDSA P-256 certificate that is never stored and is discarded at hang-up. [reasoning] [browser]

**Interception through the invitation channel is detectable — with limits.**
Anyone who can rewrite the invitation or reply can try to sit in the middle. If
they do, the two people see **different 6-digit codes**. [tested: full
certificate substitution with media relaying] A hash commitment stops them from
searching for certificates that make the codes match. Without changing what
people hear or see, their chance is about 1 in 1,000,000 per call attempt. [reasoning]
Forged commitments and replaced, replayed or withheld reveal values end the call
automatically. [tested]

**But a spoken comparison can be defeated by an attacker who manipulates speech
in real time.** An interceptor relaying the call could replace the digits each
person hears. Voice-imitation attacks of exactly this kind against SAS comparison
have been demonstrated (Shirvanian & Saxena, ACM CCS 2014), and RFC 8826
§4.3.2.2 warns about this weakness of spoken SAS. The cryptographic 1-in-a-million
figure does not apply to this attacker. **The stronger check is to compare the
code by text through a different app you trust** (not the one used for the
invitation). The code panel offers this ("Copy code"). It is as strong as that
second channel is independent of the first. [reasoning] Details and the options
considered are in `ARCHITECTURE.md` §4.

**Nothing is sent before you confirm the code** (since 1.1). Until *you*
press "Codes match", neither your microphone nor your camera is attached to
the connection, so no audio or video packets carry them. [tested: an interceptor
received 0 audio bytes and 0 video frames] The exceptions are your deliberate
choices:

* **"Turn on microphone"** (in the code panel) opens your microphone for 30 seconds (or until you turn it
  off) so you can read your half of the code. Anything said then could be heard
  by an interceptor. [tested: only the speaker's audio, and only during the window]
* **"Talk without checking"** (after a warning) sends your microphone for the
  rest of the call.
* **Camera before checking** (after a warning) sends video.

**Only you can mark the call verified.** Messages from the other side saying
"they confirmed" are shown as information and change nothing. [tested with
injected messages]

**Malformed or malicious messages are rejected.** This covers truncation,
corruption, oversized input, decompression bombs, unknown fields, wrong message
type, wrong version, ambiguous certificate fingerprints, SDP the browser engine
rejects, replayed invitations (within the same window), replies to other
invitations, and 4 000 malformed data-channel messages. Nothing from a message is
ever rendered as HTML. [tested; parsers also fuzzed with about 10 000 mutated
inputs]

**Camera and microphone are opened only after a click**, and released on hang-up,
on failure, on closing or reloading, and when the camera is turned off (the
device is stopped). [tested]

**No network access besides the call itself.** The Content-Security-Policy
forbids HTTP, WebSocket and similar (`connect-src 'none'`). The tests observe zero
HTTP requests and zero policy violations. [tested] The only traffic is WebRTC:
ICE/STUN/TURN and encrypted media.

**Nothing is stored.** No cookies, `localStorage`, IndexedDB, logs or recordings.
Settings, including a relay code, last only while the window is open. [by design]

## What is not protected

* **The code proves "no one in the middle", not identity.** Someone who receives
  your invitation and answers it *themselves* sees the same code as you. [tested]
  You must recognise the person.
* **Real-time speech manipulation** can defeat a spoken comparison (above).
* **Compromised computers** (spyware, malicious extensions, screen recording).
* **The other participant** can record the call.
* **Tampered copies of the app.** A modified file can fake everything, including
  the code. Get it from a trusted person; compare its SHA-256 (`dist/SHA256SUMS`).
* **Metadata** (next section).
* **Availability.** Anyone on the path can block the call. Nothing here
  circumvents censorship, and no such claim is made.
* **Memory.** JavaScript can't reliably erase memory. Secrets are zeroed at
  hang-up, but copies may remain until the browser closes.
* **Browser bugs.** Received SDP is checked structurally, then parsed by the
  browser's WebRTC engine. Keep the browser updated.

## Who can see what

| Observer | Learns | Does not learn |
|---|---|---|
| The other person (direct connection) | Your public IP address, and possibly your local network address | — |
| The app you send the invitation through | That you're setting up a PrivateCall, when, the call type, and your network addresses | Call content, relay credentials (never in the invitation; [lab]) |
| Google and Cloudflare STUN (default; off in relay-only mode) | That your IP is starting a WebRTC session, and when | Who you call, content |
| A relay (TURN), if used | Both IPs, timing, and traffic volume | Content |
| Your internet provider | That you're in an encrypted real-time call, with whom (IP or relay), and how long | Content |

**Hide your IP from the other person:** add a relay code and turn on "Always use
the relay". The invitation then contains only the relay address, the other person
only ever sees the relay address, and public STUN servers are not contacted.
[lab: verified from the other side's own connection statistics]

## Relay (TURN) security notes for operators

* Credentials are short-lived (coturn `use-auth-secret` scheme,
  `tools/make-relay-code.mjs`). The secret never leaves the operator. The app
  rejects expired codes and never stores them. [tested]
* For `turns:` (TLS on 443), use a hostname with a **publicly trusted
  certificate**. Chromium validates it: a self-signed relay is refused, and
  relay-only mode then reports "relay server couldn't be reached". [lab]
  TLS to the relay is transport camouflage and protects credentials. It is not
  what protects call content; DTLS-SRTP does that end to end.
* A relay can see metadata and deny service. Run it only for people who trust you.

## Implementation hardening (unchanged from 1.0)

* Strict hash-based CSP: `default-src 'none'`; only the inlined script and style
  (by SHA-256) may run. Also `connect-src 'none'`, `form-action 'none'`,
  `base-uri 'none'`, `object-src 'none'`, and Trusted Types `'none'`.
* DOM updates use `textContent` and DOM APIs only. The source contains no
  `innerHTML`, `eval`, `Function` or dynamic `import`.
* Input limits: 40 000 characters of text, 64 KB files (checked before reading),
  24 KB decoded, 32 KB decompressed (streaming cap), 20 000-character SDP,
  512-byte control messages. Strict canonical base64. Exact-key JSON schemas.
* Randomness from `crypto.getRandomValues`; hashing with WebCrypto SHA-256.

## Release practice (for maintainers)

1. Build from a clean checkout with `node build.mjs`. The build is deterministic.
2. Run `npm test`, `npm run test:e2e`, and (as root, Linux) `npm run test:netlab`.
3. Publish `PrivateCall.html` with `SHA256SUMS`, ideally signed with a key users
   obtain separately.
4. The app never updates itself (an update channel is an attack channel).
5. Change the protocol version (`v1`) whenever the message or code format changes.
   Version 1.1 kept the format, so it interoperates with 1.0.
