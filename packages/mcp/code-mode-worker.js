// Code Mode guest runner. The guest executes in this worker's vm context so a
// runaway async continuation (`await 1; while(true){}`) can be stopped by
// terminating the worker from the host, not merely timed out in a Promise.race.
//
// Host calls cross the boundary as JSON strings only. Synchronous guest APIs
// use a SharedArrayBuffer + Atomics handshake; async ones use messages. The
// worker never exposes a host/worker object to the guest, so the guest's
// constructor chains stay inside the codeGeneration-disabled vm realm.
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

const HEADER_BYTES = 8; // two Int32 slots: phase and sequence
const HEADER = new Int32Array(workerData.shared, 0, 2);
const DATA = new Uint8Array(workerData.shared, HEADER_BYTES);
const IDLE = 0;
const REQUEST = 1;
const REPLY = 2;
const SYNC_WAIT_MS = 10_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeData(text) {
  const bytes = encoder.encode(text);
  // A request that cannot fit must fail loudly, never be silently truncated
  // into corrupt JSON that the host cannot parse.
  if (bytes.length >= DATA.length) return false;
  DATA.fill(0);
  DATA.set(bytes);
  return true;
}

function readData() {
  const end = DATA.indexOf(0);
  if (end === -1)
    throw new Error("aiAuth host reply too large or missing terminator");
  let text;
  try {
    text = decoder.decode(DATA.subarray(0, end));
  } catch {
    throw new Error("aiAuth host reply could not be decoded");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("aiAuth host reply contains corrupt JSON");
  }
}

function errorInfo(error) {
  return {
    message: String(error?.message ?? "aiAuth call failed").slice(0, 240),
    ...(error?.code ? { code: error.code } : {}),
  };
}

const parse = (json) => JSON.parse(json);

let syncSeq = 0;
function syncHost(method, args) {
  const seq = ++syncSeq;
  if (!writeData(JSON.stringify({ seq, method, args })))
    throw errorInfo(
      new Error("aiAuth host call arguments too large for shared buffer"),
    );
  Atomics.store(HEADER, 1, seq);
  Atomics.store(HEADER, 0, REQUEST);
  Atomics.notify(HEADER, 0);
  parentPort.postMessage({ type: "sync", seq });
  const deadline = Date.now() + SYNC_WAIT_MS;
  while (Atomics.load(HEADER, 0) !== REPLY) {
    Atomics.wait(HEADER, 0, REQUEST, 25);
    if (Date.now() > deadline)
      throw errorInfo(new Error("Sandbox host call timed out"));
  }
  try {
    const response = readData();
    if (response.error) throw response.error;
    return parse(response.value);
  } finally {
    Atomics.store(HEADER, 0, IDLE);
  }
}

let asyncSeq = 0;
const pending = new Map();
function asyncHost(method, args) {
  return new Promise((resolve, reject) => {
    const id = ++asyncSeq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "async", id, method, args });
  });
}
parentPort.on("message", (message) => {
  if (message?.type !== "asyncResult") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(parse(message.value));
  else entry.reject(message.error);
});

function syncBridge(method) {
  return (argsJson, ok, fail) => {
    try {
      ok(JSON.stringify(syncHost(method, parse(argsJson))));
    } catch (error) {
      fail(JSON.stringify(errorInfo(error)));
    }
  };
}

function asyncBridge(method) {
  return (argsJson, ok, fail) => {
    let args;
    try {
      args = parse(argsJson);
    } catch {
      fail(
        JSON.stringify(errorInfo(new TypeError("Invalid aiAuth arguments"))),
      );
      return;
    }
    asyncHost(method, args).then(
      (value) => ok(JSON.stringify(value ?? null)),
      (error) => fail(JSON.stringify(errorInfo(error))),
    );
  };
}

async function main() {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  const factory = vm.runInContext(workerData.factorySource, context);
  const callbacks = [
    (text) =>
      parentPort.postMessage({
        type: "log",
        text: String(text ?? "").slice(0, 240),
      }),
    syncBridge("status"),
    syncBridge("listTools"),
    syncBridge("events"),
    asyncBridge("send"),
    syncBridge("move"),
    asyncBridge("invoke"),
  ];
  const wrappers = factory(...callbacks);
  sandbox.console = wrappers.console;
  sandbox.aiAuth = wrappers.aiAuth;
  const script = new vm.Script(
    `"use strict";\n(async () => {\n${workerData.code}\n})()`,
    { timeout: 2_000 },
  );
  const value = await script.runInContext(context, { timeout: 2_000 });
  parentPort.postMessage({
    type: "done",
    ok: true,
    value: JSON.stringify(value ?? null),
  });
}

main().catch((error) => {
  parentPort.postMessage({ type: "failed", ...errorInfo(error) });
});
