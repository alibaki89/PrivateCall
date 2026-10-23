// Camera and microphone handling. Devices are only ever opened after an explicit
// click, and every track this module opens is stopped by stopStream().

export const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

// 720p is a ceiling, not a target: the browser's congestion control lowers
// resolution and frame rate automatically on weak connections.
export const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: 'user',
};

export function mediaSupport() {
  return {
    rtc: typeof RTCPeerConnection === 'function',
    gum: !!(typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    secure: typeof isSecureContext === 'undefined' ? true : isSecureContext,
    crypto: !!(globalThis.crypto && crypto.subtle),
    compression: deflateRawSupported(),
    certificates: typeof RTCPeerConnection === 'function' && typeof RTCPeerConnection.generateCertificate === 'function',
  };
}

// 'deflate-raw' arrived later than CompressionStream itself (Chrome 103, Firefox 113),
// so construct it rather than only checking that the class exists.
function deflateRawSupported() {
  try {
    new CompressionStream('deflate-raw');
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

export function classifyMediaError(err) {
  const name = err && err.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'not-found';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use';
    default:
      return 'unknown';
  }
}

// Opens the microphone (required) and optionally the camera.
// If only the camera fails, returns an audio-only stream and a notice code.
export async function openLocalMedia(wantVideo) {
  const md = navigator.mediaDevices;
  if (wantVideo) {
    try {
      const stream = await md.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS });
      return { ok: true, stream, notice: null };
    } catch (err) {
      const kind = classifyMediaError(err);
      if (kind === 'permission-denied') return { ok: false, error: 'permission-denied' };
      // Fall through: maybe only the camera is missing or busy.
      try {
        const stream = await md.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        return { ok: true, stream, notice: kind === 'in-use' ? 'camera-busy' : 'camera-missing' };
      } catch (err2) {
        return { ok: false, error: classifyMediaError(err2) };
      }
    }
  }
  try {
    const stream = await md.getUserMedia({ audio: AUDIO_CONSTRAINTS });
    return { ok: true, stream, notice: null };
  } catch (err) {
    return { ok: false, error: classifyMediaError(err) };
  }
}

export async function openCamera() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
    return { ok: true, track: s.getVideoTracks()[0] };
  } catch (err) {
    return { ok: false, error: classifyMediaError(err) };
  }
}

export function stopStream(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
}

// Restrict negotiated codecs to widely interoperable, well-tested ones. This uses
// the standard setCodecPreferences API (no SDP editing) and silently keeps the
// browser defaults if the API is missing or rejects the list.
export function applyCodecPreferences(transceiver, kind) {
  try {
    if (typeof transceiver.setCodecPreferences !== 'function' || !RTCRtpReceiver.getCapabilities) return false;
    const caps = RTCRtpReceiver.getCapabilities(kind);
    if (!caps || !caps.codecs) return false;
    let keep;
    if (kind === 'audio') {
      const opus = caps.codecs.filter((c) => /^audio\/opus$/i.test(c.mimeType));
      const red = caps.codecs.filter((c) => /^audio\/red$/i.test(c.mimeType));
      keep = [...opus, ...red];
      if (opus.length === 0) return false;
    } else {
      const fmtp = (c) => c.sdpFmtpLine || '';
      const vp8 = caps.codecs.filter((c) => /^video\/VP8$/i.test(c.mimeType));
      const vp9 = caps.codecs.filter((c) => /^video\/VP9$/i.test(c.mimeType) && /profile-id=0|^$/.test(fmtp(c)));
      const h264 = caps.codecs.filter(
        (c) => /^video\/H264$/i.test(c.mimeType) && /packetization-mode=1/.test(fmtp(c)) && /profile-level-id=42e01f/i.test(fmtp(c)),
      );
      const rtx = caps.codecs.filter((c) => /^video\/rtx$/i.test(c.mimeType));
      if (vp8.length === 0) return false;
      keep = [...vp8, ...vp9, ...h264, ...rtx];
    }
    transceiver.setCodecPreferences(keep);
    return true;
  } catch {
    return false;
  }
}

// Audio first: give the voice stream priority and cap video so a weak uplink is
// not saturated by video at the expense of speech.
export async function tuneSenders(audioSender, videoSender) {
  const apply = async (sender, fn) => {
    try {
      const p = sender.getParameters();
      if (!p.encodings || p.encodings.length === 0) return;
      fn(p.encodings[0]);
      await sender.setParameters(p);
    } catch {
      /* best effort: browser keeps its defaults */
    }
  };
  if (audioSender) {
    await apply(audioSender, (e) => {
      e.priority = 'high';
      e.networkPriority = 'high';
    });
  }
  if (videoSender) {
    await apply(videoSender, (e) => {
      e.maxBitrate = 1_500_000;
      e.priority = 'low';
    });
  }
}

// Microphone level meter for the preview ("is my mic working?"). Local only.
export function createLevelMeter(stream, onLevel) {
  const track = stream && stream.getAudioTracks()[0];
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!track || !AC) return { stop() {} };
  let ctx;
  try {
    ctx = new AC();
  } catch {
    return { stop() {} };
  }
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let raf = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    onLevel(Math.min(1, rms * 4));
    raf = requestAnimationFrame(tick);
  };
  ctx.resume().catch(() => {});
  raf = requestAnimationFrame(tick);
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
      ctx.close().catch(() => {});
    },
  };
}
