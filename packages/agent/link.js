// Agent side of AI Auth connect links. The agent's wallet stays in its own
// keystore on its own machine. Given a site's one-time link it proves it holds
// the link, and the site remembers it. Later, whenever the agent is in that
// site's room, it answers the site's fresh signed challenge and is connected
// again with no new link. The link code never leaves this process: only an
// HMAC over the site key, agent id and a fresh nonce is sent, plus a public
// ephemeral ECDH key used to derive the pair secret.
import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_LINK_EVENTS,
  agentLinkProof,
  agentPairProof,
  createPairKeyPair,
  deriveAgentPairSecret,
  isAgentId,
  isAgentLinkNonce,
  isAgentPairSecret,
  isPairPublicKey,
  verifyAgentPairProof,
  randomAgentLinkNonce,
  validLinkOrigin,
} from "@enzovezzaro/ai-auth-wallet/agent-link";

const LINKS_FILE = "linked-sites.json";
const MAX_SITES = 32;
const HELLO_RETRY_MS = 2_000;
const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const SCOPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;
const cleanName = (value, fallback) =>
  String(value ?? "")
    .replace(CONTROL_CHARS, "")
    .trim()
    .slice(0, 80) || fallback;

export function linkedSitesPath(dir) {
  return path.join(dir, LINKS_FILE);
}

const validSite = (site) =>
  site &&
  validLinkOrigin(site.origin) &&
  ROOM_PATTERN.test(site.room ?? "") &&
  typeof site.name === "string" &&
  site.name.length <= 80 &&
  !new RegExp(CONTROL_CHARS.source, "u").test(site.name) &&
  Array.isArray(site.capabilities) &&
  site.capabilities.length <= 8 &&
  site.capabilities.every(
    (cap) => typeof cap === "string" && SCOPE_PATTERN.test(cap),
  ) &&
  isAgentPairSecret(site.secret);

/**
 * Sites this agent connected to with a link, mode 0600. Each record holds the
 * pair secret shared with that site; it authenticates reconnects both ways.
 */
