// Consistency checks for published docs and type declarations. These read the
// shipped text and compare version claims to the manifests and the public API
// list to a live import, so a doc cannot silently drift from the code again.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");
const json = async (path) => JSON.parse(await read(path));

const versions = {
  wallet: (await json("package.json")).version,
  agent: (await json("packages/agent/package.json")).version,
  mcp: (await json("packages/mcp/package.json")).version,
};

const tableVersion = (text, pkg) => {
  const row = text.split("\n").find((line) => line.includes(`| \`${pkg}\``));
  assert.ok(row, `no version table row for ${pkg}`);
  const cells = row.split("|").map((cell) => cell.trim());
  return cells.at(-2);
};

test("DTC-01/DTC-02: install tables track the checked-in manifests", async () => {
  const readme = await read("README.md");
  const guide = await read("docs/SDK_GUIDE.md");
  assert.equal(
    tableVersion(readme, "@enzovezzaro/ai-auth-wallet"),
    versions.wallet,
  );
  const packages = {
    wallet: "@enzovezzaro/ai-auth-wallet",
    agent: "@enzovezzaro/ai-auth-agent",
    mcp: "@enzovezzaro/ai-auth-mcp",
  };
  for (const [pkg, version] of Object.entries(versions))
    assert.equal(
      tableVersion(guide, packages[pkg]),
      version,
      `SDK_GUIDE version for ${pkg}`,
    );
});

test("DTC-03: session records are described as localStorage-backed", async () => {
  const guide = await read("docs/SDK_GUIDE.md");
  assert.match(guide, /stores a record in that origin's `localStorage`/u);
  assert.doesNotMatch(
    guide,
    /stores a record in that origin's `sessionStorage`/u,
  );
  for (const path of [
    "packages/p2p/index.d.ts",
    "packages/p2p/session-store.js",
  ]) {
    const text = await read(path);
    assert.doesNotMatch(
      text,
      /site's sessionStorage|sessionStorage-backed|sessionStorage-compatible backing/u,
      `${path} still claims sessionStorage`,
    );
  }
});

test("DTC-04: docs link to existing trackers, not IMPLEMENTATION_PLAN.md", async () => {
  for (const path of [
    "docs/SDK_GUIDE.md",
    "docs/archive/agent-collaboration-handoff.md",
  ]) {
    const text = await read(path);
    assert.doesNotMatch(text, /IMPLEMENTATION_PLAN\.md/u, path);
  }
  const guide = await read("docs/SDK_GUIDE.md");
  assert.match(
    guide,
    /Release status and remaining work are tracked in \[[^\]]+\]\((?:evidence\.md|\.\.\/CHANGELOG\.md)\)/u,
  );
});

test("DTC-05: TOOL_ERROR_CODES is declared and exported", async () => {
  const dts = await read("packages/p2p/index.d.ts");
  assert.match(dts, /export const TOOL_ERROR_CODES/u);
  const runtime = await import("../packages/p2p/index.js");
  assert.ok(runtime.TOOL_ERROR_CODES, "runtime does not export TOOL_ERROR_CODES");
});

test("DTC-06: BOUNDARIES export list matches the live runtime exports", async () => {
  const doc = await read("docs/BOUNDARIES.md");
  const section = doc.split("### `@enzovezzaro/ai-auth-wallet`")[1];
  assert.ok(section, "wallet export section missing");
  const block = section.split("```text")[1].split("```")[0];
  const listed = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z_$][\w$]*$/u.test(line))
    .sort();
  const actual = Object.keys(await import("../packages/p2p/index.js")).sort();
  assert.deepEqual(listed, actual, "exports listed in BOUNDARIES.md are stale");
  assert.match(
    section,
    new RegExp(`— ${actual.length} runtime exports`, "u"),
    "export count is stale",
  );
});

test("DTC-07: idle reset describes inbound vs local presence correctly", async () => {
  const security = await read("docs/SECURITY.md");
  assert.doesNotMatch(
    security,
    /local page's own cursor or scroll does \*\*not\*\* reset it/u,
  );
  assert.match(
    security,
    /local cursor or scroll publishing does call `lease\.touch\(\)`/u,
  );
  assert.match(
    security,
    /[Ii]nbound presence events \(including `presence\/cursor`\) do not/u,
  );
});

test("DTC-08: trust limits describe bounded catch-up and epoch propagation", async () => {
  const doc = await read("docs/explanation/trust-limits.md");
  assert.doesNotMatch(doc, /gets nothing retroactively/u);
  assert.doesNotMatch(
    doc,
    /Epoch bumps are local knowledge in this release; they are not gossiped/u,
  );
  assert.match(doc, /bounded `revocation\/sync` catch-up/u);
  assert.match(doc, /epoch announcements are propagated/u);
});

test("DTC-09: embed targeting is documented as feature-detected", async () => {
  const security = await read("docs/SECURITY.md");
  assert.doesNotMatch(security, /does not carry targets or message ids/u);
  assert.doesNotMatch(security, /cannot target a recipient or confirm receipts/u);
  assert.match(
    security,
    /validates, bounds and forwards `target` and `messageId` when the wallet reports support/u,
  );
});

test("DTC-10: the integration review does not pin the example to 0.6.2", async () => {
  const doc = await read("docs/GENERIC_INTEGRATION_REVIEW.md");
  assert.doesNotMatch(doc, /bundles `@enzovezzaro\/ai-auth-wallet@0\.6\.2`/u);
  assert.match(doc, /imports the published SDK \(no version pin\)/u);
  assert.match(doc, /0\.6\.2-era correction/u);
});

test("DTC-11: the /connect subpath declares all runtime exports", async () => {
  const dts = await read("packages/p2p/connect.d.ts");
  for (const name of [
    "CHALLENGE_MAX_MS",
    "CONSENT_VERSION",
    "MIN_SESSION_TTL_MS",
    "MAX_SESSION_TTL_MS",
    "DEFAULT_SESSION_TTL_MS",
    "DEFAULT_IDLE_TIMEOUT_MS",
    "sessionLimits",
    "SessionLease",
    "verifyConsentAgent",
  ])
    assert.match(dts, new RegExp(`\\b${name}\\b`, "u"), `missing ${name}`);
});

test("DTC-12: connect panel copy helpers are declared", async () => {
  const dts = await read("packages/p2p/index.d.ts");
  assert.match(dts, /export function connectPanelStatusText/u);
  assert.match(dts, /export function connectPanelButtonLabel/u);
});
