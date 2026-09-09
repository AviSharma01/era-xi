import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "./eraDraftCanonical.js";
import { loadEraDraftCatalogDocuments, type EraDraftCatalogDocuments } from "./eraDraftData.js";
import {
  ERA_DRAFT_WEB_ARTIFACT_SCHEMA_VERSION,
  type EraDraftWebArtifact,
  type EraDraftWebFranchise,
  type EraDraftWebSeason,
  type EraDraftWebTeam,
} from "./eraDraftScopedCatalog.js";
import {
  ERA_DRAFT_WEB_MANIFEST_SCHEMA_VERSION,
  type EraDraftWebManifest,
  type EraDraftWebManifestEntry,
} from "./eraDraftWebData.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";

const FILE_STEMS: Readonly<Record<EraId, string>> = {
  "era-foundation": "foundation",
  "era-expansion": "expansion",
  "era-transition": "transition",
  "era-modern-pre-impact": "modern-pre-impact",
  "era-impact": "impact",
};

export type EraDraftWebAssetSet = {
  readonly manifest: EraDraftWebManifest;
  readonly manifestJson: string;
  readonly artifacts: ReadonlyMap<string, { readonly artifact: EraDraftWebArtifact; readonly json: string }>;
};

export function createEraDraftWebArtifact(documents: EraDraftCatalogDocuments, eraId: EraId): EraDraftWebArtifact {
  const era = documents.eras.find((item) => item.eraId === eraId);
  const environment = documents.environments.find((item) => item.eraId === eraId);
  if (!era || !environment) throw new Error(`Missing ${eraId} source content.`);
  const seasonIds = new Set(era.seasonIds);
  const eligibility = documents.eligibility.filter((item) => item.eligibilityStatus === "ELIGIBLE" && seasonIds.has(item.seasonId));
  const playerIds = new Set(eligibility.map((item) => item.playerTeamSeasonId));
  const teamIds = new Set(eligibility.map((item) => item.teamId));
  const opponents = documents.opponentProfiles.filter((item) => item.eraId === eraId);
  opponents.forEach((item) => teamIds.add(item.teamId));
  const teams = documents.teams.filter((item) => teamIds.has(item.teamId)) as readonly EraDraftWebTeam[];
  const franchiseIds = new Set(teams.map((item) => item.franchiseId));
  return {
    schemaVersion: ERA_DRAFT_WEB_ARTIFACT_SCHEMA_VERSION,
    catalogFingerprint: documents.fingerprint,
    eraId,
    runtimeVersions: documents.versions,
    era,
    seasons: documents.seasons.filter((item) => seasonIds.has(item.seasonId)) as readonly EraDraftWebSeason[],
    teams,
    franchises: documents.franchises.filter((item) => franchiseIds.has(item.franchiseId)) as readonly EraDraftWebFranchise[],
    eligibility,
    roles: documents.roles.filter((item) => playerIds.has(item.playerTeamSeasonId)),
    qualities: documents.qualities.filter((item) => playerIds.has(item.playerTeamSeasonId)),
    roster: documents.roster.filter((item) => playerIds.has(item.playerTeamSeasonId)),
    environment,
    opponents,
  };
}

export function createEraDraftWebAssets(documents = loadEraDraftCatalogDocuments()): EraDraftWebAssetSet {
  const artifacts = new Map<string, { artifact: EraDraftWebArtifact; json: string }>();
  const entries: EraDraftWebManifestEntry[] = [];
  for (const eraId of ERA_IDS) {
    const artifact = createEraDraftWebArtifact(documents, eraId);
    const json = `${canonicalJson(artifact)}\n`;
    const hash = createHash("sha256").update(json).digest("hex");
    const path = `eras/${FILE_STEMS[eraId]}.${hash}.json`;
    artifacts.set(path, { artifact, json });
    const teamSeasons = new Set(artifact.eligibility.map((item) => `${item.teamId}\u001f${item.seasonId}`)).size;
    entries.push({ eraId, path, sha256: hash, sizeBytes: Buffer.byteLength(json), counts: {
      eligibleProfiles: artifact.eligibility.length, teamSeasons, opponents: artifact.opponents.length,
    } });
  }
  const manifest: EraDraftWebManifest = { schemaVersion: ERA_DRAFT_WEB_MANIFEST_SCHEMA_VERSION,
    catalogFingerprint: documents.fingerprint, eras: entries };
  return { manifest, manifestJson: `${canonicalJson(manifest)}\n`, artifacts };
}

export function writeEraDraftWebAssets(root = process.cwd()): EraDraftWebAssetSet {
  const assets = createEraDraftWebAssets(loadEraDraftCatalogDocuments(root));
  const output = resolve(root, "data/processed/era-draft/web/v1/public/data/era-draft/v1");
  mkdirSync(resolve(output, "eras"), { recursive: true });
  writeFileSync(resolve(output, "manifest.json"), assets.manifestJson);
  for (const [relativePath, item] of assets.artifacts) writeFileSync(resolve(output, relativePath), item.json);
  return assets;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const assets = writeEraDraftWebAssets();
  process.stdout.write(`${JSON.stringify({ manifestBytes: Buffer.byteLength(assets.manifestJson),
    artifacts: assets.manifest.eras.map((entry) => ({ eraId: entry.eraId, path: entry.path, sizeBytes: entry.sizeBytes })) }, null, 2)}\n`);
}

