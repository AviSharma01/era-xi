import { canonicalJson } from "./eraDraftCanonical.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { restoreEraDraftState, serializeEraDraftState } from "./eraDraftPersistence.js";
import {
  ERA_DRAFT_SAVE_VERSION,
  type AwaitingPickState,
  type AwaitingSpinState,
  type EraDraftTransitionResult,
  type GameCompleteState,
  type RevealedState,
  type XiCompleteState,
} from "./eraDraftTypes.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";
import {
  fetchScopedEraDraftCatalog,
  type EraDraftWebFetch,
  type EraDraftWebManifest,
} from "./eraDraftWebData.js";

export const ERA_DRAFT_UI_SAVE_VERSION = "era-draft-ui-save/v1" as const;
export const ERA_DRAFT_UI_STORAGE_KEY = "era-draft-ui-save/v1" as const;

export type Phase2EraDraftState = AwaitingSpinState | AwaitingPickState | XiCompleteState | RevealedState;
export type PersistableEraDraftState = Phase2EraDraftState | GameCompleteState;

export type EraDraftPresentationCursor =
  | { readonly phase: "LEAGUE"; readonly revealedUserMatches: number }
  | { readonly phase: "LEAGUE_COMPLETE" }
  | { readonly phase: "PLAYOFFS"; readonly revealedPlayoffMatches: number }
  | { readonly phase: "COMPLETE" };

export type EraDraftUiSaveEnvelope = {
  readonly uiSaveVersion: typeof ERA_DRAFT_UI_SAVE_VERSION;
  readonly serializedEngineState: string;
  readonly presentationCursor: EraDraftPresentationCursor | null;
};

export type EraDraftUiSaveSummary = {
  readonly eraId: EraId;
  readonly phase: PersistableEraDraftState["phase"];
  readonly pickCount: number;
  readonly revision: number;
};

export type EraDraftUiSaveCandidate = {
  readonly envelope: EraDraftUiSaveEnvelope;
  readonly summary: EraDraftUiSaveSummary;
  readonly raw: string;
};

export type EraDraftUiSaveReadResult =
  | { readonly kind: "EMPTY" }
  | { readonly kind: "CANDIDATE"; readonly save: EraDraftUiSaveCandidate }
  | { readonly kind: "INVALID"; readonly message: string }
  | { readonly kind: "UNAVAILABLE"; readonly message: string };

export type EraDraftUiStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type EraDraftUiSaveErrorCode =
  | "INVALID_UI_SAVE_JSON"
  | "INVALID_UI_SAVE_ENVELOPE"
  | "UNSUPPORTED_UI_SAVE_VERSION"
  | "INVALID_UI_SAVE_STATE"
  | "UNSUPPORTED_UI_SAVE_PHASE"
  | "INVALID_PRESENTATION_CURSOR"
  | "STORAGE_READ_FAILED"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_CLEAR_FAILED";

export class EraDraftUiSaveError extends Error {
  readonly code: EraDraftUiSaveErrorCode;

  constructor(code: EraDraftUiSaveErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EraDraftUiSaveError";
    this.code = code;
  }
}

export function readEraDraftUiSave(storage?: EraDraftUiStorage): EraDraftUiSaveReadResult {
  let raw: string | null;
  try {
    raw = (storage ?? window.localStorage).getItem(ERA_DRAFT_UI_STORAGE_KEY);
  } catch (error) {
    return { kind: "UNAVAILABLE", message: "Local save storage is unavailable in this browser." };
  }
  if (raw === null) return { kind: "EMPTY" };
  try {
    return { kind: "CANDIDATE", save: parseEraDraftUiSave(raw) };
  } catch (error) {
    return {
      kind: "INVALID",
      message: error instanceof Error ? error.message : "The local Era Draft save is invalid.",
    };
  }
}

