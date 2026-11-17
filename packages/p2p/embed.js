import {
  NonceGuard,
  SessionLease,
  createPermissionRequest,
  verifyConsentAgent,
  verifyPermissionConsent,
} from "./connect.js";
import { createCloneDetector } from "./agent-identity.js";
import {
  CANCELLED_MESSAGE,
  approvalTimeoutMessage,
  renewalKeptText,
} from "./copy.js";
import { verifyEnvelope } from "./index.js";
import {
  createSessionStore,
  listResumableSessions,
  recordFromConsent,
  verifyStoredConsent,
} from "./session-store.js";
import { authorizeProtected } from "./membership.js";
import {
  MAX_COORDINATE,
  OFFLINE_AFTER_MS,
  parseCursorPayload,
} from "./presence.js";
import { isMessageId, isWalletId } from "./receipts.js";
import { MAX_MESSAGE_CHARS } from "./message-limits.js";
import {
  markVerifiedPageConnection,
  renewVerifiedPageConnection,
  revokeVerifiedPageConnection,
} from "./session.js";

const CAPABILITY_FOR_EVENT = {
  "peer/hello": "presence.read",
  "peer/heartbeat": "presence.read",
  "peer/goodbye": "presence.read",
  "presence/cursor": "presence.read",
  "message/text": "messages.send",
  "agent/action": "tools.invoke",
};
const PASSIVE_EVENT_TYPES = new Set([
  "peer/hello",
  "peer/heartbeat",
  "peer/goodbye",
  "presence/cursor",
]);
// postMessage is delivered asynchronously: the wallet frame must stay mounted
// long enough to receive "session-ended" and close its room before we destroy
// the iframe. Bounded so teardown still always happens promptly.
const SESSION_ENDED_GRACE_MS = 500;
// setTimeout clamps delays above this to 1ms, which would spin the expiry
// re-check loop. Long waits are split into re-armed chunks of at most this size.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TOOL_EVENT_KINDS = new Set([
  "tool-catalog",
  "tool-request",
  "tool-cancel",
  "tool-response",
]);
const debug = (stage, details = "") => {
  if (
    new URLSearchParams(globalThis.location?.search ?? "").get("debug") === "1"
  )
    console.info("[AI Auth debug]", stage, details);
};

function verifiedWalletIdentity(claim, consent) {
  const issuer = consent?.body?.issuer;
  // Fail closed: the exposed identity is always the issuer verified against
  // the signed consent. A claim naming a different identity is ignored, and
  // its display name is only honored when the claim matches that issuer.
  const id = claim?.id === issuer ? claim.id : issuer;
  const name =
    claim?.id === issuer && typeof claim?.name === "string"
      ? claim.name
          .replaceAll(/[\u0000-\u001f\u007f]/gu, "")
          .trim()
          .slice(0, 60)
      : "";
  return Object.freeze({
    id,
    // The identity id is verified against the signed consent issuer. The
    // display name is site-controlled wallet data and must never be trusted
    // for authorization decisions.
    name: name || null,
  });
}

// A resumed participant is rebuilt only from the stored, signed consent. The
// descriptor claims were verified when the consent was first accepted.
function participantFromRecord(record) {
  const descriptor = record?.consent?.body?.payload?.agentDescriptor;
  const claims = descriptor
    ? {
        agentType: descriptor.agentType,
        runtime: descriptor.runtime,
        provider: descriptor.provider,
        model: descriptor.model,
      }
    : {};
  return Object.freeze({
    identity: Object.freeze({ id: record.walletId }),
    instanceId: record.instanceId,
    sessionId: record.sessionId,
    claims: Object.freeze(claims),
    claimsAttested: false,
  });
}

const MAX_ADDRESSING_TEXT = 200;
const RECEIPT_KEYS = ["messageId", "sender", "receiver", "receivedAt", "nonce"];

// Keep only the addressing fields a transfer may carry. A malformed target or
// message id is an error, never silently dropped: dropping a target would send
// a private message to the whole room.
function boundedAddressing(options, { attachment = false } = {}) {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Transfer options must be an object");
  const out = {};
  if (options.messageId !== undefined) {
    if (!isMessageId(options.messageId))
      throw new TypeError("Invalid message id");
    out.messageId = options.messageId;
  }
  if (options.target !== undefined) {
    if (!isWalletId(options.target))
      throw new TypeError("Invalid target wallet id");
    out.target = options.target;
  }
  if (attachment) {
    for (const key of ["kind", "name"]) {
      const value = options[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > MAX_ADDRESSING_TEXT)
        throw new TypeError(`Invalid attachment ${key}`);
      out[key] = value;
    }
  }
  return out;
}

// A receipt forwarded by the wallet is accepted only for this connection's own
// wallet as sender and only in its plain, bounded shape.
function boundedReceipt(receipt, senderId) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    return null;
  const keys = Object.keys(receipt);
  if (
    keys.length !== RECEIPT_KEYS.length ||
    !RECEIPT_KEYS.every((key) => keys.includes(key)) ||
    !isMessageId(receipt.messageId) ||
    !isWalletId(receipt.sender) ||
    !isWalletId(receipt.receiver) ||
    receipt.sender !== senderId ||
    !Number.isFinite(receipt.receivedAt) ||
    typeof receipt.nonce !== "string" ||
    receipt.nonce.length > MAX_ADDRESSING_TEXT
  )
    return null;
  return Object.freeze(
    Object.fromEntries(RECEIPT_KEYS.map((k) => [k, receipt[k]])),
  );
}

// A renewal that did not happen. The current session stays active until its
// expiry, and the message says so. `code` lets the connect panel tell a
// declined or timed-out renewal apart from a failed one.
function keptSessionError(code, expiresAt, prefix = "") {
  const error = new Error(`${prefix}${renewalKeptText(expiresAt)}`);
  error.code = code;
  return error;
}

