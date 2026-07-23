export type BattingPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export type DisplayedStats = {
  matches: number;
  inningsBatted: number;
  runs: number;
  ballsFaced: number;
  battingAverage: number | null;
  strikeRate: number | null;
  wickets: number;
  legalBallsBowled: number;
  runsConceded: number;
  economy: number | null;
};

export type Tier = "S" | "A" | "B" | "C" | "D";
export type TierAdjustment = "franchise_coverage" | null;
export type RatingConfidence = "high" | "medium" | "low";
export type PositionFit = "natural" | "acceptable" | "out_of_position";
export type SelectionBlockReason =
  | "draft_complete"
  | "duplicate_player"
  | "overseas_limit"
  | "wicketkeeper_required";
export type SelectionLegality =
  | { ok: true }
  | { ok: false; code: SelectionBlockReason; reason: string };

export type DraftPlayerSeason = {
  id: string;
  playerId: string;
  name: string;
  franchise: string;
  season: number;
  sourceSeason: string;
  matchesPlayed: number;
  seasonRole: string;
  preferredBattingPositions: BattingPosition[];
  naturalPositions: BattingPosition[];
  acceptablePositions: BattingPosition[];
  positionConfidence: string;
  bowlingOptionStrength: string;
  displayedStats: DisplayedStats;
  draftEligible: boolean;
  country: string;
  isOverseas: boolean;
  isWicketkeeper: boolean;
  battingRating: number | null;
  bowlingRating: number | null;
  baseRating: number;
  ratingConfidence: RatingConfidence;
  absoluteTier: Tier;
  draftTier: Tier;
  tierAdjustment: TierAdjustment;
};

export type DraftSlot = {
  position: BattingPosition;
  player: DraftPlayerSeason;
};

export type ClassicDraftState = {
  slots: DraftSlot[];
  currentSquadKey: string | null;
  recentFranchiseCooldownKeys: string[];
  respinsRemaining: number;
  completed: boolean;
};

export type DraftPool = {
  players: DraftPlayerSeason[];
  squadKeys: string[];
  bySquadKey: Map<string, DraftPlayerSeason[]>;
};

export const XI_SIZE = 11;
export const MAX_OVERSEAS = 4;
export const FRANCHISE_SPIN_COOLDOWN = 2;

