import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "./eraDraftCanonical.js";
import { loadEraDraftCatalog, loadEraDraftCatalogDocuments } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import { EraDraftDataError, type EraDraftState, type EraDraftTransitionResult } from "./eraDraftTypes.js";
import {
  ERA_DRAFT_UI_SAVE_VERSION,
  ERA_DRAFT_UI_STORAGE_KEY,
  EraDraftUiSaveError,
  clearEraDraftUiSave,
  createEraDraftUiSave,
  loadAndRestoreEraDraftUiSave,
  parseEraDraftUiSave,
  persistAcceptedEraDraftTransition,
  readEraDraftUiSave,
  type EraDraftUiStorage,
  type Phase2EraDraftState,
} from "./eraDraftUiPersistence.js";
import { createEraDraftWebAssets } from "./eraDraftWebArtifacts.js";

const catalog = loadEraDraftCatalog();
const webAssets = createEraDraftWebAssets(loadEraDraftCatalogDocuments());

test("UI save envelope strictly round-trips every Phase 2 authoritative phase", async () => {
  const states = phase2States("ui-save-round-trip");
  for (const state of states) {
    const save = createEraDraftUiSave(state);
    assert.equal(save.envelope.uiSaveVersion, ERA_DRAFT_UI_SAVE_VERSION);
    assert.equal(save.envelope.presentationCursor, null);
    assert.equal(save.summary.eraId, state.eraId);
    assert.equal(save.summary.phase, state.phase);
    assert.equal(save.summary.pickCount, state.picks.length);
    assert.equal(save.raw.includes("selectedCandidate"), false);

    const entry = webAssets.manifest.eras.find((item) => item.eraId === state.eraId)!;
    const restored = await loadAndRestoreEraDraftUiSave({
      save: parseEraDraftUiSave(save.raw),
      manifest: webAssets.manifest,
      manifestUrl: new URL("https://example.test/data/era-draft/v1/manifest.json"),
      fetcher: async () => new Response(webAssets.artifacts.get(entry.path)!.json),
      subtle: webcrypto.subtle as unknown as SubtleCrypto,
    });
    assert.deepEqual(restored.state, state);
  }
});

test("rejected transitions never replace the stored authoritative save", () => {
  const storage = new MemoryStorage();
  const state = phase2States("ui-save-rejected")[0]!;
  const acceptedResult = reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed: "persist-accepted" }), {
    type: "CHOOSE_ERA",
    eraId: "era-foundation",
  });
  assert.equal(persistAcceptedEraDraftTransition(acceptedResult, storage).kind, "SAVED");
  const before = storage.getItem(ERA_DRAFT_UI_STORAGE_KEY);
  const rejected = reduceEraDraft(catalog, state, { type: "CHOOSE_ERA", eraId: "era-expansion" });
  assert.equal(rejected.ok, false);
  assert.equal(persistAcceptedEraDraftTransition(rejected, storage).kind, "SKIPPED_REJECTED");
  assert.equal(storage.getItem(ERA_DRAFT_UI_STORAGE_KEY), before);
});

test("every Phase 2 accepted command writes the resulting authoritative phase", () => {
  const storage = new MemoryStorage();
  const states = phase2States("ui-save-autosave-points");
  const expectedCommands = ["CHOOSE_ERA", "SPIN", "LOCK_PLAYER", "RESPIN", "LOCK_PLAYER", "REVEAL_XI"];
  assert.deepEqual(states.map((state) => state.history.at(-1)!.command), expectedCommands);
  for (const state of states) {
    const result = { ok: true, state, event: state.history.at(-1)! } satisfies EraDraftTransitionResult;
    assert.equal(persistAcceptedEraDraftTransition(result, storage).kind, "SAVED");
    const read = readEraDraftUiSave(storage);
    assert.equal(read.kind, "CANDIDATE");
    if (read.kind === "CANDIDATE") {
      assert.equal(read.save.summary.phase, state.phase);
      assert.equal(read.save.summary.revision, state.revision);
    }
  }
});

test("save inspection rejects malformed envelopes, versions, eras, and serialized state", () => {
  const save = createEraDraftUiSave(phase2States("ui-save-invalid")[0]!);
  assert.throws(() => parseEraDraftUiSave("{"), hasUiCode("INVALID_UI_SAVE_JSON"));
  assert.throws(() => parseEraDraftUiSave(JSON.stringify({})), hasUiCode("INVALID_UI_SAVE_ENVELOPE"));
  assert.throws(() => parseEraDraftUiSave(JSON.stringify({
    ...save.envelope,
    uiSaveVersion: "era-draft-ui-save/v0",
  })), hasUiCode("UNSUPPORTED_UI_SAVE_VERSION"));
  assert.throws(() => parseEraDraftUiSave(tamperedEngine(save.raw, (engine) => {
    engine.eraId = "era-unknown";
  })), hasUiCode("INVALID_UI_SAVE_STATE"));
  assert.throws(() => parseEraDraftUiSave(JSON.stringify({
    ...save.envelope,
    serializedEngineState: "not-json",
  })), hasUiCode("INVALID_UI_SAVE_STATE"));
});

