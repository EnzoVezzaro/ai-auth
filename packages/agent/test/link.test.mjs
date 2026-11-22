// AI Auth agent connect links: site controller <-> agent responder over an
// in-memory room. No wallet is involved on the site side.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAIAuthAgentLink,
  createAgentLinkPayload,
  agentLinkUrl,
  parseAgentLink,
} from "@enzovezzaro/ai-auth-wallet";
import {
  AGENT_LINK_EVENTS,
  agentLinkProof,
} from "@enzovezzaro/ai-auth-wallet/agent-link";
import {
  createAgentLinkResponder,
  createLinkedSitesStore,
  linkedSitesPath,
} from "../link.js";

const ORIGIN = "https://shop.example";
const ROOM = "agents";
const CAPS = ["presence.read", "messages.send", "tools.invoke"];
const id = (n) => `agent:${String(n).padEnd(43, "x")}`;
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(5);
  }
  return false;
}

/** A tiny shared room: every member sees every other member's envelopes. */
function createBus() {
  const members = new Map();
  const deliver = (from, type, payload, to) => {
    for (const member of members.values()) {
      if (member.id === from.id) continue;
      if (to && member.id !== to) continue;
      const envelope = {
        body: {
          type,
          issuer: from.id,
          payload: { ...payload, session: from.session },
        },
      };
      for (const fn of [...member.listeners]) fn({ direction: "in", envelope });
    }
  };
  function join(memberId) {
    const member = {
      id: memberId,
      session: `s-${memberId.slice(6, 12)}`,
      listeners: new Set(),
      sent: [],
    };
    members.set(memberId, member);
    const api = {
      wallet: { id: memberId },
      get session() {
        return member.session;
      },
      peers: {
        values: () =>
          [...members.values()]
            .filter((m) => m.id !== memberId)
            .map((m) => ({ id: m.id })),
      },
      subscribe(fn) {
        member.listeners.add(fn);
        return () => member.listeners.delete(fn);
      },
      async send(type, payload, { to } = {}) {
        member.sent.push({ type, payload, to });
        deliver(member, type, payload, to);
        return { body: { type } };
      },
      leave() {
        members.delete(memberId);
        for (const m of members.values())
          for (const fn of m.listeners)
            fn({
              direction: "in",
              envelope: {
                body: { type: "peer/goodbye", issuer: memberId, payload: {} },
              },
            });
      },
      sent: member.sent,
      hello() {
        deliver(member, "peer/hello", {}, null);
      },
    };
    return api;
  }
  return { join };
}

/** Agent runtime facade over a bus member, as the responder expects it. */
function runtimeOn(
  bus,
  agentId,
  { name = "Test agent", capabilities = CAPS } = {},
) {
  const room = bus.join(agentId);
  return {
    room,
    runtime: {
      identity: { id: agentId },
      origin: ORIGIN,
      room: ROOM,
      approvedRoom: ROOM,
      capabilities,
      descriptor: { name },
      onEvent: (fn) => room.subscribe(fn),
      send: (type, payload, options) => room.send(type, payload, options),
      peers: () =>
        [...room.peers.values()].map((p) => ({ ...p, stale: false })),
    },
  };
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    data,
  };
}

async function siteOn(bus, storage = memoryStorage(), extra = {}) {
  const site = createAIAuthAgentLink({
    siteName: "Shop",
    capabilities: CAPS,
    room: ROOM,
    origin: ORIGIN,
    linkBaseUrl: `${ORIGIN}/agents`,
    storage,
    checkTimeoutMs: 200,
    openRoom: async () => {
      const room = bus.join(
        id("site" + Math.random().toString(36).slice(2, 8)),
      );
      return { room, close: async () => room.leave() };
    },
    ...extra,
  });
  await site.start();
  return { site, storage };
}

