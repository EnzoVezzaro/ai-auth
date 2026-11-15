import { DurableObject } from "cloudflare:workers";
import {
  createPermissionRequest,
  verifyPermissionConsent,
} from "../../../packages/p2p/index.js";

const encoder = new TextEncoder();
const SESSION_LIFETIME_MS = 15 * 60 * 1000;
const CHALLENGE_WINDOW_MS = 60_000;
const MAX_CHALLENGES_PER_CLIENT_WINDOW = 60;
const MAX_CHALLENGE_RATE_KEYS = 10_000;
const WEBSOCKET_RATE_WINDOW_MS = 10_000;
const MAX_WEBSOCKET_HANDSHAKES_PER_CLIENT_WINDOW = 4;
const MAX_WEBSOCKET_RATE_KEYS = 10_000;
const MAX_PENDING_CHALLENGES = 10_000;
const MAX_ACTIVE_SESSIONS = 10_000;
const MAX_ACTIVE_SESSIONS_PER_AGENT = 10;
const MAX_TENANTS = 10_000;
const MAX_TENANTS_PER_OWNER = 100;
const MAX_LIFETIME_TENANT_CREATIONS = 10_000;
const MAX_LIFETIME_TENANT_CREATIONS_PER_OWNER = 100;

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64url(new Uint8Array(digest));
}

function safeSession(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    publicKey: JSON.parse(row.public_key),
    capabilities: JSON.parse(row.capabilities),
    expiresAt: row.expires_at,
  };
}

