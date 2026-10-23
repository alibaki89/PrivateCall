// UI controller: screens, inputs, and the bridge to CallSession.
// All text is set with textContent; no HTML strings are ever built from data.

import { t, setLocale, translateDom, localDigits } from './i18n.js';
import { decodeEnvelope, LIMITS } from './codec.js';
import { parseInvite, parseReply } from './protocol.js';
import { buildIceConfig, parseRelayCode } from './ice.js';
import { CallSession, inviteAlreadyUsed } from './session.js';
import { mediaSupport, createLevelMeter } from './media.js';

const $ = (id) => document.getElementById(id);

const settings = { useStun: true, relay: null, relayOnly: false };
const ui = {
  session: null,
  flow: null, // 'start' | 'join'
  invite: null, // parsed invitation (join flow)
  localMeter: null,
  callTimer: 0,
  toastTimer: 0,
  verifyHidden: false,
  fileTarget: null,
};

const ACTIVE_STATES = new Set(['preparing', 'awaiting-reply', 'reply-ready', 'connecting', 'connected']);

// ---------------------------------------------------------------- helpers
function show(el, on = true) {
  (typeof el === 'string' ? $(el) : el).hidden = !on;
}

function setText(id, text) {
  $(id).textContent = text;
}

function setIcon(useId, name) {
  $(useId).setAttribute('href', '#i-' + name);
}

function toast(text, ms = 4000) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== 'screen-' + name;
  const heading = document.querySelector('#screen-' + name + ' h1');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}

function currentScreen() {
  const s = document.querySelector('.screen:not([hidden])');
  return s ? s.id.replace('screen-', '') : null;
}

function errorText(code) {
  const key = 'err.' + code;
  const s = t(key);
  return s === key ? t('err.invalid') : s;
}

function fieldError(id, text) {
  const el = $(id);
  el.textContent = text || '';
  el.hidden = !text;
}

function formatAgo(seconds) {
  if (seconds < 90) return t('ago.justNow');
  if (seconds < 3600) return t('ago.minutes', { n: localDigits(Math.round(seconds / 60)) });
  if (seconds < 86400 * 2) return t('ago.hours', { n: localDigits(Math.round(seconds / 3600)) });
  return t('ago.days', { n: localDigits(Math.round(seconds / 86400)) });
}

