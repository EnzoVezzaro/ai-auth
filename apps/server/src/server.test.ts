import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("local service supports authenticated collaboration, private presence, advisory locks, task handoff, and revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-auth-"));
  const port = 34000 + Math.floor(Math.random() * 10000);
  const env = {
    ...process.env,
    PORT: String(port),
    AI_AUTH_DB: join(dir, "test.sqlite"),
    CORS_ORIGIN: "http://localhost:3030,http://trusted.test",
  };
  let server: ChildProcess | undefined;
  try {
    server = spawn(
      process.execPath,
      ["--import", "tsx", "apps/server/src/server.ts"],
      { env, stdio: "ignore" },
    );
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* wait for listen */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, "server should become ready");
    assert.match(
      await (await fetch(base)).text(),
      /Give agents a shared space/,
    );
    assert.match(await (await fetch(`${base}/docs`)).text(), /Local setup/);
    assert.equal((await fetch(`${base}/.well-known/ai-auth`)).status, 200);
    const corsAllowed = await fetch(`${base}/health`, {
      headers: { origin: "http://localhost:3030" },
    });
    assert.equal(
      corsAllowed.headers.get("access-control-allow-origin"),
      "http://localhost:3030",
    );
    const corsDenied = await fetch(`${base}/health`, {
      headers: { origin: "http://untrusted.test" },
    });
    assert.equal(corsDenied.headers.get("access-control-allow-origin"), null);
    assert.match(
      await (await fetch(`${base}/sdk/ai-auth.js`)).text(),
      /AIAuth/,
    );
    assert.match(
      await (await fetch(`${base}/dashboard`)).text(),
      /Local activity/,
    );
    assert.match(await (await fetch(`${base}/demo`)).text(), /demo\.setNote/);
    const register = async (name: string) => {
      const response = await fetch(`${base}/v1/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      assert.equal(response.status, 201);
      return (await response.json()) as {
        agent: { id: string };
        token: string;
      };
    };
    const a = await register("Writer");
    const b = await register("Observer");
    assert.notEqual(a.token, b.token);
    const expiring = await register("Expired");
    const inspectDb = new Database(join(dir, "test.sqlite"));
    inspectDb
      .prepare("UPDATE agents SET token_expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), expiring.agent.id);
    assert.equal(
      (
        await fetch(`${base}/v1/me`, {
          headers: { authorization: `Bearer ${expiring.token}` },
        })
      ).status,
      401,
      "expired credential is rejected",
    );
    const privateResponse = await fetch(`${base}/v1/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Private",
        private: true,
        category: "simulated_test_client",
      }),
    });
    const privateAgent = (await privateResponse.json()) as {
      agent: { id: string };
      token: string;
    };
    assert.equal((await fetch(`${base}/v1/me`)).status, 401);
    let publicSocket: WebSocket;
    const observedTypes: string[] = [];
    const wsEvent = new Promise<string>((resolve, reject) => {
      publicSocket = new WebSocket(
        `ws://127.0.0.1:${port}/v1/events?token=${encodeURIComponent(b.token)}&room=demo`,
        { headers: { Origin: base } },
      );
      const timer = setTimeout(() => {
        publicSocket.close();
        reject(new Error("event timeout"));
      }, 3000);
      publicSocket.onmessage = (event) => {
        const data = JSON.parse(String(event.data)) as { type: string };
        observedTypes.push(data.type);
        if (data.type === "agent.message_sent") {
          clearTimeout(timer);
          resolve(String(event.data));
        }
      };
      publicSocket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("websocket failed"));
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sent = await fetch(`${base}/v1/rooms/demo/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${a.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: "hello" }),
    });
    assert.equal(sent.status, 201);
    const event = JSON.parse(await wsEvent) as {
      type: string;
      agentId: string;
      body: string;
      version: number;
      eventId: string;
      timestamp: string;
      siteId: string;
      roomId: string;
      traceId: string;
    };
    assert.equal(event.type, "agent.message_sent");
    assert.equal(event.agentId, a.agent.id);
    assert.equal(event.body, "hello");
    assert.equal(event.version, 1);
    assert.ok(event.eventId);
    assert.ok(event.timestamp);
    assert.equal(event.siteId, "local");
    assert.equal(event.roomId, "demo");
    assert.ok(event.traceId);
    const history = await fetch(`${base}/v1/audit`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    const data = (await history.json()) as { events: Array<{ kind: string }> };
    assert.ok(data.events.some((item) => item.kind === "message.created"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const activityResponse = await fetch(`${base}/v1/activity`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${b.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ activity: "Reviewing the page" }),
    });
    assert.equal(activityResponse.status, 200);
    const publicPresence = (await (
      await fetch(`${base}/v1/presence?room=demo`, {
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).json()) as { agents: Array<{ id: string; activity: string }> };
    assert.equal(
      publicPresence.agents.find((item) => item.id === b.agent.id)?.activity,
      "Reviewing the page",
    );
    const analyticsBeforePrivate = (await (
      await fetch(`${base}/v1/analytics`, {
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).json()) as { actions: number };
    const privateSocket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/events?token=${encodeURIComponent(privateAgent.token)}&room=demo`,
    );
    await new Promise<void>(
      (resolve) => (privateSocket.onopen = () => resolve()),
    );
    await fetch(`${base}/v1/activity`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${privateAgent.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ activity: "Private work" }),
    });
    const presence = await fetch(`${base}/v1/presence?room=demo`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    const members = (await presence.json()) as {
      agents: Array<{ id: string }>;
    };
    assert.ok(
      !members.agents.some((item) => item.id === privateAgent.agent.id),
    );
    const analytics = (await (
      await fetch(`${base}/v1/analytics`, {
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).json()) as { activeSessions: number; actions: number };
    assert.equal(
      analytics.activeSessions,
      1,
      "private websocket does not affect shared counters",
    );
    assert.equal(
      analytics.actions,
      analyticsBeforePrivate.actions,
      "private audit activity does not change shared action totals",
    );
    const privateWrite = await fetch(`${base}/v1/rooms/demo/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${privateAgent.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: "hidden" }),
    });
    assert.equal(privateWrite.status, 403);
    const lock1 = await fetch(`${base}/v1/rooms/demo/locks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${a.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ resource: "page:home" }),
    });
    assert.equal(lock1.status, 200);
    const lock2 = await fetch(`${base}/v1/rooms/demo/locks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${b.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ resource: "page:home" }),
    });
    assert.equal(lock2.status, 409);
    for (
      let i = 0;
      i < 20 && !observedTypes.includes("resource.conflict_detected");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      observedTypes.includes("resource.conflict_detected"),
      "resource conflict broadcasts to public peers",
    );
    const released = await fetch(`${base}/v1/rooms/demo/locks/page%3Ahome`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(released.status, 200);
    const task = await fetch(`${base}/v1/rooms/demo/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${a.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        description: "Review the page",
        assigneeId: b.agent.id,
      }),
    });
    assert.equal(task.status, 201);
    const taskData = (await task.json()) as { task: { id: string } };
    const accepted = await fetch(`${base}/v1/tasks/${taskData.task.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${b.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "accepted" }),
    });
    assert.equal(accepted.status, 200);
    const mcpClient = new Client({
      name: "ai-auth-test-client",
      version: "1.0.0",
    });
    const mcpTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "apps/server/src/mcp-server.ts"],
      env: {
        ...process.env,
        AI_AUTH_TOKEN: b.token,
        AI_AUTH_URL: base,
      } as Record<string, string>,
      stderr: "ignore",
    });
    await mcpClient.connect(mcpTransport);
    const tools = await mcpClient.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "ai_auth.send_message"));
    const resources = await mcpClient.listResources();
    assert.ok(
      resources.resources.some(
        (resource) => resource.uri === "ai-auth://presence",
      ),
    );
    const presenceResource = await mcpClient.readResource({
      uri: "ai-auth://presence",
    });
    assert.ok(presenceResource.contents.length > 0);
    const mcpWhoami = await mcpClient.callTool({
      name: "ai_auth.whoami",
      arguments: {},
    });
    assert.notEqual(mcpWhoami.isError, true);
    await mcpClient.callTool({
      name: "ai_auth.send_message",
      arguments: { room: "demo", body: "message from MCP" },
    });
    await mcpClient.close();
    const privateMcpClient = new Client({
      name: "ai-auth-private-test-client",
      version: "1.0.0",
    });
    const privateMcpTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "apps/server/src/mcp-server.ts"],
      env: {
        ...process.env,
        AI_AUTH_TOKEN: privateAgent.token,
        AI_AUTH_URL: base,
      } as Record<string, string>,
      stderr: "ignore",
    });
    await privateMcpClient.connect(privateMcpTransport);
    const privateMcpWrite = await privateMcpClient.callTool({
      name: "ai_auth.send_message",
      arguments: { room: "demo", body: "must be rejected" },
    });
    assert.equal(
      privateMcpWrite.isError,
      true,
      "server authorization rejects private collaboration write",
    );
    await privateMcpClient.close();
    const revokedSocket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/events?token=${encodeURIComponent(a.token)}&room=demo`,
    );
    await new Promise<void>((resolve, reject) => {
      revokedSocket.onopen = () => resolve();
      revokedSocket.onerror = () =>
        reject(new Error("revocation socket failed to open"));
    });
    const revokedClosed = new Promise<number>(
      (resolve) => (revokedSocket.onclose = (event) => resolve(event.code)),
    );
    privateSocket.close();
    publicSocket!.close();
    const revoke = await fetch(`${base}/v1/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(revoke.status, 200);
    assert.equal(
      await revokedClosed,
      1008,
      "active socket closes after revocation",
    );
    assert.equal(
      (
        await fetch(`${base}/v1/me`, {
          headers: { authorization: `Bearer ${a.token}` },
        })
      ).status,
      401,
    );
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => server!.once("exit", () => resolve()));
    inspectDb.close();
    server = spawn(
      process.execPath,
      ["--import", "tsx", "apps/server/src/server.ts"],
      { env, stdio: "ignore" },
    );
    let restarted = false;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) {
          restarted = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      restarted,
      true,
      "service should restart against existing database",
    );
    assert.equal(
      (
        await fetch(`${base}/v1/me`, {
          headers: { authorization: `Bearer ${a.token}` },
        })
      ).status,
      401,
      "revocation persists across restart",
    );
    const afterRestart = await fetch(`${base}/v1/rooms/demo/messages`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    const persisted = (await afterRestart.json()) as {
      messages: Array<{ body: string }>;
    };
    assert.ok(
      persisted.messages.some((message) => message.body === "hello"),
      "message persists across restart",
    );
    assert.ok(
      persisted.messages.some((message) => message.body === "message from MCP"),
      "MCP operation is persisted",
    );
  } finally {
    server?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(dir, { recursive: true, force: true });
  }
});
