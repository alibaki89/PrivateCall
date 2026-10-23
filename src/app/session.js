// One call, from invitation to hang-up. Owns the RTCPeerConnection, the local
// media, all timers and all secret values, and releases every one of them in end().
//
// Session states:
//   idle -> preparing -> awaiting-reply (offerer) | reply-ready (answerer)
//        -> connecting -> connected -> ended
// Verification states (only meaningful once connected):
//   waiting (security values not exchanged yet) -> ready (code shown)
//        -> confirmed (user said the codes match)
//
// Outgoing media before confirmation: nothing. The microphone and camera tracks
// are not attached to their RTP senders (replaceTrack(null)), so no packets carry
// them. The user can open the microphone for a short window to read the code
// aloud (speakForCode), or explicitly choose to talk before checking.

import { randomBytes, base64urlEncode, bytesEqual, wipe } from './util.js';
import { encodeEnvelope, PROTOCOL_VERSION } from './codec.js';
import {
  inspectSdp, fingerprintString, normalizeStatsFingerprint, summarizeCandidates, splitCandidates, refreshFoundation,
} from './sdp.js';
import { parseControl, SIZES } from './protocol.js';
import { gatherDecision, relayUrlsOf } from './gather.js';
import { makeCommit, checkCommit, deriveSas } from './sas.js';
import {
  openLocalMedia, openCamera, stopStream, applyCodecPreferences, tuneSenders,
} from './media.js';

export const TIMEOUTS = {
  gatherSlowNotice: 4000, // tell the user gathering is taking a while
  speakWindow: 30000, // microphone window for reading the code aloud before confirming
  // Joining side, while waiting for the reply to be added: re-supply the other
  // side's addresses this often, so connectivity checks (and the router pinholes
  // they open) never lapse. Measured: without this, port-restricted home NATs
  // fail if the reply is added more than ~40 s after it was created.
  candidateRefresh: 15000,
  candidateRefreshMax: 15 * 60000,
  connect: 45000, // offerer: from adding the reply to a working connection
  reveal: 20000, // answerer: from channel open to receiving the security value
  disconnected: 30000, // how long a dropped connection may try to recover
  statsInterval: 2000,
};

// Invitation session IDs already used in this page (replay protection on the
// joining side; the starting side only ever accepts one reply for its own ID).
const usedInviteIds = new Set();

export function inviteAlreadyUsed(sidText) {
  return usedInviteIds.has(sidText);
}

export class CallSession {
  constructor({ role, iceConfig, emit }) {
    this.role = role; // 'offerer' | 'answerer'
    this.iceConfig = iceConfig;
    this._emit = emit || (() => {});
    this.state = 'idle';
    this.verify = 'waiting';
    this.mediaMode = 'video';
    this.pc = null;
    this.dc = null;
    this.localStream = null;
    this.audioTx = null;
    this.videoTx = null;
    this.remoteAudioStream = null;
    this.remoteVideoStream = null;
    this.micOn = true;
    this.cameraOn = false;
    this.allowUnverifiedVideo = false;
    this.allowUnverifiedAudio = false;
    this.speaking = false; // microphone opened only to read the code aloud
    this.speakUntil = 0;
    this._speakTimer = 0;
    this.remoteState = { mic: false, cam: false };
    this.remoteConfirmed = false;
    this.sid = null;
    this.nonceA = null;
    this.nonceB = null;
    this.commit = null;
    this.localFp = null;
    this.remoteFp = null;
    this.sas = null;
    this.certCheck = 'pending'; // pending | matched | unavailable | mismatch
    this.connectedAt = 0;
    this.localCandidates = [];
    this.remoteCandidates = [];
    this.candidateErrors = [];
    this.gatherResult = null; // { reason, ms }
    this._lastCandidateAt = 0;
    this._settledRelayUrls = new Set();
    this._urlAttribution = false;
    this.lastStats = null;
    this._prevLoss = null;
    this._timers = new Set();
    this._ended = false;
    this._wasDisconnected = false;
    this._disconnectTimer = 0;
  }

  emit(type, data) {
    try {
      this._emit(type, data, this);
    } catch (e) {
      console.error(e);
    }
  }

  // ---------- timers ----------
  _timeout(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }
  _clear(id) {
    if (!id) return;
    clearTimeout(id);
    clearInterval(id);
    this._timers.delete(id);
  }
  _interval(fn, ms) {
    const id = setInterval(fn, ms);
    this._timers.add(id);
    return id;
  }

