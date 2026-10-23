# Changes

## 1.2.0 — final refinement

The message format is unchanged (`v1`), so 1.2, 1.1 and 1.0 can still call each
other. The security architecture is unchanged.

### Interface
* Restyled as a plain desktop utility:
  * system font and neutral colours;
  * ordinary rectangular buttons with 4 px corners;
  * no cards, pills, gradients, animations, avatars or decorative icons.
* Icons remain only on the Microphone and Camera call buttons. Every call
  control now has a visible text label (Microphone, Camera, Details, Leave).
* The security status is plain text at the top of the call ("Encrypted · not
  verified" / "Encrypted · verified"). Clicking it reopens the code check.
* **Clearer code check.** The panel states each person's part with the actual
  digits:
  1. "Turn on your microphone and say: **998**"
  2. "Listen. The other person should say: **872**"
  3. "If everything matches your screen, click Codes match."

  The caller/joiner halves are mirrored as before (reviewed; unchanged logic).
  The button names are shorter: "Turn on microphone", "Codes match",
  "Codes don't match".
* Shorter, plainer instructions throughout.

### Fixes
* The code panel was rebuilt every 2 seconds (on every statistics update). Screen
  readers re-announced the code repeatedly, and the code could not be selected.
  It is now built once per code.
* Removed the remote-voice level animation. It attached a second (WebAudio) consumer
  to the received audio track purely for decoration.
* Statistics updates no longer re-run local-media rendering (repeated `play()` calls).

### Call quality and latency
* Measured in a local call: Opus in use (RED negotiated but not used), audio
  receive buffering about 32 ms, playout delay 30 ms, video decode about 1 ms. No
  app-induced delay was found. See `docs/TESTING.md` §2.5.
* The Details panel now shows **audio buffering** and the **audio codec**, next to
  round-trip time, route and packet loss, with a short note on reading them. These
  are the numbers needed to locate a delay in a real call.

## 1.1.0 — security correctness and real-world connectivity

The protocol format is unchanged (`v1`), so 1.1 and 1.0 can call each other.

### Authentication (reassessed)
* Documented the two attacker classes separately. Commitment-based guessing
  resistance (about 10⁻⁶ per attempt, by reasoning) is distinct from attackers who
  manipulate speech in real time, which may defeat a spoken comparison (RFC 8826
  §4.3.2.2; Shirvanian & Saxena, CCS 2014).
* Added a **stronger option in the code panel**: compare the code by text through
  a *different* trusted app ("Copy code").
* **Each person reads half the code** ("You read" / "They read"), so both
  directions of speech must be checked.
* Considered and did not implement: longer codes, PAKE, HMAC with a pre-shared
  secret, identity providers, key continuity. Reasons are in `docs/ARCHITECTURE.md` §4.4.
* No new cryptography was introduced.

### Pre-verification media
* **Nothing is sent before you confirm the code.** In 1.0, audio flowed
  immediately. Now the microphone, like the camera, is detached from its sender
  until confirmation.
* **"Speak the code"** opens the microphone for 30 s to read the code aloud.
  **"Talk without checking"** (after a warning) is the explicit override.
* Tested: an interceptor received 0 audio bytes and 0 video frames before
  verification, and only the speaker's audio during their window.

### NAT traversal
* **Gathering no longer stops early** (1.0 stopped 3.5 s after the first
  srflx/relay candidate). It now waits for "complete". When a server is
  unreachable, it stops after 15 s and 4 s of quiet, never while a configured
  relay is still pending, and at most after 30 s (`src/app/gather.js`).
* **Slow-exchange fix.** Through typical home NATs, 1.0 failed if the reply was
  added more than ~40 s after it was created (measured). The joiner now
  re-supplies the starter's addresses every 15 s via `addIceCandidate()` until
  connected. Lab: gaps of 90 s and 200 s connect.
* A browser-reported ICE "failed" before the first connection is no longer
  treated as final.

### TURN / relay
* Relay-only mode no longer contacts public STUN servers.
* Verified in the lab that Chromium validates TURN/TLS certificates. Documented
  that operators need a publicly trusted certificate.
* Verified that relay credentials never appear in invitations.

### Robustness
* SDP that passes PrivateCall's checks but is rejected by the browser engine now
  gives "This message isn't valid" (previously a generic error) and releases the
  microphone.
* Stricter feature detection: actually constructs `deflate-raw` streams and checks
  `generateCertificate`.

### Testing
* **New network lab** (`tests/netlab/`): Chromium in Linux network namespaces
  behind simulated home, symmetric, UDP-blocked and TCP/443-only NAT routers, with
  a real STUN/TURN server (pion/turn).
* **More adversarial e2e tests:** replaced/replayed reveal, withheld reveal, forged
  "confirmed", 4 000 injected malformed control messages, impersonation (a
  documented limit), browser-rejected SDP, and media leakage measured at the
  interceptor.
* **Fuzzing** of the envelope, schema, SDP and relay-code parsers (about 10 000
  inputs, deterministic seeds).
* New `docs/COMPATIBILITY.md`.
