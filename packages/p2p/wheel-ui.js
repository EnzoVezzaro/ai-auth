// Static styles, markup and focus helpers for the collaboration wheel.
import { MAX_MESSAGE_CHARS } from "./message-limits.js";

export const WHEEL_STYLE = `
:host{all:initial} *{box-sizing:border-box}
.root{position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483001;color:#172321;font:14px/1.4 system-ui,sans-serif}
button,input,select{font:inherit} button{cursor:pointer}
button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #1b7f5c;outline-offset:2px}
.toggle{width:56px;height:56px;border:0;border-radius:50%;background:#174f41;color:#fff;box-shadow:0 5px 20px #0004;font-size:24px}
.panel{position:absolute;right:0;bottom:68px;width:min(360px,calc(100vw - 24px - env(safe-area-inset-left) - env(safe-area-inset-right)));max-height:min(620px,calc(100vh - 96px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));max-height:min(620px,calc(100dvh - 96px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));display:flex;flex-direction:column;background:#fff;border:1px solid #ccd8d3;border-radius:16px;box-shadow:0 8px 32px #0003;overflow:hidden}
.panel[hidden],.preview[hidden],.picker[hidden],.cancel-record[hidden]{display:none}
.root.picking .panel{display:none}
h2{margin:0;padding:12px 16px;background:#174f41;color:#fff;font-size:15px;font-weight:650}
.body{display:flex;flex-direction:column;min-height:0;overflow:auto}
.who-row{padding:10px 12px;border-bottom:1px solid #e4eae7;display:grid;gap:6px}
.who-row label{font-weight:650;font-size:12px}
.who-row select{width:100%;min-width:0;padding:6px;border:1px solid #aabcb3;border-radius:7px;background:#fff}
.peers{list-style:none;margin:0;padding:0;font-size:12px;color:#33493f;max-height:84px;overflow:auto}
.peers li{overflow-wrap:anywhere}
.warn{margin:0;font-size:12px;color:#5b3a00;background:#fff4dc;border-radius:7px;padding:6px 8px}
.log{padding:10px 14px;overflow:auto;min-height:80px;max-height:220px;overflow-wrap:anywhere}
.entry{margin:0 0 10px;white-space:pre-wrap}.who{font-weight:650}.state{display:block;font-size:12px;color:#465d52}
.controls{padding:10px 12px;border-top:1px solid #e4eae7}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.actions button,.send,.preview button{min-height:36px;border:1px solid #9fb5ab;border-radius:7px;background:#f5faf7;color:#173b30;padding:6px 10px}
button[aria-disabled="true"],button:disabled,input:disabled{opacity:.55;cursor:not-allowed}
form{display:flex;gap:6px} input{min-width:0;flex:1;border:1px solid #aabcb3;border-radius:7px;padding:7px}
.hint,.status{margin:8px 0 0;min-height:1.2em;color:#465d52;font-size:12px}
.preview{padding:10px 12px;border-top:1px solid #e4eae7;display:grid;gap:6px;background:#f8fbf9}
.preview h3{margin:0;font-size:13px}.preview pre{margin:0;max-height:110px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.preview img,.preview video{max-width:100%;max-height:150px;border-radius:6px}
.preview .row{display:flex;gap:6px;flex-wrap:wrap}
.picker{position:absolute;right:0;bottom:68px;width:min(320px,calc(100vw - 24px));background:#fff;border:2px solid #1b7f5c;border-radius:12px;padding:10px;box-shadow:0 8px 32px #0003;display:flex;gap:8px;align-items:center}
.picker p{margin:0;flex:1;font-size:13px}
@media (prefers-reduced-motion:no-preference){.panel{transition:opacity .12s}}
`;

export const WHEEL_MARKUP = `
<section class="panel" hidden role="dialog" aria-modal="true" aria-labelledby="wheel-title">
  <h2 id="wheel-title">Collaboration</h2>
  <div class="body">
    <div class="who-row">
      <label for="wheel-recipient">Send to</label>
      <select id="wheel-recipient" class="recipient"><option value="everyone">Everyone in public room</option></select>
      <ul class="peers" aria-label="Peers in this room"></ul>
      <p class="warn" role="note"></p>
    </div>
    <div class="log" role="log" aria-live="polite" aria-label="Messages" tabindex="0"></div>
    <section class="preview" hidden aria-labelledby="wheel-preview-title">
      <h3 id="wheel-preview-title" tabindex="-1">Review before sending</h3>
      <div class="preview-body"></div>
      <p class="preview-warn warn" role="note"></p>
      <div class="row"><button type="button" data-action="confirm">Send</button><button type="button" data-action="discard">Discard</button></div>
    </section>
    <div class="controls">
      <div class="actions">
        <button type="button" data-action="element">Share element</button>
        <button type="button" data-action="screenshot">Screenshot</button>
        <button type="button" data-action="record">Record screen</button>
        <button type="button" data-action="cancel-record" class="cancel-record" hidden>Cancel recording</button>
      </div>
      <form><input aria-label="Message" aria-describedby="wheel-hint" maxlength="${MAX_MESSAGE_CHARS}" placeholder="Message collaborators" autocomplete="off"><button class="send" type="submit">Send</button></form>
      <p class="hint" id="wheel-hint"></p>
      <p class="status" role="status"></p>
    </div>
  </div>
</section>
<div class="picker" hidden role="group" aria-label="Element selection"><p>Click an element, or Tab to one and press Enter. Escape cancels.</p><button type="button" data-action="stop-picking">Cancel</button></div>
<button class="toggle" type="button" aria-label="Open collaboration" aria-expanded="false" aria-haspopup="dialog">✦</button>
`;

export function createShell(doc, target) {
  const host = doc.createElement("div");
  host.dataset.aiAuthCollaborationWheel = "true";
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = WHEEL_STYLE;
  const root = doc.createElement("div");
  root.className = "root";
  root.innerHTML = WHEEL_MARKUP;
  const outline = doc.createElement("div");
  outline.style.cssText =
    "position:fixed;display:none;pointer-events:none;z-index:2147483000;outline:3px solid #21a976;outline-offset:2px";
  shadow.append(style, root, outline);
  target.append(host);
  const $ = (selector) => shadow.querySelector(selector);
  const refs = {
    host,
    shadow,
    root,
    outline,
    panel: $(".panel"),
    toggle: $(".toggle"),
    log: $(".log"),
    status: $(".status"),
    hint: $(".hint"),
    form: $("form"),
    input: $("input"),
    send: $(".send"),
    recipient: $(".recipient"),
    peers: $(".peers"),
    warn: $(".who-row .warn"),
    preview: $(".preview"),
    previewBody: $(".preview-body"),
    previewWarn: $(".preview-warn"),
    previewTitle: $("#wheel-preview-title"),
    picker: $(".picker"),
    pickerText: $(".picker p"),
    action: (name) => $(`[data-action="${name}"]`),
  };
  return refs;
}

const FOCUSABLE =
  "button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],video[controls],[tabindex='0']";

export function focusableIn(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter(
    (node) => !node.closest("[hidden]"),
  );
}

/** Keep Tab / Shift+Tab inside `container`. `active` is the shadow's activeElement. */
export function trapTab(event, container, active) {
  if (event.key !== "Tab") return;
  const nodes = focusableIn(container);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (active === last || !container.contains(active))
  ) {
    event.preventDefault();
    first.focus();
  }
}