export class AuthDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS challenges (
        nonce TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumed_nonces (
        nonce TEXT PRIMARY KEY,
        consumed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS challenge_rate_limits (
        client_key TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS websocket_rate_limits (
        client_key TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS websocket_rate_limits_window
        ON websocket_rate_limits (window_started_at);
      CREATE TABLE IF NOT EXISTS websocket_rate_limit_capacity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_keys INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO websocket_rate_limit_capacity (id, active_keys)
      SELECT 1, COUNT(*) FROM websocket_rate_limits;
      CREATE TRIGGER IF NOT EXISTS websocket_rate_limits_count_insert
      AFTER INSERT ON websocket_rate_limits BEGIN
        UPDATE websocket_rate_limit_capacity
        SET active_keys = active_keys + 1 WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS websocket_rate_limits_count_delete
      AFTER DELETE ON websocket_rate_limits BEGIN
        UPDATE websocket_rate_limit_capacity
        SET active_keys = active_keys - 1 WHERE id = 1;
      END;
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id TEXT PRIMARY KEY,
        owner_agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_creation_usage (
        owner_agent_id TEXT PRIMARY KEY,
        creation_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_creation_total (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        creation_count INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO tenant_creation_total (id, creation_count)
      VALUES (1, 0);
      CREATE INDEX IF NOT EXISTS tenants_owner ON tenants (owner_agent_id);
    `);
  }

  async health() {
    this.sql.exec("SELECT 1").toArray();
    return true;
  }

  async allowWebSocketHandshake(clientIp) {
    if (
      typeof clientIp !== "string" ||
      clientIp.length === 0 ||
      clientIp.length > 64
    )
      return false;

    const now = Date.now();
    const windowStartedAt =
      Math.floor(now / WEBSOCKET_RATE_WINDOW_MS) * WEBSOCKET_RATE_WINDOW_MS;
    const clientKey = await sha256(`websocket\n${clientIp}`);
    this.sql.exec(
      "DELETE FROM websocket_rate_limits WHERE window_started_at < ?",
      windowStartedAt,
    );
    const existing = this.sql
      .exec(
        "SELECT window_started_at FROM websocket_rate_limits WHERE client_key = ?",
        clientKey,
      )
      .toArray()[0];
    if (
      !existing &&
      this.sql
        .exec(
          "SELECT active_keys AS count FROM websocket_rate_limit_capacity WHERE id = 1",
        )
        .toArray()[0].count >= MAX_WEBSOCKET_RATE_KEYS
    )
      return false;

    const row = this.sql
      .exec(
        `INSERT INTO websocket_rate_limits
         (client_key, window_started_at, request_count) VALUES (?, ?, 1)
         ON CONFLICT(client_key) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           request_count = CASE
             WHEN websocket_rate_limits.window_started_at = excluded.window_started_at
             THEN websocket_rate_limits.request_count + 1
             ELSE 1
           END
         WHERE websocket_rate_limits.window_started_at != excluded.window_started_at
            OR websocket_rate_limits.request_count < ?
         RETURNING request_count`,
        clientKey,
        windowStartedAt,
        MAX_WEBSOCKET_HANDSHAKES_PER_CLIENT_WINDOW,
      )
      .toArray()[0];
    return Boolean(row);
  }

  async createChallenge({ audience, capabilities, clientKey = "unknown" }) {
    const request = await createPermissionRequest(audience, capabilities, {
      expiresInMs: 60_000,
    });
    const now = Date.now();
    this.sql.exec("DELETE FROM challenges WHERE expires_at <= ?", now);
    this.sql.exec(
      "DELETE FROM consumed_nonces WHERE consumed_at < ?",
      now - 600_000,
    );
    this.sql.exec(
      "DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      now,
    );
    this.sql.exec(
      "DELETE FROM challenge_rate_limits WHERE window_started_at < ?",
      now - CHALLENGE_WINDOW_MS,
    );

    const windowStartedAt =
      Math.floor(now / CHALLENGE_WINDOW_MS) * CHALLENGE_WINDOW_MS;
    const rateKey = await sha256(`${clientKey}\n${audience}`);
    const rate = this.sql
      .exec(
        "SELECT window_started_at, request_count FROM challenge_rate_limits WHERE client_key = ?",
        rateKey,
      )
      .toArray()[0];
    if (
      rate?.window_started_at === windowStartedAt &&
      rate.request_count >= MAX_CHALLENGES_PER_CLIENT_WINDOW
    )
      return null;
    if (
      !rate &&
      this.sql
        .exec("SELECT COUNT(*) AS count FROM challenge_rate_limits")
        .toArray()[0].count >= MAX_CHALLENGE_RATE_KEYS
    )
      return null;
    if (
      this.sql.exec("SELECT COUNT(*) AS count FROM challenges").toArray()[0]
        .count >= MAX_PENDING_CHALLENGES
    )
      return null;
    this.sql.exec(
      `INSERT INTO challenge_rate_limits (client_key, window_started_at, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(client_key) DO UPDATE SET
         window_started_at = excluded.window_started_at,
         request_count = CASE
           WHEN challenge_rate_limits.window_started_at = excluded.window_started_at
           THEN challenge_rate_limits.request_count + 1
           ELSE 1
         END`,
      rateKey,
      windowStartedAt,
    );
    this.sql.exec(
      "INSERT INTO challenges (nonce, request_json, expires_at) VALUES (?, ?, ?)",
      request.nonce,
      JSON.stringify(request),
      request.expiresAt,
    );
    return request;
  }

  async registerTenant({ tenantId, ownerAgentId }) {
    const now = Date.now();
    const total = this.sql
      .exec("SELECT COUNT(*) AS count FROM tenants")
      .toArray()[0].count;
    const owned = this.sql
      .exec(
        "SELECT COUNT(*) AS count FROM tenants WHERE owner_agent_id = ?",
        ownerAgentId,
      )
      .toArray()[0].count;
    if (total >= MAX_TENANTS || owned >= MAX_TENANTS_PER_OWNER) return false;
    const ownerUsage =
      this.sql
        .exec(
          "SELECT creation_count FROM tenant_creation_usage WHERE owner_agent_id = ?",
          ownerAgentId,
        )
        .toArray()[0]?.creation_count ?? 0;
    const lifetimeTotal = this.sql
      .exec("SELECT creation_count FROM tenant_creation_total WHERE id = 1")
      .toArray()[0].creation_count;
    if (
      ownerUsage >= MAX_LIFETIME_TENANT_CREATIONS_PER_OWNER ||
      lifetimeTotal >= MAX_LIFETIME_TENANT_CREATIONS
    )
      return false;
    const row = this.sql
      .exec(
        "INSERT INTO tenants (tenant_id, owner_agent_id, created_at) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO NOTHING RETURNING tenant_id",
        tenantId,
        ownerAgentId,
        now,
      )
      .toArray()[0];
    if (!row) return false;
    this.sql.exec(
      "INSERT INTO tenant_creation_usage (owner_agent_id, creation_count) VALUES (?, 1) ON CONFLICT(owner_agent_id) DO UPDATE SET creation_count = creation_count + 1",
      ownerAgentId,
    );
    this.sql.exec(
      "UPDATE tenant_creation_total SET creation_count = creation_count + 1 WHERE id = 1",
    );
    return true;
  }

  async removeTenant({ tenantId, ownerAgentId }) {
    this.sql.exec(
      "DELETE FROM tenants WHERE tenant_id = ? AND owner_agent_id = ?",
      tenantId,
      ownerAgentId,
    );
  }

  async tenantExists(tenantId) {
    return Boolean(
      this.sql
        .exec("SELECT tenant_id FROM tenants WHERE tenant_id = ?", tenantId)
        .toArray()[0],
    );
  }

  async tenantOwnedBy({ tenantId, ownerAgentId }) {
    return Boolean(
      this.sql
        .exec(
          "SELECT tenant_id FROM tenants WHERE tenant_id = ? AND owner_agent_id = ?",
          tenantId,
          ownerAgentId,
        )
        .toArray()[0],
    );
  }

  async createSession({ consent, agentId }) {
    if (
      typeof agentId !== "string" ||
      !/^agent:[A-Za-z0-9_-]{43}$/u.test(agentId)
    )
      return null;
    const nonce = consent?.body?.payload?.requestNonce;
    if (typeof nonce !== "string") return null;
    const challenge = this.sql
      .exec(
        "SELECT request_json, expires_at FROM challenges WHERE nonce = ?",
        nonce,
      )
      .toArray()[0];
    if (!challenge || challenge.expires_at <= Date.now()) return null;

    const request = JSON.parse(challenge.request_json);
    const publicKey = consent?.proof?.publicKey;
    const valid = await verifyPermissionConsent(consent, request, {
      expectedOrigin: request.audience,
      expectedWallet: agentId,
      nonceGuard: {
        consume: (value, expiresAt) =>
          value === request.nonce && expiresAt <= request.expiresAt,
      },
    });
    if (!valid) return null;

    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256(token);
    const now = Date.now();
    this.sql.exec(
      "DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      now,
    );
    const activeSessions = this.sql
      .exec("SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?", now)
      .toArray()[0].count;
    const agentSessions = this.sql
      .exec(
        "SELECT COUNT(*) AS count FROM sessions WHERE agent_id = ? AND expires_at > ?",
        agentId,
        now,
      )
      .toArray()[0].count;
    if (
      activeSessions >= MAX_ACTIVE_SESSIONS ||
      agentSessions >= MAX_ACTIVE_SESSIONS_PER_AGENT
    )
      return null;

    const consume = this.sql
      .exec(
        `INSERT INTO consumed_nonces (nonce, consumed_at)
         VALUES (?, ?)
         ON CONFLICT(nonce) DO NOTHING
         RETURNING nonce`,
        nonce,
        now,
      )
      .toArray()[0];
    if (!consume) return null;

    const sessionId = crypto.randomUUID();
    const expiresAt = now + SESSION_LIFETIME_MS;
    this.sql.exec(
      `INSERT INTO sessions
       (id, token_hash, agent_id, public_key, capabilities, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      tokenHash,
      agentId,
      JSON.stringify(publicKey),
      JSON.stringify(consent.body.payload.capabilities),
      now,
      expiresAt,
    );
    this.sql.exec("DELETE FROM challenges WHERE nonce = ?", nonce);
    return {
      token,
      session: {
        id: sessionId,
        agentId,
        capabilities: consent.body.payload.capabilities,
        expiresAt,
      },
    };
  }

  async verifySessionToken(token) {
    if (typeof token !== "string" || token.length < 40 || token.length > 128)
      return null;
    const row = this.sql
      .exec(
        `SELECT id, agent_id, public_key, capabilities, expires_at, revoked_at
         FROM sessions WHERE token_hash = ?`,
        await sha256(token),
      )
      .toArray()[0];
    if (!row || row.revoked_at !== null || row.expires_at <= Date.now())
      return null;
    return safeSession(row);
  }

  async verifySessionId(sessionId) {
    if (typeof sessionId !== "string") return null;
    const row = this.sql
      .exec(
        `SELECT id, agent_id, public_key, capabilities, expires_at, revoked_at
         FROM sessions WHERE id = ?`,
        sessionId,
      )
      .toArray()[0];
    if (!row || row.revoked_at !== null || row.expires_at <= Date.now())
      return null;
    return safeSession(row);
  }

  async revokeSession(token) {
    if (typeof token !== "string" || token.length < 40 || token.length > 128)
      return false;
    const hash = await sha256(token);
    const row = this.sql
      .exec("DELETE FROM sessions WHERE token_hash = ? RETURNING id", hash)
      .toArray()[0];
    return Boolean(row);
  }
}