const BATTING_POSITIONS: BattingPosition[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export function createClassicDraftState(): ClassicDraftState {
  return {
    slots: [],
    currentSquadKey: null,
    recentFranchiseCooldownKeys: [],
    respinsRemaining: 1,
    completed: false,
  };
}

export function loadDraftPool(raw: unknown): DraftPool {
  if (!Array.isArray(raw)) {
    throw new Error("rated_player_seasons.json must contain an array.");
  }

  const players = raw.map(validatePlayerSeason).filter((player) => player.draftEligible);
  if (players.length === 0) {
    throw new Error("No draft-eligible player seasons found.");
  }

  const bySquadKey = new Map<string, DraftPlayerSeason[]>();
  for (const player of players) {
    const key = squadKey(player);
    const squad = bySquadKey.get(key) ?? [];
    squad.push(player);
    bySquadKey.set(key, squad);
  }

  return {
    players,
    squadKeys: [...bySquadKey.keys()].sort(),
    bySquadKey,
  };
}

export function spinFranchiseSeason(
  pool: DraftPool,
  state: ClassicDraftState,
  random = Math.random,
): ClassicDraftState {
  ensureDraftOpen(state);
  const keys = getSpinCandidates(pool, state.recentFranchiseCooldownKeys);
  const nextKey = keys[Math.floor(random() * keys.length)];
  const nextCooldownKey = getSquadCooldownKey(pool, nextKey);
  return {
    ...state,
    currentSquadKey: nextKey,
    recentFranchiseCooldownKeys: recordFranchiseSpin(state.recentFranchiseCooldownKeys, nextCooldownKey),
  };
}

export function useVoluntaryRespin(
  pool: DraftPool,
  state: ClassicDraftState,
  random = Math.random,
): ClassicDraftState {
  ensureDraftOpen(state);
  if (state.currentSquadKey === null) {
    throw new Error("Spin before using the voluntary respin.");
  }
  if (state.respinsRemaining < 1) {
    throw new Error("The voluntary respin has already been used.");
  }
  return {
    ...spinFranchiseSeason(pool, state, random),
    respinsRemaining: state.respinsRemaining - 1,
  };
}

export function getCurrentSquad(pool: DraftPool, state: ClassicDraftState): DraftPlayerSeason[] {
  if (state.currentSquadKey === null) {
    return [];
  }
  return pool.bySquadKey.get(state.currentSquadKey) ?? [];
}

export function getOpenPositions(state: ClassicDraftState): BattingPosition[] {
  const filled = new Set(state.slots.map((slot) => slot.position));
  return BATTING_POSITIONS.filter((position) => !filled.has(position));
}

export function getLegalPlayers(pool: DraftPool, state: ClassicDraftState): DraftPlayerSeason[] {
  return getCurrentSquad(pool, state).filter((player) => isLegalPlayerSelection(state, player).ok);
}

export function isLegalPlayerSelection(
  state: ClassicDraftState,
  player: DraftPlayerSeason,
): SelectionLegality {
  if (state.completed) {
    return { ok: false, code: "draft_complete", reason: "The XI is already complete." };
  }

  if (state.slots.some((slot) => slot.player.playerId === player.playerId)) {
    return {
      ok: false,
      code: "duplicate_player",
      reason: "That player is already locked in this XI.",
    };
  }

  const overseasAfterPick = getOverseasCount(state) + (player.isOverseas ? 1 : 0);
  if (overseasAfterPick > MAX_OVERSEAS) {
    return {
      ok: false,
      code: "overseas_limit",
      reason: `The XI cannot include more than ${MAX_OVERSEAS} overseas players.`,
    };
  }

  const hasWicketkeeperAfterPick = hasWicketkeeper(state) || player.isWicketkeeper;
  const openSlotsAfterPick = XI_SIZE - state.slots.length - 1;
  if (!hasWicketkeeperAfterPick && openSlotsAfterPick === 0) {
    return {
      ok: false,
      code: "wicketkeeper_required",
      reason: "A completed XI must include a wicketkeeper.",
    };
  }

  return { ok: true };
}

export function pickPlayer(
  pool: DraftPool,
  state: ClassicDraftState,
  playerSeasonId: string,
  position: BattingPosition,
): ClassicDraftState {
  ensureDraftOpen(state);
  if (state.currentSquadKey === null) {
    throw new Error("Spin a franchise-season before picking.");
  }
  if (!getOpenPositions(state).includes(position)) {
    throw new Error(`Batting position ${position} is already locked.`);
  }

  const player = getCurrentSquad(pool, state).find((candidate) => candidate.id === playerSeasonId);
  if (!player) {
    throw new Error("That player is not in the current spun squad.");
  }

  const legality = isLegalPlayerSelection(state, player);
  if (!legality.ok) {
    throw new Error(legality.reason);
  }

  const slots = [...state.slots, { position, player }].sort((a, b) => a.position - b.position);
  const completed = slots.length === XI_SIZE;
  const nextState: ClassicDraftState = {
    ...state,
    slots,
    currentSquadKey: null,
    completed,
  };

  return nextState;
}

export function getOverseasCount(state: ClassicDraftState): number {
  return state.slots.filter((slot) => slot.player.isOverseas).length;
}

export function hasWicketkeeper(state: ClassicDraftState): boolean {
  return state.slots.some((slot) => slot.player.isWicketkeeper);
}

export function getPositionFit(player: DraftPlayerSeason, position: BattingPosition): PositionFit {
  if (
    player.preferredBattingPositions.includes(position) ||
    player.naturalPositions.includes(position) ||
    (isOpenerPosition(position) && player.naturalPositions.some(isOpenerPosition))
  ) {
    return "natural";
  }
  if (player.acceptablePositions.includes(position)) {
    return "acceptable";
  }
  return "out_of_position";
}

function isOpenerPosition(position: BattingPosition): boolean {
  return position === 1 || position === 2;
}

export function createSeededRandom(seed: string): () => number {
  let hash = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }

  return () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    const result = (hash ^= hash >>> 16) >>> 0;
    return result / 4294967296;
  };
}

