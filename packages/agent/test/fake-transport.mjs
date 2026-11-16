// In-process stand-in for Trystero's joinRoom (same surface NostrWebRTC uses).
// A hub joins every transport created with the same topic as direct peers.
export function createHub() {
  const rooms = new Map();
  const hub = {
    failJoins: 0,
    joins: 0,
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
      };
      const emit = (set, ...args) => [...set].forEach((fn) => fn(...args));
      for (const other of members) {
        emit(other.join, { peerId: me.id });
      }
      members.add(me);
      return {
        selfId: me.id,
        onError: () => () => {},
        makeAction: () => ({
          // Same contract as @trystero-p2p/core 0.27: `send(data, { target })`.
          send(envelope, options = {}) {
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
          members.delete(me);
          for (const other of members) emit(other.leave, { peerId: me.id });
        },
      };
    },
  };
  return hub;
}
