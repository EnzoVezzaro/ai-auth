// Replay memory must be capped per issuer so one chatty room member cannot
// blackhole inbound traffic from everyone else.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createReplayCache,
  MAX_REPLAY_PER_ISSUER,
} from "../packages/p2p/embed.js";

test("replay memory keeps a per-issuer budget", () => {
  const cache = createReplayCache();
  for (let i = 0; i < MAX_REPLAY_PER_ISSUER + 20; i += 1)
    cache.note(`issuerA:session:${i}`, "issuerA", Date.now() + 60_000);
  assert.equal(
    cache.has("issuerB:session:fresh"),
    false,
    "a new issuer is not marked seen before it is noted",
  );
  cache.note("issuerB:session:fresh", "issuerB", Date.now() + 60_000);
  assert.equal(cache.has("issuerB:session:fresh"), true);
  assert.equal(
    cache.has("issuerA:session:0"),
    false,
    "only the flooding issuer's oldest keys are evicted",
  );
  assert.ok(
    cache.size <= MAX_REPLAY_PER_ISSUER + 1,
    `total entries stayed bounded (got ${cache.size})`,
  );
});

test("a global eviction does not inflate the issuer's held count", () => {
  const cache = createReplayCache();
  const expiresAt = Date.now() + 60_000;
  // One entry from X first, then enough other issuers to fill the global
  // cache. X:0 is now the oldest entry, so the next note evicts it globally.
  cache.note("X:0", "X", expiresAt);
  for (let issuer = 0; issuer < 31; issuer += 1)
    for (let i = 0; i < MAX_REPLAY_PER_ISSUER; i += 1)
      cache.note(`Y${issuer}:${i}`, `Y${issuer}`, expiresAt);
  for (let i = 0; i < MAX_REPLAY_PER_ISSUER - 1; i += 1)
    cache.note(`Y31:${i}`, "Y31", expiresAt);
  assert.equal(cache.size, 4_096);
  assert.equal(cache.has("X:0"), true);

  cache.note("X:1", "X", expiresAt); // global eviction drops X:0
  assert.equal(cache.has("X:0"), false);
  for (let i = 2; i <= MAX_REPLAY_PER_ISSUER; i += 1)
    cache.note(`X:${i}`, "X", expiresAt);

  // X must still retain its full per-issuer budget. If `held` is not
  // recomputed after the global eviction, the stale count evicts X:1 early.
  assert.equal(
    cache.has("X:1"),
    true,
    "an entry evicted globally must not shorten another issuer's budget",
  );
});

test("expired replay keys are pruned on the next note", () => {
  const cache = createReplayCache();
  cache.note("issuerA:session:old", "issuerA", Date.now() - 1);
  cache.note("issuerB:session:new", "issuerB", Date.now() + 60_000);
  assert.equal(cache.has("issuerA:session:old"), false);
  assert.equal(cache.size, 1);
});
