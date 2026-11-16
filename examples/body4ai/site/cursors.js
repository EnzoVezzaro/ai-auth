// Presence list keyed by VERIFIED identity (the envelope issuer). A display
// label is shown as the sender's claim next to the verified fingerprint.
const GRACE_MS = 30_000;

export function mountCursorList({ target, room }) {
  const entries = new Map();
  const render = () => {
    target.replaceChildren();
    for (const entry of entries.values()) {
      const node = document.createElement("li");
      node.dataset.cursor = "";
      node.dataset.issuer = entry.issuer;
      node.dataset.session = entry.session;
      node.dataset.x = String(entry.x);
      node.dataset.y = String(entry.y);
      const fingerprint = document.createElement("code");
      fingerprint.className = "fp";
      fingerprint.textContent = entry.issuer.slice(6, 18);
      const claim = document.createElement("span");
      claim.className = "claim";
      claim.textContent = ` claims to be "${entry.label}"`;
      node.append(fingerprint, claim);
      target.append(node);
    }
  };
  const live = (issuer) =>
    [...room.peers.values()].some((peer) => peer.id === issuer);
  const stop = room.subscribe(({ direction, envelope }) => {
    if (direction !== "in" || !envelope) return;
    const { type, issuer, payload } = envelope.body;
    if (type === "peer/goodbye") {
      if (entries.delete(issuer)) render();
    } else if (type === "presence/cursor") {
      if (payload.visible === false) entries.delete(issuer);
      else
        entries.set(issuer, {
          issuer,
          session: payload.session,
          x: payload.x,
          y: payload.y,
          label: String(payload.label ?? "").slice(0, 60),
          seenAt: Date.now(),
        });
      render();
    }
  });
  const sweep = setInterval(() => {
    let changed = false;
    for (const [issuer, entry] of entries)
      if (Date.now() - entry.seenAt > GRACE_MS && !live(issuer)) {
        entries.delete(issuer);
        changed = true;
      }
    if (changed) render();
  }, 2_000);
  return () => {
    stop();
    clearInterval(sweep);
    entries.clear();
    render();
  };
}