function formatAge(seconds) {
  if (seconds < 86400 * 2) return t('age.hours', { n: localDigits(Math.max(1, Math.round(seconds / 3600))) });
  return t('age.days', { n: localDigits(Math.round(seconds / 86400)) });
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return localDigits(h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`);
}

async function copyText(text, textarea, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
    return true;
  } catch {
    /* fall back below */
  }
  textarea.focus();
  textarea.select();
  try {
    if (document.execCommand('copy')) {
      toast(okMessage);
      return true;
    }
  } catch {
    /* ignore */
  }
  toast(t('copy.manual'), 6000);
  return false;
}

function saveText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  toast(t('saved', { name: filename }), 6000);
}

async function readDroppedFile(file) {
  if (!file) return null;
  if (file.size > LIMITS.file) {
    toast(t('file.tooLarge'));
    return null;
  }
  try {
    return await file.text();
  } catch {
    toast(t('file.unreadable'));
    return null;
  }
}

// Paste box with Paste / Open file buttons and drag-and-drop.
function wireInput({ textarea, pasteBtn, fileBtn, dropzone, onText }) {
  let debounce = 0;
  const submit = (text) => {
    clearTimeout(debounce);
    onText(text);
  };
  textarea.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => onText(textarea.value), 250);
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      textarea.value = text;
      submit(text);
    } catch {
      textarea.focus();
      toast(t('paste.manual'));
    }
  });
  fileBtn.addEventListener('click', () => {
    ui.fileTarget = async (file) => {
      const text = await readDroppedFile(file);
      if (text !== null) {
        textarea.value = text;
        submit(text);
      }
    };
    $('file-input').value = '';
    $('file-input').click();
  });
  const over = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('is-over');
  };
  dropzone.addEventListener('dragenter', over);
  dropzone.addEventListener('dragover', over);
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('is-over');
    await handleDrop(e.dataTransfer, textarea, submit);
  });
}

async function handleDrop(dt, textarea, submit) {
  if (!dt) return;
  let text = null;
  if (dt.files && dt.files.length > 0) text = await readDroppedFile(dt.files[0]);
  else text = dt.getData('text/plain') || null;
  if (text !== null) {
    textarea.value = text;
    submit(text);
  }
}

// ---------------------------------------------------------------- session
function newSession(role) {
  const s = new CallSession({ role, iceConfig: buildIceConfig(settings), emit: onSessionEvent });
  ui.session = s;
  return s;
}

function sessionActive() {
  return ui.session && ACTIVE_STATES.has(ui.session.state);
}

function onSessionEvent(type, data, s) {
  if (s !== ui.session) return; // events from a finished session
  switch (type) {
    case 'local-media':
      renderLocalMedia();
      break;
    case 'remote-media':
      attachRemote();
      break;
    case 'connected':
      enterCall(true);
      break;
    case 'sas':
      renderVerify();
      break;
    case 'verified':
      renderSecurity();
      renderVerify();
      renderLocalMedia();
      toast(t('call.verifiedToast'));
      break;
    case 'remote-confirmed':
      renderVerify();
      break;
    case 'remote-state':
      renderRemote();
      renderVerify();
      break;
    case 'stats':
      renderStats(data);
      break;
    case 'cert-check':
      if ($('dlg-details').open) renderDetails();
      break;
    case 'unstable':
      banner(t('call.unstable'));
      break;
    case 'stable':
      banner(null);
      toast(t('call.stable'));
      break;
    case 'gathering-slow':
      setText(s.role === 'offerer' ? 'start-working-text' : 'join-working-text', t('start.preparingSlow'));
      break;
    case 'path-trouble':
      setText('join-waiting-text', t('join.pathTrouble'));
      break;
    case 'ended':
      onEnded(data);
      break;
    default:
  }
}

// ---------------------------------------------------------------- preview & local media
function mountPreview(sideId) {
  const side = $(sideId);
  side.appendChild($('preview'));
  show('preview');
  show(side);
  renderLocalMedia();
}

function renderLocalMedia() {
  const s = ui.session;
  if (!s || !s.localStream) return;
  const hasVideo = !!s.videoTrack;

  // Setup preview
  const pv = $('preview-video');
  if (hasVideo) {
    if (pv.srcObject !== s.localStream) pv.srcObject = s.localStream;
    pv.play().catch(() => {});
  } else {
    pv.srcObject = null;
  }
  show(pv, hasVideo);
  show('preview-off', !hasVideo);
  setText('preview-cam-label', s.cameraOn ? t('call.camOff') : t('call.camOn'));

  // In-call self view
  const sv = $('self-video');
  if (hasVideo) {
    if (sv.srcObject !== s.localStream) sv.srcObject = s.localStream;
    sv.play().catch(() => {});
  } else {
    sv.srcObject = null;
  }
  show(sv, hasVideo);
  show('self-off', !hasVideo);
  show('self-badge', hasVideo && s.state === 'connected' && !s.sendingVideo);
  show('self-muted', s.state === 'connected' ? !s.sendingAudio : !s.micOn);
  setPressed($('ctl-mic'), s.micOn, 'mic');
  setIcon('ctl-mic-icon', s.micOn ? 'mic' : 'mic-off');
  setPressed($('ctl-cam'), s.cameraOn, 'cam');
  setIcon('ctl-cam-icon', s.cameraOn ? 'cam' : 'cam-off');

  if (!ui.localMeter) {
    ui.localMeter = createLevelMeter(s.localStream, (level) => {
      const v = ui.session && ui.session.micOn ? level : 0;
      $('meter-fill').style.transform = `scaleX(${v.toFixed(3)})`;
    });
  }
  renderVerify();
}

function setPressed(btn, on, kind) {
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const label = kind === 'mic' ? t('call.micLabel') : t('call.camLabel');
  const action = kind === 'mic' ? (on ? t('call.mute') : t('call.unmute')) : on ? t('call.camOff') : t('call.camOn');
  btn.setAttribute('aria-label', label);
  btn.title = action + (btn.id.startsWith('ctl-') ? ` (${kind === 'mic' ? 'M' : 'V'})` : '');
}

function toggleMic() {
  const s = ui.session;
  if (!s || !s.localStream) return;
  s.setMic(!s.micOn);
}

async function toggleCamera() {
  const s = ui.session;
  if (!s || !s.localStream) return;
  const on = !s.cameraOn;
  let opts = {};
  if (on && s.state === 'connected' && !s.videoAllowed) {
    const answer = await askDialog('dlg-cam');
    if (answer === 'yes') opts = { allowUnverified: true };
    else if (answer !== 'no') return;
  }
  const r = await s.setCamera(on, opts);
  if (r && !r.ok && r.error) toast(t('media.cameraFailed') + ' ' + t('media.' + r.error));
}

function askDialog(id) {
  const dlg = $(id);
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true });
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- start flow
function openStart() {
  ui.flow = 'start';
  resetSetupUi();
  showScreen('start');
}

async function startCall(withVideo) {
  show('start-media-error', false);
  show('start-type', false);
  show('start-steps');
  show('start-foot');
  setStep('start', 1);
  show('start-working');
  show('start-error', false);
  setText('start-working-text', withVideo ? t('start.media') : t('start.mediaAudio'));

  const s = newSession('offerer');
  const m = await s.openMedia(withVideo);
  if (s !== ui.session) return;
  if (!m.ok) {
    s.end('cancelled', { silent: true });
    ui.session = null;
    show('start-steps', false);
    show('start-foot', false);
    show('start-type');
    fieldError('start-media-error', t('media.' + m.error));
    return;
  }
  mountPreview('start-side');
  if (m.notice) {
    setText('preview-notice', t('media.' + m.notice));
    show('preview-notice');
  }
  setText('start-working-text', t('start.preparing'));
  let text;
  try {
    text = await s.createInvitation(t('invite.intro'));
  } catch (e) {
    if (s === ui.session) {
      s.end('internal', { silent: true });
      show('start-working', false);
      fieldError('start-error', errorText(e.code || 'internal'));
    }
    return;
  }
  if (!text || s !== ui.session) return;
  show('start-working', false);
  $('invite-text').value = text;
  show('invite-out');
  show('reply-in-wrap');
  setStep('start', 2, { keepPrevActive: true });
  $('invite-copy').focus();
}

async function handleReplyText(text) {
  const s = ui.session;
  fieldError('reply-error', null);
  if (!s || s.role !== 'offerer' || s.state !== 'awaiting-reply') return;
  if (!text.trim()) return;
  const r = await decodeEnvelope(text);
  if (s !== ui.session) return;
  if (!r.ok) return fieldError('reply-error', errorText(r.error));
  if (r.kind === 'invite') return fieldError('reply-error', t('err.wrong-kind-invite'));
  const rep = parseReply(r.payload);
  if (!rep.ok) return fieldError('reply-error', t('err.invalid'));
  const res = await s.acceptReply(rep);
  if (s !== ui.session) return;
  if (!res.ok) return fieldError('reply-error', errorText(res.error));
  $('reply-text').readOnly = true;
  setStep('start', 3);
  enterCall(false);
}

// ---------------------------------------------------------------- join flow
function openJoin() {
  ui.flow = 'join';
  resetSetupUi();
  showScreen('join');
}

async function handleInviteText(text) {
  fieldError('invite-error', null);
  show('invite-summary', false);
  ui.invite = null;
  if (sessionActive()) return;
  if (!text.trim()) return;
  const r = await decodeEnvelope(text);
  if (!r.ok) return fieldError('invite-error', errorText(r.error));
  if (r.kind === 'reply') return fieldError('invite-error', t('err.wrong-kind-reply'));
  const inv = parseInvite(r.payload);
  if (!inv.ok) return fieldError('invite-error', t('err.invalid'));
  if (inviteAlreadyUsed(inv.sidText)) return fieldError('invite-error', t('err.replay'));
  ui.invite = inv;

  const age = Math.floor(Date.now() / 1000) - inv.ts;
  setText('invite-kind', inv.media === 'video' ? t('join.summaryVideo') : t('join.summaryAudio'));
  setText('invite-age', age > -600 ? t('join.madeAgo', { ago: formatAgo(Math.max(0, age)) }) : '');
  let warn = null;
  if (age > 3600) warn = t('join.oldWarning', { ago: formatAge(age) });
  else if (age < -600) warn = t('join.clockWarning');
  setText('invite-warn', warn || '');
  show('invite-warn', !!warn);
  show('join-cam', inv.media === 'video');
  setText('join-mic-label', inv.media === 'video' ? t('join.withMic') : t('join.withMicVoice'));
  $('join-mic').classList.toggle('btn-primary', inv.media !== 'video');
  show('invite-summary');
  (inv.media === 'video' ? $('join-cam') : $('join-mic')).focus();
}

async function joinCall(withVideo) {
  const inv = ui.invite;
  if (!inv || sessionActive()) return;
  $('invite-in').readOnly = true;
  $('join-cam').disabled = $('join-mic').disabled = true;
  show('join-actions', false);
  show('join-step2-body');
  show('join-foot');
  show('join-working');
  show('join-error', false);
  setStep('join', 2);
  setText('join-working-text', withVideo ? t('start.media') : t('start.mediaAudio'));

  const s = newSession('answerer');
  const m = await s.openMedia(withVideo);
  if (s !== ui.session) return;
  if (!m.ok) {
    s.end('cancelled', { silent: true });
    ui.session = null;
    show('join-working', false);
    fieldError('join-error', t('media.' + m.error));
    $('invite-in').readOnly = false;
    $('join-cam').disabled = $('join-mic').disabled = false;
    show('join-actions');
    setStep('join', 1);
    return;
  }
  mountPreview('join-side');
  if (m.notice) {
    setText('preview-notice', t('media.' + m.notice));
    show('preview-notice');
  }
  setText('join-working-text', t('join.preparing'));
  let r;
  try {
    r = await s.acceptInvitation(inv, t('reply.intro'));
  } catch (e) {
    r = { ok: false, error: e.code || 'internal' };
  }
  if (r.error === 'cancelled') return; // the person cancelled meanwhile
  if (!r.ok) {
    // The session may already have ended itself (silently) on this error.
    s.end('internal', { silent: true });
    show('join-working', false);
    fieldError('join-error', errorText(r.error));
    return;
  }
  if (s !== ui.session) return;
  show('join-working', false);
  $('reply-out-text').value = r.text;
  setText('join-waiting-text', t('join.waiting'));
  show('reply-out');
  $('reply-copy').focus();
}

// ---------------------------------------------------------------- steps
function setStep(flow, active, { keepPrevActive = false } = {}) {
  for (let i = 1; i <= 3; i++) {
    const li = $(`${flow}-step${i}`);
    li.classList.toggle('is-done', i < active && !(keepPrevActive && i === active - 1));
    li.classList.toggle('is-active', i === active || (keepPrevActive && i === active - 1));
    li.classList.toggle('is-pending', i > active);
    if (i === active) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

function markDone(flow, step) {
  const li = $(`${flow}-step${step}`);
  li.classList.remove('is-active');
  li.classList.add('is-done');
}

function resetSetupUi() {
  // Start
  show('start-type');
  show('start-media-error', false);
  show('start-steps', false);
  show('start-foot', false);
  show('start-side', false);
  show('invite-out', false);
  show('reply-in-wrap', false);
  show('start-error', false);
  $('invite-text').value = '';
  $('reply-text').value = '';
  $('reply-text').readOnly = false;
  fieldError('reply-error', null);
  // Join
  $('invite-in').value = '';
  $('invite-in').readOnly = false;
  $('join-cam').disabled = $('join-mic').disabled = false;
  show('join-actions');
  fieldError('invite-error', null);
  show('invite-summary', false);
  show('join-step2-body', false);
  show('join-foot', false);
  show('join-side', false);
  show('reply-out', false);
  show('join-error', false);
  $('reply-out-text').value = '';
  setStep('join', 1);
  ui.invite = null;
  // Preview
  show('preview', false);
  show('preview-notice', false);
  document.body.appendChild($('preview'));
}

// ---------------------------------------------------------------- call screen
function enterCall(connected) {
  const s = ui.session;
  if (!s) return;
  if (currentScreen() !== 'call') {
    ui.verifyHidden = false;
    showScreen('call');
    attachRemote();
  }
  show('call-connecting', !connected);
  if (connected) startTimer();
  renderSecurity();
  renderVerify();
  renderRemote();
  renderLocalMedia();
}

function attachRemote() {
  const s = ui.session;
  if (!s || !s.remoteAudioStream || currentScreen() !== 'call') return;
  const v = $('remote-video');
  const a = $('remote-audio');
  if (v.srcObject !== s.remoteVideoStream) v.srcObject = s.remoteVideoStream;
  if (a.srcObject !== s.remoteAudioStream) {
    a.srcObject = s.remoteAudioStream;
    a.play().then(
      () => show('btn-enable-sound', false),
      () => show('btn-enable-sound'),
    );
  }
  v.play().catch(() => {});
}

function renderRemote() {
  const s = ui.session;
  if (!s) return;
  const v = $('remote-video');
  const showVideo = s.state === 'connected' && s.remoteState.cam && v.videoWidth > 0;
  show(v, showVideo);
  show('remote-placeholder', s.state === 'connected' && !showVideo);
  const parts = [];
  parts.push(s.mediaMode === 'audio' && !s.remoteState.cam ? t('call.voiceCall') : t('call.remoteNoVideo'));
  if (!s.remoteState.mic) parts.push(t('call.remoteMuted'));
  setText('remote-placeholder-text', parts.join(' · '));
}

function renderSecurity() {
  const s = ui.session;
  if (!s) return;
  const chip = $('sec-chip');
  const verified = s.verify === 'confirmed';
  chip.classList.toggle('is-verified', verified);
  setText('sec-chip-text', verified ? t('call.statusVerified') : s.sas ? t('call.statusUnverified') : t('call.statusChecking'));
  chip.title = t('call.statusTip');
}

function renderVerify() {
  const s = ui.session;
  if (!s || currentScreen() !== 'call') return;
  const visible = s.state === 'connected' && s.verify !== 'confirmed' && !ui.verifyHidden;
  show('verify', visible);
  renderSecurity();
  if (!visible) return;
  const code = $('verify-code');
  // Rebuild the code only when it changes (it sits in a live region).
  const key = s.sas || '';
  if (code.dataset.key !== key) {
    code.dataset.key = key;
    code.replaceChildren();
    if (s.sas) {
      code.classList.remove('is-waiting');
      for (const part of [s.sas.slice(0, 3), s.sas.slice(3)]) {
        const span = document.createElement('span');
        span.className = 'digit-group';
        span.textContent = localDigits(part);
        code.appendChild(span);
      }
      code.setAttribute('aria-label', s.sas.split('').join(' '));
      // Each person reads one half, so both directions of speech are checked:
      // the starter reads the first three digits, the joiner the last three.
      const mine = s.role === 'offerer' ? s.sas.slice(0, 3) : s.sas.slice(3);
      const theirs = s.role === 'offerer' ? s.sas.slice(3) : s.sas.slice(0, 3);
      setDigitsText('verify-step-say', t('call.stepSay'), mine);
      setDigitsText('verify-step-hear', t('call.stepHear'), theirs);
    } else {
      code.classList.add('is-waiting');
      code.textContent = t('call.verifyWaiting');
      code.removeAttribute('aria-label');
    }
  }
  const ready = !!s.sas;
  show('verify-body', ready);
  show('verify-speak', ready && !s.allowUnverifiedAudio);
  show('verify-strong', ready);
  show('verify-private', ready && !s.allowUnverifiedAudio);
  show($('btn-talk-unverified').parentElement, ready && !s.allowUnverifiedAudio);
  for (const id of ['btn-match', 'btn-nomatch']) $(id).disabled = !ready;
  renderSpeak();
  setText('verify-remote-mic', s.remoteState.mic ? t('call.remoteMicOn') : t('call.remoteMicOff'));
  show('verify-remote', s.remoteConfirmed);
}

// "Say: 482" with the digits in bold, built without HTML strings.
function setDigitsText(id, label, digits) {
  const el = $(id);
  const strong = document.createElement('strong');
  strong.textContent = localDigits(digits);
  el.replaceChildren(document.createTextNode(label + ' '), strong);
}

function renderSpeak() {
  const s = ui.session;
  if (!s) return;
  const btn = $('btn-speak');
  btn.setAttribute('aria-pressed', s.speaking ? 'true' : 'false');
  if (s.speaking) {
    const left = Math.max(0, Math.ceil((s.speakUntil - Date.now()) / 1000));
    setText('btn-speak-label', t('call.speaking', { time: formatDuration(left * 1000) }));
  } else {
    setText('btn-speak-label', t('call.speak'));
    btn.title = '';
  }
}

function startTimer() {
  if (ui.callTimer) return;
  const tick = () => {
    const s = ui.session;
    if (s && s.connectedAt) setText('call-timer', formatDuration(Date.now() - s.connectedAt));
    if (s && s.speaking) renderSpeak();
  };
  tick();
  ui.callTimer = setInterval(tick, 1000);
}

function banner(text) {
  const el = $('call-banner');
  el.textContent = text || '';
  el.hidden = !text;
}

function renderStats(st) {
  setText('quality', t('call.quality.' + st.quality));
  renderRemote();
  if ($('dlg-details').open) renderDetails();
}

function renderDetails() {
  const s = ui.session;
  const list = $('details-list');
  list.replaceChildren();
  if (!s) return;
  const st = s.lastStats || {};
  const row = (label, value, mono = false) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (mono) dd.className = 'mono';
    list.append(dt, dd);
  };
  const path = st.path === 'relay' ? t('details.pathRelay') : st.path === 'direct' ? t('details.pathDirect') : t('details.pathUnknown');
  row(t('details.path'), path + (st.protocol ? ` (${st.protocol.toUpperCase()})` : ''));
  const enc = ['DTLS-SRTP', st.srtpCipher, st.tlsVersion === 'FEFC' ? 'DTLS 1.3' : st.tlsVersion === 'FEFD' ? 'DTLS 1.2' : null].filter(Boolean).join(' · ');
  row(t('details.encryption'), enc);
  row(t('details.certs'), t('details.certs.' + (s.certCheck === 'mismatch' ? 'pending' : s.certCheck)));
  row(t('details.rtt'), st.rtt != null ? localDigits(Math.round(st.rtt * 1000)) + ' ms' : '–');
  row(t('details.loss'), st.loss != null ? localDigits((st.loss * 100).toFixed(1)) + '%' : '–');
  row(t('details.audioBuffer'), st.audioBufferMs != null ? localDigits(Math.round(st.audioBufferMs)) + ' ms' : '–');
  if (st.audioCodec) row(t('details.audioCodec'), st.audioCodec);
  const vid = (v) => {
    if (!v) return t('details.none');
    let out = localDigits(`${v.w}×${v.h}`) + (v.fps ? ' · ' + localDigits(Math.round(v.fps)) + ' fps' : '');
    if (v.limit && v.limit !== 'none') {
      const reason = ['bandwidth', 'cpu'].includes(v.limit) ? t('details.reason.' + v.limit) : t('details.reason.other');
      out += ', ' + t('details.limited', { reason });
    }
    return out;
  };
  row(t('details.sending'), vid(st.outVideo));
  row(t('details.receiving'), vid(st.inVideo));
  if (s.localFp) row(t('details.yourFp'), s.localFp.alg + ' ' + s.localFp.value, true);
  if (s.remoteFp) row(t('details.theirFp'), s.remoteFp.alg + ' ' + s.remoteFp.value, true);
  setText('details-latency', t('details.latencyNote'));
}

function hangup() {
  if (ui.session) ui.session.end('local-hangup');
}

// ---------------------------------------------------------------- ended
const DANGER = new Set(['code-mismatch', 'security-failed']);
const WARN = new Set(['connect-failed', 'connection-lost']);

function onEnded({ reason, duration, diagnostics, detail }) {
  const flow = ui.flow;
  const silent = !!(detail && detail.silent);
  cleanupUi(!silent);
  ui.session = null;
  if (silent) return; // setup error is shown in place by the caller
  if (reason === 'cancelled' || reason === 'page-closed') {
    showScreen('welcome');
    return;
  }
  const card = $('ended-card');
  card.classList.toggle('is-danger', DANGER.has(reason));
  card.classList.toggle('is-warn', WARN.has(reason));
  const key = t('ended.title.' + reason) === 'ended.title.' + reason ? 'internal' : reason;
  setText('ended-title', t('ended.title.' + key));
  setText('ended-body', t('ended.body.' + key));
  setText('ended-duration', duration > 0 ? t('ended.duration', { time: formatDuration(duration) }) : '');
  show('ended-duration', duration > 0 && !DANGER.has(reason));
  show('ended-tips', reason === 'connect-failed');
  if (reason === 'connect-failed') setText('ended-diag', diagnosticsText(diagnostics));
  setText('ended-again', flow === 'join' ? t('ended.joinCall') : t('ended.newCall'));
  showScreen('ended');
}

function diagnosticsText(d) {
  if (!d) return '';
  const items = [];
  if (d.local.host > 0) items.push(t('ended.diag.local'));
  if (d.local.srflx > 0) items.push(t('ended.diag.public'));
  if (d.local.relay > 0) items.push(t('ended.diag.relay'));
  let text = t('ended.diag', { items: items.length ? items.join(', ') : t('ended.diag.nothing') });
  if (settings.useStun && d.local.srflx === 0 && d.candidateErrors.length > 0) text += ' ' + t('ended.diag.stunFailed');
  return text;
}

function cleanupUi(resetSetup = true) {
  clearInterval(ui.callTimer);
  ui.callTimer = 0;
  if (ui.localMeter) ui.localMeter.stop();
  ui.localMeter = null;
  for (const id of ['preview-video', 'self-video', 'remote-video', 'remote-audio']) {
    const el = $(id);
    el.pause();
    el.srcObject = null;
  }
  for (const id of ['dlg-details', 'dlg-cam', 'dlg-talk']) if ($(id).open) $(id).close();
  banner(null);
  show('btn-enable-sound', false);
  setText('call-timer', '');
  setText('quality', '');
  $('verify-code').dataset.key = '';
  $('meter-fill').style.transform = 'scaleX(0)';
  show('preview', false);
  show('start-side', false);
  show('join-side', false);
  // Remove invitation / reply text from the page once a call is over.
  if (resetSetup) resetSetupUi();
}

// ---------------------------------------------------------------- settings
function openSettings() {
  $('set-stun').checked = settings.useStun;
  $('set-relay').value = '';
  fieldError('relay-error', null);
  renderRelay();
  show('settings-next', sessionActive());
  $('dlg-settings').showModal();
}

function renderRelay() {
  const r = settings.relay;
  show('relay-entry', !r);
  show('relay-active', !!r);
  if (r) {
    setText('relay-active-text', t('settings.relayActive', {
      label: r.label ? ` (${r.label})` : '',
      until: new Date(r.expires * 1000).toLocaleString(),
    }));
  }
  $('set-relay-only').disabled = !r;
  $('set-relay-only').checked = !!r && settings.relayOnly;
}

// ---------------------------------------------------------------- startup
function init() {
  setLocale('en');
  translateDom(document);

  const sup = mediaSupport();
  if (!sup.rtc || !sup.gum || !sup.secure || !sup.crypto || !sup.compression || !sup.certificates) {
    show('unsupported');
    $('btn-start').disabled = $('btn-join').disabled = true;
  }

  $('btn-start').addEventListener('click', openStart);
  $('btn-join').addEventListener('click', openJoin);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-about').addEventListener('click', () => $('dlg-about').showModal());
  $('btn-start-video').addEventListener('click', () => startCall(true));
  $('btn-start-audio').addEventListener('click', () => startCall(false));
  for (const id of ['start-back', 'start-cancel', 'join-back', 'join-cancel']) {
    $(id).addEventListener('click', () => {
      if (ui.session) ui.session.end('cancelled');
      else {
        cleanupUi();
        showScreen('welcome');
      }
    });
  }

  $('invite-copy').addEventListener('click', async () => {
    if (await copyText($('invite-text').value, $('invite-text'), t('invite.copied'))) markDone('start', 1);
  });
  $('invite-save').addEventListener('click', () => {
    saveText($('invite-text').value, t('invite.filename'));
    markDone('start', 1);
  });
  $('reply-copy').addEventListener('click', () => copyText($('reply-out-text').value, $('reply-out-text'), t('reply.copied')));
  $('reply-save').addEventListener('click', () => saveText($('reply-out-text').value, t('reply.filename')));

  wireInput({ textarea: $('reply-text'), pasteBtn: $('reply-paste'), fileBtn: $('reply-file'), dropzone: $('reply-drop'), onText: handleReplyText });
  wireInput({ textarea: $('invite-in'), pasteBtn: $('invite-paste'), fileBtn: $('invite-file'), dropzone: $('invite-drop'), onText: handleInviteText });
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f && ui.fileTarget) ui.fileTarget(f);
  });
  $('join-cam').addEventListener('click', () => joinCall(true));
  $('join-mic').addEventListener('click', () => joinCall(false));

  // Dropping a file anywhere: route it to whichever box makes sense, and never
  // let the browser navigate away from the app to display the file.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const screen = currentScreen();
    if (screen === 'welcome' && !sessionActive()) {
      openJoin();
      await handleDrop(e.dataTransfer, $('invite-in'), handleInviteText);
    } else if (screen === 'join' && !sessionActive()) {
      await handleDrop(e.dataTransfer, $('invite-in'), handleInviteText);
    } else if (screen === 'start' && ui.session && ui.session.state === 'awaiting-reply') {
      await handleDrop(e.dataTransfer, $('reply-text'), handleReplyText);
    }
  });

  // Call controls
  $('preview-cam').addEventListener('click', toggleCamera);
  $('ctl-mic').addEventListener('click', toggleMic);
  $('ctl-cam').addEventListener('click', toggleCamera);
  $('ctl-hangup').addEventListener('click', hangup);
  $('ctl-details').addEventListener('click', () => {
    renderDetails();
    $('dlg-details').showModal();
  });
  $('sec-chip').addEventListener('click', () => {
    const s = ui.session;
    if (s && s.verify !== 'confirmed' && s.state === 'connected') {
      ui.verifyHidden = false;
      renderVerify();
      $('btn-match').focus();
    } else {
      renderDetails();
      $('dlg-details').showModal();
    }
  });
  $('btn-match').addEventListener('click', () => ui.session && ui.session.confirmCode());
  $('btn-speak').addEventListener('click', () => {
    const s = ui.session;
    if (s) s.speakForCode(!s.speaking);
  });
  $('btn-copy-code').addEventListener('click', async () => {
    const s = ui.session;
    if (!s || !s.sas) return;
    try {
      await navigator.clipboard.writeText(s.sas);
      toast(t('call.codeCopied'));
    } catch {
      toast(t('copy.manual'));
    }
  });
  $('btn-talk-unverified').addEventListener('click', async () => {
    const s = ui.session;
    if (!s) return;
    if ((await askDialog('dlg-talk')) === 'yes' && ui.session === s) {
      s.allowTalkUnverified();
      renderVerify();
      toast(t('call.talkingUnverified'), 6000);
    }
  });
  $('btn-nomatch').addEventListener('click', () => ui.session && ui.session.rejectCode());
  $('btn-later').addEventListener('click', () => {
    ui.verifyHidden = true;
    renderVerify();
    $('sec-chip').focus();
  });
  $('btn-enable-sound').addEventListener('click', () => {
    $('remote-audio').play().then(() => show('btn-enable-sound', false), () => {});
  });
  $('remote-video').addEventListener('resize', renderRemote);
  $('remote-video').addEventListener('loadeddata', renderRemote);

  document.addEventListener('keydown', (e) => {
    if (currentScreen() !== 'call' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (document.querySelector('dialog[open]')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (k === 'm') toggleMic();
    else if (k === 'v') toggleCamera();
  });

  $('ended-again').addEventListener('click', () => (ui.flow === 'join' ? openJoin() : openStart()));
  $('ended-home').addEventListener('click', () => showScreen('welcome'));

  // Settings
  $('set-stun').addEventListener('change', (e) => {
    settings.useStun = e.target.checked;
  });
  $('set-relay-add').addEventListener('click', () => {
    const r = parseRelayCode($('set-relay').value);
    if (!r.ok) return fieldError('relay-error', t('err.' + r.error));
    fieldError('relay-error', null);
    settings.relay = r.relay;
    $('set-relay').value = '';
    renderRelay();
  });
  $('set-relay-remove').addEventListener('click', () => {
    settings.relay = null;
    settings.relayOnly = false;
    renderRelay();
  });
  $('set-relay-only').addEventListener('change', (e) => {
    settings.relayOnly = e.target.checked && !!settings.relay;
  });

  // Leaving the page ends the call and releases the camera and microphone.
  window.addEventListener('beforeunload', (e) => {
    if (sessionActive()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => {
    if (ui.session) ui.session.end('page-closed');
  });

  showScreen('welcome');
}

init();
