# Browser compatibility (opening `PrivateCall.html` from disk)

**Tested:** Chromium 153 on Linux (Playwright build), both for same-machine
calls and in the network lab. **Not tested:** Google Chrome, Microsoft Edge,
Firefox, Safari, Windows, macOS. The sandbox could not download Firefox or Edge.
Everything below about those browsers comes from documentation and code review.
It is not a test result.

## Requirements and where each browser stands

| Requirement | Used for | Chromium (tested) | Chrome / Edge (expected) | Firefox (expected; untested) |
|---|---|---|---|---|
| `file://` is a secure context | WebCrypto, getUserMedia, clipboard | ✔ verified | Same engine as Chromium | Secure Contexts spec treats `file:` as potentially trustworthy; needs a hands-on check |
| `CompressionStream('deflate-raw')` | message encoding | ✔ | Chrome/Edge 103+ | Firefox 113+ |
| `RTCPeerConnection.generateCertificate` (ECDSA P-256) | fresh certificate per call | ✔ | ✔ | ✔ |
| `RTCCertificate.getFingerprints()` | self-check of our own fingerprint | ✔ | ✔ | Not implemented. The check is skipped (guarded). |
| Certificate stats in `getStats()` | defence-in-depth DTLS certificate check | ✔ | ✔ | Probably absent. The details panel shows "Not reported by this browser"; the call proceeds. |
| `setCodecPreferences` | smaller invitations, interoperable codecs | ✔ | ✔ | Firefox 128+ (per Mozilla's blog). Without it, browser defaults are used (guarded). |
| `RTCPeerConnectionIceEvent.url` | knowing when a relay finished gathering | ✔ | ✔ | Unknown. Without it the gathering policy falls back to the quiet-period rule. |
| Re-adding a candidate under a new foundation restarts checks | slow-exchange reliability (joiner side) | ✔ lab: 90 s and 200 s gaps connect | Same engine | **Unknown.** If Firefox ignores re-added candidates, a Firefox *joiner* behind a port-restricted NAT has the ~40 s window that 1.0 had. |
| Recovering from ICE "failed" before the first connection | slow exchanges | ✔ lab | Same engine | Unknown |
| `replaceTrack(null)` / re-attach without renegotiation | pre-verification media gating | ✔ | ✔ | ✔ (long supported) |
| Negotiated data channel, max-bundle | control messages | ✔ | ✔ | ✔ |
| TURN over TLS validates the server certificate | relay security | ✔ lab | Same engine | Expected; unverified |
| CSS `:has()` | layout details | ✔ | Chrome 105+ | Firefox 121+ (older versions: cosmetic issues only) |
| `<dialog>` | settings, warnings | ✔ | ✔ | Firefox 98+ |
| Async clipboard on `file://` | Copy / Paste buttons | ✔ (falls back to manual copy without permission) | ✔ | `writeText` yes; `readText` 125+ with a confirmation pop-up; Ctrl+V always works |

**Minimum versions the app checks for itself.** At start-up the app checks
WebRTC, getUserMedia, secure context, WebCrypto, `deflate-raw` compression and
certificate generation. If any is missing, it disables Start/Join and shows
"This browser can't make calls".

## Known browser-specific behaviour

* **Chromium sends TURN/TCP through a configured HTTP proxy** (seen in the lab).
  On corporate networks with a proxy, this can help the relay connection.
* **Chromium "Local Network Access"** permission prompts (Chrome 142+) apply to
  web requests to local addresses. According to Chrome's announcement, WebRTC was
  *not yet* covered. If that changes, same-LAN calls may show a permission prompt.
* **Local addresses in invitations.** In the lab, Chromium exposed raw private
  addresses (e.g. 192.168.1.10) in host candidates. In other runs it used mDNS
  names (`….local`). This varies with browser policy and permissions. Relay-only
  mode avoids it.
* **Edge** is Chromium-based. Its Enhanced Security mode and SmartScreen
  download warnings for `.html` files are untested.

## Manual checks still required

See `TESTING.md` §4 (M6, M7). In short: Firefox ⇄ Firefox and Firefox ⇄ Chrome
in both directions, opening from disk, with a slow (2-minute) exchange behind
home routers, plus Edge ⇄ Chrome.
