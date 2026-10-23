// When to stop collecting network candidates (non-trickle ICE).
//
// Because the invitation and reply are each sent once, any candidate gathered
// after the message is produced is lost for this call. Reliability therefore
// comes first: we wait for the browser to report gathering "complete".
//
// Measured in the network lab (Chromium 153, see docs/TESTING.md): with reachable
// STUN/TURN servers, gathering completes in ~0.1-0.2 s, so waiting costs nothing.
// It is only slow when a server is unreachable: ~26 s when its DNS name cannot be
// resolved, ~40 s when UDP is blocked. Waiting that long cannot produce candidates
// from an unreachable server, so after a generous minimum we stop once no new
// candidate has appeared for a while -- but never while a configured relay
// (the fallback that makes restrictive networks work) is still being contacted,
// when the browser lets us tell which server each result came from.

export const GATHER_POLICY = {
  minMs: 15000, // never stop before this unless gathering is complete
  quietMs: 4000, // ...and only after this long without a new candidate
  maxMs: 30000, // hard cap: an invitation must eventually be produced
};

// state: {
//   elapsedMs, msSinceLastCandidate, complete,
//   relayUrls: string[]            relay (TURN) URLs configured
//   settledRelayUrls: Set<string>  relay URLs that produced a candidate or an error
//   attribution: boolean           browser reports which server a result came from
//   haveRelayCandidate: boolean    at least one relay candidate was gathered
// }
// returns { done: boolean, reason }
export function gatherDecision(state, policy = GATHER_POLICY) {
  if (state.complete) return { done: true, reason: 'complete' };
  if (state.elapsedMs >= policy.maxMs) return { done: true, reason: 'cap' };
  if (state.elapsedMs < policy.minMs) return { done: false, reason: 'min' };
  if (state.msSinceLastCandidate < policy.quietMs) return { done: false, reason: 'active' };
  // A relay is the fallback that makes restrictive networks work. Until we hold a
  // relay candidate, keep waiting for any relay URL that has not answered yet.
  // Once we hold one, other relay transports (UDP/TCP/TLS to the same relay) add
  // no new reachability: all relay candidates are the relay's public address.
  if (state.relayUrls.length > 0 && state.attribution && !state.haveRelayCandidate) {
    const pending = state.relayUrls.filter((u) => !state.settledRelayUrls.has(u));
    if (pending.length > 0) return { done: false, reason: 'relay-pending' };
  }
  return { done: true, reason: 'quiet' };
}

export function relayUrlsOf(iceConfig) {
  const out = [];
  for (const s of iceConfig.iceServers || []) {
    for (const u of [].concat(s.urls)) if (/^turns?:/i.test(u)) out.push(u);
  }
  return out;
}
