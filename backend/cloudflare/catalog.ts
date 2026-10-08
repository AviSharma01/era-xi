import { artifacts, manifest } from '../stage-a/.generated/catalogs';
import { buildScopedEraDraftCatalog } from '../../src/eraDraftScopedCatalog';
import type { EraId } from '../../src/teamEvaluationV2';

/** Reuses Stage A's pinned, content-addressed artifacts and eagerly indexed scoped catalog. */
export async function loadRoomCatalog(eraId: EraId) {
  const entry = manifest.eras.find((era) => era.eraId === eraId);
  const raw = artifacts[eraId];
  if (!entry || !raw) throw new Error('Unknown room era');
  const bytes = new TextEncoder().encode(raw);
  if (bytes.length !== entry.sizeBytes) throw new Error('Catalog artifact size mismatch');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== entry.sha256) throw new Error('Catalog artifact hash mismatch');
  return buildScopedEraDraftCatalog(JSON.parse(raw), { eraId, catalogFingerprint: manifest.catalogFingerprint });
}
