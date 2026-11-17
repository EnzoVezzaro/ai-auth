import test from "node:test";
import assert from "node:assert/strict";
import { resolveApproval, renderPreview, ApprovalError } from "../approval.js";

const requested = ["messages.send", "presence.read", "tools.invoke"];
const base = {
  requested,
  interactive: false,
  ask: async () => assert.fail("must not prompt"),
};

test("non-interactive without --approve refuses", async () => {
  await assert.rejects(
    resolveApproval({ ...base, approve: null }),
    (e) => e instanceof ApprovalError && /refus/i.test(e.message),
  );
});

test("--approve with an exact subset is granted, sorted and de-duplicated by validation", async () => {
  assert.deepEqual(
    await resolveApproval({
      ...base,
      approve: ["presence.read", "messages.send"],
    }),
    ["messages.send", "presence.read"],
  );
});

test("--approve can never escalate beyond what was requested", async () => {
  await assert.rejects(
    resolveApproval({ ...base, approve: ["presence.read", "admin.write"] }),
    /not requested|escalat/i,
  );
  await assert.rejects(
    resolveApproval({
      ...base,
      requested: ["presence.read"],
      approve: ["tools.invoke"],
    }),
    /not requested|escalat/i,
  );
});

test("wildcards, empty and duplicate scope lists are rejected", async () => {
  for (const approve of [
    ["*"],
    [],
    ["presence.read", "presence.read"],
    ["all"],
  ])
    await assert.rejects(resolveApproval({ ...base, approve }), ApprovalError);
});

test("interactive mode prompts and grants only a requested subset", async () => {
  const granted = await resolveApproval({
    requested,
    approve: null,
    interactive: true,
    ask: async () => "presence.read",
  });
  assert.deepEqual(granted, ["presence.read"]);
  await assert.rejects(
    resolveApproval({
      requested,
      approve: null,
      interactive: true,
      ask: async () => "tools.invoke,admin.write",
    }),
    /not requested/i,
  );
  await assert.rejects(
    resolveApproval({
      requested,
      approve: null,
      interactive: true,
      ask: async () => "",
    }),
    /denied|no capabilit/i,
  );
  assert.deepEqual(
    await resolveApproval({
      requested,
      approve: null,
      interactive: true,
      ask: async () => "all",
    }),
    requested,
  );
});

test("MCP-08: an invalid interactive scope re-prompts instead of exiting", async () => {
  const prompts = [];
  const answers = ["presnce.read", "all"];
  const granted = await resolveApproval({
    requested,
    approve: null,
    interactive: true,
    ask: async (_requested, error) => {
      prompts.push(error?.message ?? null);
      return answers.shift();
    },
  });
  assert.deepEqual(granted, requested);
  assert.equal(prompts.length, 2, "a second prompt was shown");
  assert.match(String(prompts[1]), /not requested|escalat/iu);
  await assert.rejects(
    resolveApproval({
      requested,
      approve: null,
      interactive: true,
      ask: async () => "",
    }),
    /denied|no capabilit/iu,
  );
});

test("preview lists origin, room, wallet and every scope with a plain meaning", () => {
  const text = renderPreview({
    origin: "https://site.example",
    room: "lobby",
    walletId: "agent:abc",
    requested,
    source: "url",
  });
  for (const needle of [
    "https://site.example",
    "lobby",
    "agent:abc",
    "tools.invoke",
    "messages.send",
    "discovery",
  ])
    assert.ok(text.includes(needle), needle);
});