test("Continue fetches only the saved era and verifies its artifact before strict restore", async () => {
  const state = phase2States("ui-save-continue").find((item) => item.phase === "AWAITING_PICK")!;
  const save = createEraDraftUiSave(state);
  const requested: string[] = [];
  const entry = webAssets.manifest.eras.find((item) => item.eraId === state.eraId)!;
  const restored = await loadAndRestoreEraDraftUiSave({
    save,
    manifest: webAssets.manifest,
    manifestUrl: new URL("https://example.test/data/era-draft/v1/manifest.json"),
    fetcher: async (url) => {
      requested.push(String(url));
      return new Response(webAssets.artifacts.get(entry.path)!.json);
    },
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
  });
  assert.deepEqual(restored.state, state);
  assert.deepEqual(requested, [`https://example.test/data/era-draft/v1/${entry.path}`]);

  const fingerprintMismatch = parseEraDraftUiSave(tamperedEngine(save.raw, (engine) => {
    engine.catalogFingerprint = "0".repeat(64);
  }));
  await assert.rejects(() => loadAndRestoreEraDraftUiSave({
    save: fingerprintMismatch,
    manifest: webAssets.manifest,
    manifestUrl: new URL("https://example.test/data/era-draft/v1/manifest.json"),
    fetcher: async () => new Response(webAssets.artifacts.get(entry.path)!.json),
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
  }), hasUiCode("INVALID_UI_SAVE_STATE"));

  await assert.rejects(() => loadAndRestoreEraDraftUiSave({
    save: fingerprintMismatch,
    manifest: webAssets.manifest,
    manifestUrl: new URL("https://example.test/data/era-draft/v1/manifest.json"),
    fetcher: async () => new Response("corrupt"),
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
  }), (error) => error instanceof EraDraftDataError && error.code === "WEB_ARTIFACT_SIZE_MISMATCH");
});

test("storage failures preserve the accepted in-memory state and remain recoverable", () => {
  const state = phase2States("ui-save-storage")[0]!;
  const snapshot = canonicalJson(state);
  const result = { ok: true, state, event: state.history.at(-1)! } satisfies EraDraftTransitionResult;
  const failing = new MemoryStorage({ writeFailure: true });
  assert.throws(() => persistAcceptedEraDraftTransition(result, failing), (error) =>
    hasUiCode("STORAGE_WRITE_FAILED")(error)
      && error instanceof Error
      && /progress may be lost if you refresh or close it/.test(error.message));
  assert.equal(canonicalJson(state), snapshot);
  assert.equal(failing.getItem(ERA_DRAFT_UI_STORAGE_KEY), null);

  const storage = new MemoryStorage();
  storage.setItem(ERA_DRAFT_UI_STORAGE_KEY, "bad-json");
  assert.equal(readEraDraftUiSave(storage).kind, "INVALID");
  clearEraDraftUiSave(storage);
  assert.equal(readEraDraftUiSave(storage).kind, "EMPTY");
});

function phase2States(seed: string): readonly Phase2EraDraftState[] {
  const setup = createEraDraftGame({ catalog, rootSeed: seed });
  const awaitingSpin = accepted(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  const awaitingPick = accepted(reduceEraDraft(catalog, awaitingSpin, { type: "SPIN" }));
  const firstView = projectEraDraftPublicState(catalog, hidden(awaitingPick));
  if (firstView.phase !== "AWAITING_PICK") throw new Error("Expected candidate view.");
  const first = firstView.candidates.flatMap((candidate) => candidate.positions.map((position) => ({ candidate, position })))
    .find(({ position }) => position.available)!;
  const partial = accepted(reduceEraDraft(catalog, awaitingPick, {
    type: "LOCK_PLAYER",
    playerTeamSeasonId: first.candidate.playerTeamSeasonId,
    battingPosition: first.position.battingPosition,
  }));
  const partialPick = accepted(reduceEraDraft(catalog, partial, { type: "SPIN" }));
  const respun = accepted(reduceEraDraft(catalog, partialPick, { type: "RESPIN" }));
  let state = partial;
  while (state.picks.length < 11) {
    if (state.phase !== "AWAITING_SPIN") throw new Error("Expected awaiting spin.");
    state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
    const view = projectEraDraftPublicState(catalog, hidden(state));
    if (view.phase !== "AWAITING_PICK") throw new Error("Expected awaiting pick.");
    const choice = view.candidates.flatMap((candidate) => candidate.positions.map((position) => ({ candidate, position })))
      .find(({ position }) => position.available)!;
    state = accepted(reduceEraDraft(catalog, state, {
      type: "LOCK_PLAYER",
      playerTeamSeasonId: choice.candidate.playerTeamSeasonId,
      battingPosition: choice.position.battingPosition,
    }));
  }
  if (state.phase !== "XI_COMPLETE") throw new Error("Expected XI complete.");
  const revealed = accepted(reduceEraDraft(catalog, state, { type: "REVEAL_XI" }));
  if (revealed.phase !== "REVEALED") throw new Error("Expected revealed state.");
  return [awaitingSpin, awaitingPick, partial, respun, state, revealed];
}

function accepted(result: EraDraftTransitionResult): Phase2EraDraftState {
  if (!result.ok) assert.fail(result.error.message);
  if (result.state.phase === "SETUP" || result.state.phase === "GAME_COMPLETE") assert.fail("Unexpected phase.");
  return result.state;
}

function hidden(state: Phase2EraDraftState) {
  if (state.phase === "REVEALED") throw new Error("Expected hidden Phase 2 state.");
  return state;
}

function tamperedEngine(raw: string, mutate: (engine: Record<string, unknown>) => void): string {
  const envelope = JSON.parse(raw) as Record<string, unknown>;
  const engine = JSON.parse(envelope.serializedEngineState as string) as Record<string, unknown>;
  mutate(engine);
  envelope.serializedEngineState = JSON.stringify(engine);
  return JSON.stringify(envelope);
}

function hasUiCode(code: EraDraftUiSaveError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof EraDraftUiSaveError && error.code === code;
}

class MemoryStorage implements EraDraftUiStorage {
  readonly values = new Map<string, string>();
  readonly writeFailure: boolean;

  constructor(options: { readonly writeFailure?: boolean } = {}) {
    this.writeFailure = options.writeFailure ?? false;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.writeFailure) throw new Error("quota");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
