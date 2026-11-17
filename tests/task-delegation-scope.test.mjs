import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCOVERY_CAPABILITIES,
  validateDiscovery,
} from "../packages/p2p/discovery.js";
import { capabilityCopy } from "../packages/p2p/copy.js";
import { renderPreview } from "../packages/mcp/approval.js";
import { appSource } from "./helpers/app-source.mjs";

const ORIGIN = "https://site.example";

test("CT-06: task delegation is not a default request choice", () => {
  assert.equal(
    DISCOVERY_CAPABILITIES.includes("tasks.delegate"),
    false,
    "discovery does not offer a scope with no protocol behind it",
  );
});

test("CT-06: an explicitly requested tasks.delegate scope is still accepted", () => {
  const result = validateDiscovery(
    {
      type: "ai-auth-discovery",
      v: 1,
      origin: ORIGIN,
      capabilities: ["tasks.delegate"],
    },
    { origin: ORIGIN },
  );
  assert.equal(result.ok, true, "sites that ask for it are not rejected");
});

test("CT-06: the wallet no longer advertises task handoff as a default choice", async () => {
  const source = await appSource();
  const start = source.indexOf("const capabilityOptions =");
  const end = source.indexOf("].map(", start);
  const block = source.slice(start, end);
  assert.ok(block.length > 0, "the default capability list is present");
  assert.doesNotMatch(block, /tasks\.delegate/u);
});

test("CT-06: consent copy no longer promises task handoff", () => {
  const copy = capabilityCopy("tasks.delegate");
  assert.notEqual(copy.title, "Hand off a task");
  assert.equal(/take over one limited task/u.test(copy.detail), false);
});

test("CT-13: the CLI preview explains tasks.delegate instead of calling it site-defined", () => {
  const preview = renderPreview({
    origin: ORIGIN,
    room: "research",
    walletId: "agent:me",
    requested: ["tasks.delegate"],
    source: "discovery",
  });
  assert.match(preview, /tasks\.delegate: /u);
  assert.doesNotMatch(preview, /tasks\.delegate: site-defined operation/u);
  assert.match(preview, /delegat|handoff|task protocol/iu);
});