export function parseEraDraftUiSave(raw: string): EraDraftUiSaveCandidate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_JSON", "The local Era Draft save is not valid JSON.", { cause: error });
  }
  const row = object(parsed, "UI save envelope");
  exactKeys(row, ["uiSaveVersion", "serializedEngineState", "presentationCursor"], "UI save envelope");
  if (row.uiSaveVersion !== ERA_DRAFT_UI_SAVE_VERSION) {
    throw new EraDraftUiSaveError("UNSUPPORTED_UI_SAVE_VERSION", "The local Era Draft save uses an unsupported version.");
  }
  const presentationCursor = parsePresentationCursor(row.presentationCursor);
  if (typeof row.serializedEngineState !== "string" || row.serializedEngineState.length === 0) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_ENVELOPE", "The local Era Draft save has no serialized engine state.");
  }
  const envelope: EraDraftUiSaveEnvelope = {
    uiSaveVersion: ERA_DRAFT_UI_SAVE_VERSION,
    serializedEngineState: row.serializedEngineState,
    presentationCursor,
  };
  const summary = inspectSerializedEngineState(envelope.serializedEngineState);
  validateCursorSummary(summary, presentationCursor);
  return { envelope, summary, raw };
}

export function createEraDraftUiSave(
  state: PersistableEraDraftState,
  presentationCursor: EraDraftPresentationCursor | null = null,
): EraDraftUiSaveCandidate {
  validateEraDraftPresentationCursor(state, presentationCursor);
  const envelope: EraDraftUiSaveEnvelope = {
    uiSaveVersion: ERA_DRAFT_UI_SAVE_VERSION,
    serializedEngineState: serializeEraDraftState(state),
    presentationCursor,
  };
  const raw = canonicalJson(envelope);
  return { envelope, summary: inspectSerializedEngineState(envelope.serializedEngineState), raw };
}

export function writeEraDraftUiSave(
  state: PersistableEraDraftState,
  storage?: EraDraftUiStorage,
  presentationCursor: EraDraftPresentationCursor | null = null,
): EraDraftUiSaveCandidate {
  const save = createEraDraftUiSave(state, presentationCursor);
  try {
    (storage ?? window.localStorage).setItem(ERA_DRAFT_UI_STORAGE_KEY, save.raw);
  } catch (error) {
    throw new EraDraftUiSaveError("STORAGE_WRITE_FAILED", "The game is playable, but this update could not be saved locally.", { cause: error });
  }
  return save;
}

export function persistAcceptedEraDraftTransition(
  result: EraDraftTransitionResult,
  storage?: EraDraftUiStorage,
  presentationCursor: EraDraftPresentationCursor | null = null,
): { readonly kind: "SKIPPED_REJECTED" } | { readonly kind: "SAVED"; readonly save: EraDraftUiSaveCandidate } {
  if (!result.ok) return { kind: "SKIPPED_REJECTED" };
  const state = persistableState(result.state);
  return { kind: "SAVED", save: writeEraDraftUiSave(state, storage, presentationCursor) };
}

export function clearEraDraftUiSave(storage?: EraDraftUiStorage): void {
  try {
    (storage ?? window.localStorage).removeItem(ERA_DRAFT_UI_STORAGE_KEY);
  } catch (error) {
    throw new EraDraftUiSaveError("STORAGE_CLEAR_FAILED", "The invalid local save could not be removed.", { cause: error });
  }
}

export async function loadAndRestoreEraDraftUiSave(input: {
  readonly save: EraDraftUiSaveCandidate;
  readonly manifest: EraDraftWebManifest;
  readonly manifestUrl: URL;
  readonly fetcher?: EraDraftWebFetch;
  readonly subtle?: SubtleCrypto;
}): Promise<{ readonly catalog: EraDraftCatalog; readonly state: PersistableEraDraftState; readonly presentationCursor: EraDraftPresentationCursor | null }> {
  const catalog = await fetchScopedEraDraftCatalog({
    manifest: input.manifest,
    manifestUrl: input.manifestUrl,
    eraId: input.save.summary.eraId,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.subtle ? { subtle: input.subtle } : {}),
  });
  const restored = persistableState(restoreEraDraftState(catalog, input.save.envelope.serializedEngineState));
  if (restored.eraId !== input.save.summary.eraId || restored.phase !== input.save.summary.phase) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_STATE", "The local save summary does not match its authoritative state.");
  }
  validateEraDraftPresentationCursor(restored, input.save.envelope.presentationCursor);
  return { catalog, state: restored, presentationCursor: input.save.envelope.presentationCursor };
}

