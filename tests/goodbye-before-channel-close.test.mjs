import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { appSource, extractFunction } from "./helpers/app-source.mjs";
import { until } from "./helpers/wait.mjs";

// The site-side stub transport used by disconnect-goodbye.test.mjs delivers
// synchronously, so it cannot catch a room closed before the goodbye is sent.
// This test models the real order: the room's close() awaits a delayed, signed
// send before the goodbye leaves, while the rtc connection closes immediately.
test("the goodbye is sent before the wallet's connection is closed", async () => {
  const source = await appSource();
  const expire = extractFunction(source, "expireExternalSession");

  const events = [];
  const room = {
    close() {
      return new Promise((resolve) => {
        setTimeout(() => {
          events.push("goodbye-sent");
          resolve();
        }, 50);
      });
    },
  };
  const rtc = {
    close() {
      events.push("rtc-closed");
    },
  };

  const state = {
    externalStatus: "sent",
    externalOrigin: "https://site.example",
    externalPendingEvents: [],
    consent: { body: { payload: { requestNonce: "nonce" } } },
    lease: { revoke() {} },
    transfers: { close() {} },
    rtc,
    room,
  };
  const externalHost = { postMessage() {} };
  const context = vm.createContext({
    console,
    state,
    externalHost,
    roomGeneration: 0,
    markSessionEnded() {},
    render() {},
    clearTimeout,
  });

  await vm.runInContext(`${expire}\nexpireExternalSession();`, context);
  // Wait for the delayed goodbye to land so the assertion is about the order
  // of the two events, not about whether a timer has fired by a fixed tick.
  await until(() => events.length === 2, {
    timeout: 2_000,
    interval: 10,
    message: "goodbye sent then rtc closed",
  });

  assert.deepEqual(
    events,
    ["goodbye-sent", "rtc-closed"],
    "rtc.close() must not run until room.close() has sent the goodbye",
  );
});

test("a rejected room close still closes the rtc connection and renders", async () => {
  const source = await appSource();
  const expire = extractFunction(source, "expireExternalSession");

  const events = [];
  const room = { close: () => Promise.reject(new Error("send failed")) };
  const rtc = {
    close() {
      events.push("rtc-closed");
    },
  };

  const state = {
    externalStatus: "sent",
    externalOrigin: "https://site.example",
    externalPendingEvents: [],
    consent: { body: { payload: { requestNonce: "nonce" } } },
    lease: { revoke() {} },
    transfers: { close() {} },
    rtc,
    room,
  };
  const context = vm.createContext({
    console,
    state,
    externalHost: { postMessage() {} },
    roomGeneration: 0,
    markSessionEnded() {},
    render() {
      events.push("rendered");
    },
    clearTimeout,
  });

  await vm.runInContext(`${expire}\nexpireExternalSession();`, context);

  assert.deepEqual(events, ["rtc-closed", "rendered"]);
});