  // ---------- media ----------
  async openMedia(wantVideo) {
    this.mediaMode = wantVideo ? 'video' : 'audio';
    const r = await openLocalMedia(wantVideo);
    if (this._ended) {
      if (r.ok) stopStream(r.stream);
      return { ok: false, error: 'cancelled' };
    }
    if (!r.ok) return r;
    this.localStream = r.stream;
    this.cameraOn = r.stream.getVideoTracks().length > 0;
    this.emit('local-media');
    return r;
  }

  get audioTrack() {
    return this.localStream ? this.localStream.getAudioTracks()[0] || null : null;
  }
  get videoTrack() {
    return this.localStream ? this.localStream.getVideoTracks()[0] || null : null;
  }

  // ---------- peer connection ----------
  async _createPeerConnection() {
    const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    this._cert = cert;
    const pc = new RTCPeerConnection({ ...this.iceConfig, certificates: [cert] });
    this.pc = pc;
    pc.onicecandidate = (e) => {
      // Chromium reports the server on the candidate (RTCIceCandidate.url);
      // the event-level url is the older, deprecated location.
      this._noteServer((e.candidate && e.candidate.url) || e.url);
      if (e.candidate && e.candidate.candidate) {
        this._lastCandidateAt = Date.now();
        const m = /typ (host|srflx|prflx|relay)/.exec(e.candidate.candidate);
        this.localCandidates.push({
          type: m ? m[1] : 'unknown',
          protocol: (e.candidate.protocol || '').toLowerCase(),
          address: e.candidate.address || '',
        });
      }
    };
    pc.onicecandidateerror = (e) => {
      this._noteServer(e.url);
      if (this.candidateErrors.length < 10) {
        this.candidateErrors.push({ url: e.url || '', code: e.errorCode || 0 });
      }
    };
    const onState = () => this._onConnectionState();
    pc.onconnectionstatechange = onState;
    pc.oniceconnectionstatechange = onState;

    const dc = pc.createDataChannel('control', { negotiated: true, id: 0, ordered: true });
    this.dc = dc;
    dc.onopen = () => this._onChannelOpen();
    dc.onmessage = (e) => this._onControl(e.data);
    dc.onclose = () => {
      if (!this._ended && this.state === 'connected') {
        // The other side closed its connection (hung up, closed the tab, reloaded).
        this._timeout(() => this.end('remote-hangup'), 300);
      }
    };
    return pc;
  }

  _attachRemoteStreams() {
    this.remoteAudioStream = new MediaStream([this.audioTx.receiver.track]);
    this.remoteVideoStream = new MediaStream([this.videoTx.receiver.track]);
    this.emit('remote-media');
  }

  // Which ICE server produced a candidate or an error (Chromium reports this).
  _noteServer(url) {
    if (typeof url !== 'string' || !url) return;
    this._urlAttribution = true;
    this._settledRelayUrls.add(url);
  }

  _waitForGathering() {
    const pc = this.pc;
    const relayUrls = relayUrlsOf(this.iceConfig);
    return new Promise((resolve) => {
      const started = Date.now();
      this._lastCandidateAt = started;
      let done = false;
      let poll = 0;
      let slow = 0;
      const check = () => {
        if (done) return;
        if (this._ended || pc.signalingState === 'closed') return finish('closed');
        const now = Date.now();
        const d = gatherDecision({
          elapsedMs: now - started,
          msSinceLastCandidate: now - this._lastCandidateAt,
          complete: pc.iceGatheringState === 'complete',
          relayUrls,
          settledRelayUrls: this._settledRelayUrls,
          attribution: this._urlAttribution,
          haveRelayCandidate: this.localCandidates.some((c) => c.type === 'relay'),
        });
        if (d.done) finish(d.reason);
      };
      const finish = (reason) => {
        done = true;
        this._clear(poll);
        this._clear(slow);
        pc.removeEventListener('icegatheringstatechange', check);
        this.gatherResult = { reason, ms: Date.now() - started };
        resolve();
      };
      pc.addEventListener('icegatheringstatechange', check);
      poll = this._interval(check, 250);
      slow = this._timeout(() => {
        if (!done) this.emit('gathering-slow');
      }, TIMEOUTS.gatherSlowNotice);
      check();
    });
  }

