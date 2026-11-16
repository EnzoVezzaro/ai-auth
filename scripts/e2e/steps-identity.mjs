// Steps 1, 2, 3 and 5: identity, consent, session lifetime and site links.
import { assert, CAPS, config, expectEventually } from "./world.mjs";
import { Participant, newContext } from "./participants.mjs";

export async function bootAgents(w) {
  const { browser, serverA } = w;
  const make = async (key, name, kind, opts) => {
    const context = await newContext(browser, opts);
    w.contexts.push(context);
    w.p[key] = new Participant(
      name,
      context,
      serverA.siteUrl + "body4ai/",
      kind,
    );
    return w.p[key];
  };
  await make("ha", "Human A", "human", { capture: true });
  await make("hb", "Human B", "human");
  await make("a1", "Agent 1", "agent");
  await make("a2", "Agent 2", "agent");
  await make("a3", "Agent 3 (uninvited)", "agent");
  await make("probe", "Session probe", "agent", { clock: true });
}

export async function step1(w, evidence) {
  const { ha, hb, a1, a2, a3 } = w.p;
  const people = [
    [ha, "product.html", "Human A", { host: true }],
    [hb, "index.html", "Human B", { host: false }],
    [a1, "index.html", "Agent 1", {}],
    [a2, "index.html", "Agent 2", {}],
    [a3, "index.html", "Agent 3", { restricted: false }],
  ];
  const results = await Promise.all(
    people.map(async ([p, path, label, extra]) => {
      await p.open(path, config(w, { label, ...extra }));
      return p.identity(label);
    }),
  );
  for (const r of results)
    assert.equal(r.created, true, "wallet created on first connect");
  const ids = results.map((r) => r.walletId);
  const keys = results.map((r) => `${r.publicKey.x}.${r.publicKey.y}`);
  assert.equal(new Set(ids).size, ids.length, "wallet ids are distinct");
  assert.equal(new Set(keys).size, keys.length, "public keys are distinct");
  evidence.walletIds = Object.fromEntries(
    people.map(([p], i) => [p.name, ids[i]]),
  );
}

export async function admitMembers(w) {
  const { authority, p } = w;
  const grants = [
    [p.ha, CAPS],
    [p.hb, CAPS],
    [p.a1, CAPS],
    // Mixed permissions: Agent 2 starts without tools.invoke (step 11).
    [p.a2, ["presence.read", "messages.send"]],
  ];
  for (const [who, scopes] of grants) {
    const proof = await authority.admit(who.walletId, scopes);
    await who.call("admitMembership", proof);
  }
}

export async function step2(w, evidence) {
  const { a1, a2, ha } = w.p;
  const s1 = await a1.connect();
  assert.deepEqual([...s1.capabilities].sort(), [...CAPS].sort());
  const subset = ["presence.read", "messages.send", "tools.invoke"];
  const s2 = await a2.connect({ approve: subset });
  assert.deepEqual([...s2.capabilities].sort(), [...subset].sort());
  assert.ok(!s2.capabilities.includes("content.share"));
  // The SDK room enforces the approved subset: Agent 2 cannot share content.
  w.walletIds = { a1: a1.walletId, a2: a2.walletId };
  evidence.requested = CAPS;
  evidence.approvedByAgent2 = s2.capabilities;
  evidence.agent1Approved = s1.capabilities;
  evidence.humanA = ha.walletId;
}

export async function step3(w, evidence) {
  const probe = w.p.probe;
  await probe.open(
    "index.html",
    config(w, {
      label: "Probe",
      restricted: false,
      // Session length defaults to Never; this step needs a finite expiry.
      sessionTtlMs: 30 * 60_000,
    }),
  );
  await probe.identity("Probe");
  const s = await probe.connect();
  const grantMs = s.expiresAt - s.issuedAt;
  assert.ok(
    grantMs >= 15 * 60_000,
    "grant is longer than the 2 minute handshake",
  );
  assert.match(
    await probe.page.locator("#session-expiry").innerText(),
    /Session ends at/u,
  );
  const setOffset = (ms) =>
    probe.page.evaluate((offset) => (window.__clockOffset = offset), ms);
  await setOffset(180_000);
  assert.equal((await probe.call("probeSign")).ok, true, "survives past 120 s");
  const renewing = probe.call("renew");
  await probe.page.locator("#consent-approve").click();
  const renewed = await renewing;
  assert.ok(renewed.expiresAt > s.expiresAt, "renewal moved expiry forward");
  assert.deepEqual([...renewed.capabilities].sort(), [...CAPS].sort());
  for (const minute of [12, 21, 30]) {
    await setOffset(minute * 60_000);
    assert.equal((await probe.call("probeSign")).ok, true, `minute ${minute}`);
  }
  await setOffset(70 * 60_000);
  const after = await probe.call("probeSign");
  assert.match(
    after.error ?? "",
    /connection is closed/u,
    "expired session cannot publish",
  );
  await expectEventually(
    async () => (await probe.snapshot()).sessionStatus !== "active",
    "lease to report expiry",
    5_000,
  );
  assert.ok(
    await probe.get("b4a.state.lifecycle.some((e) => e.reason === 'expired')"),
    "lifecycle reports expired",
  );
  evidence.grantMinutes = Math.round(grantMs / 60_000);
  evidence.renewedExpiryDeltaMs = renewed.expiresAt - s.expiresAt;
}

export async function step5(w, evidence) {
  const { a1 } = w.p;
  const resource = "body4ai:wishlist";
  const requested = ["presence.read", "wishlist.write"];
  const challenge = w.authority.linkChallenge(resource, requested);
  const proof = await a1.call("linkApprove", challenge, ["presence.read"]);
  const verdict = await w.authority.acceptLink(proof, resource, requested);
  assert.equal(verdict.valid, true, `site verifies link: ${verdict.reason}`);
  w.link = { proof, resource, requested, linkId: verdict.link.linkId };
  // A new page load in the same profile still lists the link.
  const reloaded = await a1.context.newPage();
  await reloaded.goto(a1.siteUrl + "index.html");
  await reloaded.waitForFunction(() => Boolean(window.__b4a));
  await reloaded.evaluate(
    ([cfg, label]) => {
      window.__b4a.init(cfg);
      return window.__b4a.identity({ label, passphrase: "unused" });
    },
    [config(w, { label: "Agent 1" }), "Agent 1"],
  );
  const listed = await reloaded.evaluate(() => window.__b4a.links());
  await reloaded.close();
  assert.ok(
    listed.some((l) => l.linkId === w.link.linkId),
    "link listed after reload",
  );
  assert.deepEqual(w.authority.useLink(w.link.linkId, "presence.read"), {
    allow: true,
    reason: "ok",
  });
  assert.equal(
    w.authority.useLink(w.link.linkId, "wishlist.write").allow,
    false,
  );
  evidence.linkId = w.link.linkId;
  evidence.approved = ["presence.read"];
  evidence.deniedScope = "wishlist.write";
}