test("a link URL round-trips, keeps its secret in the fragment, and binds the page origin", () => {
  const payload = createAgentLinkPayload({
    origin: ORIGIN,
    room: ROOM,
    site: id("site1"),
    name: "Shop",
    capabilities: CAPS,
  });
  const url = agentLinkUrl(`${ORIGIN}/agents?reset=SECRET&x=$(id)`, payload);
  assert.match(new URL(url).hash, /^#ai-auth-link=/u);
  assert.equal(new URL(url).search, "", "the page query string is dropped");
  assert.doesNotMatch(url, /['"`$()]/u, "safe inside a quoted shell argument");
  const odd = agentLinkUrl(`${ORIGIN}/a'b$(c)/`, payload);
  assert.doesNotMatch(odd, /['"`$()]/u, "path characters are encoded too");
  assert.throws(
    () => parseAgentLink(new URL(url).hash.slice(14)),
    /no link token/u,
  );
  assert.deepEqual(parseAgentLink(url), payload);
  const moved = url.replace(ORIGIN, "https://evil.example");
  assert.throws(() => parseAgentLink(moved), /origin does not match/u);
  assert.throws(
    () => parseAgentLink(url, { now: payload.expiresAt + 1 }),
    (error) => error.code === "AGENT_LINK_EXPIRED",
  );
  assert.throws(
    () =>
      createAgentLinkPayload({
        origin: "http://shop.example",
        site: id("s"),
        name: "x",
        capabilities: CAPS,
      }),
    /bad origin/u,
  );
});

test("an agent with a link connects, the site remembers it, and the agent saves the site", async () => {
  const bus = createBus();
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-link-"));
  try {
    const { site } = await siteOn(bus);
    const view = await site.check();
    assert.equal(view.phase, "needs-link", "nobody known yet: show the link");
    const link = parseAgentLink(view.link.url);

    const agentId = id("agentA");
    const { runtime } = runtimeOn(bus, agentId, {
      capabilities: ["presence.read", "tools.invoke"],
    });
    const store = createLinkedSitesStore({ dir });
    const responder = createAgentLinkResponder({ runtime, link, store });

    assert.ok(
      await until(() => site.state.phase === "connected"),
      "site connected",
    );
    assert.deepEqual(
      site.agent(agentId).capabilities,
      ["presence.read", "tools.invoke"],
      "only scopes both sides allow",
    );
    assert.equal(site.state.link, null, "the link is single use");
    assert.ok(
      await until(() => responder.status().connected),
      "agent knows it is connected",
    );
    const status = responder.status();
    assert.deepEqual(status.site, { name: "Shop", origin: ORIGIN, room: ROOM });
    assert.equal(status.via, "link");

    const saved = await store.get(ORIGIN, ROOM);
    assert.equal(saved.name, "Shop");
    assert.equal((await stat(linkedSitesPath(dir))).mode & 0o777, 0o600);
    assert.ok(
      !(await readFile(linkedSitesPath(dir), "utf8")).includes(link.code),
      "the link code is never stored",
    );
    assert.ok(
      !JSON.stringify(site.state.remembered).includes(saved.secret),
      "the site never exposes the pair secret in its state",
    );
    responder.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a remembered agent reconnects with a fresh challenge and no new link", async () => {
  const bus = createBus();
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-link-"));
  const storage = memoryStorage();
  try {
    const first = await siteOn(bus, storage);
    const link = parseAgentLink((await first.site.check()).link.url);
    const agentId = id("agentB");
    const a1 = runtimeOn(bus, agentId);
    const store = createLinkedSitesStore({ dir });
    const r1 = createAgentLinkResponder({ runtime: a1.runtime, link, store });
    assert.ok(await until(() => first.site.state.phase === "connected"));
    assert.ok(
      await until(async () => Boolean(await store.get(ORIGIN, ROOM))),
      "agent saved the site",
    );
    r1.close();
    a1.room.leave();
    await first.site.close();

    // A new page load (new site key) and a restarted agent with its saved record.
    const second = await siteOn(bus, storage);
    const saved = await store.get(ORIGIN, ROOM);
    const a2 = runtimeOn(bus, agentId);
    const r2 = createAgentLinkResponder({ runtime: a2.runtime, saved, store });
    a2.room.hello();
    const view = await second.site.check();
    assert.ok(
      await until(() => second.site.state.phase === "connected"),
      `reconnected (was ${view.phase})`,
    );
    assert.ok(await until(() => r2.status().connected));
    assert.equal(r2.status().via, "challenge");
    r2.close();
    await second.site.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stranger in the room can neither pose as the site nor redeem a link it does not hold", async () => {
  const bus = createBus();
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-link-"));
  const storage = memoryStorage();
  try {
    const { site } = await siteOn(bus, storage);
    const link = parseAgentLink((await site.check()).link.url);
    const agentId = id("agentC");
    const a = runtimeOn(bus, agentId);
    const store = createLinkedSitesStore({ dir });
    const r = createAgentLinkResponder({ runtime: a.runtime, link, store });
    assert.ok(await until(() => r.status().connected));
    await site.close();

    // Rogue peer sends a challenge without the pair secret.
    const rogue = bus.join(id("rogue1"));
    const before = a.room.sent.length;
    await rogue.send(
      AGENT_LINK_EVENTS.challenge,
      { target: agentId, challenge: "c".repeat(32), siteProof: "f".repeat(43) },
      { to: agentId },
    );
    await wait(30);
    assert.equal(
      a.room.sent.length,
      before,
      "agent ignores an unauthenticated challenge",
    );
    assert.equal(
      r.status().connected,
      false,
      "and does not think it is connected to the rogue",
    );

    // A fresh site; the rogue tries the old (used/other) link code with a forged proof.
    const fresh = await siteOn(bus, memoryStorage());
    const freshLink = parseAgentLink((await fresh.site.check()).link.url);
    await rogue.send(
      AGENT_LINK_EVENTS.hello,
      {
        target: freshLink.site,
        linkNonce: "n".repeat(32),
        proof: await agentLinkProof({
          ...link,
          site: freshLink.site,
          agent: id("rogue1"),
          linkNonce: "n".repeat(32),
        }),
        name: "Rogue",
        capabilities: CAPS,
      },
      { to: freshLink.site },
    );
    await wait(30);
    assert.equal(
      fresh.site.state.phase,
      "needs-link",
      "a proof from another link is refused",
    );
    assert.equal(fresh.site.agent(id("rogue1")), null);

    // A forged reconnect answer for a remembered agent is refused too: a peer
    // using the remembered id but without the pair secret stays unconnected.
    await fresh.site.close();
    const reload = await siteOn(bus, storage);
    r.close();
    a.room.leave();
    const impostor = bus.join(agentId);
    impostor.subscribe(({ envelope }) => {
      if (envelope.body.type !== AGENT_LINK_EVENTS.challenge) return;
      void impostor.send(
        AGENT_LINK_EVENTS.response,
        {
          target: envelope.body.issuer,
          challenge: envelope.body.payload.challenge,
          agentProof: "A".repeat(43),
        },
        { to: envelope.body.issuer },
      );
    });
    impostor.hello();
    await reload.site.check();
    await wait(50);
    assert.equal(reload.site.agent(agentId), null, "no secret, no reconnect");
    assert.notEqual(reload.site.state.phase, "connected");
    await reload.site.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("site tools answer only connected agents; others get a clear DENIED", async () => {
  const bus = createBus();
  const { site } = await siteOn(bus);
  await site.check();
  const connection = site.toolConnection();
  const seen = [];
  connection.onEvent((envelope) => seen.push(envelope.body.payload.kind));
  const stranger = bus.join(id("stranger"));
  const replies = [];
  stranger.subscribe(({ envelope }) => replies.push(envelope.body.payload));
  await stranger.send("agent/action", {
    kind: "tool-request",
    requestId: "req-12345678",
    name: "x",
  });
  await wait(20);
  assert.deepEqual(
    seen,
    [],
    "the page never sees a request from an unconnected agent",
  );
  const denied = replies.find((p) => p.kind === "tool-response");
  assert.equal(denied?.code, "DENIED");
  assert.match(denied.error, /connect link/u);
  await site.close();
});

test("an expired link is refused before anything is sent", async () => {
  const payload = createAgentLinkPayload({
    origin: ORIGIN,
    room: ROOM,
    site: id("site9"),
    name: "Shop",
    capabilities: CAPS,
    ttlMs: 30_000,
  });
  const url = agentLinkUrl(`${ORIGIN}/`, payload);
  assert.throws(
    () => parseAgentLink(url, { now: Date.now() + 31_000 }),
    /expired/u,
  );
});

test("a lost accept is re-sent to the same agent, never to another", async () => {
  const bus = createBus();
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-link-"));
  try {
    const { site } = await siteOn(bus);
    const link = parseAgentLink((await site.check()).link.url);
    const agentId = id("agentL");
    const a = runtimeOn(bus, agentId);
    // Drop the first accept the agent would receive.
    let dropped = false;
    const realSubscribe = a.runtime.onEvent;
    a.runtime.onEvent = (fn) =>
      realSubscribe((message) => {
        if (
          !dropped &&
          message.envelope?.body?.type === AGENT_LINK_EVENTS.accept
        ) {
          dropped = true;
          return;
        }
        fn(message);
      });
    const store = createLinkedSitesStore({ dir });
    const r = createAgentLinkResponder({ runtime: a.runtime, link, store });
    assert.ok(await until(() => site.state.phase === "connected"));
    assert.ok(dropped, "the first accept was lost");
    assert.ok(
      await until(() => r.status().connected, 5_000),
      "the agent's next hello got the accept again",
    );
    assert.ok(await store.get(ORIGIN, ROOM));
    r.close();
    await site.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed start is retried on the next Connect, and close() during start leaks nothing", async () => {
  let attempts = 0;
  const bus = createBus();
  const site = createAIAuthAgentLink({
    siteName: "Shop",
    capabilities: CAPS,
    room: ROOM,
    origin: ORIGIN,
    linkBaseUrl: `${ORIGIN}/agents`,
    storage: memoryStorage(),
    openRoom: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("relays down");
      const room = bus.join(id("siteR" + attempts));
      return { room, close: async () => room.leave() };
    },
  });
  await assert.rejects(site.check(), /relays down/u);
  const view = await site.check();
  assert.equal(view.phase, "needs-link", "the second press works");
  await site.close();

  let closedRoom = false;
  let release;
  const slow = createAIAuthAgentLink({
    siteName: "Shop",
    capabilities: CAPS,
    origin: ORIGIN,
    linkBaseUrl: `${ORIGIN}/`,
    storage: memoryStorage(),
    openRoom: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            room: bus.join(id("siteSlow")),
            close: async () => (closedRoom = true),
          });
      }),
  });
  const starting = slow.start();
  await slow.close();
  release();
  await assert.rejects(starting, /closed/u);
  assert.equal(
    closedRoom,
    true,
    "a room that finished opening after close() is closed",
  );
});

test("a damaged linked-sites file is reported, not silently erased", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-link-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(linkedSitesPath(dir), "{ not json");
    const store = createLinkedSitesStore({ dir });
    await assert.rejects(store.list(), /not valid JSON/u);
    await assert.rejects(
      store.put({
        origin: ORIGIN,
        room: ROOM,
        name: "Shop",
        capabilities: CAPS,
        linkedAt: 1,
        secret: "A".repeat(43),
      }),
      /not valid JSON/u,
    );
    assert.equal(await readFile(linkedSitesPath(dir), "utf8"), "{ not json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("site names with control characters are refused", () => {
  assert.throws(
    () =>
      createAgentLinkPayload({
        origin: ORIGIN,
        site: id("site7"),
        name: "Shop\u001b[2J",
        capabilities: CAPS,
      }),
    /bad site name/u,
  );
});