function shortIssuerLabel(id) {
  return typeof id === "string" && id.length > 26
    ? `Agent ${id.slice(6, 26)}…`
    : "Connected agent";
}

function walletPageUrl(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol))
    throw new TypeError("Wallet URL must use HTTP or HTTPS");
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  ) {
    throw new TypeError(
      "Wallet pages must use HTTPS outside local development",
    );
  }
  url.searchParams.set("connect", "1");
  return url;
}

export async function connectAIAuthModal({
  walletUrl,
  capabilities,
  room = "default",
  origin = globalThis.location?.origin,
  timeoutMs = 120_000,
  windowObject = globalThis.window,
  sessionTtlMs,
  idleTimeoutMs,
  participation,
  sessionStore,
  storage,
  resumeRecord = null,
  resumeTimeoutMs = 8_000,
} = {}) {
  if (
    participation !== undefined &&
    typeof participation?.policy?.inspect !== "function"
  )
    throw new TypeError("participation needs a participation policy");
  if (!windowObject?.document?.body)
    throw new Error("AI Auth modal connections require a browser document");
  if (typeof origin !== "string")
    throw new TypeError("A site origin is required");
  const target = new URL(origin);
  if (
    target.origin !== origin ||
    !["https:", "http:"].includes(target.protocol)
  )
    throw new TypeError("Site origin must be an exact HTTP origin");
  const walletPage = walletPageUrl(walletUrl);
  // The challenge stays short-lived and single-use; the session lifetime the
  // site would like is only a bounded hint the wallet may shorten.
  const sessionOptions = { sessionTtlMs, idleTimeoutMs };
  let request = await createPermissionRequest(origin, capabilities, {
    room,
    expiresInMs: 120_000,
    ...sessionOptions,
  });
  // Site-origin storage is optional in headless integrations. Without it there
  // is no record to save or restore, and the normal consent flow is unchanged.
  // The default is localStorage so a record survives a page refresh.
  const store =
    sessionStore ??
    (storage || globalThis.localStorage
      ? createSessionStore({ storage })
      : null);
  const document = windowObject.document;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Connect AI Auth wallet");
  dialog.style.cssText =
    "padding:0;border:0;border-radius:12px;width:min(96vw,720px);height:min(90vh,800px);max-width:none;overflow:hidden;display:flex;flex-direction:column;background:#f3f1eb;color:#0e0e10";
  // Cancel sits in its own row above the wallet, so it never covers the
  // wallet's header. It meets the page's 44px touch-target rule.
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.setAttribute("aria-label", "Cancel wallet connection");
  cancelButton.style.cssText =
    "align-self:flex-end;margin:6px 8px 0 0;min-height:44px;min-width:44px;padding:0 16px;border:1px solid #0e0e10;border-radius:999px;background:#fff;color:#0e0e10;font:600 15px/1 system-ui,sans-serif;cursor:pointer";
  const frame = document.createElement("iframe");
  frame.title = "AI Auth wallet";
  frame.style.cssText =
    "border:0;width:100%;flex:1 1 auto;min-height:0;display:block";
  frame.allow = "clipboard-write";
  dialog.append(cancelButton, frame);
  document.body.append(dialog);
  const popup = frame.contentWindow;
  if (!popup) {
    dialog.remove();
    throw new Error("Could not open the AI Auth wallet");
  }

  const consentGuard = new NonceGuard();
  const seen = new Map();
  const listeners = new Set();
  const disconnectListeners = new Set();
  const transferListeners = new Set();
  const pendingTransfers = new Map();
  let transferSequence = 0;
  let consent;
  let lease;
  let pendingRenewal = null;
  let walletIdentity = null;
  let participant = null;
  // What the wallet page says it can do. Never assumed: an older wallet ignores
  // targets, and a silently public "private" message is worse than an error.
  let walletFeatures = { targets: false, receipts: false };
  let cloneDiagnostics = Object.freeze([]);
  const cloneDetector = createCloneDetector();
  let walletSession = null;
  const roomReadyListeners = new Set();
  let closedReason = "";
  let resolveReady;
  let rejectReady;
  let timeout;
  let expiryTimer;
  let resumeTimer;
  let activeConnection;
  let currentRecord = resumeRecord ?? null;
  let agentKey = resumeRecord?.agentKey ?? null;
  let resuming = Boolean(resumeRecord);
  if (resumeRecord) {
    consent = resumeRecord.consent;
    lease = new SessionLease(consent.body.payload);
    walletIdentity = verifiedWalletIdentity(null, consent);
    participant = participantFromRecord(resumeRecord);
  }
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let onRenewed = () => {};
  // The element that had focus before the wallet window opened. Closing the
  // window returns focus there, so a keyboard user is not dropped on the body.
  const opener = document.activeElement;
  const restoreFocus = () => {
    if (typeof opener?.focus === "function") opener.focus();
  };
  const hideDialog = () => {
    dialog.close();
    dialog.style.display = "none";
  };
  // One timer follows the earlier of grant expiry and idle deadline, and
  // re-checks the lease each time so renewal and activity move it forward.
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    if (!lease || !activeConnection) return;
    const status = lease.status();
    if (status !== "active") {
      activeConnection.close(status);
      return;
    }
    const deadline = lease.deadline;
    // A Never grant has no deadline. Re-check expiry on activity instead of
    // re-arming a 1ms timer forever (null - Date.now() is negative).
    if (deadline === null) return;
    // Cap the delay: setTimeout treats delays above the 32-bit maximum as 1ms,
    // and re-arming on each fire keeps very long waits bounded.
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(1, deadline - Date.now()),
    );
    expiryTimer = setTimeout(scheduleExpiry, delay);
  };
  const recordActivity = () => {
    const active = lease?.touch();
    if (active && store && agentKey) store.touch(origin, agentKey);
    return active;
  };

  // Tearing down the dialog removes the iframe (the wallet frame). On a
  // site-initiated close this is deferred so the already-posted session-ended
  // message reaches a live frame first; the message listener stays attached
  // until that deferred teardown runs.
  const teardownFrame = () => {
    windowObject.removeEventListener("message", onMessage);
    dialog.remove();
  };
  const cleanup = ({ deferFrame = false } = {}) => {
    clearTimeout(timeout);
    clearTimeout(expiryTimer);
    clearTimeout(resumeTimer);
    if (pendingRenewal) {
      const renewal = pendingRenewal;
      pendingRenewal = null;
      clearTimeout(renewal.timer);
      renewal.reject(
        keptSessionError(
          "renewal-declined",
          consent?.body?.payload?.expiresAt,
          "The AI Auth connection closed. ",
        ),
      );
    }
    dialog.removeEventListener("cancel", onCancel);
    dialog.removeEventListener("close", onDialogClose);
    if (deferFrame) setTimeout(teardownFrame, SESSION_ENDED_GRACE_MS);
    else teardownFrame();
    restoreFocus();
  };

  // Closing the window before a connection exists cancels that request at once,
  // so the site never waits for an approval the user has already refused.
  const cancelPending = () => {
    cleanup();
    rejectReady(new Error(CANCELLED_MESSAGE));
  };
  const onCancel = (event) => {
    event.preventDefault();
    // A renewal re-shows the dialog, so Escape/Cancel there must decline only
    // the extension - never tear down the still-active session.
    if (pendingRenewal) {
      const renewal = pendingRenewal;
      pendingRenewal = null;
      clearTimeout(renewal.timer);
      hideDialog();
      renewal.reject(
        keptSessionError("renewal-declined", consent?.body?.payload?.expiresAt),
      );
      return;
    }
    if (activeConnection) activeConnection.close();
    else cancelPending();
  };
  // Any other way the window closes (for example the browser closing it) must
  // cancel the same way. After consent the close is expected and changes nothing.
  const onDialogClose = () => {
    if (!consent && !activeConnection) cancelPending();
  };

  // An explicit Resume is the only path that asks the wallet to restore. Any
  // failure deletes just this agent's record and leaves the site to offer a
  // fresh connect; no new scope is ever granted implicitly.
  const failResume = (message) => {
    resuming = false;
    if (store && agentKey) store.remove(origin, agentKey);
    cleanup();
    rejectReady(new Error(message));
  };
  const finishResume = () => {
    clearTimeout(resumeTimer);
    resuming = false;
    hideDialog();
    clearTimeout(timeout);
    timeout = undefined;
    if (store && currentRecord) {
      currentRecord = { ...currentRecord, lastActivity: Date.now() };
      void store.save(origin, currentRecord);
    }
    resolveReady(createConnection());
  };
  async function validResumeResponse(data) {
    const record = currentRecord;
    const payload = data?.consent?.body?.payload;
    if (!record || !payload || data.sessionId !== record.sessionId)
      return false;
    if (data.wallet?.id && data.wallet.id !== record.walletId) return false;
    // A renewed consent carries the renewal nonce but stays bound to the
    // original session id, which this record keeps as its stable key.
    if (
      payload.requestNonce !== record.sessionId &&
      payload.renewsNonce !== record.sessionId
    )
      return false;
    const scopes = payload.capabilities;
    if (
      !Array.isArray(scopes) ||
      scopes.length !== record.capabilities.length ||
      !scopes.every((scope) => record.capabilities.includes(scope))
    )
      return false;
    return verifyStoredConsent(data.consent, {
      origin,
      walletId: record.walletId,
      room,
    });
  }

  const onMessage = async (event) => {
    if (event.source !== popup || event.origin !== walletPage.origin) return;
    if (lease && !lease.isActive()) {
      activeConnection?.close(lease.status());
      return;
    }
    debug("wallet-message", event.data?.type);
    if (resuming && event.data?.type === "ai-auth/session-resumed") {
      if (!(await validResumeResponse(event.data))) {
        failResume("The saved session could not be re-verified");
        return;
      }
      finishResume();
      return;
    }
    if (
      resuming &&
      (event.data?.type === "ai-auth/session-ended" ||
        event.data?.type === "ai-auth/session-resume-failed")
    ) {
      failResume("The wallet no longer holds this session");
      return;
    }
    if (event.data?.type === "ai-auth/wallet-setup") {
      // The wallet is creating a key instead of asking for approval. Keep a
      // bounded timeout armed so abandoning wallet creation still rejects the
      // ready promise instead of waiting forever.
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        cleanup();
        rejectReady(new Error(approvalTimeoutMessage(timeoutMs)));
      }, timeoutMs);
      return;
    }
    if (event.data?.type === "ai-auth/connect-ready") {
      if (resuming) {
        clearTimeout(timeout);
        popup.postMessage(
          {
            type: "ai-auth/session-resume",
            sessionId: currentRecord.sessionId,
            walletId: currentRecord.walletId,
            // Public, signed data only: the wallet re-verifies this envelope
            // against its own key before it agrees to resume.
            consent: currentRecord.consent,
            audience: origin,
            room,
            capabilities: [...currentRecord.capabilities],
            lastActivity: currentRecord.lastActivity,
          },
          walletPage.origin,
        );
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(
          () => failResume("The wallet did not confirm the saved session"),
          resumeTimeoutMs,
        );
        return;
      }
      if (consent) return;
      request = await createPermissionRequest(origin, capabilities, {
        room,
        expiresInMs: 120_000,
        ...sessionOptions,
      });
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        cleanup();
        rejectReady(new Error(approvalTimeoutMessage(timeoutMs)));
      }, timeoutMs);
      popup.postMessage(
        { type: "ai-auth/connect-request", request },
        walletPage.origin,
      );
      return;
    }
    if (
      event.data?.type === "ai-auth/room-ready" &&
      consent &&
      (event.data.requestNonce === request.nonce ||
        event.data.requestNonce === consent.body.payload.requestNonce) &&
      event.data.walletId === walletIdentity?.id &&
      typeof event.data.session === "string" &&
      event.data.session.length >= 8
    ) {
      walletSession = event.data.session;
      walletFeatures = {
        targets: event.data.features?.targets === true,
        receipts: event.data.features?.receipts === true,
      };
      for (const listener of roomReadyListeners) {
        try {
          listener(walletSession);
        } catch {}
      }
      roomReadyListeners.clear();
      return;
    }
    if (event.data?.type === "ai-auth/connect-rejected") {
      cleanup();
      rejectReady(new Error("The wallet declined this site request"));
      return;
    }
    if (event.data?.type === "ai-auth/connect-consent" && !consent) {
      const candidate = event.data.consent;
      const expectedWallet = candidate?.body?.issuer;
      const valid = await verifyPermissionConsent(candidate, request, {
        expectedOrigin: origin,
        expectedWallet,
        nonceGuard: consentGuard,
      });
      if (!valid) {
        cleanup();
        rejectReady(new Error("The wallet consent could not be verified"));
        return;
      }
      const agent = await verifyConsentAgent(candidate, request, {
        expectedOrigin: origin,
        expectedWallet,
      });
      if (!agent.ok) {
        cleanup();
        rejectReady(new Error("The wallet agent descriptor was invalid"));
        return;
      }
      participant = agent.participant;
      cloneDiagnostics = participant
        ? cloneDetector.observe({
            walletId: participant.identity.id,
            instanceId: participant.instanceId,
            sessionId: participant.sessionId,
            expiresAt: candidate.body.payload.expiresAt,
          })
        : Object.freeze([]);
      consent = candidate;
      lease = new SessionLease(consent.body.payload);
      walletIdentity = verifiedWalletIdentity(event.data.wallet, consent);
      if (store) {
        currentRecord = recordFromConsent(candidate, {
          origin,
          room,
          participant,
        });
        agentKey = currentRecord.agentKey;
        void store.save(origin, currentRecord);
      }
      hideDialog();
      clearTimeout(timeout);
      timeout = undefined;
      resolveReady(createConnection());
      return;
    }
    if (consent && event.data?.type === "ai-auth/session-ended") {
      // The wallet user ended the session or the wallet timed it out.
      const reason = event.data.reason;
      activeConnection?.close(
        reason === "idle" ? "idle" : reason === "ended" ? "revoked" : "expired",
      );
      return;
    }
    if (
      consent &&
      pendingRenewal &&
      event.data?.type === "ai-auth/renew-rejected" &&
      event.data.requestNonce === pendingRenewal.request.nonce
    ) {
      const renewal = pendingRenewal;
      pendingRenewal = null;
      clearTimeout(renewal.timer);
      hideDialog();
      renewal.reject(
        keptSessionError(
          "renewal-declined",
          consent.body.payload.expiresAt,
          "The wallet declined to extend. ",
        ),
      );
      return;
    }
    if (
      consent &&
      pendingRenewal &&
      event.data?.type === "ai-auth/renew-consent" &&
      event.data.requestNonce === pendingRenewal.request.nonce
    ) {
      const renewal = pendingRenewal;
      pendingRenewal = null;
      clearTimeout(renewal.timer);
      const candidate = event.data.consent;
      const valid = await verifyPermissionConsent(candidate, renewal.request, {
        expectedOrigin: origin,
        expectedWallet: consent.body.issuer,
        nonceGuard: consentGuard,
        previousConsent: consent,
      });
      hideDialog();
      if (
        !valid ||
        !lease?.isActive() ||
        !lease.renew(candidate.body.payload)
      ) {
        renewal.reject(new Error("The wallet renewal could not be verified"));
        return;
      }
      consent = candidate;
      if (store && currentRecord) {
        currentRecord = {
          ...currentRecord,
          consent: candidate,
          expiresAt: candidate.body.payload.expiresAt,
          idleTimeoutMs: candidate.body.payload.idleTimeoutMs ?? null,
          capabilities: [...candidate.body.payload.capabilities],
          lastActivity: Date.now(),
        };
        void store.save(origin, currentRecord);
      }
      renewVerifiedPageConnection(activeConnection, consent);
      scheduleExpiry();
      onRenewed();
      renewal.resolve();
      return;
    }
    if (consent && event.data?.type === "ai-auth/transfer-result") {
      const pending = pendingTransfers.get(event.data.id);
      if (pending) {
        pendingTransfers.delete(event.data.id);
        clearTimeout(pending.timer);
        if (event.data.error)
          pending.reject(new Error(String(event.data.error)));
        else pending.resolve();
      }
      return;
    }
    if (consent && event.data?.type === "ai-auth/transfer-event") {
      let transfer = event.data.transfer;
      if (transfer?.type === "receipt") {
        const receipt = walletFeatures.receipts
          ? boundedReceipt(transfer.receipt, walletIdentity?.id)
          : null;
        if (!receipt) return;
        for (const listener of transferListeners) {
          try {
            listener({ type: "receipt", receipt });
          } catch {}
        }
        return;
      }
      const capability =
        transfer?.type === "text" ? "messages.send" : "content.share";
      if (
        !["text", "element", "attachment"].includes(transfer?.type) ||
        !consent.body.payload.capabilities.includes(capability)
      )
        return;
      lease?.touch();
      for (const listener of transferListeners) {
        try {
          listener(transfer);
        } catch {}
      }
      return;
    }
    if (event.data?.type !== "ai-auth/collaboration-event" || !consent) return;
    const envelope = event.data.envelope;
    debug("sdk-collaboration-envelope", envelope?.body?.type);
    const capability = CAPABILITY_FOR_EVENT[envelope?.body?.type];
    if (
      !capability ||
      !consent.body.payload.capabilities.includes(capability)
    ) {
      debug("sdk-rejected-capability", capability);
      return;
    }
    const payload = envelope?.body?.payload;
    if (
      payload?.origin !== origin ||
      payload?.room !== (request.room ?? "default") ||
      typeof payload.session !== "string" ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length < 20 ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt > Date.now() + 125_000
    )
      return;
    if (
      envelope.body.type === "presence/cursor" &&
      !parseCursorPayload(payload).ok
    )
      return;
    if (
      ["message/text", "collab/text"].includes(envelope.body.type) &&
      (typeof payload.text !== "string" ||
        payload.text.length > MAX_MESSAGE_CHARS)
    )
      return;
    if (
      envelope.body.type === "agent/action" &&
      ["tool-request", "tool-cancel"].includes(payload?.kind) &&
      (payload.targetWallet !== walletIdentity?.id ||
        payload.targetNonce !== request.nonce ||
        payload.targetSession !== walletSession ||
        typeof payload.requestId !== "string" ||
        !/^[A-Za-z0-9_-]{8,80}$/u.test(payload.requestId) ||
        (payload.kind === "tool-request" &&
          (typeof payload.name !== "string" ||
            !/^[a-z][a-z0-9._-]{0,63}$/u.test(payload.name) ||
            payload.input === null ||
            typeof payload.input !== "object" ||
            Array.isArray(payload.input) ||
            (() => {
              try {
                return (
                  new TextEncoder().encode(JSON.stringify(payload.input))
                    .byteLength > 8_192
                );
              } catch {
                return true;
              }
            })())))
    )
      return;
    if (
      envelope.body.type === "agent/action" &&
      !TOOL_EVENT_KINDS.has(payload?.kind) &&
      (typeof payload.name !== "string" ||
        !/^[a-z][a-z0-9._-]{0,63}$/u.test(payload.name) ||
        ![
          "started",
          "progress",
          "completed",
          "failed",
          "cancelled",
          "needs-human",
        ].includes(payload.state) ||
        typeof payload.summary !== "string" ||
        payload.summary.length > 240)
    )
      return;
    const replayKey = `${envelope.body.issuer}:${payload.session}:${payload.nonce}`;
    for (const [key, expiresAt] of seen)
      if (expiresAt <= Date.now()) seen.delete(key);
    if (seen.has(replayKey) || seen.size >= 4096) return;
    if (!(await verifyEnvelope(envelope))) {
      debug("sdk-rejected-signature", envelope?.body?.type);
      return;
    }
    seen.set(replayKey, payload.expiresAt);
    // A remote tool request is a protected operation. With a participation
    // policy it must pass the fail-closed check at the moment it arrives, so
    // a revoked identity, stale epoch or lapsed grant never reaches a listener.
    if (
      participation &&
      envelope.body.type === "agent/action" &&
      payload.kind === "tool-request" &&
      !authorizeProtected({
        policy: participation.policy,
        walletId: envelope.body.issuer,
        scope: "tools.invoke",
        now: participation.now,
      }).allow
    ) {
      debug("sdk-rejected-unauthorized-tool-request", envelope.body.issuer);
      return;
    }
    // Passive presence traffic must not keep an idle session alive.
    if (!PASSIVE_EVENT_TYPES.has(envelope.body.type)) lease?.touch();
    debug("sdk-event-accepted", envelope.body.type);
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch {
        // An application listener cannot block other collaboration listeners.
      }
    }
  };

  function createConnection() {
    let closed = false;
    const lifecycleListeners = new Set();
    const connectedEvent = () => ({
      type: "connected",
      label: walletIdentity?.name ?? shortIssuerLabel(walletIdentity?.id),
      identity: walletIdentity,
      participant,
      diagnostics: cloneDiagnostics,
      capabilities: Object.freeze([...consent.body.payload.capabilities]),
      expiresAt: consent.body.payload.expiresAt,
      idleTimeoutMs: consent.body.payload.idleTimeoutMs ?? null,
    });
    onRenewed = () =>
      notifyLifecycle({
        ...connectedEvent(),
        type: "renewed",
      });
    // An expired, idle or revoked session closes the connection before any
    // authorized publish, receive or transfer proceeds.
    const guardActive = () => {
      if (closed) return false;
      const status = lease.status();
      if (status !== "active") {
        connection.close(status);
        return false;
      }
      return true;
    };
    const notifyLifecycle = (event) => {
      for (const listener of lifecycleListeners) {
        try {
          listener(event);
        } catch {}
      }
    };
    function sendTransfer(method, args, capability) {
      if (!guardActive())
        return Promise.reject(new Error("The AI Auth connection is closed"));
      if (!consent.body.payload.capabilities.includes(capability))
        return Promise.reject(
          new Error("This wallet did not approve this capability"),
        );
      recordActivity();
      const id = String(++transferSequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingTransfers.delete(id);
          reject(new Error("Wallet transfer timed out"));
        }, 180_000);
        pendingTransfers.set(id, { resolve, reject, timer });
        popup.postMessage(
          { type: "ai-auth/transfer-request", id, method, args },
          walletPage.origin,
        );
      });
    }
    function sendAddressed(method, args, options, capability, attachment) {
      let addressing;
      try {
        addressing = boundedAddressing(options, { attachment });
        if (addressing.target !== undefined && !walletFeatures.targets)
          throw new Error("This wallet cannot deliver targeted messages");
      } catch (error) {
        return Promise.reject(error);
      }
      return sendTransfer(method, [...args, addressing], capability);
    }
    const transfers = Object.freeze({
      // Targets and message ids travel to the wallet, which signs them into
      // the payload. They are validated and bounded here first.
      sendText: (text, options) =>
        sendAddressed("sendText", [text], options, "messages.send"),
      sendElement: (metadata, options) =>
        sendAddressed("sendElement", [metadata], options, "content.share"),
      sendAttachment: (blob, options) =>
        sendAddressed("sendAttachment", [blob], options, "content.share", true),
      get supportsTargets() {
        return walletFeatures.targets;
      },
      get supportsReceipts() {
        return walletFeatures.receipts;
      },
      subscribe(listener) {
        if (typeof listener !== "function")
          throw new TypeError("A transfer listener function is required");
        if (closed) return () => {};
        transferListeners.add(listener);
        return () => transferListeners.delete(listener);
      },
      close() {
        transferListeners.clear();
      },
    });
    const connection = Object.freeze({
      transfers,
      // Read by the collaboration wheel before it offers targets or receipts.
      get supportsTargets() {
        return walletFeatures.targets;
      },
      get supportsReceipts() {
        return walletFeatures.receipts;
      },
      request,
      get consent() {
        return consent;
      },
      get expiresAt() {
        return consent.body.payload.expiresAt;
      },
      get idleTimeoutMs() {
        return consent.body.payload.idleTimeoutMs ?? null;
      },
      /**
       * Ask the wallet to renew this session. The wallet user must approve
       * again; renewal can only keep or narrow the approved capabilities.
       */
      renew() {
        if (!guardActive())
          return Promise.reject(
            new Error("The session is no longer active; connect again"),
          );
        if (pendingRenewal) return pendingRenewal.promise;
        return (async () => {
          const renewalRequest = await createPermissionRequest(
            origin,
            consent.body.payload.capabilities,
            {
              room,
              expiresInMs: 120_000,
              ...sessionOptions,
              renews: consent.body.payload.requestNonce,
            },
          );
          if (closed || pendingRenewal)
            throw new Error("The AI Auth connection is closed");
          const renewal = { request: renewalRequest };
          renewal.promise = new Promise((resolve, reject) => {
            renewal.resolve = resolve;
            renewal.reject = reject;
          });
          renewal.timer = setTimeout(() => {
            if (pendingRenewal !== renewal) return;
            pendingRenewal = null;
            hideDialog();
            renewal.reject(
              keptSessionError(
                "renewal-timed-out",
                consent.body.payload.expiresAt,
                "The approval window closed. ",
              ),
            );
          }, timeoutMs);
          pendingRenewal = renewal;
          dialog.style.display = "";
          dialog.showModal();
          popup.postMessage(
            { type: "ai-auth/renew-request", request: renewalRequest },
            walletPage.origin,
          );
          return renewal.promise;
        })();
      },
      identity: walletIdentity,
      /** Verified identity plus the agent's self-declared claims, or null. */
      participant,
      /**
       * The participation policy this connection enforces (or null), with the
       * fail-closed check bound to it, for tool layers that gate execution.
       */
      participation: participation
        ? Object.freeze({
            policy: participation.policy,
            authorizeProtected: (walletId, scope = "tools.invoke") =>
              authorizeProtected({
                policy: participation.policy,
                walletId,
                scope,
                now: participation.now,
              }),
          })
        : null,
      capabilities: Object.freeze([...consent.body.payload.capabilities]),
      onLifecycle(listener) {
        if (typeof listener !== "function")
          throw new TypeError("A lifecycle listener function is required");
        if (closed) {
          listener({
            type: "disconnected",
            reason: closedReason || "closed",
          });
          return () => {};
        }
        lifecycleListeners.add(listener);
        // A verified page connection only exists after signed consent, so the
        // connected lifecycle event fires immediately on subscription.
        listener(connectedEvent());
        return () => lifecycleListeners.delete(listener);
      },
      onDisconnect(listener) {
        if (typeof listener !== "function")
          throw new TypeError("A disconnect listener function is required");
        if (closed) {
          listener();
          return () => {};
        }
        disconnectListeners.add(listener);
        return () => disconnectListeners.delete(listener);
      },
      onEvent(listener) {
        if (typeof listener !== "function")
          throw new TypeError("An event listener function is required");
        if (!guardActive()) return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get walletSession() {
        return walletSession;
      },
      onRoomReady(listener) {
        if (typeof listener !== "function")
          throw new TypeError("A room-ready listener function is required");
        if (walletSession) {
          listener(walletSession);
          return () => {};
        }
        if (closed) return () => {};
        roomReadyListeners.add(listener);
        return () => roomReadyListeners.delete(listener);
      },
      publishAgentEvent(agentEvent) {
        if (!guardActive()) throw new Error("The AI Auth connection is closed");
        if (!consent.body.payload.capabilities.includes("tools.invoke"))
          throw new Error("This wallet did not approve tool invocation");
        if (
          !agentEvent ||
          !TOOL_EVENT_KINDS.has(agentEvent.kind) ||
          new TextEncoder().encode(JSON.stringify(agentEvent)).byteLength >
            8_192
        )
          throw new TypeError("The shared agent event is invalid or too large");
        recordActivity();
        popup.postMessage(
          { type: "ai-auth/site-agent-event", event: agentEvent },
          walletPage.origin,
        );
      },
      publishAction({ name, state, summary }) {
        if (!guardActive()) throw new Error("The AI Auth connection is closed");
        if (!consent.body.payload.capabilities.includes("tools.invoke"))
          throw new Error("This wallet did not approve site action sharing");
        if (
          typeof name !== "string" ||
          !/^[a-z][a-z0-9._-]{0,63}$/u.test(name) ||
          ![
            "started",
            "progress",
            "completed",
            "failed",
            "cancelled",
            "needs-human",
          ].includes(state) ||
          typeof summary !== "string" ||
          summary.length > 240
        )
          throw new TypeError(
            "Site action events need a valid name, state, and short summary",
          );
        recordActivity();
        popup.postMessage(
          { type: "ai-auth/site-action", action: { name, state, summary } },
          walletPage.origin,
        );
      },
      publishCursor({ x, y, visible = true, scroll }) {
        if (!guardActive()) return;
        if (!consent.body.payload.capabilities.includes("presence.read"))
          return;
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          x > 1 ||
          y < 0 ||
          y > 1
        )
          return;
        if (
          scroll !== undefined &&
          (!Number.isFinite(scroll) || scroll < 0 || scroll > 1)
        )
          return;
        recordActivity();
        popup.postMessage(
          {
            type: "ai-auth/site-cursor",
            cursor: {
              x,
              y,
              visible,
              ...(scroll === undefined ? {} : { scroll }),
            },
          },
          walletPage.origin,
        );
      },
      close(reason = "closed") {
        if (closed) return;
        // Withdraw the site's WebMCP catalog while the signed connection is
        // still usable. Peers drop its tools at once instead of waiting for
        // expiry or inferring from a later absence.
        try {
          if (connection.capabilities.includes("tools.invoke"))
            connection.publishAgentEvent({ kind: "tool-catalog", tools: [] });
        } catch {
          /* the provider is already gone; expiry still bounds the catalog */
        }
        closed = true;
        closedReason = ["expired", "idle", "revoked"].includes(reason)
          ? reason
          : "closed";
        // A site-initiated disconnect must revoke at the wallet too: the signed
        // consent is a bearer token, so keeping it resumable at the wallet would
        // let a later explicit resume revive a session the site already ended.
        const endedPosted =
          ["closed", "revoked"].includes(closedReason) && !!popup;
        if (endedPosted)
          popup.postMessage(
            { type: "ai-auth/session-ended", reason: "ended" },
            walletPage.origin,
          );
        // Deleting only this agent's record leaves every other agent's record
        // in the same browser untouched.
        if (store && agentKey) store.remove(origin, agentKey);
        lease?.revoke();
        revokeVerifiedPageConnection(connection);
        // Everything above (and everything below) keeps its current order and
        // timing. Only the dialog/iframe teardown and the message listener are
        // deferred, and only when session-ended was actually posted.
        cleanup({ deferFrame: endedPosted });
        listeners.clear();
        roomReadyListeners.clear();
        transferListeners.clear();
        for (const pending of pendingTransfers.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("The AI Auth connection is closed"));
        }
        pendingTransfers.clear();
        for (const listener of disconnectListeners) {
          try {
            listener();
          } catch {}
        }
        disconnectListeners.clear();
        notifyLifecycle({ type: "disconnected", reason: closedReason });
        lifecycleListeners.clear();
      },
    });
    activeConnection = connection;
    markVerifiedPageConnection(connection, consent);
    scheduleExpiry();
    return connection;
  }

  windowObject.addEventListener("message", onMessage);
  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("close", onDialogClose);
  cancelButton.addEventListener("click", onCancel);
  dialog.showModal();
  timeout = setTimeout(() => {
    cleanup();
    rejectReady(new Error(approvalTimeoutMessage(timeoutMs)));
  }, timeoutMs);
  frame.src = walletPage.href;
  return ready;
}

