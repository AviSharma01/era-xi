import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { EraDraftDataError } from "./eraDraftTypes.js";
import { buildScopedEraDraftCatalog } from "./eraDraftScopedCatalog.js";

export const ERA_DRAFT_WEB_MANIFEST_SCHEMA_VERSION = "ipl-era-draft-web-manifest/v1" as const;

export type EraDraftWebManifestEntry = {
  readonly eraId: EraId;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly counts: {
    readonly eligibleProfiles: number;
    readonly teamSeasons: number;
    readonly opponents: number;
  };
};

export type EraDraftWebManifest = {
  readonly schemaVersion: typeof ERA_DRAFT_WEB_MANIFEST_SCHEMA_VERSION;
  readonly catalogFingerprint: string;
  readonly eras: readonly EraDraftWebManifestEntry[];
};

export type EraDraftWebFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function eraDraftManifestUrl(baseUrl: string, origin = window.location.origin): URL {
  const applicationBase = new URL(baseUrl, origin);
  return new URL("data/era-draft/v1/manifest.json", applicationBase);
}

export async function fetchEraDraftManifest(
  url: URL,
  fetcher: EraDraftWebFetch = globalThis.fetch.bind(globalThis),
): Promise<EraDraftWebManifest> {
  const response = await fetcher(url, { cache: "no-cache" });
  if (!response.ok) throw new EraDraftDataError("WEB_MANIFEST_FETCH_FAILED", `Era Draft manifest request failed with ${response.status}.`);
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch (error) {
    throw new EraDraftDataError("INVALID_WEB_MANIFEST", "Era Draft manifest is not valid JSON.", {}, { cause: error });
  }
  return parseEraDraftWebManifest(value);
}

export async function fetchScopedEraDraftCatalog(input: {
  readonly manifest: EraDraftWebManifest;
  readonly manifestUrl: URL;
  readonly eraId: EraId;
  readonly fetcher?: EraDraftWebFetch;
  readonly subtle?: SubtleCrypto;
}): Promise<EraDraftCatalog> {
  const entry = input.manifest.eras.find((item) => item.eraId === input.eraId);
  if (!entry) throw new EraDraftDataError("MISSING_WEB_ERA", `Manifest has no artifact for ${input.eraId}.`);
  const response = await (input.fetcher ?? globalThis.fetch.bind(globalThis))(new URL(entry.path, input.manifestUrl), { cache: "force-cache" });
  if (!response.ok) throw new EraDraftDataError("WEB_ARTIFACT_FETCH_FAILED", `${input.eraId} artifact request failed with ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== entry.sizeBytes) {
    throw new EraDraftDataError("WEB_ARTIFACT_SIZE_MISMATCH", `${input.eraId} artifact byte size does not match its manifest.`,
      { expected: entry.sizeBytes, actual: bytes.byteLength });
  }
  const subtle = input.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) throw new EraDraftDataError("WEB_CRYPTO_UNAVAILABLE", "SHA-256 artifact verification requires Web Crypto.");
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  const actualHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualHash !== entry.sha256) {
    throw new EraDraftDataError("WEB_ARTIFACT_HASH_MISMATCH", `${input.eraId} artifact failed SHA-256 verification.`,
      { expected: entry.sha256, actual: actualHash });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new EraDraftDataError("INVALID_WEB_ARTIFACT_JSON", `${input.eraId} artifact is not valid UTF-8 JSON.`, {}, { cause: error });
  }
  return buildScopedEraDraftCatalog(value, { eraId: input.eraId, catalogFingerprint: input.manifest.catalogFingerprint });
}

export function parseEraDraftWebManifest(value: unknown): EraDraftWebManifest {
  const row = record(value, "Era Draft web manifest");
  exactKeys(row, ["schemaVersion", "catalogFingerprint", "eras"], "Era Draft web manifest");
  if (row.schemaVersion !== ERA_DRAFT_WEB_MANIFEST_SCHEMA_VERSION || typeof row.catalogFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(row.catalogFingerprint)) {
    throw new EraDraftDataError("INVALID_WEB_MANIFEST", "Era Draft manifest version or fingerprint is invalid.");
  }
  if (!Array.isArray(row.eras) || row.eras.length !== ERA_IDS.length) {
    throw new EraDraftDataError("INVALID_WEB_MANIFEST", "Era Draft manifest must contain exactly five eras.");
  }
  const eras = row.eras.map((value, index): EraDraftWebManifestEntry => {
    const entry = record(value, `manifest eras[${index}]`);
    exactKeys(entry, ["eraId", "path", "sha256", "sizeBytes", "counts"], `manifest eras[${index}]`);
    if (typeof entry.eraId !== "string" || !ERA_IDS.includes(entry.eraId as EraId)
      || typeof entry.path !== "string" || !/^eras\/[a-z0-9-]+\.[0-9a-f]{64}\.json$/.test(entry.path)
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || !Number.isInteger(entry.sizeBytes) || (entry.sizeBytes as number) <= 0) {
      throw new EraDraftDataError("INVALID_WEB_MANIFEST", `Invalid artifact identity at manifest eras[${index}].`);
    }
    const counts = record(entry.counts, `manifest eras[${index}].counts`);
    exactKeys(counts, ["eligibleProfiles", "teamSeasons", "opponents"], `manifest eras[${index}].counts`);
    for (const key of ["eligibleProfiles", "teamSeasons", "opponents"] as const) {
      if (!Number.isInteger(counts[key]) || (counts[key] as number) <= 0) {
        throw new EraDraftDataError("INVALID_WEB_MANIFEST", `Invalid ${key} count for ${entry.eraId}.`);
      }
    }
    return Object.freeze({ eraId: entry.eraId as EraId, path: entry.path, sha256: entry.sha256,
      sizeBytes: entry.sizeBytes as number, counts: Object.freeze(counts as EraDraftWebManifestEntry["counts"]) });
  });
  const ids = eras.map((item) => item.eraId);
  if (new Set(ids).size !== ERA_IDS.length || ERA_IDS.some((eraId) => !ids.includes(eraId))) {
    throw new EraDraftDataError("INVALID_WEB_MANIFEST", "Era Draft manifest era identities are incomplete or duplicated.");
  }
  return Object.freeze({ schemaVersion: ERA_DRAFT_WEB_MANIFEST_SCHEMA_VERSION,
    catalogFingerprint: row.catalogFingerprint, eras: Object.freeze(eras) });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EraDraftDataError("INVALID_WEB_MANIFEST", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new EraDraftDataError("INVALID_WEB_MANIFEST", `${label} has unexpected fields.`);
  }
}
