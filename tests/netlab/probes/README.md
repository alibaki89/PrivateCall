# Lab probes

One-off measurement scripts used to make the 1.1 design decisions (run as root):

* `probe-gather.mjs [nat]`: candidate gathering timing and server attribution per ICE server configuration. Finding: unreachable STUN makes gathering take 26–40 s; Chromium reports `RTCIceCandidate.url`.
* `probe-tls.mjs`: Chromium validates TURN/TLS certificates.
* `probe-tcp.mjs`: raw TCP/TLS reachability of the relay through the NAT.
* `probe-slow.mjs <plain|readd> <seconds>`: slow-exchange behaviour through port-restricted NATs. Finding: plain fails beyond ~40 s; re-supplying candidates connects after 90 s and 200 s.
