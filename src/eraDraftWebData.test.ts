import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { loadEraDraftCatalogDocuments } from "./eraDraftData.js";
import { createEraDraftWebAssets } from "./eraDraftWebArtifacts.js";
import { fetchScopedEraDraftCatalog, parseEraDraftWebManifest, type EraDraftWebFetch } from "./eraDraftWebData.js";

const documents = loadEraDraftCatalogDocuments();

test("web artifact generation is deterministic and manifest entries describe exact bytes", () => {
  const first = createEraDraftWebAssets(documents);
  const second = createEraDraftWebAssets(documents);
  assert.equal(first.manifestJson, second.manifestJson);
  assert.deepEqual([...first.artifacts.keys()], [...second.artifacts.keys()]);
  for (const entry of first.manifest.eras) {
    const file = first.artifacts.get(entry.path)!;
    assert.equal(Buffer.byteLength(file.json), entry.sizeBytes);
    assert.equal(file.json, second.artifacts.get(entry.path)!.json);
  }
  assert.equal(parseEraDraftWebManifest(JSON.parse(first.manifestJson)).catalogFingerprint, documents.fingerprint);
});

test("committed browser artifacts exactly match the deterministic release asset set", () => {
  const assets = createEraDraftWebAssets(documents);
  const root = resolve("data/processed/era-draft/web/v1/public/data/era-draft/v1");
  assert.equal(readFileSync(resolve(root, "manifest.json"), "utf8"), assets.manifestJson);
  const committed = readdirSync(resolve(root, "eras")).sort();
  const expected = [...assets.artifacts.keys()].map((path) => path.replace(/^eras\//, "")).sort();
  assert.deepEqual(committed, expected);
  for (const [relativePath, artifact] of assets.artifacts) {
    assert.equal(readFileSync(resolve(root, relativePath), "utf8"), artifact.json, relativePath);
  }
});

test("browser loader verifies bytes before constructing the selected scoped catalog", async () => {
  const assets = createEraDraftWebAssets(documents);
  const requested: string[] = [];
  const fetcher: EraDraftWebFetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const relative = url.split("/data/era-draft/v1/")[1]!;
    const body = relative === "manifest.json" ? assets.manifestJson : assets.artifacts.get(relative)?.json;
    return new Response(body ?? "missing", { status: body ? 200 : 404 });
  };
  const manifestUrl = new URL("https://example.test/game/data/era-draft/v1/manifest.json");
  const catalog = await fetchScopedEraDraftCatalog({ manifest: assets.manifest, manifestUrl, eraId: "era-impact",
    fetcher, subtle: webcrypto.subtle as unknown as SubtleCrypto });
  assert.deepEqual(requested, [`https://example.test/game/data/era-draft/v1/${assets.manifest.eras[4]!.path}`]);
  assert.equal(catalog.fingerprint, documents.fingerprint);
  assert.deepEqual(catalog.getEraIds(), ["era-impact"]);
});

test("browser loader rejects size and hash mismatches without constructing a catalog", async () => {
  const assets = createEraDraftWebAssets(documents);
  const manifestUrl = new URL("https://example.test/data/era-draft/v1/manifest.json");
  const entry = assets.manifest.eras[0]!;
  const original = assets.artifacts.get(entry.path)!.json;
  const fetcher: EraDraftWebFetch = async () => new Response(`${original} `);
  await assert.rejects(fetchScopedEraDraftCatalog({ manifest: assets.manifest, manifestUrl, eraId: entry.eraId,
    fetcher, subtle: webcrypto.subtle as unknown as SubtleCrypto }),
  (error) => typeof error === "object" && error !== null && "code" in error && error.code === "WEB_ARTIFACT_SIZE_MISMATCH");

  const sameSizeTamper = `${original.slice(0, -2)} ${original.slice(-1)}`;
  const hashFetcher: EraDraftWebFetch = async () => new Response(sameSizeTamper);
  await assert.rejects(fetchScopedEraDraftCatalog({ manifest: assets.manifest, manifestUrl, eraId: entry.eraId,
    fetcher: hashFetcher, subtle: webcrypto.subtle as unknown as SubtleCrypto }),
  (error) => typeof error === "object" && error !== null && "code" in error && error.code === "WEB_ARTIFACT_HASH_MISMATCH");
});
