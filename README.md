# PrivateCall

A portable, privacy-focused one-to-one voice and video calling application. PrivateCall runs from a single HTML file in a desktop browser. Two people exchange one invitation and one reply through an existing messaging channel; the browsers then establish a WebRTC connection.

**[Download PrivateCall.html](https://github.com/alibaki89/PrivateCall/releases/latest/download/PrivateCall.html)** · [Website](https://alibaki89.github.io/PrivateCall/) · [Simple user guide](documentation/PrivateCall-How-To.pdf) · [Technical report](documentation/PrivateCall-System-Report.pdf)

## Making a call

1. Both participants download **the same** `PrivateCall.html` and open it in **Google Chrome** (the tested browser).
2. One chooses **Start a call**, selects voice or video, and sends the complete invitation text through any chat app.
3. The other chooses **Join a call**, pastes the invitation, and sends the complete reply back.
4. The first participant pastes the reply. When connected, both compare the six-digit security code before sharing normal voice/video.

For the detailed instructions, see [How to Use (PDF)](documentation/PrivateCall-How-To.pdf) or [plain text](documentation/PrivateCall-How-To.txt).

## How it works

PrivateCall uses manual WebRTC signaling, rather than a dedicated signaling service. Calls use browser-provided DTLS-SRTP encryption and normally travel directly between the two participants. Public STUN servers help identify reachable network addresses. Some networks require a separately configured TURN relay; a direct call is **not guaranteed**. Verification relies on correctly comparing the six-digit security code, ideally using an independently trusted channel.

There is no account, application backend, message history, or recording feature. This does **not** make users anonymous, prevent a participant from recording externally, or conceal network metadata from every observer.

**Status:** experimental prototype. The supplied test records cover Chromium and simulated networks. The project has **not been independently security-audited** and is **not recommended for high-risk communications**. Connections on restrictive networks (including Iran) have not been demonstrated by the supplied tests.

## Repository structure

| Path | Content |
| --- | --- |
| [`dist/PrivateCall.html`](dist/PrivateCall.html) | Self-contained distributable file |
| [`src/`](src/) | JavaScript modules, UI template and CSS |
| [`tests/`](tests/) | Unit, browser end-to-end, and network-lab tests |
| [`docs/`](docs/) | Developer architecture, security, compatibility, and testing notes |
| [`documentation/`](documentation/) | PDF system report, printable and plain-text user guides, documentation sources |
| [`site/`](site/) | Minimal static GitHub Pages landing page; **not** the calling app |
| [`tools/`](tools/) | Optional relay-operator utility |
| [`build.mjs`](build.mjs) | Reproducible, dependency-free HTML bundler |

## Build and verify

Node.js 20 or newer is needed **only for development**, not to use the app.

```sh
node build.mjs --check  # Verify the committed HTML matches the source
npm test                # Unit tests (no npm install needed)
node build.mjs          # Rebuild the HTML and SHA256SUMS
```

Browser E2E tests require Playwright and Chromium; the Linux network laboratory requires additional system tools and privileges. See [docs/TESTING.md](docs/TESTING.md) before running these.

## Documents

- [System design and implementation report](documentation/PrivateCall-System-Report.pdf)
- [How to use PrivateCall (PDF)](documentation/PrivateCall-How-To.pdf)
- [How to use PrivateCall (plain text)](documentation/PrivateCall-How-To.txt)
- [Architecture](docs/ARCHITECTURE.md)
- [Security and threat model](docs/SECURITY.md)
- [Known limitations](docs/LIMITATIONS.md)
- [Browser compatibility](docs/COMPATIBILITY.md)
- [Test evidence and limitations](docs/TESTING.md)
- [Release changes](CHANGES.md)

## License

MIT — see [LICENSE](LICENSE).
