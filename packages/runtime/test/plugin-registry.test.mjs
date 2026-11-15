import test from "node:test";
import assert from "node:assert/strict";
import {
  createPluginHost,
  PLUGIN_API_VERSION,
  PluginConfigurationError,
  createCallbackAuthorizationProvider,
  createScopeAuthorizationProvider,
} from "../index.js";

function implementationFor(slot) {
  return {
    identity: { identify: async () => "agent:test" },
    authorization: { allows: () => false },
    storage: { getTenant: () => ({}) },
    presence: { getTenant: () => ({}) },
    transport: { forwardTenant: async () => new Response() },
    observability: { record: () => {} },
  }[slot];
}

function plugin(id, slot, lifecycle = {}) {
  return {
    id,
    slot,
    apiVersion: PLUGIN_API_VERSION,
    implementation: implementationFor(slot),
    initialize: async () => lifecycle.start?.(),
    close: async () => lifecycle.stop?.(),
    ...lifecycle.plugin,
  };
}

function providers() {
  return [
    plugin("wallet", "identity"),
    plugin("caps", "authorization"),
    plugin("sqlite", "storage"),
    plugin("presence", "presence"),
    plugin("websocket", "transport"),
  ];
}

test("host initializes required providers and exposes them by slot", async () => {
  const context = { marker: "shared startup context" };
  const plugins = providers();
  const receivedContexts = [];
  plugins[0].initialize = async (value) => receivedContexts.push(value);
  const host = await createPluginHost(plugins, { context });
  assert.equal(host.get("identity"), plugins[0]);
  assert.equal(host.get("storage"), plugins[2]);
  assert.deepEqual(receivedContexts, [context]);
  await host.close();
});

test("host rejects missing slots and duplicate providers before startup", async () => {
  const started = [];
  const plugins = providers().filter((item) => item.slot !== "storage");
  await assert.rejects(
    createPluginHost(plugins),
    (error) => error instanceof PluginConfigurationError,
  );
  await assert.rejects(
    createPluginHost([...providers(), plugin("other-storage", "storage")]),
    /Only one plugin may provide the storage slot/u,
  );
  assert.deepEqual(started, []);
});

test("host rejects providers that do not satisfy the slot contract", async () => {
  const plugins = providers();
  const started = [];
  plugins[0].implementation = { algorithms: ["ECDSA-P256-SHA256"] };
  plugins[0].initialize = () => started.push("started");
  await assert.rejects(
    createPluginHost(plugins),
    /identity plugin implementation must provide identify\(\)/u,
  );
  assert.deepEqual(started, []);
});

test("scope and callback authorization providers share a fail-closed contract", () => {
  const scoped = createScopeAuthorizationProvider();
  const callback = createCallbackAuthorizationProvider(
    (subject, capability, resource) =>
      subject?.tenant === "research" &&
      capability === "messages.read" &&
      resource !== "other",
  );
  const asyncCallback = createCallbackAuthorizationProvider(() =>
    Promise.resolve(true),
  );
  const session = { capabilities: ["messages.read"], tenant: "research" };

  assert.equal(scoped.allows(session, "messages.read"), true);
  assert.equal(scoped.allows(session, "tenant.delete"), false);
  assert.equal(scoped.allows({}, "messages.read"), false);
  assert.equal(scoped.allows({ capabilities: [undefined] }, undefined), false);
  assert.equal(scoped.allows(session, ""), false);
  assert.equal(callback.allows(session, "messages.read"), true);
  assert.equal(callback.allows(session, "tenant.delete"), false);
  assert.equal(callback.allows(session, "messages.read", "other"), false);
  assert.equal(callback.allows(session, undefined), false);
  assert.equal(asyncCallback.allows(session, "messages.read"), false);
});

test("host initializes dependencies first and closes in reverse order once", async () => {
  const events = [];
  const plugins = providers();
  plugins[2].dependsOn = ["wallet"];
  plugins[2].initialize = async () => events.push("start:sqlite");
  plugins[0].initialize = async () => events.push("start:wallet");
  plugins[2].close = async () => events.push("stop:sqlite");
  plugins[0].close = async () => events.push("stop:wallet");
  const host = await createPluginHost(plugins);
  await host.close();
  await host.close();
  assert.deepEqual(events, [
    "start:wallet",
    "start:sqlite",
    "stop:sqlite",
    "stop:wallet",
  ]);
});

test("startup failure cleans up the failing plugin without exposing its error", async () => {
  const events = [];
  const plugins = providers();
  plugins[0].initialize = async () => events.push("start:wallet");
  plugins[0].close = async () => events.push("stop:wallet");
  plugins[1].initialize = async () => {
    throw new Error("private-key=must-not-escape");
  };
  plugins[1].close = async () => events.push("stop:caps");
  await assert.rejects(createPluginHost(plugins), (error) => {
    assert.equal(error.message, "Plugin host startup failed at caps");
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(events, ["start:wallet", "stop:caps", "stop:wallet"]);
});

test("host rejects dependency cycles and missing dependencies", async () => {
  const plugins = providers();
  plugins[0].dependsOn = ["caps"];
  plugins[1].dependsOn = ["wallet"];
  await assert.rejects(createPluginHost(plugins), /contain a cycle/u);
  plugins[1].dependsOn = ["missing-plugin"];
  await assert.rejects(createPluginHost(plugins), /depends on missing/u);
});