function inspectSerializedEngineState(serialized: string): EraDraftUiSaveSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_STATE", "The local save contains invalid serialized engine state.", { cause: error });
  }
  const row = object(parsed, "serialized engine state");
  if (row.saveVersion !== ERA_DRAFT_SAVE_VERSION) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_STATE", "The local save contains an unsupported engine save version.");
  }
  const phase = oneOf(row.phase, ["AWAITING_SPIN", "AWAITING_PICK", "XI_COMPLETE", "REVEALED", "GAME_COMPLETE"] as const, "phase");
  const eraId = oneOf(row.eraId, ERA_IDS, "eraId");
  const picks = Array.isArray(row.picks) ? row.picks : invalid("Serialized engine picks must be an array.");
  const revision = integer(row.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  const pickCount = picks.length;
  if (pickCount > 11 || ((phase === "XI_COMPLETE" || phase === "REVEALED" || phase === "GAME_COMPLETE") && pickCount !== 11)) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_STATE", "The local save has an invalid pick count for its phase.");
  }
  return { eraId, phase, pickCount, revision };
}

function persistableState(state: ReturnType<typeof restoreEraDraftState> | EraDraftTransitionResult["state"]): PersistableEraDraftState {
  if (state.phase === "AWAITING_SPIN" || state.phase === "AWAITING_PICK" || state.phase === "XI_COMPLETE"
    || state.phase === "REVEALED" || state.phase === "GAME_COMPLETE") {
    return state;
  }
  throw new EraDraftUiSaveError("UNSUPPORTED_UI_SAVE_PHASE", `The web UI cannot persist authoritative phase ${state.phase}.`);
}

export function validateEraDraftPresentationCursor(
  state: PersistableEraDraftState,
  cursor: EraDraftPresentationCursor | null,
): void {
  if (state.phase !== "GAME_COMPLETE") {
    if (cursor !== null) cursorError("Draft and reveal states cannot carry a season presentation cursor.");
    return;
  }
  if (cursor === null) cursorError("A completed season requires a presentation cursor.");
  if (cursor.phase === "LEAGUE") {
    if (cursor.revealedUserMatches < 1 || cursor.revealedUserMatches > 14) {
      cursorError("League cursor must reveal between one and fourteen user matches.");
    }
    return;
  }
  if (cursor.phase === "PLAYOFFS") {
    if (!state.season.userOutcome.qualified) cursorError("A non-qualifier cannot have a playoffs cursor.");
    const userPlayoffMatches = state.season.league.playoffs.filter((match) =>
      match.firstBattingTeamId === "user" || match.chasingTeamId === "user").length;
    if (cursor.revealedPlayoffMatches < 1 || cursor.revealedPlayoffMatches > userPlayoffMatches) {
      cursorError("Playoffs cursor exceeds the stored user playoff route.");
    }
  }
}

function parsePresentationCursor(value: unknown): EraDraftPresentationCursor | null {
  if (value === null) return null;
  const row = object(value, "presentation cursor");
  const phase = oneOf(row.phase, ["LEAGUE", "LEAGUE_COMPLETE", "PLAYOFFS", "COMPLETE"] as const, "presentation cursor phase");
  if (phase === "LEAGUE") {
    exactKeys(row, ["phase", "revealedUserMatches"], "presentation cursor");
    return { phase, revealedUserMatches: integer(row.revealedUserMatches, "revealed user matches", 1, 14) };
  }
  if (phase === "PLAYOFFS") {
    exactKeys(row, ["phase", "revealedPlayoffMatches"], "presentation cursor");
    return { phase, revealedPlayoffMatches: integer(row.revealedPlayoffMatches, "revealed playoff matches", 1, 4) };
  }
  exactKeys(row, ["phase"], "presentation cursor");
  return { phase };
}

function validateCursorSummary(summary: EraDraftUiSaveSummary, cursor: EraDraftPresentationCursor | null): void {
  if (summary.phase === "GAME_COMPLETE" && cursor === null) {
    cursorError("A completed season save is missing its presentation cursor.");
  }
  if (summary.phase !== "GAME_COMPLETE" && cursor !== null) {
    cursorError("A draft or reveal save cannot carry a season presentation cursor.");
  }
}

function cursorError(message: string): never {
  throw new EraDraftUiSaveError("INVALID_PRESENTATION_CURSOR", message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_ENVELOPE", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_ENVELOPE", `${label} has unexpected fields.`);
  }
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_STATE", `The local save has an invalid ${label}.`);
  }
  return value as T[number];
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new EraDraftUiSaveError("INVALID_UI_SAVE_STATE", `The local save has an invalid ${label}.`);
  }
  return value as number;
}

function invalid(message: string): never {
  throw new EraDraftUiSaveError("INVALID_UI_SAVE_STATE", message);
}
