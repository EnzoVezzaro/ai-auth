import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "dist-p2p");
const basePath = process.env.BASE_PATH ?? "/";
if (!basePath.startsWith("/") || !basePath.endsWith("/"))
  throw new Error("BASE_PATH must start and end with a slash");
// A second server over the same dist-p2p (for example a second origin in an
// E2E run) must not rebuild underneath the first one.
if (process.env.AI_AUTH_SKIP_BUILD !== "1") {
  const build = spawnSync(
    process.execPath,
    [resolve(root, "scripts/build-p2p-static.mjs")],
    { stdio: "inherit" },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
};
const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  if (basePath !== "/") {
    if (pathname === basePath.slice(0, -1)) pathname = basePath;
    if (!pathname.startsWith(basePath)) {
      response.writeHead(404).end("Not found");
      return;
    }
    pathname = pathname.slice(basePath.length - 1);
  }
  if (pathname === "/") pathname = "/index.html";
  let file = resolve(output, `.${pathname}`);
  if (file !== output && !file.startsWith(output + sep)) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      if (!pathname.endsWith("/")) {
        const originalUrl = new URL(request.url, "http://localhost");
        response
          .writeHead(308, {
            Location: `${originalUrl.pathname}/${originalUrl.search}`,
          })
          .end();
        return;
      }
      file = resolve(file, "index.html");
      info = await stat(file);
    }
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  } catch {
    response
      .writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Not found");
  }
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, "127.0.0.1", () => {
  console.log(
    `Static wallet preview: http://127.0.0.1:${port} (files only; no API server)`,
  );
});
