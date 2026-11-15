import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

test("OIDC adapter verifies signature, issuer, audience, and expiry before identity mapping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-auth-oidc-"));
  const issuer = "http://127.0.0.1:39871/issuer";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "local-test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const provider = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) =>
    provider.listen(39872, "127.0.0.1", resolve),
  );
  const port = 39873 + Math.floor(Math.random() * 1000);
  const childEnv = {
    ...process.env,
    PORT: String(port),
    AI_AUTH_DB: join(dir, "oidc.sqlite"),
    OIDC_ISSUER: issuer,
    OIDC_AUDIENCE: "ai-auth-local",
    OIDC_JWKS_URL: "http://127.0.0.1:39872/jwks",
  };
  let service: ChildProcess | undefined;
  try {
    service = spawn(
      process.execPath,
      ["--import", "tsx", "apps/server/src/server.ts"],
      { env: childEnv, stdio: "ignore" },
    );
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
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
    assert.equal(ready, true);
    const makeToken = (
      claims: Record<string, unknown> = {},
      tokenIssuer = issuer,
    ) =>
      new SignJWT({
        azp: "browser-agent",
        agent_name: "OIDC Writer",
        agent_category: "browser_automation",
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
        .setIssuer(tokenIssuer)
        .setSubject("principal-123")
        .setAudience("ai-auth-local")
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(privateKey);
    const token = await makeToken();
    const me = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.status, 200);
    const first = (await me.json()) as {
      agent: { id: string; name: string; category: string };
    };
    assert.equal(first.agent.name, "OIDC Writer");
    assert.equal(first.agent.category, "browser_automation");
    const repeat = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(
      ((await repeat.json()) as { agent: { id: string } }).agent.id,
      first.agent.id,
    );
    const wrongIssuer = await makeToken({}, "https://untrusted.example");
    assert.equal(
      (
        await fetch(`${base}/v1/me`, {
          headers: { authorization: `Bearer ${wrongIssuer}` },
        })
      ).status,
      401,
    );
    const wrongAudience = await new SignJWT({ azp: "browser-agent" })
      .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
      .setIssuer(issuer)
      .setSubject("other")
      .setAudience("other-service")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(privateKey);
    assert.equal(
      (
        await fetch(`${base}/v1/me`, {
          headers: { authorization: `Bearer ${wrongAudience}` },
        })
      ).status,
      401,
    );
    const expired = await new SignJWT({ azp: "browser-agent" })
      .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
      .setIssuer(issuer)
      .setSubject("expired")
      .setAudience("ai-auth-local")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);
    assert.equal(
      (
        await fetch(`${base}/v1/me`, {
          headers: { authorization: `Bearer ${expired}` },
        })
      ).status,
      401,
    );
  } finally {
    service?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
