// Interface text. Every user-visible string lives here so a translation (for
// example Persian, right-to-left) is a new entry in LOCALES, not a code change.
// Placeholders use {name}. Keep security wording precise when translating.

export const EN = {
  'app.name': 'PrivateCall',
  'app.noscript': 'PrivateCall needs JavaScript to run. Open this file in a current version of Chrome, Edge or Firefox.',

  'top.settings': 'Connection settings',
  'top.about': 'Privacy and safety',

  'welcome.title': 'Private voice and video calls',
  'welcome.lead': 'Calls go directly between two computers and are encrypted. No account is needed and nothing is stored.',
  'welcome.start': 'Start a call',
  'welcome.join': 'Join a call',
  'welcome.howTitle': 'How it works',
  'welcome.how1': 'One person clicks Start a call and sends the invitation to the other, using any app.',
  'welcome.how2': 'The other person clicks Join a call, pastes the invitation, and sends back the reply.',
  'welcome.how3': 'When the call connects, you check a short security code together.',
  'welcome.unsupported': 'This browser can’t make calls with PrivateCall. Open this file in a current version of Chrome, Edge or Firefox.',

  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.tryAgain': 'Try again',
  'common.close': 'Close',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.save': 'Save as file',
  'common.paste': 'Paste',
  'common.openFile': 'Open file',
  'common.or': 'or',

  'start.title': 'Start a call',
  'start.typeQuestion': 'What kind of call?',
  'start.video': 'Video call',
  'start.audio': 'Voice call',
  'start.step1': 'Send this invitation',
  'start.step1Hint': 'Copy it and send it to the other person in any app you trust. It can be used only once.',
  'start.preparing': 'Preparing your invitation…',
  'start.preparingSlow': 'Checking which network routes work. On some networks this takes up to 30 seconds.',
  'start.media': 'Waiting for camera and microphone permission…',
  'start.mediaAudio': 'Waiting for microphone permission…',
  'start.step2': 'Add their reply',
  'start.step2Hint': 'Paste their reply here, or drop the reply file onto this window.',
  'start.step3': 'Check the security code',
  'start.step3Hint': 'When the call connects, you check a 6-digit code together before talking.',
  'start.replyPlaceholder': 'Paste the reply here',
  'start.waitingReply': 'Keep this window open until they reply.',

  'join.title': 'Join a call',
  'join.step1': 'Add the invitation',
  'join.step1Hint': 'Paste the whole message you received, or drop the invitation file onto this window.',
  'join.invitePlaceholder': 'Paste the invitation here',
  'join.summaryVideo': 'Video call invitation',
  'join.summaryAudio': 'Voice call invitation',
  'join.madeAgo': 'Created {ago}.',
  'join.oldWarning': 'This invitation is {ago} old. If connecting fails, ask for a new one.',
  'join.clockWarning': 'This invitation seems to come from the future. One of your computer clocks may be wrong; this is usually harmless.',
  'join.withCamera': 'Join with camera',
  'join.withMic': 'Join with microphone only',
  'join.withMicVoice': 'Join the voice call',
  'join.step2': 'Send this reply back',
  'join.step2Hint': 'Copy it and send it back to the person who invited you.',
  'join.preparing': 'Preparing your reply…',
  'join.waiting': 'Waiting for them to add your reply. The call starts automatically.',
  'join.pathTrouble': 'Still not connected after 15 minutes. If they haven’t added your reply, start over with a new invitation.',
  'join.step3': 'Check the security code',

  'ago.justNow': 'just now',
  'ago.minutes': '{n} min ago',
  'ago.hours': '{n} h ago',
  'ago.days': '{n} days ago',
  'age.hours': '{n} hours',
  'age.days': '{n} days',

  'invite.intro': 'Join my private call: open PrivateCall, choose “Join a call”, and paste this whole message.',
  'reply.intro': 'Here’s my reply: paste this whole message into PrivateCall on the computer that started the call.',
  'invite.filename': 'PrivateCall-invitation.txt',
  'reply.filename': 'PrivateCall-reply.txt',
  'invite.copied': 'Invitation copied. Paste it into a message to the other person.',
  'reply.copied': 'Reply copied. Paste it into a message back to them.',
  'copy.manual': 'Couldn’t copy automatically. Select the text and press Ctrl+C.',
  'paste.manual': 'Click in the box and press Ctrl+V to paste.',
  'file.tooLarge': 'That file is too large to be an invitation or reply.',
  'file.unreadable': 'That file couldn’t be read. Try copying and pasting the text instead.',
  'saved': 'Check your downloads for {name}, then send it to the other person as an attachment.',

  'err.empty': 'Paste the message first.',
  'err.not-found': 'This doesn’t look like a PrivateCall message. Make sure you copied the whole message.',
  'err.incomplete': 'Part of the message is missing. Copy everything from “PrivateCall.” to “:end”, or ask for it as a file.',
  'err.corrupt': 'This message was damaged or changed on the way. Ask for a new one, ideally sent as a file.',
  'err.multiple': 'There’s more than one PrivateCall message here. Paste just one.',
  'err.too-large': 'This is too large to be a PrivateCall message.',
  'err.version-newer': 'This was made with a newer version of PrivateCall. You both need the same version.',
  'err.version-older': 'This was made with an older version of PrivateCall. You both need the same version.',
  'err.browser-unsupported': 'This browser can’t read PrivateCall messages. Use a current Chrome, Edge or Firefox.',
  'err.is-relay-code': 'That’s a relay code, not an invitation. Add it in Connection settings instead.',
  'err.invalid': 'This message isn’t valid. It may have been changed on the way, or made by a different program.',
  'err.wrong-kind-reply': 'This is a reply, not an invitation. Paste it on the computer that started the call.',
  'err.wrong-kind-invite': 'This is an invitation, not a reply. You need the reply the other person sends back.',
  'err.replay': 'This invitation was already used. Ask for a new one.',
  'err.reply-mismatch': 'This reply is for a different invitation. Make sure they answered the invitation you just sent.',
  'err.reply-unexpected': 'A reply was already added for this call.',
  'err.reply-invalid': 'Your browser rejected this reply. Start a new call.',
  'err.internal': 'Something went wrong while preparing the call. Start again.',
  'err.no-network': 'Your computer didn’t find any network connection to offer. Check that you’re online, then try again.',
  'err.relay-unreachable': 'The relay server couldn’t be reached. Check the relay code, or turn off “Always use the relay” in Connection settings.',

  'media.permission-denied': 'PrivateCall wasn’t allowed to use your microphone or camera. Allow access using the icon in the address bar, then try again.',
  'media.not-found': 'No microphone was found. Connect one and try again.',
  'media.in-use': 'Your microphone or camera is being used by another app. Close that app and try again.',
  'media.unknown': 'Your microphone or camera couldn’t be started. Check your devices and try again.',
  'media.camera-missing': 'No camera was found, so this will be a voice call.',
  'media.camera-busy': 'Your camera is being used by another app, so this will be a voice call. You can turn it on later.',
  'media.cameraFailed': 'Your camera couldn’t be started.',

  'preview.micCheck': 'Microphone level',
  'preview.cameraOff': 'Camera off',

  'call.connecting': 'Connecting…',
  'call.statusChecking': 'Encrypted · checking the code',
  'call.statusUnverified': 'Encrypted · not verified',
  'call.statusVerified': 'Encrypted · verified',
  'call.statusTip': 'Encrypted means outsiders can’t listen. Verified means you confirmed the same code as the other person, so no one is in the middle.',
  'call.verifyTitle': 'Check the security code',
  'call.speak': 'Turn on microphone',
  'call.speaking': 'Microphone on ({time}) – click to turn off',
  'call.remoteMicOn': 'Their microphone is on.',
  'call.remoteMicOff': 'Their microphone is not on yet.',
  'call.privateUntilConfirm': 'Until you click “Codes match”, the other person can’t see you, and can hear you only while your microphone is turned on here.',
  'call.copyCode': 'Copy code',
  'call.codeCopied': 'Code copied. Send it through a different app than the invitation.',
  'call.talkUnverified': 'Talk without checking',
  'call.talkConfirmTitle': 'Talk before checking the code?',
  'call.talkConfirmBody': 'Until you compare the security code, you can’t be sure no one is listening in the middle. Everything you say could be heard by them.',
  'call.talkConfirmYes': 'Talk now',
  'call.talkingUnverified': 'You chose to talk before checking. The call may not be private.',
  'call.verifyWaiting': 'Getting the security code…',
  'call.match': 'Codes match',
  'call.noMatch': 'Codes don’t match',
  'call.later': 'Check later',
  'call.remoteConfirmed': 'The other person has confirmed the code.',
  'call.verifiedToast': 'Verified. You confirmed the codes match.',
  'call.verifyAgain': 'Check code',
  'call.unstable': 'Connection unstable. Trying to recover…',
  'call.stable': 'Connection recovered.',
  'call.remoteMuted': 'Their microphone is off',
  'call.remoteNoVideo': 'Their camera is off',
  'call.voiceCall': 'Voice call',
  'call.other': 'Other person',
  'call.youNotShared': 'Not sent yet',
  'call.controls': 'Call controls',
  'call.micLabel': 'Microphone',
  'call.camLabel': 'Camera',
  'call.mute': 'Turn off microphone',
  'call.unmute': 'Turn on microphone',
  'call.camOff': 'Turn camera off',
  'call.camOn': 'Turn camera on',
  'call.hangup': 'Leave',
  'call.details': 'Details',
  'call.enableSound': 'Click to turn on sound',
  'call.quality.good': 'Connection: good',
  'call.quality.fair': 'Connection: fair',
  'call.quality.poor': 'Connection: poor',
  'call.quality.unknown': '',
  'call.camConfirmTitle': 'Share your camera before checking the code?',
  'call.camConfirmBody': 'Until you compare the security code, you can’t be sure the call isn’t intercepted. Your video would be visible to anyone in the middle.',
  'call.camConfirmYes': 'Share camera now',
  'call.camConfirmNo': 'Wait',

  'details.title': 'Connection details',
  'details.path': 'Route',
  'details.pathDirect': 'Direct between your computers',
  'details.pathRelay': 'Through a relay server',
  'details.pathUnknown': 'Not known yet',
  'details.pathNote': 'On a direct route, each of you can see the other’s internet address. A relay hides it but sees that you’re talking.',
  'details.encryption': 'Encryption',
  'details.certs': 'Certificate check',
  'details.certs.matched': 'Matches the security code',
  'details.certs.unavailable': 'Not reported by this browser',
  'details.certs.pending': 'Checking…',
  'details.rtt': 'Round-trip time',
  'details.loss': 'Audio packet loss',
  'details.sending': 'Video you send',
  'details.receiving': 'Video you receive',
  'details.none': 'None',
  'details.limited': 'reduced by {reason}',
  'details.reason.bandwidth': 'connection speed',
  'details.reason.cpu': 'computer load',
  'details.reason.other': 'browser',
  'details.yourFp': 'Your certificate',
  'details.theirFp': 'Their certificate',

  'ended.title.local-hangup': 'Call ended',
  'ended.body.local-hangup': 'You left the call.',
  'ended.title.remote-hangup': 'Call ended',
  'ended.body.remote-hangup': 'The other person left the call.',
  'ended.title.connection-lost': 'Connection lost',
  'ended.body.connection-lost': 'The connection dropped and didn’t recover. To talk again, start a new call and exchange a new invitation.',
  'ended.title.connect-failed': 'Couldn’t connect',
  'ended.body.connect-failed': 'Your computers couldn’t find a way to reach each other. This happens on some office, school, mobile and restricted networks.',
  'ended.title.code-mismatch': 'Call ended for your safety',
  'ended.body.code-mismatch': 'The security codes didn’t match, so someone may have intercepted the invitation or reply. Don’t continue on this connection. Start a new call, send the invitation through a different app if you can, and compare the code again.',
  'ended.title.security-failed': 'Security check failed',
  'ended.body.security-failed': 'The connection didn’t pass PrivateCall’s security check, so it was ended. Start a new call. If this keeps happening, someone may be interfering.',
  'ended.title.internal': 'Something went wrong',
  'ended.body.internal': 'The call couldn’t be set up. Start again.',
  'ended.title.cancelled': 'Call cancelled',
  'ended.body.cancelled': 'Nothing was sent.',
  'ended.duration': 'Call length {time}.',
  'ended.newCall': 'Start a new call',
  'ended.joinCall': 'Join a call',
  'ended.home': 'Back to start',
  'ended.tipsTitle': 'Things to try',
  'ended.tip1': 'Exchange a new invitation and reply quickly, within a few minutes.',
  'ended.tip2': 'Try a different network for one of you, such as a phone hotspot or home Wi‑Fi.',
  'ended.tip3': 'If it keeps failing, one of you can add a relay code in Connection settings.',
  'ended.diag': 'What your computer found: {items}.',
  'ended.diag.local': 'local network address',
  'ended.diag.public': 'public address',
  'ended.diag.relay': 'relay',
  'ended.diag.nothing': 'no usable network address',
  'ended.diag.stunFailed': 'The public helper servers couldn’t be reached from your network.',

  'settings.title': 'Connection settings',
  'settings.intro': 'Most people never need to change these. Settings last only while this window is open.',
  'settings.stun': 'Use public helper servers to find a route',
  'settings.stunHint': 'Recommended. Google and Cloudflare servers tell your computer its public address. They can’t hear the call, but they learn that your address is starting one.',
  'settings.relayTitle': 'Relay server (optional)',
  'settings.relayHint': 'If calls can’t connect, a relay can pass the encrypted call along. Only one of you needs it. Paste a relay code from someone you trust who runs one.',
  'settings.relayPlaceholder': 'PCRELAY1:…',
  'settings.relayAdd': 'Use this relay',
  'settings.relayRemove': 'Remove relay',
  'settings.relayActive': 'Relay added{label}. Valid until {until}.',
  'settings.relayOnly': 'Always use the relay (hides your internet address from the other person)',
  'settings.relayOnlyHint': 'Calls may be slower. The relay operator can see your address and when you talk, but not what you say.',
  'settings.appliesNext': 'Changes apply to your next call.',
  'settings.done': 'Done',
  'err.relay-invalid': 'That relay code isn’t valid. Check you copied all of it.',
  'err.relay-expired': 'That relay code has expired. Ask for a new one.',

  'about.title': 'Privacy and safety',
  'about.p1': 'Calls are encrypted with the same standard technology browsers use for all video calls (DTLS-SRTP). The audio and video travel directly between the two computers whenever possible. Nothing is uploaded, recorded or stored by PrivateCall.',
  'about.h2': 'Why compare the code?',
  'about.p2': 'Encryption stops outsiders from listening, but someone who intercepted your invitation could try to sit in the middle of the call. The 6-digit code reveals this: if anyone is in the middle, your codes will be different. Until you confirm the code, nothing from your microphone or camera is sent, except while you turn the microphone on to read the code. Reading the code aloud is convenient, but a skilled attacker can imitate voices; comparing it by text in a different app you trust is stronger. The code doesn’t prove who the other person is.',
  'about.h3': 'What others can see',
  'about.li1': 'The other person can see your internet address on a direct connection.',
  'about.li2': 'The app you use to send the invitation can see that you’re setting up a call, when, and your network addresses.',
  'about.li3': 'Helper servers (Google, Cloudflare) and any relay learn that your address is making a call, but not what is said.',
  'about.li4': 'Your internet provider can see that you’re making an encrypted call, but not its content.',
  'about.h4': 'Limits',
  'about.p4': 'PrivateCall can’t protect a call if either computer is infected with spyware, or if the other person records it. Get this file only from someone you trust, and compare its checksum if they gave you one.',
  'call.stepSay': 'Turn on your microphone and say:',
  'call.stepHear': 'Listen. The other person should say:',
  'call.stepConfirm': 'If everything matches your screen, click “Codes match”.',
  'call.strongShort': 'For a stronger check, compare the code in a different app you trust.',
  'call.micNotSent': 'Microphone not sent',
  'preview.noCamera': 'No camera',
  'details.audioBuffer': 'Audio buffering',
  'details.audioCodec': 'Audio',
  'details.latencyNote': 'If the call feels delayed: a high round-trip time or a relay route points to the network; high audio buffering points to an unsteady connection; if both are low, check for Bluetooth headsets or other audio devices.',
};

export const LOCALES = {
  en: { name: 'English', dir: 'ltr', strings: EN },
};

let current = 'en';

export function setLocale(code) {
  if (LOCALES[code]) current = code;
  const doc = globalThis.document;
  if (doc) {
    doc.documentElement.lang = code;
    doc.documentElement.dir = LOCALES[current].dir;
  }
}

export function getLocale() {
  return current;
}

export function t(key, vars) {
  const table = LOCALES[current].strings;
  let s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : EN[key];
  if (s === undefined) s = key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}

// Digits in the user's numbering system (e.g. Persian digits for "fa").
export function localDigits(str) {
  let fmt;
  try {
    fmt = new Intl.NumberFormat(current, { useGrouping: false });
  } catch {
    return str;
  }
  return String(str).replace(/\d/g, (d) => fmt.format(Number(d)));
}

// Apply translations to static markup: data-i18n (text), data-i18n-aria (aria-label),
// data-i18n-title (title), data-i18n-placeholder (placeholder).
export function translateDom(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.setAttribute('title', t(el.dataset.i18nTitle));
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
}