// Kept as an API alias for existing integrations; this now opens a modal.
export const connectAIAuthPopup = connectAIAuthModal;

/**
 * Explicit resume, called only after the visitor clicks a Resume action.
 * Returns null when there is no valid record so the site can show its normal
 * Connect button. A wallet that cannot confirm makes the promise reject and
 * drops that agent's record; it never starts a fresh approval silently.
 */
export async function resumeAIAuthSession(options = {}) {
  // Match connectAIAuthModal's default so a site can pass the same options.
  const origin = options.origin ?? globalThis.location?.origin;
  // A caller-supplied record is trusted only for this site. Without this check
  // a foreign or tampered record would start a handshake and disclose consent
  // before the wallet has a chance to reject it.
  if (options.record && options.record.audience !== origin)
    throw new TypeError(
      "The supplied session record belongs to another origin",
    );
  const store =
    options.sessionStore ??
    (options.storage || globalThis.localStorage
      ? createSessionStore({ storage: options.storage })
      : null);
  if (!store) return null;
  const records = options.record
    ? [options.record]
    : await listResumableSessions(store, {
        origin,
        room: options.room,
        capabilities: options.capabilities,
        now: options.now,
      });
  if (records.length === 0) return null;
  return connectAIAuthModal({
    ...options,
    origin,
    sessionStore: store,
    resumeRecord: records[0],
  });
}

