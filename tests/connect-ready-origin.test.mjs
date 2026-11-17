import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { appSource } from "./helpers/app-source.mjs";

const source = await appSource();

// Runs the real top-level wallet bootstrap (loadWallet -> render -> the
// connect-ready announcement) with a controlled browser environment. The
// postMessage double records the target origin so a wildcard is observable.
function balancedFrom(marker, needle) {
  const at = source.indexOf(needle);
  assert.ok(at >= 0, `app.js has no ${needle}`);
  const start = source.lastIndexOf(marker, at);
  assert.ok(start >= 0, `app.js has no ${marker} before ${needle}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced bootstrap block in app.js");
}

async function boot({ referrer }) {
  const posts = [];
  const state = {
    wallet: { id: "agent:test", name: "Test" },
    room: null,
    rtc: null,
    consent: null,
    view: "connect",
    error: "",
  };
  const sandbox = vm.createContext({
    console,
    state,
    loadWallet: async () => state.wallet,
    startRoom: async () => {},
    render: () => {},
    externalConnectMode: true,
    externalHost: {
      postMessage: (data, targetOrigin) => posts.push({ data, targetOrigin }),
    },
    document: { referrer },
    location: { origin: "https://site.example" },
    URL,
  });
  const code = balancedFrom("try {", "state.wallet = await loadWallet();");
  await vm.runInContext(
    `(async () => { ${code} catch (error) { throw error; } })()`,
    sandbox,
  );
  return { posts, state };
}

test("startup never broadcasts connect-ready to every origin", async () => {
  const { posts } = await boot({ referrer: "https://site.example/connect" });
  const ready = posts.filter(
    (entry) => entry.data?.type === "ai-auth/connect-ready",
  );
  assert.equal(ready.length, 1, "the opener receives exactly one ready signal");
  assert.notEqual(
    ready[0].targetOrigin,
    "*",
    "the ready signal must name one verified origin, never a wildcard",
  );
  assert.equal(
    ready[0].targetOrigin,
    "https://site.example",
    "the ready signal is addressed to the verified opener origin",
  );
});