export function parseBattingPosition(value: string): BattingPosition | null {
  const position = Number(value);
  return BATTING_POSITIONS.includes(position as BattingPosition) ? (position as BattingPosition) : null;
}

export function squadKey(player: Pick<DraftPlayerSeason, "season" | "franchise">): string {
  return `${player.season} ${player.franchise}`;
}

export function getFranchiseCooldownKey(player: Pick<DraftPlayerSeason, "franchise">): string {
  return player.franchise;
}

function getSpinCandidates(pool: DraftPool, recentFranchiseCooldownKeys: string[]): string[] {
  for (let excludedCount = Math.min(FRANCHISE_SPIN_COOLDOWN, recentFranchiseCooldownKeys.length); excludedCount >= 0; excludedCount -= 1) {
    const excluded = new Set(excludedCount > 0 ? recentFranchiseCooldownKeys.slice(-excludedCount) : []);
    const candidates = pool.squadKeys.filter((key) => !excluded.has(getSquadCooldownKey(pool, key)));
    if (candidates.length > 0) {
      return candidates;
    }
  }
  return pool.squadKeys;
}

function getSquadCooldownKey(pool: DraftPool, key: string): string {
  const squad = pool.bySquadKey.get(key);
  const firstPlayer = squad?.[0];
  if (!firstPlayer) {
    return key;
  }
  return getFranchiseCooldownKey(firstPlayer);
}

function recordFranchiseSpin(recentFranchiseCooldownKeys: string[], cooldownKey: string): string[] {
  return [...recentFranchiseCooldownKeys, cooldownKey].slice(-FRANCHISE_SPIN_COOLDOWN);
}

function ensureDraftOpen(state: ClassicDraftState): void {
  if (state.completed) {
    throw new Error("The XI is already complete.");
  }
}

function validatePlayerSeason(value: unknown, index: number): DraftPlayerSeason {
  if (!isRecord(value)) {
    throw new Error(`Player season at index ${index} must be an object.`);
  }

  const player: DraftPlayerSeason = {
    id: requiredString(value, "id", index),
    playerId: requiredString(value, "playerId", index),
    name: requiredString(value, "name", index),
    franchise: requiredString(value, "franchise", index),
    season: requiredNumber(value, "season", index),
    sourceSeason: requiredString(value, "sourceSeason", index),
    matchesPlayed: requiredNumber(value, "matchesPlayed", index),
    seasonRole: requiredString(value, "seasonRole", index),
    preferredBattingPositions: requiredPositions(value, "preferredBattingPositions", index),
    naturalPositions: requiredPositions(value, "naturalPositions", index),
    acceptablePositions: requiredPositions(value, "acceptablePositions", index),
    positionConfidence: requiredString(value, "positionConfidence", index),
    bowlingOptionStrength: requiredString(value, "bowlingOptionStrength", index),
    displayedStats: requiredDisplayedStats(value, index),
    draftEligible: requiredBoolean(value, "draftEligible", index),
    country: requiredString(value, "country", index),
    isOverseas: requiredBoolean(value, "isOverseas", index),
    isWicketkeeper: requiredBoolean(value, "isWicketkeeper", index),
    battingRating: optionalRating(value, "battingRating", index),
    bowlingRating: optionalRating(value, "bowlingRating", index),
    baseRating: requiredBaseRating(value, index),
    ratingConfidence: requiredRatingConfidence(value, index),
    absoluteTier: requiredTier(value, "absoluteTier", index),
    draftTier: requiredTier(value, "draftTier", index),
    tierAdjustment: optionalTierAdjustment(value, index),
  };

  return player;
}

