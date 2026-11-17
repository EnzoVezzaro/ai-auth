// In-process stand-in for Trystero's joinRoom (same surface NostrWebRTC uses).
// A hub joins every transport created with the same topic as direct peers.
// With `goodbyeOnly`, a peer disappears only when a peer/goodbye envelope is
// sent, so tests can tell a real goodbye from a bare transport leave.
export function createHub({ goodbyeOnly = false } = {}) {
  const rooms = new Map();
  const emit = (set, ...args) => [...set].forEach((fn) => fn(...args));
  const hub = {
    failJoins: 0,
    joins: 0,
    goodbyes: 0,
    goodbyeOnly,
    emitError(topic, error) {
      for (const other of rooms.get(topic) ?? []) emit(other.errors, error);
    },
    joinRoom(config, topic) {
      hub.joins += 1;
      if (hub.failJoins > 0) {
        hub.failJoins -= 1;
        throw new Error("simulated relay failure");
      }
      const members = rooms.get(topic) ?? new Set();
      rooms.set(topic, members);
      const me = {
        id: `peer-${Math.random().toString(36).slice(2, 10)}`,
        join: new Set(),
        leave: new Set(),
        msg: new Set(),
        errors: new Set(),
      };
      for (const other of members) {
        emit(other.join, { peerId: me.id });
      }
      members.add(me);
      return {
        selfId: me.id,
        onError(fn) {
          me.errors.add(fn);
          return () => me.errors.delete(fn);
        },
        makeAction: () => ({
          // Same contract as @trystero-p2p/core 0.27: `send(data, { target })`.
          send(envelope, options = {}) {
            if (goodbyeOnly && envelope?.body?.type === "peer/goodbye") {
              hub.goodbyes += 1;
              members.delete(me);
              for (const other of members) emit(other.leave, { peerId: me.id });
            }
            const target = options?.target;
            const targets =
              target === undefined || target === null ? null : [target].flat();
            for (const other of members)
              if (other !== me && (!targets || targets.includes(other.id)))
                queueMicrotask(() =>
                  emit(other.msg, JSON.parse(JSON.stringify(envelope)), {
                    peerId: me.id,
                  }),
                );
            return Promise.resolve();
          },
          onMessage(fn) {
            me.msg.add(fn);
            return () => me.msg.delete(fn);
          },
        }),
        onPeerJoin(fn, { replay } = {}) {
          me.join.add(fn);
          if (replay)
            for (const other of members)
              if (other !== me) fn({ peerId: other.id });
          return () => me.join.delete(fn);
        },
        onPeerLeave(fn) {
          me.leave.add(fn);
          return () => me.leave.delete(fn);
        },
        getPeers: () =>
          Object.fromEntries(
            [...members].filter((m) => m !== me).map((m) => [m.id, {}]),
          ),
        async leave() {
          if (goodbyeOnly) return; // only an explicit peer/goodbye removes a peer
          members.delete(me);
          for (const other of members) emit(other.leave, { peerId: me.id });
        },
      };
    },
  };
  return hub;
}
