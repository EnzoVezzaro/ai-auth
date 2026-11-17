import assert from "node:assert/strict";
import test from "node:test";
import { COLLABORATION_LIMITS } from "../packages/p2p/collaboration.js";
import { WHEEL_MARKUP } from "../packages/p2p/wheel-ui.js";
import { buildAgentActions } from "../packages/mcp/bridge.js";

test("one message length cap governs the SDK, MCP schema and wheel input", () => {
  const cap = COLLABORATION_LIMITS.textCharacters;
  const actions = buildAgentActions({
    getBridge: () => ({}),
    siteCapabilities: ["messages.send"],
  });
  const send = actions.find((action) => action.name === "ai_auth_send");
  assert.equal(
    send.inputSchema.text.safeParse("x".repeat(cap)).success,
    true,
    "ai_auth_send must accept every message the SDK accepts",
  );
  assert.equal(
    send.inputSchema.text.safeParse("x".repeat(cap + 1)).success,
    false,
    "and reject one character beyond the shared cap",
  );
  assert.match(
    WHEEL_MARKUP,
    new RegExp(`maxlength="${cap}"`, "u"),
    "the wheel input must use the shared cap",
  );
});
