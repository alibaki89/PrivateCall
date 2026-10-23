# Network lab

Real PrivateCall calls between two Chromium instances. Each runs inside its own
Linux network namespace behind a simulated NAT router, with a real STUN/TURN
server on a simulated public network.

```
hostA 192.168.1.10 ── rtrA [NAT] 203.0.113.2 ──┐
                                                ├── inet ── relay 192.0.2.10 (STUN + TURN udp/tcp 3478, TLS 443)
hostB 192.168.1.10 ── rtrB [NAT] 198.51.100.2 ─┘
```

NAT profiles (`lab.mjs`, iptables) use RFC 4787 terms:

| Profile | Behaviour |
|---|---|
| `cone` | endpoint-independent mapping (port-preserving MASQUERADE), address+port-dependent filtering, unsolicited WAN input dropped. This is a typical home router. |
| `symmetric` | `MASQUERADE --random-fully`: a new external port per destination |
| `udp-blocked` | no outbound UDP; TCP allowed |
| `tcp443-only` | only outbound TCP to port 443 |

## Running (Linux, root)

1. Install `iproute2`, `iptables` and `openssl`.
2. Build the relay (test-only, based on [pion/turn](https://github.com/pion/turn) v4.1.4):
   ```sh
   cd tests/netlab/relayserver && go build -o /tmp/relayserver .
   ```
   In the original sandbox, Go's module proxy and checksum database were not
   reachable. Modules were fetched directly from GitHub with `GOPROXY=direct
   GOSUMDB=off`, and `golang.org/x/{crypto,net,sys}` came from their GitHub
   mirrors via local `replace` directives (see `go.mod`). On a normal machine,
   drop the `replace` block and let the checksum database verify the modules.
3. `npm run build && sudo node tests/netlab/run.mjs [filter]`

## What it does not model

DPI or protocol fingerprinting, IP blocklists, bandwidth throttling, packet loss,
latency, carrier-grade NAT pools, IPv6, captive portals, or the real Internet.
Passing these tests is necessary, not sufficient, for real-world connectivity.

## Test-only adjustments

* An init script rewrites the app's public STUN servers to the lab STUN server
  (except in tests that model unreachable STUN).
* The TLS relay test passes `--ignore-certificate-errors` to the browser using
  it, as a stand-in for a publicly trusted certificate. A separate test shows
  the rejection without it.
* `--no-proxy-server` keeps the sandbox's HTTP proxy settings out. Chromium
  would otherwise tunnel TURN/TCP through them.
