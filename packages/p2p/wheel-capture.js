// Explicit, user-initiated screen capture for the wheel. Nothing here starts on
// its own: every capture is a `getDisplayMedia` call from a click, and every
// track is stopped when the capture ends, is cancelled, or the wheel closes.

export const MEDIA_LIMITS = Object.freeze({
  screenshotBytes: 512 * 1024,
  recordingBytes: 1024 * 1024,
});

export function createMediaCapture(win, doc) {
  let stream;
  let recorder;
  let generation = 0;
  let finishRecording;

  const stopTracks = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  };
  const open = async () => {
    const token = ++generation;
    const opened = await win.navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    if (token !== generation) {
      // Cancelled or closed while the browser picker was open.
      opened.getTracks().forEach((track) => track.stop());
      return null;
    }
    stream = opened;
    return opened;
  };

  async function screenshot() {
    const opened = await open();
    if (!opened) return null;
    try {
      const video = doc.createElement("video");
      video.srcObject = opened;
      video.muted = true;
      await video.play();
      const scale = Math.min(
        1,
        1280 / video.videoWidth,
        720 / video.videoHeight,
      );
      const canvas = doc.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      if (!canvas.width || !canvas.height)
        throw new Error("Could not capture a screen frame.");
      canvas
        .getContext("2d")
        .drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.65),
      );
      if (!blob) throw new Error("Could not create screenshot.");
      if (blob.size > MEDIA_LIMITS.screenshotBytes)
        throw new Error("Screenshot exceeds the 512 KiB sharing limit.");
      return blob;
    } finally {
      stopTracks();
    }
  }

  /** Start recording; resolves to a Blob when stopped, or null when cancelled. */
  async function record(onStart) {
    const opened = await open();
    if (!opened) return null;
    const chunks = [];
    let bytes = 0;
    let cancelled = false;
    try {
      recorder = new win.MediaRecorder(opened);
    } catch (error) {
      stopTracks();
      throw error;
    }
    const done = new Promise((resolve) => {
      recorder.onstop = () => {
        const type = recorder?.mimeType || "video/webm";
        stopTracks();
        recorder = undefined;
        finishRecording = undefined;
        resolve(cancelled ? null : new win.Blob(chunks, { type }));
      };
    });
    finishRecording = () => {
      cancelled = true;
    };
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      // Stop before appending a chunk that would cross the cap: pushing it
      // first makes auto-stop produce a blob that is always over the limit.
      if (bytes + event.data.size > MEDIA_LIMITS.recordingBytes) {
        stopRecording();
        return;
      }
      chunks.push(event.data);
      bytes += event.data.size;
    };
    opened
      .getVideoTracks()[0]
      ?.addEventListener("ended", () => stopRecording(), { once: true });
    recorder.start(250);
    onStart?.();
    return done;
  }

  function stopRecording() {
    if (recorder?.state === "recording") recorder.stop();
  }

  /** Abort anything in flight and release the screen. Safe to call repeatedly. */
  function cancel() {
    generation += 1;
    finishRecording?.();
    if (recorder?.state === "recording") recorder.stop();
    else stopTracks();
  }

  return {
    screenshot,
    record,
    stopRecording,
    cancel,
    isRecording: () => recorder?.state === "recording",
    isLive: () => Boolean(stream),
  };
}
