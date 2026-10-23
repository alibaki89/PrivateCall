// Short Authentication String (security code) protocol.
//
// Goal: detect a "person in the middle" who swapped the DTLS certificates in the
// invitation and/or reply. This follows the commit-then-reveal idea of ZRTP
// (RFC 6189) adapted to WebRTC's DTLS-SRTP:
//
//   Invitation (offer):  sid, commit = H("commit", sid, nA), offer SDP (cert fpO)
//   Reply (answer):      sid, nB, answer SDP (cert fpA)
//   After DTLS is up:    offerer reveals nA over the encrypted data channel;
//                        answerer checks H(nA) == commit.
//   Both show:           code = H("sas", sid, fpO, fpA, nA, nB) as 6 digits.
//
// An attacker who substitutes certificates must commit to every value it sends
// before learning nA (nA is hidden in the commitment until the DTLS sessions,
// and therefore the certificates, are fixed). So it cannot search for
// certificates that make both sides display the same code: the two codes match
// by chance with probability about 1 in 1,000,000 per attempt, and each attempt
// is a visible call that the users must accept.
//
// The code proves "no one is in the middle of THIS call". It does not prove who
// the other person is; people do that by recognising each other.

import { sha256, lengthPrefixed, bytesEqual } from './util.js';
import { fingerprintString } from './sdp.js';

const COMMIT_LABEL = 'PrivateCall commit v1';
const SAS_LABEL = 'PrivateCall SAS v1';
export const SAS_DIGITS = 6;

export async function makeCommit(sid, nonceA) {
  return sha256(lengthPrefixed([COMMIT_LABEL, sid, nonceA]));
}

export async function checkCommit(sid, nonceA, commit) {
  return bytesEqual(await makeCommit(sid, nonceA), commit);
}

export async function deriveSas({ sid, offerFingerprint, answerFingerprint, nonceA, nonceB }) {
  const h = await sha256(
    lengthPrefixed([
      SAS_LABEL,
      sid,
      fingerprintString(offerFingerprint),
      fingerprintString(answerFingerprint),
      nonceA,
      nonceB,
    ]),
  );
  // 64 bits reduced mod 10^6: bias is below 2^-44, negligible.
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
  return (n % 10n ** BigInt(SAS_DIGITS)).toString().padStart(SAS_DIGITS, '0');
}
