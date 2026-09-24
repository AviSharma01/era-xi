import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist-web");
const origin = "http://127.0.0.1:4173";
const vite = resolve(root, "node_modules/.bin/vite");

const server = spawn(vite, ["preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
let diagnostics = "";
server.stdout.on("data", (chunk) => { diagnostics += chunk; });
server.stderr.on("data", (chunk) => { diagnostics += chunk; });

try {
  await waitForServer();
  for (const path of ["/", "/era-draft", "/classic"]) {
    const response = await fetch(`${origin}${path}`, { redirect: "error" });
    assert(response.ok, `${path} returned ${response.status}`);
    assert(response.headers.get("content-type")?.includes("text/html"), `${path} did not return HTML`);
    assert((await response.text()).includes('<div id="app"></div>'), `${path} returned the wrong application shell`);
  }

  const manifestResponse = await fetch(`${origin}/data/era-draft/v1/manifest.json`);
  assert(manifestResponse.ok, `manifest returned ${manifestResponse.status}`);
  assert(manifestResponse.headers.get("content-type")?.includes("application/json"), "manifest MIME type is not JSON");
  const manifest = await manifestResponse.json();
  assert(Array.isArray(manifest.eras) && manifest.eras.length === 5, "manifest must contain five eras");
  for (const entry of manifest.eras) {
    const response = await fetch(`${origin}/data/era-draft/v1/${entry.path}`);
    assert(response.ok, `${entry.eraId} returned ${response.status}`);
    assert(response.headers.get("content-type")?.includes("application/json"), `${entry.eraId} MIME type is not JSON`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert(bytes.byteLength === entry.sizeBytes, `${entry.eraId} byte size differs from its manifest`);
    assert(createHash("sha256").update(bytes).digest("hex") === entry.sha256, `${entry.eraId} hash differs from its manifest`);
  }

  const noticeFiles = filesUnder(dist).filter((path) => /THIRD_PARTY_NOTICES.*\.txt$/.test(path));
  assert(noticeFiles.length === 1, "production bundle must contain one third-party notices file");
  const notices = readFileSync(noticeFiles[0], "utf8");
  for (const required of ["Cricsheet", "Space Grotesk", "Geist Project Authors", "SIL OPEN FONT LICENSE Version 1.1"]) {
    assert(notices.includes(required), `third-party notices are missing ${required}`);
  }

  process.stdout.write("Production web smoke passed: routes, catalog hashes, MIME types and notices verified.\n");
} finally {
  server.kill("SIGTERM");
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite preview exited early.\n${diagnostics}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The preview server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Vite preview did not become ready.\n${diagnostics}`);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