  _checkLocalDescription(type) {
    const info = inspectSdp(this.pc.localDescription.sdp, type);
    if (!info.ok) throw Object.assign(new Error('local SDP rejected: ' + info.error), { code: 'internal' });
    // Without any network candidate the other side could never reach us; say so now
    // rather than after the person has sent the message.
    if (info.candidates.length === 0) {
      const relayOnly = this.iceConfig.iceTransportPolicy === 'relay';
      throw Object.assign(new Error('no candidates'), { code: relayOnly ? 'relay-unreachable' : 'no-network' });
    }
    // If the browser can tell us our certificate's fingerprint, it must be the one in our SDP.
    if (this._cert && typeof this._cert.getFingerprints === 'function') {
      const fps = this._cert.getFingerprints().map((f) => normalizeStatsFingerprint(f.algorithm, f.value));
      if (fps.length && !fps.includes(fingerprintString(info.fingerprint))) {
        throw Object.assign(new Error('certificate mismatch'), { code: 'internal' });
      }
    }
    this.localFp = info.fingerprint;
    return info;
  }

  // ---------- starting side ----------
  async createInvitation(introText) {
    if (this.state !== 'idle') throw new Error('bad state');
    this.state = 'preparing';
    const pc = await this._createPeerConnection();
    // Both senders start empty; tracks are attached only when allowed (see header).
    this.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
    applyCodecPreferences(this.audioTx, 'audio');
    applyCodecPreferences(this.videoTx, 'video');
    this._attachRemoteStreams();
    await pc.setLocalDescription();
    await this._waitForGathering();
    if (this._ended) return null;
    const info = this._checkLocalDescription('offer');

    this.sid = randomBytes(SIZES.SID_BYTES);
    this.nonceA = randomBytes(SIZES.NONCE_BYTES);
    this.commit = await makeCommit(this.sid, this.nonceA);
    const text = await encodeEnvelope(
      'invite',
      {
        v: PROTOCOL_VERSION,
        sid: base64urlEncode(this.sid),
        ts: Math.floor(Date.now() / 1000),
        media: this.mediaMode,
        commit: base64urlEncode(this.commit),
        sdp: pc.localDescription.sdp,
      },
      introText,
    );
    if (this._ended) return null;
    this.localSummary = summarizeCandidates(info.candidates);
    this.state = 'awaiting-reply';
    this.emit('state');
    return text;
  }

