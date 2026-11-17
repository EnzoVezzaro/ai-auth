// Loads small, self-contained fragments of apps/p2p/app.js and runs them in a
// VM sandbox with controlled globals. The wallet app has top-level browser side
// effects that cannot run under Node, so message-handler tests extract the real
// source text of the handler and exercise that code directly.
import { readFile } from "node:fs/promises";
import vm from "node:vm";

export function appSource() {
  return readFile(new URL("../../apps/p2p/app.js", import.meta.url), "utf8");
}

function closingBrace(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unbalanced braces in extracted app.js fragment");
}

export function extractFunction(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`app.js has no function ${name}`);
  // Keep a leading `async` if the function has become asynchronous.
  const start = source.slice(0, at).endsWith("async ")
    ? at - "async ".length
    : at;
  const open = source.indexOf("{", at);
  return source.slice(start, closingBrace(source, open) + 1);
}

export function extractIfContaining(source, needle) {
  const at = source.indexOf(needle);
  if (at === -1) throw new Error(`app.js has no branch containing ${needle}`);
  const start = source.lastIndexOf("if (", at);
  if (start === -1) throw new Error(`no if statement before ${needle}`);
  const open = source.indexOf("{", at);
  return source.slice(start, closingBrace(source, open) + 1);
}

export function runFragment(code, context = {}) {
  const sandbox = vm.createContext({ console, ...context });
  vm.runInContext(code, sandbox);
  return sandbox;
}

export function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}