function requiredDisplayedStats(value: Record<string, unknown>, index: number): DisplayedStats {
  const stats = value.displayedStats;
  if (!isRecord(stats)) {
    throw new Error(`Player season at index ${index} is missing displayedStats.`);
  }
  return {
    matches: requiredNumber(stats, "matches", index),
    inningsBatted: requiredNumber(stats, "inningsBatted", index),
    runs: requiredNumber(stats, "runs", index),
    ballsFaced: requiredNumber(stats, "ballsFaced", index),
    battingAverage: optionalNumber(stats, "battingAverage", index),
    strikeRate: optionalNumber(stats, "strikeRate", index),
    wickets: requiredNumber(stats, "wickets", index),
    legalBallsBowled: requiredNumber(stats, "legalBallsBowled", index),
    runsConceded: requiredNumber(stats, "runsConceded", index),
    economy: optionalNumber(stats, "economy", index),
  };
}

function requiredString(value: Record<string, unknown>, field: string, index: number): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`Player season at index ${index} must include string field ${field}.`);
  }
  return fieldValue;
}

function requiredNumber(value: Record<string, unknown>, field: string, index: number): number {
  const fieldValue = value[field];
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new Error(`Player season at index ${index} must include numeric field ${field}.`);
  }
  return fieldValue;
}

function requiredBaseRating(value: Record<string, unknown>, index: number): number {
  const fieldValue = requiredNumber(value, "baseRating", index);
  if (fieldValue < 30 || fieldValue > 83) {
    throw new Error(`Player season at index ${index} must include baseRating within 30..83.`);
  }
  return fieldValue;
}

function optionalNumber(value: Record<string, unknown>, field: string, index: number): number | null {
  const fieldValue = value[field];
  if (fieldValue === null) {
    return null;
  }
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new Error(`Player season at index ${index} must include numeric or null field ${field}.`);
  }
  return fieldValue;
}

function optionalRating(value: Record<string, unknown>, field: string, index: number): number | null {
  const fieldValue = value[field];
  if (fieldValue === null) {
    return null;
  }
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new Error(`Player season at index ${index} must include numeric or null field ${field}.`);
  }
  return fieldValue;
}

function requiredBoolean(value: Record<string, unknown>, field: string, index: number): boolean {
  const fieldValue = value[field];
  if (typeof fieldValue !== "boolean") {
    throw new Error(`Player season at index ${index} must include boolean field ${field}.`);
  }
  return fieldValue;
}

function requiredPositions(value: Record<string, unknown>, field: string, index: number): BattingPosition[] {
  const fieldValue = value[field];
  if (!Array.isArray(fieldValue)) {
    throw new Error(`Player season at index ${index} must include array field ${field}.`);
  }
  const positions = fieldValue.filter((position): position is BattingPosition =>
    typeof position === "number" && BATTING_POSITIONS.includes(position as BattingPosition),
  );
  if (positions.length !== fieldValue.length) {
    throw new Error(`Player season at index ${index} has an invalid batting position in ${field}.`);
  }
  return positions;
}

function requiredTier(value: Record<string, unknown>, field: string, index: number): Tier {
  const fieldValue = value[field];
  if (fieldValue === "S" || fieldValue === "A" || fieldValue === "B" || fieldValue === "C" || fieldValue === "D") {
    return fieldValue;
  }
  throw new Error(`Player season at index ${index} must include tier field ${field} as S, A, B, C or D.`);
}

function requiredRatingConfidence(value: Record<string, unknown>, index: number): RatingConfidence {
  const fieldValue = value.ratingConfidence;
  if (fieldValue === "high" || fieldValue === "medium" || fieldValue === "low") {
    return fieldValue;
  }
  throw new Error(`Player season at index ${index} must include ratingConfidence as high, medium or low.`);
}

function optionalTierAdjustment(value: Record<string, unknown>, index: number): TierAdjustment {
  const fieldValue = value.tierAdjustment;
  if (fieldValue === null || fieldValue === "franchise_coverage") {
    return fieldValue;
  }
  throw new Error(`Player season at index ${index} must include tierAdjustment as franchise_coverage or null.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
