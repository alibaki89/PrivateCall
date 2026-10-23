# Limitations and future work (prioritised, version 1.2)

## Must address before relying on this for high-risk use

1. **Independent security review.** The commitment/SAS protocol (a small
   adaptation of ZRTP's), the media gating and the parsers are tested against
   concrete attacks, but no cryptographer or security auditor has reviewed them.
2. **Spoken comparison is weak against capable attackers.** A person in the middle
   who can manipulate speech in real time may defeat a code read aloud
   (`ARCHITECTURE.md` §4.2b). The text comparison through a separate app is the
   real defence, and it is only as good as that app's independence. User studies
   are needed on whether people actually use it.
3. **Firefox and Edge untested** (`COMPATIBILITY.md`). The new slow-exchange
   technique (re-supplying candidates) is verified only in Chromium.
4. **No field testing.** The network lab models NAT types and port/protocol
   blocking only. It does not model DPI, IP blocklists, throttling, packet loss,
   latency, CGNAT pools, IPv6, or anything about Iranian networks. No
   connectivity or censorship-resistance claim is made.
5. **Relay with a real certificate.** TURN/TLS was lab-tested with certificate
   checks disabled as a stand-in. Repeat it with a real hostname and a publicly
   trusted certificate.
6. **Distribution integrity.** Users still need a practical way to check that
   their copy of the file is genuine (signed releases and a checksum read out by a
   trusted contact).

## Known behaviour and limits

* **Latency in real calls is not explained yet.** The noticeable delay in the
  first real call could not be reproduced in the sandbox. In a local call the
  app adds only the browser's minimum buffering (about 30 ms of audio buffering).
  Packet loss, jitter and long paths could not be emulated (`tc`/netem was
  unavailable). The Details panel now shows round-trip time, route (direct or
  relay, UDP or TCP), audio buffering and loss. Reading those during a delayed call,
  plus the type of headset used, is what's needed to find the cause.
* **No audio/video lip-sync.** Received audio and video are played independently
  (no shared media stream). This avoids delaying speech to wait for video, but
  they are not kept in sync. The size of the drift on real networks has not been
  measured.
* **Waiting times.**
  * When public STUN servers are unreachable, an invitation takes about 15–30 s
    instead of under a second. This is a deliberate trade for not losing
    candidates.
  * The starter waits 45 s after adding the reply, and the joiner up to 15 min.
* **Slow exchanges.** Through port-restricted home NATs, Chromium now connects
  after 90 s and 200 s gaps (lab). Routers with shorter timeouts, symmetric NATs
  without a relay, or a starter whose own mapping expires are not covered.
* **No reconnection.** A long outage (lab: 40 s) ends the call; a new exchange
  is needed. Short outages (lab: 8 s) recover.
* **Pre-verification calling.** Nothing is sent before confirmation, so people
  can't chat while setting up. "Talk without checking" exists for that, with a
  warning.
* **Peer-sent status is informational** ("they confirmed", their mic/camera state)
  and could be faked by an interceptor.
* **IP disclosure** on direct calls. Relay-only mode avoids it but needs a relay.
* **Accessibility.** Keyboard operation, focus management and screen-reader labels
  exist, but there has been no audit. The 30-second speaking window may be too
  short for some users; pressing again restarts it.
* **English only.** Persian is designed for (RTL verified with English text) but
  not translated.

## Candidate future work

1. A **Persian translation**, with native-speaker review of the security wording.
2. An **audited PAKE** (e.g. CPace), with a word agreed in advance. This would
   give cryptographic authentication without relying on voice. It is only worth
   it with a reviewed, dependency-free implementation.
3. **ICE restart through one more manual exchange**, to recover from network
   changes without re-verifying.
4. **Optional key continuity**, once there is a storage design that `file://` can
   protect.
