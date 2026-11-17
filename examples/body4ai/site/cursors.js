// Presence list and cursor overlay built on the SDK presence tracker
// (docs/PROTOCOL.md §6, §8). The tracker only receives events the room has
// already verified (signature, room, origin, replay, membership), so every
// entry is keyed by a verified wallet id and session. Labels are claims.
import { createPresenceTracker } from "../../../packages/p2p/browser.js";
import { MAX_COORDINATE } from "../../../packages/p2p/presence.js";

const SWEEP_MS = 2_000;

const documentSize = () => {
  const docEl = document.documentElement;
  return {
    width: docEl?.scrollWidth ?? docEl?.clientWidth ?? 1,
    height: docEl?.scrollHeight ?? docEl?.clientHeight ?? 1,
  };
};
const toPixels = (value, size) =>
  Math.round((value / MAX_COORDINATE) * Math.max(1, size));

function presenceItem(peer) {
  const node = document.createElement("li");
  node.dataset.cursor = "";
  node.dataset.issuer = peer.walletId;
  node.dataset.session = peer.session;
  node.dataset.state = peer.state;
  if (peer.cursor) {
    const { width, height } = documentSize();
    node.dataset.x = String(toPixels(peer.cursor.x, width));
    node.dataset.y = String(toPixels(peer.cursor.y, height));
    node.dataset.page = peer.cursor.pageKey;
  }
  const fingerprint = document.createElement("code");
  fingerprint.className = "fp";
  fingerprint.textContent = peer.walletId.slice(6, 18);
  const claim = document.createElement("span");
  claim.className = "claim";
  claim.textContent = ` claims to be "${peer.label ?? "unnamed"}" (${peer.state})`;
  node.append(fingerprint, claim);
  return node;
}

function cursorMarker(peer) {
  const { width, height } = documentSize();
  const marker = document.createElement("div");
  marker.className = "remote-cursor";
  marker.dataset.issuer = peer.walletId;
  marker.style.left = `${toPixels(peer.cursor.x, width)}px`;
  marker.style.top = `${toPixels(peer.cursor.y, height)}px`;
  marker.textContent = `▲ ${peer.walletId.slice(6, 12)} · ${peer.label ?? ""}`;
  return marker;
}

/** Feeds verified room events into the tracker and renders its view. */
export function mountPresence({ list, overlay, room, pageKey }) {
  const tracker = createPresenceTracker();
  const render = (peers) => {
    list.replaceChildren(...peers.map(presenceItem));
    overlay.replaceChildren(
      ...peers
        .filter((p) => p.state === "online" && p.cursor?.pageKey === pageKey)
        .map(cursorMarker),
    );
  };
  const stopTracker = tracker.subscribe(render);
  const stopRoom = room.subscribe(({ direction, envelope }) => {
    if (direction !== "in" || !envelope) return;
    const { type, issuer, payload } = envelope.body;
    const peer = { walletId: issuer, session: payload.session };
    if (type === "peer/hello" || type === "peer/heartbeat")
      tracker.heartbeat({ ...peer, label: String(payload.label ?? "") });
    else if (type === "peer/goodbye") tracker.goodbye(peer);
    else if (type === "presence/cursor") tracker.cursor({ ...peer, payload });
  });
  const sweep = setInterval(
    () => tracker.sweep() || render(tracker.list()),
    SWEEP_MS,
  );
  return {
    tracker,
    stop() {
      stopRoom();
      stopTracker();
      clearInterval(sweep);
      tracker.clear();
    },
  };
}
