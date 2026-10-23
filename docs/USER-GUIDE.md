# PrivateCall — how to use it

PrivateCall lets two people have a private voice or video call, straight between
their two computers. There's nothing to install and no account to create.

**You need:** a laptop or desktop computer with a microphone (and a camera for
video), a recent version of **Google Chrome** or **Microsoft Edge** (Firefox should work but has not been tested yet), and some
way to send a short message to the other person (any chat app or email).

## Before your first call

1. Get the file **PrivateCall.html** from someone you trust.
2. Save it somewhere easy to find, such as your Desktop.
3. Double-click it. It opens in your web browser. (If it opens in another
   program, right-click it and choose *Open with → Chrome* or *Edge*.)

## Starting a call

1. Click **Start a call**, then **Video call** or **Voice call**.
2. Your browser asks to use your microphone (and camera). Click **Allow**.
3. An **invitation** appears, usually within a few seconds (on some networks it can take up to 30 seconds). Click **Copy**, then paste it
   into a message to the other person. You can also click **Save as file** and
   send the file.
4. Keep the PrivateCall window open and wait.
5. When the other person sends their **reply**, copy all of it and paste it into
   the box under **Add their reply**. You can also drag the reply file onto the
   window.
6. The call starts by itself.

## Joining a call

1. Open PrivateCall.html and click **Join a call**.
2. Paste the whole invitation message you received, or drag the invitation file
   onto the window.
3. Click **Join with camera**, **Join with microphone only**, or **Join the voice
   call**. Allow the microphone (and camera) when your browser asks.
4. A **reply** appears. Click **Copy** and send it back to the person who invited
   you. You can also click **Save as file** and send the file.
5. Wait. The call starts as soon as they add your reply.

Tip: do the whole exchange within about 10 minutes. Invitations work only once.

## The security code (please don't skip this)

When the call connects, a box called **Check the security code** appears on both
screens, showing a 6-digit code such as `998 872`. **Until you confirm it, the
other person can't see you, and can hear you only while you turn your microphone
on in that box.** If someone intercepted your messages, they get nothing.

The box tells each of you exactly what to do:

1. Click **Turn on microphone** and say the three digits shown in bold after
   "say:". The person who started the call says the first three digits; the person
   who joined says the last three.
2. Listen. The other person should say the three digits shown after "should say:".
3. If everything matches your screen, click **Codes match**.

The microphone switches off again by itself after 30 seconds.

**Stronger check:** click **Copy code** and send the code through a *different*
app you trust than the one you used for the invitation. For example, if the
invitation went by email, send the code by Signal. If what they send matches your
screen, click **Codes match**. Use this when the call really matters, because a
skilled attacker can imitate voices.

**If the codes are different,** click **Codes don't match**. The call ends.
Someone may have intercepted your messages. Start again, using a different app
for the invitation if you can.

After you confirm, the text at the top changes to *Encrypted · verified*, and your
microphone and camera are sent normally.

The code shows that **no one is in the middle**. It does not prove who the other
person is. Make sure you recognise them.

*(If you really need to talk before checking, click **Talk without checking**.
The app warns you first, because the call may not be private.)*

## During the call

* **Microphone** (or press **M**): mute and unmute.
* **Camera** (or press **V**): turn your camera on or off. Turning it off really
  switches the camera off.
* **Details**: connection details, including numbers that help explain a delay.
* **Leave**: end the call.

**If the call feels delayed,** open **Details**:

* A **round-trip time** above about 300 ms, or a **route** "through a relay",
  means the delay comes from the network path.
* **Audio buffering** above about 150 ms means the connection is unsteady.
* If both are low, check whether either of you is using a Bluetooth headset. These
  often add a noticeable delay. Wired headphones are best.

## If something goes wrong

| What you see | What to do |
|---|---|
| "wasn't allowed to use your microphone or camera" | Click the camera icon in the browser's address bar, choose **Allow**, and try again. |
| "Part of the message is missing" or "damaged" | The message was cut off or changed. Ask for it again, or ask them to send it as a file. |
| "This is a reply, not an invitation" (or the reverse) | You pasted it on the wrong computer. The invitation goes to the person joining; the reply goes back to the person who started. |
| "already used" or "for a different invitation" | Each invitation works once. Start over with a new invitation. |
| **Couldn't connect** | Try again quickly. If it still fails, one of you can try a different network (for example a phone hotspot). Someone you trust may be able to give you a *relay code* to add under **Connection settings**. |
| **Connection lost** | Start a new call. You'll need to exchange a new invitation. |

## Good to know

* PrivateCall stores nothing. When you close the window, everything is gone.
* On a direct connection, the other person's computer can see your internet
  address. If that matters, ask for a relay code and turn on **Always use the
  relay** under Connection settings.
* The app you use to send the invitation can see that you're setting up a call
  and when, but not what you say.
* No app can protect a call if a computer has spyware on it.
