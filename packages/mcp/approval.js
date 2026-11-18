import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  MIN_SESSION_TTL_MS,
  SessionLease,
} from "@enzovezzaro/ai-auth-wallet";

export class ApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApprovalError";
  }
}

const MEANING = {
  "presence.read": "join the room, appear as a peer, and read room events",
  "messages.send": "send signed text messages to peers in the room",
  "tools.invoke":
    "list and call the site's WebMCP tools (the site owner still approves each call)",
  // Accepted for compatibility, but no task/command protocol exists yet.
  "tasks.delegate":
    "legacy task-delegation scope: no task protocol is implemented yet, so it grants no working handoff",
};

export function renderPreview({ origin, room, walletId, requested, source }) {
  const lines = [
    "AI Auth agent connection preview",
    `  Site origin : ${origin}`,
    `  Room        : ${room ?? "(not chosen yet)"}`,
    `  Agent wallet: ${walletId}`,
    `  Requested by: ${source === "url" ? "URL discovery (no scopes; nothing is granted by a URL)" : source}`,
    "  Scopes you can grant (a signature proves key possession, not who you are):",
    ...requested.map(
      (cap) => `    - ${cap}: ${MEANING[cap] ?? "site-defined operation"}`,
    ),
    "  Data goes directly to peers over WebRTC; public Nostr relays see only signaling.",
  ];
  return lines.join("\n");
}

function validateScopes(list, requested) {
  if (!Array.isArray(list) || list.length === 0)
    throw new ApprovalError("No capabilities were approved; connection denied");
  if (new Set(list).size !== list.length)
    throw new ApprovalError("Approved capabilities contain duplicates");
  for (const cap of list) {
    if (cap === "*" || cap === "all")
      throw new ApprovalError(
        "Wildcard approvals are not allowed; list exact scopes",
      );
    if (!requested.includes(cap))
      throw new ApprovalError(
        `"${cap}" was not requested by the site; approvals can never escalate`,
      );
  }
  return [...list].sort();
}

/**
 * Decide the granted scopes. Always a subset of `requested`. Without a TTY the
 * caller must pass exact scopes via --approve; there is no implicit approval.
 */
export async function resolveApproval({
  requested,
  approve,
  interactive,
  ask,
}) {
  if (approve !== null && approve !== undefined)
    return validateScopes(approve, requested);
  if (!interactive)
    throw new ApprovalError(
      "Refusing to auto-approve without a TTY: pass --approve with the exact scopes to grant",
    );
  let lastError = null;
  // A typo at the TTY should not force a restart (and a fresh passphrase).
  // Empty input stays an explicit, terminal "deny".
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = String((await ask(requested, lastError)) ?? "").trim();
    if (!answer)
      throw new ApprovalError(
        "No capabilities were approved; connection denied",
      );
    if (answer === "all") return [...requested].sort();
    try {
      return validateScopes(
        answer
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        requested,
      );
    } catch (error) {
      if (!(error instanceof ApprovalError)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new ApprovalError("No valid scopes were approved");
}

/**
 * Non-secret approval snapshot kept beside runtime.json. It holds only public
 * configuration (origin, room, scope names, lifetime, timestamp): no token,
 * passphrase, private key or signed consent is ever written here.
 */
export const GRANT_FILE = "runtime-grants.json";
const GRANT_VERSION = 1;
export const grantPath = (dir) => path.join(dir, GRANT_FILE);

const sameSet = (a, b) => {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};
const optionalMs = (value) =>
  value === null || (Number.isSafeInteger(value) && value > 0);

function positiveMs(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < MIN_SESSION_TTL_MS)
    throw new ApprovalError(
      `${label} must be a positive integer number of milliseconds`,
    );
  return value;
}

/**
 * Headless lifetime choice, the CLI equivalent of the wallet's Never / numeric
 * pick. No variables means Never (unbounded), matching docs/lifecycle.md. A
 * numeric session also gets the browser's 10-minute idle ceiling unless an
 * idle timeout was chosen explicitly.
 */
export function lifetimeFromEnv(env = process.env) {
  const read = (name) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < MIN_SESSION_TTL_MS)
      throw new ApprovalError(
        `${name} must be a positive integer number of milliseconds`,
      );
    return value;
  };
  const sessionTtlMs = read("AI_AUTH_SESSION_TTL_MS");
  const chosenIdle = read("AI_AUTH_IDLE_TIMEOUT_MS");
  const idleTimeoutMs =
    sessionTtlMs !== null && chosenIdle === null
      ? Math.min(DEFAULT_IDLE_TIMEOUT_MS, sessionTtlMs)
      : chosenIdle;
  return { sessionTtlMs, idleTimeoutMs };
}