export function createLinkedSitesStore({ dir }) {
  if (typeof dir !== "string" || !dir)
    throw new TypeError("A keystore dir is required");
  const file = linkedSitesPath(dir);
  const read = async () => {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Never treat a damaged file as empty: the next write would erase every
      // saved site. Surface it instead.
      throw new Error(
        `${file} is not valid JSON; fix or remove it to save linked sites again`,
      );
    }
    return parsed?.v === 1 && Array.isArray(parsed.sites)
      ? parsed.sites.filter(validSite)
      : [];
  };
  const write = async (sites) => {
    const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(
        tmp,
        `${JSON.stringify({ v: 1, sites: sites.slice(0, MAX_SITES) }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };
  return Object.freeze({
    list: read,
    async get(origin, room) {
      return (
        (await read()).find(
          (site) =>
            site.origin === origin &&
            (room === undefined || site.room === room),
        ) ?? null
      );
    },
    /** The most recently connected site, for `serve` with no --connect. */
    async latest() {
      return (
        (await read()).sort(
          (a, b) => (b.linkedAt ?? 0) - (a.linkedAt ?? 0),
        )[0] ?? null
      );
    },
    async put(site) {
      if (!validSite(site))
        throw new TypeError("A valid linked site is required");
      const rest = (await read()).filter(
        (item) => !(item.origin === site.origin && item.room === site.room),
      );
      await write([{ ...site }, ...rest]);
    },
    async remove(origin, room) {
      await write(
        (await read()).filter(
          (item) => !(item.origin === origin && item.room === room),
        ),
      );
    },
  });
}

/**
 * Attach link handling to a joined (or joining) agent runtime.
 *
 * - `link`: a parsed one-time link (parseAgentLink) to redeem, or null.
 * - `saved`: this agent's saved record for the runtime's site, or null.
 * - `store`: createLinkedSitesStore, used to remember an accepted link.
 */
export function createAgentLinkResponder({
  runtime,
  link = null,
  saved = null,
  store,
  now = Date.now,
}) {
  if (
    !runtime ||
    typeof runtime.onEvent !== "function" ||
    typeof runtime.send !== "function"
  )
    throw new TypeError("An agent runtime is required");
  if (
    link &&
    (link.origin !== runtime.origin ||
      (runtime.approvedRoom && link.room !== runtime.approvedRoom))
  )
    throw new TypeError(
      "The link is for a different site or room than this runtime",
    );
  const status = {
    site: link
      ? { name: link.name, origin: link.origin, room: link.room }
      : saved
        ? { name: saved.name, origin: saved.origin, room: saved.room }
        : null,
    linked: Boolean(saved),
    connected: false,
    via: null, // "link" | "challenge"
    capabilities: saved ? [...saved.capabilities] : [],
    lastVerifiedAt: null,
    error: null,
  };
  // The site key that last verified us. Site keys are per page session, so
  // "connected" also requires that exact key to still be present.
  let siteKey = null;
  let pairSecret = saved?.secret ?? null;
  const siteKeyPresent = () =>
    Boolean(siteKey) &&
    runtime.peers().some((peer) => peer.id === siteKey && !peer.stale);
  const linkNonce = link ? randomAgentLinkNonce() : null;
  // Ephemeral ECDH key for this redemption; its private half never leaves.
  const pairKeys = link ? createPairKeyPair() : null;
  let redeemed = false;
  let helloTimer = null;
  let closed = false;
  const me = () => runtime.identity?.id;

  const sitePresent = () =>
    link &&
    runtime.peers().some((peer) => peer.id === link.site && !peer.stale);

  async function sendHello() {
    if (closed || redeemed || !link || !me()) return;
    if (link.expiresAt <= now()) {
      status.error =
        "The connect link expired before the site answered. Ask the site for a new link.";
      clearInterval(helloTimer);
      return;
    }
    if (!sitePresent()) return;
    try {
      const proof = await agentLinkProof({
        code: link.code,
        origin: link.origin,
        room: link.room,
        site: link.site,
        agent: me(),
        linkNonce,
      });
      await runtime.send(
        AGENT_LINK_EVENTS.hello,
        {
          target: link.site,
          linkNonce,
          proof,
          pairKey: (await pairKeys).publicKey,
          name: runtime.descriptor?.name ?? "AI Auth agent",
          capabilities: [...runtime.capabilities],
        },
        { to: link.site },
      );
    } catch {
      // Not joined yet or the site went away; the timer retries.
    }
  }

  async function onAccept(issuer, payload) {
    if (!link || redeemed || issuer !== link.site) return;
    if (
      payload?.target !== me() ||
      payload.linkNonce !== linkNonce ||
      !isPairPublicKey(payload.pairKey)
    )
      return;
    let secret;
    try {
      secret = await deriveAgentPairSecret({
        code: link.code,
        agent: me(),
        linkNonce,
        privateKey: (await pairKeys).privateKey,
        peerPublicKey: payload.pairKey,
      });
    } catch {
      return; // A malformed accept; keep waiting for the real one.
    }
    if (redeemed) return;
    redeemed = true;
    siteKey = issuer;
    clearInterval(helloTimer);
    const granted = Array.isArray(payload.capabilities)
      ? payload.capabilities
          .filter((cap) => runtime.capabilities.includes(cap))
          .sort()
      : [];
    const record = {
      origin: link.origin,
      room: link.room,
      name: cleanName(payload.name, link.name),
      capabilities: granted,
      linkedAt: now(),
      secret,
    };
    pairSecret = record.secret;
    await store?.put(record).catch((error) => {
      status.error = `Connected, but could not save the site for reconnects: ${error.message}`;
    });
    Object.assign(status, {
      site: { name: record.name, origin: record.origin, room: record.room },
      linked: true,
      connected: true,
      via: "link",
      capabilities: granted,
      lastVerifiedAt: now(),
    });
  }

  async function onChallenge(issuer, payload) {
    if (!pairSecret) return;
    if (payload?.target !== me() || !isAgentLinkNonce(payload.challenge))
      return;
    const fields = (role) => ({
      role,
      origin: runtime.origin,
      room: runtime.room ?? runtime.approvedRoom,
      site: issuer,
      agent: me(),
      challenge: payload.challenge,
    });
    // Only the site we paired with knows the pair secret. Anyone else in the
    // open room is ignored, so it cannot make this agent think it is connected.
    if (
      !(await verifyAgentPairProof(
        pairSecret,
        fields("site-challenge"),
        payload.siteProof,
      ))
    )
      return;
    try {
      const agentProof = await agentPairProof(
        pairSecret,
        fields("agent-response"),
      );
      await runtime.send(
        AGENT_LINK_EVENTS.response,
        { target: issuer, challenge: payload.challenge, agentProof },
        { to: issuer },
      );
      if (status.linked) siteKey = issuer;
      if (status.linked)
        Object.assign(status, {
          connected: true,
          via: status.via ?? "challenge",
          lastVerifiedAt: now(),
        });
    } catch {
      // The challenger left before the answer could be delivered.
    }
  }

  const stop = runtime.onEvent((message) => {
    if (message?.direction !== "in" || !message.envelope?.body) return;
    const { type, issuer, payload } = message.envelope.body;
    if (!isAgentId(issuer) || issuer === me()) return;
    // The site just showed up (or spoke): try the link now, not on the next tick.
    if (
      link &&
      !redeemed &&
      issuer === link.site &&
      type !== AGENT_LINK_EVENTS.accept
    )
      void sendHello();
    if (type === AGENT_LINK_EVENTS.accept) void onAccept(issuer, payload);
    else if (type === AGENT_LINK_EVENTS.challenge)
      void onChallenge(issuer, payload);
    else if (type === "peer/goodbye" && issuer === siteKey)
      status.connected = false;
  });
  if (link) {
    helloTimer = setInterval(() => void sendHello(), HELLO_RETRY_MS);
    helloTimer.unref?.();
    void sendHello();
  }

  return Object.freeze({
    status: () =>
      Object.freeze({
        ...status,
        connected: status.connected && siteKeyPresent(),
        site: status.site ? { ...status.site } : null,
        capabilities: [...status.capabilities],
        pending: Boolean(link && !redeemed),
      }),
    close() {
      closed = true;
      clearInterval(helloTimer);
      stop?.();
    },
  });
}
