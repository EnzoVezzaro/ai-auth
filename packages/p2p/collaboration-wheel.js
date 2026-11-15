/** Mount a page-local collaboration control for an established AI Auth connection. */
export function mountCollaborationWheel(
  connection,
  { target = globalThis.document?.body, capabilities = null } = {},
) {
  if (!connection || typeof connection.subscribe !== "function")
    throw new TypeError("A collaboration transfer session is required");
  if (!target?.ownerDocument)
    throw new TypeError("A target element is required");
  const doc = target.ownerDocument;
  const win = doc.defaultView;
  const host = doc.createElement("div");
  host.dataset.aiAuthCollaborationWheel = "true";
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = `
    :host{all:initial} *{box-sizing:border-box} .root{position:fixed;right:20px;bottom:20px;z-index:2147483001;color:#172321;font:14px/1.4 system-ui,sans-serif}
    button,input{font:inherit} button{cursor:pointer} button:focus-visible,input:focus-visible{outline:3px solid #5ed1a5;outline-offset:2px}
    .toggle{width:58px;height:58px;border:0;border-radius:50%;background:#174f41;color:white;box-shadow:0 5px 20px #0004;font-size:24px}
    .panel{position:absolute;right:0;bottom:70px;width:min(360px,calc(100vw - 40px));max-height:min(520px,calc(100vh - 110px));display:flex;flex-direction:column;background:white;border:1px solid #ccd8d3;border-radius:16px;box-shadow:0 8px 32px #0003;overflow:hidden}
    .panel[hidden]{display:none} header{padding:14px 16px;background:#174f41;color:white;font-weight:650} .log{padding:12px 16px;overflow:auto;min-height:100px;max-height:250px;overflow-wrap:anywhere} .entry{margin:0 0 10px;white-space:pre-wrap}.who{font-weight:650} .controls{padding:10px 12px;border-top:1px solid #e4eae7}.actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.actions button,.send{border:1px solid #b9cac2;border-radius:7px;background:#f5faf7;color:#173b30;padding:6px 9px}.actions button:disabled,.send:disabled{opacity:.5;cursor:not-allowed} form{display:flex;gap:6px} input{min-width:0;flex:1;border:1px solid #aabcb3;border-radius:7px;padding:7px} .status{min-height:1.4em;margin:8px 0 0;color:#465d52;font-size:12px} .selecting{cursor:crosshair!important;outline:3px solid #21a976!important;outline-offset:2px!important}
  `;
  const root = doc.createElement("div");
  root.className = "root";
  root.innerHTML = `<section class="panel" hidden aria-label="Collaboration"><header>Collaboration</header><div class="log" role="log" aria-live="polite"></div><div class="controls"><div class="actions"><button type="button" data-action="element">Share element</button><button type="button" data-action="screenshot">Screenshot</button><button type="button" data-action="record">Record screen</button></div><form><input aria-label="Message" maxlength="3000" placeholder="Message collaborators"><button class="send" type="submit">Send</button></form><p class="status" role="status"></p></div></section><button class="toggle" type="button" aria-label="Open collaboration" aria-expanded="false">✦</button>`;
  shadow.append(style, root);
  const outline = doc.createElement("div");
  outline.style.cssText =
    "position:fixed;display:none;pointer-events:none;z-index:2147483000;outline:3px solid #21a976;outline-offset:2px";
  shadow.append(outline);
  target.append(host);
  const panel = shadow.querySelector(".panel");
  const toggle = shadow.querySelector(".toggle");
  const log = shadow.querySelector(".log");
  const status = shadow.querySelector(".status");
  const form = shadow.querySelector("form");
  const input = shadow.querySelector("input");
  const elementButton = shadow.querySelector('[data-action="element"]');
  const screenshotButton = shadow.querySelector('[data-action="screenshot"]');
  const recordButton = shadow.querySelector('[data-action="record"]');
  const canMessage =
    typeof connection.sendText === "function" &&
    (!capabilities || capabilities.includes("messages.send"));
  const canShare = !capabilities || capabilities.includes("content.share");
  const canAttach = canShare && typeof connection.sendAttachment === "function";
  const canCapture =
    typeof win?.navigator?.mediaDevices?.getDisplayMedia === "function";
  input.disabled = !canMessage;
  shadow.querySelector(".send").disabled = !canMessage;
  elementButton.disabled =
    !canShare || typeof connection.sendElement !== "function";
  screenshotButton.disabled = !canAttach || !canCapture;
  recordButton.disabled = !canAttach || !canCapture || !win.MediaRecorder;
  let selecting = false;
  let recorder;
  let stream;
  let capturing = false;
  let disposed = false;
  const say = (text) => {
    status.textContent = text;
  };
  const add = (who, text) => {
    const entry = doc.createElement("p");
    entry.className = "entry";
    const label = doc.createElement("span");
    label.className = "who";
    label.textContent = `${who}: `;
    entry.append(label, doc.createTextNode(text));
    log.append(entry);
    while (log.childNodes.length > 100) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  };
  async function send(text) {
    await connection.sendText(text);
    if (!disposed) add("You", text);
  }
  const objectUrls = new Set();
  const unsub = connection.subscribe((event) => {
    const who = String(
      event.issuer ?? event.envelope?.body?.issuer ?? "Peer",
    ).slice(0, 60);
    if (event.type === "text" && typeof event.text === "string")
      add(who, event.text.slice(0, 4000));
    if (event.type === "element")
      add(
        who,
        `Shared element: ${event.metadata?.tag ?? "element"} ${event.metadata?.text ?? ""}`.slice(
          0,
          1500,
        ),
      );
    if (event.type === "attachment" && event.blob instanceof win.Blob) {
      const url = win.URL.createObjectURL(event.blob);
      objectUrls.add(url);
      const link = doc.createElement("a");
      link.href = url;
      link.download = String(event.name ?? "attachment").slice(0, 120);
      link.textContent = `${who} shared ${link.download}`;
      const entry = doc.createElement("p");
      entry.className = "entry";
      entry.append(link);
      log.append(entry);
    }
  });
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    toggle.setAttribute(
      "aria-label",
      panel.hidden ? "Open collaboration" : "Close collaboration",
    );
    if (!panel.hidden) input.focus();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    try {
      await send(text);
      input.value = "";
      say("Message sent.");
    } catch (error) {
      say(error.message || "Could not send message.");
    }
  });
  function clearSelection() {
    selecting = false;
    outline.style.display = "none";
    doc.removeEventListener("pointerover", highlight, true);
    doc.removeEventListener("click", choose, true);
    doc.removeEventListener("keydown", cancelSelection, true);
  }
  function highlight(event) {
    if (!selecting || event.composedPath().includes(host)) return;
    const rect = event.target.getBoundingClientRect();
    Object.assign(outline.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }
  function clearOutline() {
    outline.style.display = "none";
  }
  function cancelSelection(event) {
    if (event.key === "Escape") {
      clearOutline();
      clearSelection();
      say("Element selection cancelled.");
    }
  }
  async function choose(event) {
    if (!selecting || event.composedPath().includes(host)) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.target;
    clearOutline();
    clearSelection();
    const tag = element.tagName?.toLowerCase() || "element";
    const text = (
      element.innerText ||
      element.getAttribute?.("aria-label") ||
      ""
    )
      .trim()
      .slice(0, 1000);
    try {
      await connection.sendElement({
        tag,
        text,
        url: `${win.location.origin}${win.location.pathname}`,
      });
      add("You", `Shared element: ${tag} ${text}`);
      say("Element shared.");
    } catch (error) {
      say(error.message || "Could not share element.");
    }
  }
  elementButton.addEventListener("click", () => {
    selecting = true;
    say("Select an element on the page, or press Escape to cancel.");
    doc.addEventListener("pointerover", highlight, true);
    doc.addEventListener("click", choose, true);
    doc.addEventListener("keydown", cancelSelection, true);
  });
  async function capture() {
    return win.navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
  }
  function stopStream() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }
  screenshotButton.addEventListener("click", async () => {
    if (capturing) return;
    capturing = true;
    try {
      stream = await capture();
      if (disposed) return;
      const video = doc.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      const canvas = doc.createElement("canvas");
      const scale = Math.min(
        1,
        1280 / video.videoWidth,
        720 / video.videoHeight,
      );
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      if (!canvas.width || !canvas.height)
        throw new Error("Could not capture a screen frame.");
      canvas.getContext("2d").drawImage(video, 0, 0);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.65),
      );
      if (!blob) throw new Error("Could not create screenshot.");
      stopStream();
      if (blob.size > 512 * 1024)
        throw new Error("Screenshot exceeds the 512 KiB sharing limit.");
      await connection.sendAttachment(blob, {
        kind: "screenshot",
        name: "screenshot.jpg",
      });
      say(
        "Screenshot submitted to the peer transport; delivery is not confirmed.",
      );
    } catch (error) {
      say(error.message || "Screenshot cancelled.");
    } finally {
      stopStream();
      capturing = false;
    }
  });
  recordButton.addEventListener("click", async () => {
    if (recorder?.state === "recording") {
      recorder.stop();
      return;
    }
    if (capturing) return;
    capturing = true;
    try {
      stream = await capture();
      if (disposed) {
        stopStream();
        capturing = false;
        return;
      }
      const chunks = [];
      let bytes = 0;
      recorder = new win.MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          bytes += event.data.size;
        }
        if (bytes > 1024 * 1024 && recorder.state === "recording")
          recorder.stop();
      };
      recorder.onstop = async () => {
        stopStream();
        capturing = false;
        recordButton.textContent = "Record screen";
        if (disposed) return;
        const blob = new win.Blob(chunks, {
          type: recorder.mimeType || "video/webm",
        });
        try {
          if (blob.size > 1024 * 1024)
            throw new Error(
              "Recording exceeds the 1 MiB sharing limit. Try a shorter recording.",
            );
          await connection.sendAttachment(blob, {
            kind: "recording",
            name: "recording.webm",
          });
          say(
            "Recording submitted to the peer transport; delivery is not confirmed.",
          );
        } catch (error) {
          say(error.message || "Could not share recording.");
        }
      };
      stream.getVideoTracks()[0].addEventListener(
        "ended",
        () => {
          if (recorder?.state === "recording") recorder.stop();
        },
        { once: true },
      );
      recorder.start(250);
      recordButton.textContent = "Stop recording";
      say("Recording. Stop to send; recordings are limited to 1 MiB.");
    } catch (error) {
      stopStream();
      capturing = false;
      say(error.message || "Recording cancelled.");
    }
  });
  if (!canMessage) say("Messaging is unavailable in this connection.");
  return () => {
    disposed = true;
    clearOutline();
    clearSelection();
    if (recorder?.state === "recording") recorder.stop();
    stopStream();
    for (const url of objectUrls) win.URL.revokeObjectURL(url);
    unsub?.();
    host.remove();
  };
}
