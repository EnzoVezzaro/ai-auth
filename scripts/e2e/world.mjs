// Shared scenario state and small assertion helpers.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NetworkFailure } from "./report.mjs";
import { waitFor } from "./helpers.mjs";

export const CAPS = [
  "presence.read",
  "messages.send",
  "content.share",
  "tools.invoke",
];
export const roomName = () => `body4ai-e2e-${randomBytes(6).toString("hex")}`;

export function config(w, extra = {}) {
  return {
    room: w.room,
    restricted: true,
    issuer: w.authority.issuerJwk,
    ...extra,
  };
}

/** Distinguishes "the network blocked us" from "the product is wrong". */
export async function networkAware(participants, fn) {
  try {
    return await fn();
  } catch (error) {
    for (const p of participants) {
      if (!p.page) continue;
      const diag = await p.page
        .evaluate(() => ({
          ice: window.__aiAuthIceDiagnostics ?? [],
          status: window.__b4a?.state.statusLog ?? [],
        }))
        .catch(() => null);
      const text = JSON.stringify(diag ?? {});
      if (/Direct ICE failed|Could not reach a Nostr relay/u.test(text))
        throw new NetworkFailure(
          `Network failure on ${p.name} (not a product failure): ${text.slice(0, 400)}`,
        );
    }
    throw error;
  }
}

export const cursorsOf = async (p) => (await p.snapshot()).cursors;

export async function expectEventually(check, message, timeout = 30_000) {
  return waitFor(check, { timeout, message });
}

export const hasEvent = (p, predicate, arg) =>
  p.get(`b4a.state.events.some(${predicate})`, arg);

export { assert };
