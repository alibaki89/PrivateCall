// Test-only STUN/TURN server for the PrivateCall network lab (never shipped).
// Built on pion/turn, an established open-source TURN implementation.
// Speaks STUN binding + TURN over UDP and TCP, and TURN over TLS (turns:) on a
// separate port, authenticating with the coturn-compatible "TURN REST API"
// scheme (username = "<expiry>:<label>", password = base64(HMAC-SHA1(secret, username))),
// i.e. exactly what tools/make-relay-code.mjs produces.
package main

import (
	"crypto/tls"
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

func main() {
	publicIP := flag.String("public-ip", "", "IP address to advertise for relayed addresses")
	port := flag.Int("port", 3478, "UDP/TCP port")
	tlsPort := flag.Int("tls-port", 0, "TLS port (0 = disabled)")
	certFile := flag.String("cert", "", "TLS certificate (PEM)")
	keyFile := flag.String("key", "", "TLS key (PEM)")
	realm := flag.String("realm", "privatecall.test", "realm")
	flag.Parse()
	secret := os.Getenv("TURN_SECRET")
	if *publicIP == "" || secret == "" {
		log.Fatal("need -public-ip and TURN_SECRET")
	}
	ip := net.ParseIP(*publicIP)
	lf := logging.NewDefaultLoggerFactory()
	gen := &turn.RelayAddressGeneratorStatic{RelayAddress: ip, Address: "0.0.0.0"}

	udp, err := net.ListenPacket("udp4", "0.0.0.0:"+itoa(*port))
	if err != nil {
		log.Fatal(err)
	}
	tcp, err := net.Listen("tcp4", "0.0.0.0:"+itoa(*port))
	if err != nil {
		log.Fatal(err)
	}
	listeners := []turn.ListenerConfig{{Listener: tcp, RelayAddressGenerator: gen}}
	if *tlsPort != 0 {
		cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
		if err != nil {
			log.Fatal(err)
		}
		tl, err := tls.Listen("tcp4", "0.0.0.0:"+itoa(*tlsPort), &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
		if err != nil {
			log.Fatal(err)
		}
		listeners = append(listeners, turn.ListenerConfig{Listener: tl, RelayAddressGenerator: gen})
	}
	authLog := lf.NewLogger("auth")
	s, err := turn.NewServer(turn.ServerConfig{
		Realm:             *realm,
		AuthHandler:       turn.LongTermTURNRESTAuthHandler(secret, authLog),
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: gen}},
		ListenerConfigs:   listeners,
		LoggerFactory:     lf,
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("relay listening on %s:%d (udp,tcp) tls=%d", *publicIP, *port, *tlsPort)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	_ = s.Close()
}

func itoa(n int) string { return net.JoinHostPort("", itoaRaw(n))[1:] }
func itoaRaw(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}
