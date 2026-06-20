import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export async function listenOnRandomPort(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function addressPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
  return address.port;
}

export async function withReleaseServer(releaseDir, version, fn) {
  const server = createServer(async (request, response) => {
    try {
      const requestPath = new URL(request.url || "/", `http://${request.headers.host}`).pathname;
      const fileName = path.basename(decodeURIComponent(requestPath));
      const bytes = await readFile(path.join(releaseDir, fileName));
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(bytes);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });
  await listenOnRandomPort(server);
  try {
    return await fn(`http://127.0.0.1:${addressPort(server)}/releases/download/v${version}`);
  } finally {
    await closeServer(server);
  }
}