  // reply: output of protocol.parseReply()
  async acceptReply(reply) {
    if (this.role !== 'offerer' || this.state !== 'awaiting-reply') return { ok: false, error: 'reply-unexpected' };
    if (!bytesEqual(reply.sid, this.sid)) return { ok: false, error: 'reply-mismatch' };
    this.state = 'connecting';
    this.nonceB = reply.nb;
    this.remoteFp = reply.sdpInfo.fingerprint;
    this.remoteCandidates = reply.sdpInfo.candidates;
    this.emit('state');
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: reply.sdp });
    } catch (e) {
      this.end('connect-failed', { cause: 'remote-description' });
      return { ok: false, error: 'reply-invalid' };
    }
    this._connectTimer = this._timeout(() => {
      if (this.state !== 'connected') this.end('connect-failed', { cause: 'timeout' });
    }, TIMEOUTS.connect);
    return { ok: true };
  }

  // ---------- joining side ----------
  // invite: output of protocol.parseInvite()
  async acceptInvitation(invite, introText) {
    if (this.state !== 'idle') throw new Error('bad state');
    if (usedInviteIds.has(invite.sidText)) return { ok: false, error: 'replay' };
    usedInviteIds.add(invite.sidText);
    this.state = 'preparing';
    this.sid = invite.sid;
    this.commit = invite.commit;
    this.remoteFp = invite.sdpInfo.fingerprint;
    this.remoteCandidates = invite.sdpInfo.candidates;
    this.mediaMode = invite.media;

    const pc = await this._createPeerConnection();
    // The offer's candidates are supplied separately (standard trickle API) so that
    // they can be re-supplied while we wait; see _refreshRemoteCandidates().
    const split = splitCandidates(invite.sdp);
    this._remoteIce = split.candidates;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: split.sdp });
    } catch {
      // Passed our structural checks but the browser's WebRTC engine refused it.
      this.end('internal', { silent: true });
      return { ok: false, error: 'invalid' };
    }
    const txs = pc.getTransceivers();
    this.audioTx = txs.find((t) => t.receiver.track.kind === 'audio');
    this.videoTx = txs.find((t) => t.receiver.track.kind === 'video');
    if (!this.audioTx || !this.videoTx) {
      this.end('internal', { silent: true });
      return { ok: false, error: 'invalid' };
    }
    this.audioTx.direction = 'sendrecv';
    this.videoTx.direction = 'sendrecv';
    applyCodecPreferences(this.audioTx, 'audio');
    applyCodecPreferences(this.videoTx, 'video');
    this._attachRemoteStreams();
    await pc.setLocalDescription();
    await this._waitForGathering();
    if (this._ended) return { ok: false, error: 'cancelled' };
    const info = this._checkLocalDescription('answer');

    this.nonceB = randomBytes(SIZES.NONCE_BYTES);
    const text = await encodeEnvelope(
      'reply',
      {
        v: PROTOCOL_VERSION,
        sid: base64urlEncode(this.sid),
        ts: Math.floor(Date.now() / 1000),
        nb: base64urlEncode(this.nonceB),
        sdp: pc.localDescription.sdp,
      },
      introText,
    );
    if (this._ended) return { ok: false, error: 'cancelled' };
    this.localSummary = summarizeCandidates(info.candidates);
    this.state = 'reply-ready';
    this.emit('state');
    this._refreshRemoteCandidates(0);
    return { ok: true, text };
  }

  // Supply the other side's candidates; then, until connected, supply them again
  // every TIMEOUTS.candidateRefresh under fresh foundations. Each round restarts
  // connectivity checks toward the same addresses (nothing new is revealed).
  async _refreshRemoteCandidates(round) {
    if (this._ended || this.state === 'connected' || !this.pc) return;
    for (const c of this._remoteIce || []) {
      try {
        await this.pc.addIceCandidate({ candidate: round === 0 ? c.candidate : refreshFoundation(c.candidate, round), sdpMid: c.sdpMid });
      } catch {
        /* a candidate the browser cannot use (e.g. unresolvable name) */
      }
      if (this._ended || !this.pc) return;
    }
    if (round === 0) this._refreshStarted = Date.now();
    if (Date.now() - this._refreshStarted >= TIMEOUTS.candidateRefreshMax) {
      this.emit('path-trouble');
      return;
    }
    this._refreshTimer = this._timeout(() => this._refreshRemoteCandidates(round + 1), TIMEOUTS.candidateRefresh);
  }

  // ---------- connection lifecycle ----------
  _connState() {
    const pc = this.pc;
    if (!pc) return 'closed';
    if (pc.connectionState) return pc.connectionState;
    const ice = pc.iceConnectionState;
    return ice === 'completed' ? 'connected' : ice === 'checking' ? 'connecting' : ice;
  }

  _onConnectionState() {
    if (this._ended) return;
    const s = this._connState();
    if (s === 'connected') {
      if (!this.connectedAt) this._onConnected();
      else if (this._wasDisconnected) {
        this._wasDisconnected = false;
        this._clear(this._disconnectTimer);
        this.emit('stable');
      }
    } else if (s === 'disconnected') {
      if (this.connectedAt && !this._wasDisconnected) {
        this._wasDisconnected = true;
        this.emit('unstable');
        this._disconnectTimer = this._timeout(() => {
          if (this._connState() !== 'connected') this.end('connection-lost');
        }, TIMEOUTS.disconnected);
      }
    } else if (s === 'failed') {
      // Before the first connection, "failed" is not final in practice: checks
      // restart (the joining side re-supplies candidates) and browsers recover.
      // The offerer's connect timer and the refresh limit decide when to give up.
      if (this.connectedAt) this.end('connection-lost');
    }
  }

  _onConnected() {
    this.connectedAt = Date.now();
    this.state = 'connected';
    this._clear(this._connectTimer);
    this.emit('connected');
    this._checkCertificates();
    tuneSenders(this.audioTx.sender, this.videoTx.sender);
    this._statsTimer = this._interval(() => this._sampleStats(), TIMEOUTS.statsInterval);
    this._sampleStats();
  }

  // Defence in depth: compare the certificates the browser actually used in the
  // DTLS handshake (from getStats) with the fingerprints the code is computed over.
  // Browsers already enforce this match; if they ever didn't, we end the call.
  async _checkCertificates() {
    for (let attempt = 0; attempt < 4 && !this._ended; attempt++) {
      let report;
      try {
        report = await this.pc.getStats();
      } catch {
        break;
      }
      let transport = null;
      report.forEach((s) => {
        if (s.type === 'transport' && s.remoteCertificateId) transport = s;
      });
      if (transport) {
        const local = report.get(transport.localCertificateId);
        const remote = report.get(transport.remoteCertificateId);
        if (local && remote) {
          const okLocal = normalizeStatsFingerprint(local.fingerprintAlgorithm, local.fingerprint) === fingerprintString(this.localFp);
          const okRemote = normalizeStatsFingerprint(remote.fingerprintAlgorithm, remote.fingerprint) === fingerprintString(this.remoteFp);
          if (okLocal && okRemote) {
            this.certCheck = 'matched';
            this.emit('cert-check');
            return;
          }
          this.certCheck = 'mismatch';
          this.end('security-failed', { cause: 'certificate' });
          return;
        }
      }
      await new Promise((r) => this._timeout(r, 500));
    }
    if (!this._ended) {
      this.certCheck = 'unavailable';
      this.emit('cert-check');
    }
  }

  _send(obj) {
    if (this.dc && this.dc.readyState === 'open') {
      try {
        this.dc.send(JSON.stringify(obj));
      } catch {
        /* channel closing */
      }
    }
  }

  async _onChannelOpen() {
    if (this._ended) return;
    this._sendState();
    if (this.role === 'offerer') {
      // The DTLS handshake has completed, so the certificates are now fixed and
      // it is safe to reveal the value we committed to in the invitation.
      this._send({ t: 'reveal', na: base64urlEncode(this.nonceA) });
      await this._computeSas();
    } else {
      this._revealTimer = this._timeout(() => {
        if (!this.sas) this.end('security-failed', { cause: 'no-reveal' });
      }, TIMEOUTS.reveal);
    }
  }

  async _onControl(data) {
    if (this._ended) return;
    const m = parseControl(data);
    if (!m) return;
    switch (m.t) {
      case 'reveal':
        if (this.role !== 'answerer' || this.nonceA || this.sas) return;
        if (!(await checkCommit(this.sid, m.na, this.commit))) {
          this.end('security-failed', { cause: 'commit' });
          return;
        }
        this.nonceA = m.na;
        this._clear(this._revealTimer);
        await this._computeSas();
        break;
      case 'state':
        this.remoteState = { mic: m.mic, cam: m.cam };
        this.emit('remote-state');
        break;
      case 'confirmed':
        this.remoteConfirmed = true;
        this.emit('remote-confirmed');
        break;
      case 'bye':
        this.end('remote-hangup');
        break;
      default:
    }
  }

  async _computeSas() {
    const offerer = this.role === 'offerer';
    const code = await deriveSas({
      sid: this.sid,
      offerFingerprint: offerer ? this.localFp : this.remoteFp,
      answerFingerprint: offerer ? this.remoteFp : this.localFp,
      nonceA: this.nonceA,
      nonceB: this.nonceB,
    });
    if (this._ended) return;
    this.sas = code;
    this.verify = 'ready';
    this.emit('sas', code);
  }

  confirmCode() {
    if (this.verify !== 'ready' || this._ended) return;
    this.verify = 'confirmed';
    this._clear(this._speakTimer);
    this.speaking = false;
    this._send({ t: 'confirmed' });
    this._syncAudioSender();
    this._syncVideoSender();
    this.emit('verified');
  }

  rejectCode() {
    this.end('code-mismatch');
  }

  // ---------- local controls ----------
  get videoAllowed() {
    return this.verify === 'confirmed' || this.allowUnverifiedVideo;
  }

  get audioAllowed() {
    return this.verify === 'confirmed' || this.allowUnverifiedAudio || this.speaking;
  }

  get sendingAudio() {
    return !!(this.audioTx && this.audioTx.sender.track && this.micOn);
  }

  async _syncAudioSender() {
    if (!this.audioTx || this._ended) return;
    const want = this.audioAllowed ? this.audioTrack : null;
    if (this.audioTx.sender.track !== want) {
      try {
        await this.audioTx.sender.replaceTrack(want);
      } catch (e) {
        console.warn('replaceTrack failed', e);
      }
    }
    this._sendState();
    this.emit('local-media');
  }

  // Open the microphone for a short window, only to read the code aloud.
  speakForCode(on) {
    if (this._ended || this.state !== 'connected' || this.verify === 'confirmed') return;
    this._clear(this._speakTimer);
    this.speaking = !!on;
    this.speakUntil = on ? Date.now() + TIMEOUTS.speakWindow : 0;
    if (on) {
      if (!this.micOn) this.setMic(true);
      this._speakTimer = this._timeout(() => this.speakForCode(false), TIMEOUTS.speakWindow);
    }
    this._syncAudioSender();
  }

  // The user chose to talk before checking the code (after a warning).
  allowTalkUnverified() {
    if (this._ended) return;
    this.allowUnverifiedAudio = true;
    this._clear(this._speakTimer);
    this.speaking = false;
    this._syncAudioSender();
  }

  get sendingVideo() {
    return !!(this.videoTx && this.videoTx.sender.track);
  }

  async _syncVideoSender() {
    if (!this.videoTx || this._ended) return;
    const want = this.cameraOn && this.videoAllowed ? this.videoTrack : null;
    if (this.videoTx.sender.track !== want) {
      try {
        await this.videoTx.sender.replaceTrack(want);
      } catch (e) {
        console.warn('replaceTrack failed', e);
      }
    }
    this._sendState();
    this.emit('local-media');
  }

  _sendState() {
    this._send({ t: 'state', mic: this.sendingAudio, cam: this.sendingVideo });
  }

  setMic(on) {
    this.micOn = !!on;
    const t = this.audioTrack;
    if (t) t.enabled = this.micOn;
    this._sendState();
    this.emit('local-media');
  }

  async setCamera(on, { allowUnverified = false } = {}) {
    if (this._ended) return { ok: false };
    if (allowUnverified) this.allowUnverifiedVideo = true;
    if (on) {
      if (!this.videoTrack) {
        const r = await openCamera();
        if (this._ended) {
          if (r.ok) r.track.stop();
          return { ok: false };
        }
        if (!r.ok) return r;
        this.localStream.addTrack(r.track);
      }
      this.cameraOn = true;
    } else {
      this.cameraOn = false;
      const t = this.videoTrack;
      if (t) {
        // Stop the device (camera light goes off), not just disable the track.
        if (this.videoTx) {
          try {
            await this.videoTx.sender.replaceTrack(null);
          } catch {
            /* ignore */
          }
        }
        t.stop();
        this.localStream.removeTrack(t);
      }
    }
    await this._syncVideoSender();
    return { ok: true };
  }

  // ---------- statistics ----------
  async _sampleStats() {
    if (this._ended || !this.pc) return;
    let report;
    try {
      report = await this.pc.getStats();
    } catch {
      return;
    }
    if (this._ended) return;
    let transport = null;
    let pair = null;
    const s = { at: Date.now() };
    report.forEach((r) => {
      if (r.type === 'transport' && !transport) transport = r;
      if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded')) && !pair) pair = r;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') s.inAudio = r;
      if (r.type === 'inbound-rtp' && r.kind === 'video') s.inVideo = r;
      if (r.type === 'outbound-rtp' && r.kind === 'video') s.outVideo = r;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') s.outAudio = r;
    });
    if (transport && transport.selectedCandidatePairId) pair = report.get(transport.selectedCandidatePairId) || pair;
    const summary = {
      rtt: pair && typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null,
      outgoingBitrate: pair && pair.availableOutgoingBitrate ? pair.availableOutgoingBitrate : null,
      path: null,
      protocol: null,
      loss: null,
      srtpCipher: transport ? transport.srtpCipher || null : null,
      dtlsCipher: transport ? transport.dtlsCipher || null : null,
      tlsVersion: transport ? transport.tlsVersion || null : null,
      inVideo: null,
      outVideo: null,
      audioBytesReceived: s.inAudio ? s.inAudio.bytesReceived || 0 : 0,
      audioBytesSent: s.outAudio ? s.outAudio.bytesSent || 0 : 0,
      videoFramesDecoded: s.inVideo ? s.inVideo.framesDecoded || 0 : 0,
      videoFramesSent: s.outVideo ? s.outVideo.framesSent || s.outVideo.framesEncoded || 0 : 0,
    };
    if (pair) {
      const lc = report.get(pair.localCandidateId);
      const rc = report.get(pair.remoteCandidateId);
      if (lc && rc) {
        summary.path = lc.candidateType === 'relay' || rc.candidateType === 'relay' ? 'relay' : 'direct';
        summary.protocol = (lc.relayProtocol || lc.protocol || '').toLowerCase();
        summary.localType = lc.candidateType;
        summary.remoteType = rc.candidateType;
      }
    }
    if (s.inAudio) {
      // Receive-side audio buffering over the last interval (jitter buffer).
      const jbDelay = s.inAudio.jitterBufferDelay;
      const jbCount = s.inAudio.jitterBufferEmittedCount;
      if (typeof jbDelay === 'number' && typeof jbCount === 'number') {
        const prev = this._prevJb;
        if (prev && jbCount > prev.count) summary.audioBufferMs = (1000 * (jbDelay - prev.delay)) / (jbCount - prev.count);
        this._prevJb = { delay: jbDelay, count: jbCount };
      }
      const codec = s.inAudio.codecId ? report.get(s.inAudio.codecId) : null;
      if (codec && codec.mimeType) summary.audioCodec = codec.mimeType.replace(/^audio\//i, '');
      const lost = s.inAudio.packetsLost || 0;
      const recv = s.inAudio.packetsReceived || 0;
      if (this._prevLoss) {
        const dl = lost - this._prevLoss.lost;
        const dr = recv - this._prevLoss.recv;
        summary.loss = dl + dr > 0 ? Math.max(0, dl) / (Math.max(0, dl) + dr) : 0;
      }
      this._prevLoss = { lost, recv };
    }
    if (s.inVideo && s.inVideo.frameHeight) {
      summary.inVideo = { w: s.inVideo.frameWidth, h: s.inVideo.frameHeight, fps: s.inVideo.framesPerSecond || null };
    }
    if (s.outVideo && s.outVideo.frameHeight && this.sendingVideo) {
      summary.outVideo = {
        w: s.outVideo.frameWidth,
        h: s.outVideo.frameHeight,
        fps: s.outVideo.framesPerSecond || null,
        limit: s.outVideo.qualityLimitationReason || null,
      };
    }
    summary.quality = rateQuality(summary.rtt, summary.loss);
    this.lastStats = summary;
    this.emit('stats', summary);
  }

  diagnostics() {
    return {
      local: this.localSummary || summarizeCandidates([]),
      remote: summarizeCandidates(this.remoteCandidates),
      candidateErrors: this.candidateErrors.slice(),
      iceState: this.pc ? this.pc.iceConnectionState : 'closed',
      relayOnly: this.iceConfig.iceTransportPolicy === 'relay',
    };
  }

  // ---------- teardown ----------
  end(reason, detail = {}) {
    if (this._ended) return;
    this._ended = true;
    const duration = this.connectedAt ? Date.now() - this.connectedAt : 0;
    const diagnostics = this.diagnostics();
    const tellRemote = ['local-hangup', 'code-mismatch', 'page-closed', 'security-failed'];
    if (tellRemote.includes(reason)) this._send({ t: 'bye' });
    for (const id of this._timers) {
      clearTimeout(id);
      clearInterval(id);
    }
    this._timers.clear();
    if (this.dc) {
      this.dc.onopen = this.dc.onmessage = this.dc.onclose = null;
      try {
        this.dc.close();
      } catch {
        /* ignore */
      }
    }
    if (this.pc) {
      const pc = this.pc;
      pc.onicecandidate = pc.onicecandidateerror = pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    stopStream(this.localStream);
    stopStream(this.remoteAudioStream);
    stopStream(this.remoteVideoStream);
    wipe(this.nonceA);
    wipe(this.nonceB);
    wipe(this.sid);
    this.nonceA = this.nonceB = this.commit = null;
    this.sas = null;
    this._cert = null;
    this.dc = null;
    this.pc = null;
    this.state = 'ended';
    this.emit('ended', { reason, detail, duration, diagnostics });
  }
}

export function rateQuality(rtt, loss) {
  if (rtt == null && loss == null) return 'unknown';
  const r = rtt == null ? 0 : rtt;
  const l = loss == null ? 0 : loss;
  if (r < 0.3 && l < 0.02) return 'good';
  if (r < 0.6 && l < 0.08) return 'fair';
  return 'poor';
}