/**
 * Authorization adapter passed to createAgentRuntime(). It reuses the SDK's
 * SessionLease so headless expiry/idle follow the same rules as a browser
 * session; `idle` is reported as `expired` because both end the connection.
 */
export function createApprovalLease({
  sessionTtlMs = null,
  idleTimeoutMs = null,
  approvedAt = Date.now(),
  now = Date.now,
} = {}) {
  const ttl = positiveMs(sessionTtlMs, "sessionTtlMs");
  const idle = positiveMs(idleTimeoutMs, "idleTimeoutMs");
  if (!Number.isFinite(approvedAt))
    throw new ApprovalError("approvedAt must be a finite timestamp");
  const expiresAt = ttl === null ? null : approvedAt + ttl;
  const lease = new SessionLease(
    { expiresAt, idleTimeoutMs: idle, capabilities: [] },
    { now },
  );
  let localRevoked = false;
  return Object.freeze({
    check() {
      if (localRevoked) return "revoked";
      const status = lease.status();
      return status === "idle" ? "expired" : status;
    },
    touch: () => lease.touch(),
    revoke: () => {
      localRevoked = true;
      lease.revoke();
    },
    get status() {
      return localRevoked ? "revoked" : lease.status();
    },
    get expiresAt() {
      return expiresAt;
    },
  });
}

/** Reuse a saved grant only for the exact origin, room and requested scopes. */
export async function readSavedGrant({
  dir,
  origin,
  room,
  requested,
  file = grantPath(dir),
}) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new ApprovalError(
      "The saved agent grant is unreadable; re-approve with --approve",
    );
  }
  const wanted = [...requested].sort();
  const granted = raw?.granted;
  const usable =
    raw?.v === GRANT_VERSION &&
    raw.origin === origin &&
    raw.room === room &&
    Array.isArray(raw.requested) &&
    sameSet(raw.requested, wanted) &&
    Array.isArray(granted) &&
    granted.length > 0 &&
    new Set(granted).size === granted.length &&
    granted.every(
      (cap) => typeof cap === "string" && raw.requested.includes(cap),
    ) &&
    optionalMs(raw.sessionTtlMs) &&
    optionalMs(raw.idleTimeoutMs) &&
    Number.isFinite(raw.approvedAt);
  if (!usable)
    throw new ApprovalError(
      "The saved agent grant does not match this origin, room or scopes; pass --approve to grant again",
    );
  return Object.freeze({
    scopes: Object.freeze([...granted].sort()),
    sessionTtlMs: raw.sessionTtlMs,
    idleTimeoutMs: raw.idleTimeoutMs,
    approvedAt: raw.approvedAt,
  });
}

export async function writeSavedGrant({
  dir,
  origin,
  room,
  requested,
  granted,
  sessionTtlMs = null,
  idleTimeoutMs = null,
  approvedAt = Date.now(),
  file = grantPath(dir),
}) {
  const body = JSON.stringify({
    v: GRANT_VERSION,
    origin,
    room,
    requested: [...requested].sort(),
    granted: [...granted].sort(),
    sessionTtlMs,
    idleTimeoutMs,
    approvedAt,
  });
  await writeFile(file, `${body}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** Visible line prompt on the controlling TTY (stderr keeps stdout clean). */
export function askOnTty({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  return (requested, error) =>
    new Promise((resolve) => {
      const rl = createInterface({ input, output });
      const hint = error ? ` [${error.message}]` : "";
      rl.question(
        `Grant which scopes? (comma list of ${requested.join(", ")}; "all"; empty = deny)${hint}: `,
        (line) => {
          rl.close();
          resolve(line);
        },
      );
    });
}