// A stable colour per verified issuer. The wallet id is hashed to a hue and
// drawn at a mid lightness with a white outline, so it reads on light and dark
// pages alike; a peer can never supply its own colour.
function issuerHue(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

function normalizePageKey(key) {
  if (key === null || key === undefined) return null;
  const path = String(key).split(/[?#]/u, 1)[0];
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

function createCursorNode(document) {
  const node = document.createElement("div");
  node.className = "cursor";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of [
    ["width", "18"],
    ["height", "22"],
    ["viewBox", "0 0 18 22"],
    ["aria-hidden", "true"],
  ])
    icon.setAttribute(name, value);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("stroke", "white");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("d", "M1 1v17l4.5-4.5 3.3 6.1 3-1.6-3.1-6.1h6.1z");
  icon.append(path);
  const label = document.createElement("span");
  label.className = "label";
  node.append(icon, label);
  return { node, path, label };
}

export function mountAIAuthCollaboration(
  connection,
  { target = globalThis.document?.body, pageKey } = {},
) {
  if (!connection || typeof connection.onEvent !== "function")
    throw new TypeError("A connected AI Auth page session is required");
  if (!target || !target.ownerDocument)
    throw new TypeError("A page element is required for collaboration cursors");
  const document = target.ownerDocument;
  const viewerPage = normalizePageKey(
    pageKey ?? globalThis.location?.pathname ?? null,
  );
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;pointer-events:none;overflow:hidden";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .cursor { position:absolute; transform:translate(-2px,-2px); color:#fff; transition:opacity .2s ease; }
    .cursor svg { display:block; filter:drop-shadow(0 1px 2px #0008); }
    .label { display:block; margin:2px 0 0 10px; padding:3px 7px; border-radius:4px; color:#fff; font:12px/1.3 system-ui,sans-serif; white-space:nowrap; }
  `;
  const layer = document.createElement("div");
  shadow.append(style, layer);
  target.append(host);
  const cursors = new Map();
  const place = (node, cursor) => {
    const docEl = document.documentElement;
    const width = docEl?.scrollWidth ?? docEl?.clientWidth ?? 1;
    const height = docEl?.scrollHeight ?? docEl?.clientHeight ?? 1;
    const scrollX = globalThis.scrollX ?? docEl?.scrollLeft ?? 0;
    const scrollY = globalThis.scrollY ?? docEl?.scrollTop ?? 0;
    node.style.left = `${(cursor.x / MAX_COORDINATE) * width - scrollX}px`;
    node.style.top = `${(cursor.y / MAX_COORDINATE) * height - scrollY}px`;
  };
  const show = (key, issuer, cursor) => {
    if (cursor.pageKey !== null && cursor.pageKey !== viewerPage) {
      const old = cursors.get(key);
      if (old) {
        old.node.remove();
        cursors.delete(key);
      }
      return;
    }
    let entry = cursors.get(key);
    if (!entry) {
      entry = createCursorNode(document);
      cursors.set(key, entry);
      layer.append(entry.node);
    }
    const color = `hsl(${issuerHue(issuer)} 72% 42%)`;
    entry.path.setAttribute("fill", color);
    entry.label.style.background = color;
    entry.label.textContent = String(cursor.label ?? "Agent").slice(0, 60);
    entry.node.style.opacity = cursor.visible === false ? "0.35" : "1";
    entry.seenAt = Date.now();
    place(entry.node, cursor);
  };
  const fadeIdle = () => {
    const now = Date.now();
    for (const entry of cursors.values())
      if (now - entry.seenAt > OFFLINE_AFTER_MS)
        entry.node.style.opacity = "0.35";
  };
  const idleTimer = setInterval(fadeIdle, 2_000);
  idleTimer.unref?.();
  const unsubscribe = connection.onEvent((envelope) => {
    if (envelope.body.type !== "presence/cursor") return;
    const parsed = parseCursorPayload(envelope.body.payload);
    if (!parsed.ok) return;
    const session = envelope.body.payload.session ?? "default";
    show(
      `${envelope.body.issuer}:${session}`,
      envelope.body.issuer,
      parsed.cursor,
    );
  });

  let lastSentAt = 0;
  let lastX = 0;
  let lastY = 0;
  // Scroll and pointer share one throttle so page activity produces at most
  // one signed presence event per interval. Only normalized coordinates and a
  // scroll fraction leave the page; never text, form values, or element data.
  const scrollFraction = () => {
    const docEl = document.documentElement;
    const max = Math.max(
      1,
      (docEl?.scrollHeight ?? 0) - (docEl?.clientHeight ?? 0),
    );
    const position = globalThis.scrollY ?? docEl?.scrollTop ?? 0;
    return Math.max(0, Math.min(1, position / max));
  };
  const publishPresence = (x, y, visible, scroll) => {
    const now = Date.now();
    if (now - lastSentAt < 450) return;
    lastSentAt = now;
    connection.publishCursor({ x, y, visible, scroll });
  };
  const fraction = (client, size, scroll) =>
    Math.max(0, Math.min(1, (client + scroll) / Math.max(1, size)));
  const publish = (event) => {
    const docEl = document.documentElement;
    lastX = fraction(
      event.clientX,
      docEl?.clientWidth ?? 0,
      globalThis.scrollX ?? 0,
    );
    lastY = fraction(
      event.clientY,
      docEl?.clientHeight ?? 0,
      globalThis.scrollY ?? 0,
    );
    publishPresence(lastX, lastY, true, scrollFraction());
  };
  const publishScroll = () =>
    publishPresence(lastX, lastY, true, scrollFraction());
  const leave = () =>
    connection.publishCursor({
      x: lastX,
      y: lastY,
      visible: false,
      scroll: scrollFraction(),
    });
  target.addEventListener("pointermove", publish, { passive: true });
  target.addEventListener("pointerleave", leave);
  // Viewport scroll fires on document, not on body: capture it there so the
  // signed scroll fraction is actually published.
  document.addEventListener("scroll", publishScroll, {
    passive: true,
    capture: true,
  });

  return () => {
    unsubscribe();
    clearInterval(idleTimer);
    target.removeEventListener("pointermove", publish);
    target.removeEventListener("pointerleave", leave);
    document.removeEventListener("scroll", publishScroll, { capture: true });
    host.remove();
  };
}
