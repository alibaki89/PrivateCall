module privatecall/netlab/relayserver

go 1.24

require (
	github.com/pion/logging v0.2.4
	github.com/pion/turn/v4 v4.1.4
)

require (
	github.com/pion/dtls/v3 v3.0.7 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/stun/v3 v3.0.1 // indirect
	github.com/pion/transport/v3 v3.0.8 // indirect
	github.com/pion/transport/v4 v4.0.1 // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	golang.org/x/crypto v0.32.0 // indirect
)

replace (
	golang.org/x/crypto => /tmp/gomirror/crypto
	golang.org/x/net => /tmp/gomirror/net
	golang.org/x/sys => /tmp/gomirror/sys
)
