// The e2e "message received" helpers must compare the unique message text,
// not just the issuer: an earlier event from the same wallet must not satisfy
// a check for a later message. Mirrors Participant.get's real page.evaluate
// path (new Function over the site's window.__b4a state).
import assert from "node:assert/strict";
import test from "node:test";
import { gotText, hasTextMessage } from "../scripts/e2e/messages.mjs";

const issuer = "wallet-A";
const participant = (events) => ({
  get(expression, arg, arg2) {
    const b4a = { state: { events } };
    return Promise.resolve(
      new Function("b4a", "arg", "arg2", `return ${expression}`)(
        b4a,
        arg,
        arg2,
      ),
    );
  },
});

test("gotText ignores an earlier message from the same issuer", async () => {
  const p = participant([
    { type: "message/text", issuer, text: "a1 to a2" },
  ]);
  const result = await gotText(p, issuer, "the new reply");
  assert.equal(result, false, "stale text must not satisfy the check");
});

test("gotText matches the issuer and the exact text", async () => {
  const p = participant([
    { type: "message/text", issuer, text: "a1 to a2" },
    { type: "message/text", issuer, text: "the new reply" },
    { type: "message/text", issuer: "wallet-B", text: "the new reply" },
  ]);
  assert.equal(await gotText(p, issuer, "a1 to a2"), true);
  assert.equal(await gotText(p, issuer, "the new reply"), true);
  assert.equal(await gotText(p, issuer, "missing"), false);
});

test("hasTextMessage does the same content comparison", async () => {
  const p = participant([
    { type: "message/text", issuer, text: "a2 to a1" },
  ]);
  assert.equal(await hasTextMessage(p, issuer, "a2 to a1"), true);
  assert.equal(await hasTextMessage(p, issuer, "a1 to a2"), false);
});
