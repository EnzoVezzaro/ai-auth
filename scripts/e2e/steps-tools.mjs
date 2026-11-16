// Steps 10 and 11: BODY4AI WebMCP tools and mixed permissions.
import { assert, CAPS, expectEventually } from "./world.mjs";

const ids = (p) => p.get("b4a.state.catalogs.map((c) => c.wallet)");

export async function discover(p, host) {
  await expectEventually(
    async () => (await ids(p)).includes(host.walletId),
    `${p.name} to discover ${host.name}'s catalog`,
    90_000,
  );
}

export async function approveNext(host, decision = "approve") {
  const button = host.page.locator(`#${decision}-action`);
  await button.waitFor({ state: "visible", timeout: 20_000 });
  await button.click();
}

export async function step10(w, evidence) {
  const { ha, a1, a2 } = w.p;
  await Promise.all([discover(a1, ha), discover(a2, ha)]);
  const catalog = (await a1.snapshot()).catalogs.find(
    (c) => c.wallet === ha.walletId,
  );
  assert.deepEqual([...catalog.tools].sort(), [
    "catalog.search",
    "product.get",
    "wishlist.add",
  ]);
  evidence.tools = catalog.tools;
  // Restricted room: a member without an execution grant runs nothing, not
  // even a read-only tool, and gets an explicit refusal (no human prompt).
  const noGrant = await a1.call("callTool", {
    host: ha.walletId,
    name: "catalog.search",
    input: { query: "chair" },
    giveUpMs: 15_000,
  });
  assert.equal(noGrant.ok, undefined, "no execution grant, no run");
  assert.match(noGrant.error ?? "", /not authorized/u);
  assert.equal(await ha.get("b4a.state.executions.length"), 0);
  evidence.withoutGrant = noGrant.error;
  const grant = await w.authority.executionGrant(a1.walletId);
  assert.equal((await ha.call("admitGrant", a1.walletId, grant)).ok, true);
  const search = await a1.call("callTool", {
    host: ha.walletId,
    name: "catalog.search",
    input: { query: "chair" },
  });
  assert.equal(search.ok, true, search.error);
  assert.equal(search.result.results[0].id, "b4a-001");
  assert.equal(search.result.results[0].memberPrice, 995);
  assert.equal(await ha.get("b4a.state.wishlist.length"), 0);
  // Approve.
  const approved = a1.call("callTool", {
    host: ha.walletId,
    name: "wishlist.add",
    input: { productId: "b4a-001" },
  });
  await approveNext(ha, "approve");
  const done = await approved;
  assert.equal(done.ok, true, done.error);
  assert.equal(done.result.ok, true);
  assert.equal(await ha.get("b4a.state.wishlist.length"), 1);
  // Cancellation while the tool is genuinely running.
  const running = a1.call("callTool", {
    host: ha.walletId,
    name: "catalog.search",
    input: { query: "__wait_for_cancel__" },
    callId: "c1",
  });
  await expectEventually(
    () =>
      ha.get(
        "b4a.state.executions.some((e) => e.input.query === '__wait_for_cancel__')",
      ),
    "the cancellable call to start on the host",
  );
  await a1.call("abortCall", "c1");
  const cancelled = await running;
  assert.equal(cancelled.name, "AbortError");
  await expectEventually(
    () =>
      a2.get(
        "b4a.state.events.some((e) => e.type === 'agent/action' && e.name === 'catalog.search' && e.state === 'cancelled')",
      ),
    "a cancelled event on the room",
  );
  // Duplicate request id: two distinct signed requests, one execution.
  const req = {
    host: ha.walletId,
    name: "product.get",
    input: { productId: "b4a-dup" },
    requestId: "dup00000000000001",
  };
  await a1.call("rawToolRequest", req);
  await a1.call("rawToolRequest", req);
  await expectEventually(
    () =>
      ha.get(
        "b4a.state.executions.some((e) => e.input.productId === 'b4a-dup')",
      ),
    "the duplicated request to run once",
  );
  await a1.call("callTool", {
    host: ha.walletId,
    name: "product.get",
    input: { productId: "b4a-001" },
  });
  assert.equal(
    await ha.get(
      "b4a.state.executions.filter((e) => e.input.productId === 'b4a-dup').length",
    ),
    1,
  );
  evidence.duplicateExecutions = 1;
  evidence.cancelled = true;
  // Deny: the human says no. Nothing runs; the SDK reports it as a result.
  const denied = a1.call("callTool", {
    host: ha.walletId,
    name: "wishlist.add",
    input: { productId: "b4a-002" },
  });
  await approveNext(ha, "deny");
  const verdict = await denied;
  assert.equal(
    await ha.get("b4a.state.wishlist.length"),
    1,
    "denied call did not run",
  );
  evidence.denyObservation = verdict;
  evidence.hostDenials = await ha.get("b4a.state.denials");
  assert.equal(verdict.ok, undefined, "a denied call must not succeed");
  assert.match(
    verdict.error,
    /approval|denied/u,
    `deny must surface as a rejection, got: ${verdict.error}; host ${JSON.stringify(await ha.get("b4a.state.executions.slice(-3)"))}`,
  );
}

export async function step11(w, evidence) {
  const { ha, a2 } = w.p;
  // Agent 2's membership lacks tools.invoke even though it consented to it.
  const blocked = await a2.call("callTool", {
    host: ha.walletId,
    name: "wishlist.add",
    input: { productId: "b4a-001" },
    giveUpMs: 6_000,
  });
  assert.ok(blocked.error, "no tools.invoke scope: no success");
  assert.equal(
    await ha.get(
      "b4a.state.executions.filter((e) => e.requester === arg).length",
      a2.walletId,
    ),
    0,
  );
  evidence.withoutScope = blocked.error;
  // Upgrade Agent 2: the same call path now works, proving the scope was the cause.
  const upgraded = await w.authority.admit(a2.walletId, CAPS);
  await a2.call("admitMembership", upgraded);
  await expectEventually(
    async () => (await ha.call("authorize", a2.walletId, "tools.invoke")).can,
    "host to accept the upgraded membership",
    45_000,
  );
  const grant = await w.authority.executionGrant(a2.walletId);
  assert.equal((await ha.call("admitGrant", a2.walletId, grant)).ok, true);
  const ok = await a2.call("callTool", {
    host: ha.walletId,
    name: "catalog.search",
    input: { query: "desk" },
  });
  assert.equal(ok.ok, true, ok.error);
  evidence.afterUpgrade = "catalog.search ok";
}
