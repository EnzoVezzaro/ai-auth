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

test("expired replay keys are pruned on the next note", () => {
  const cache = createReplayCache();
  cache.note("issuerA:session:old", "issuerA", Date.now() - 1);
  cache.note("issuerB:session:new", "issuerB", Date.now() + 60_000);
  assert.equal(cache.has("issuerA:session:old"), false);
  assert.equal(cache.size, 1);
});
