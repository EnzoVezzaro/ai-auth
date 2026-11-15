import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";

test("authenticated local presence load: 10, 50, and 100 concurrent simulated clients", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "ai-auth-load-"));
  const port = 39000 + Math.floor(Math.random() * 10000);
  const env = {
    ...process.env,
    PORT: String(port),
    AI_AUTH_DB: join(dir, "load.sqlite"),
  };
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  const allSockets: WebSocket[] = [];
  try {
    server = spawn(
      process.execPath,
      ["--import", "tsx", "apps/server/src/server.ts"],
      { env, stdio: "ignore" },
    );
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, "load-test service starts");
    const measurements: Array<{
      clients: number;
      successful: number;
      p50ConnectMs: number;
      p95ConnectMs: number;
      eventDeliveryMs?: number;
      rssMb: number;
    }> = [];
    for (const count of [10, 50, 100]) {
      const registrations = await Promise.all(
        Array.from({ length: count }, async (_, index) => {
          const response = await fetch(`${base}/v1/agents/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: `Load ${count}-${index}`,
              runtime: "node-load-harness",
              category: "simulated_test_client",
            }),
          });
          assert.equal(response.status, 201);
          const result = (await response.json()) as {
            agent: { id: string };
            token: string;
          };
          return { id: result.agent.id, token: result.token };
        }),
      );
      const opened = await Promise.all(
        registrations.map(
          (agent) =>
            new Promise<{ socket: WebSocket; latency: number }>(
              (resolve, reject) => {
                const socket = new WebSocket(
                  `ws://127.0.0.1:${port}/v1/events?token=${encodeURIComponent(agent.token)}&room=loadtest`,
                );
                allSockets.push(socket);
                const began = performance.now();
                const timeout = setTimeout(() => {
                  socket.terminate();
                  reject(new Error("WebSocket connect timeout"));
                }, 5000);
                socket.once("open", () => {
                  clearTimeout(timeout);
                  resolve({ socket, latency: performance.now() - began });
                });
                socket.once("error", (error) => {
                  clearTimeout(timeout);
                  reject(error);
                });
              },
            ),
        ),
      );
      const connectLatencies = opened
        .map((item) => item.latency)
        .sort((a, b) => a - b);
      const percentile = (values: number[], fraction: number) =>
        values[
          Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
        ];
      const presence = await fetch(`${base}/v1/presence?room=loadtest`, {
        headers: { authorization: `Bearer ${registrations[0]!.token}` },
      });
      const roster = (await presence.json()) as {
        agents: Array<{ id: string }>;
      };
      const summary = (await (
        await fetch(`${base}/v1/analytics`, {
          headers: { authorization: `Bearer ${registrations[0]!.token}` },
        })
      ).json()) as { activeSessions: number };
      assert.equal(
        roster.agents.length,
        count - 1,
        `room roster matches the ${count}-client cohort, excluding caller`,
      );
      assert.equal(
        summary.activeSessions,
        count,
        `public analytics matches ${count} connected sessions`,
      );
      let eventDeliveryMs: number | undefined;
      if (count === 100) {
        const deliveredAt = new Map<WebSocket, number>();
        const sentAt = performance.now();
        const delivered = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("100-client event fanout timed out")),
            5000,
          );
          for (const socket of opened.map((item) => item.socket))
            socket.on("message", (raw) => {
              try {
                const event = JSON.parse(raw.toString()) as { type?: string };
                if (event.type === "agent.message_sent") {
                  deliveredAt.set(socket, performance.now());
                  if (deliveredAt.size === count) {
                    clearTimeout(timer);
                    resolve();
                  }
                }
              } catch {}
            });
        });
        await fetch(`${base}/v1/rooms/loadtest/messages`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${registrations[0]!.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ body: "fanout probe" }),
        }).then(async (response) => assert.equal(response.status, 201));
        await delivered;
        eventDeliveryMs = Math.max(
          ...[...deliveredAt.values()].map((time) => time - sentAt),
        );
        assert.ok(
          eventDeliveryMs < 5000,
          "100-client event fanout stays below five seconds",
        );
      }
      const rssBytes: number =
        Number(
          execFileSync("ps", ["-o", "rss=", "-p", String(server!.pid)], {
            encoding: "utf8",
          }).trim(),
        ) * 1024;
      const values: (typeof measurements)[number] = {
        clients: count,
        successful: opened.length,
        p50ConnectMs: Number(percentile(connectLatencies, 0.5).toFixed(2)),
        p95ConnectMs: Number(percentile(connectLatencies, 0.95).toFixed(2)),
        ...(eventDeliveryMs === undefined
          ? {}
          : { eventDeliveryMs: Number(eventDeliveryMs.toFixed(2)) }),
        rssMb: Number((rssBytes / 1024 / 1024).toFixed(1)),
      };
      measurements.push(values);
      assert.equal(values.successful, count);
      assert.ok(
        values.p95ConnectMs < 5000,
        `${count}-client connection p95 stays below five seconds`,
      );
      for (const { socket } of opened) socket.close();
      await Promise.all(
        opened.map(
          ({ socket }) =>
            new Promise<void>((resolve) =>
              socket.once("close", () => resolve()),
            ),
        ),
      );
      if (count !== 100)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    context.diagnostic(
      `Load-test measurements (simulated_test_client, not autonomous agents): ${JSON.stringify(measurements)}`,
    );
  } finally {
    for (const socket of allSockets)
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      )
        socket.terminate();
    if (server?.pid) {
      server.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rm(dir, { recursive: true, force: true });
  }
});
