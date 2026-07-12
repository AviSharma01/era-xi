import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  type DraftPool,
  MAX_OVERSEAS,
  XI_SIZE,
  createClassicDraftState,
} from "./draftClassic.js";
import { evaluateCompletedTeam } from "./teamEvaluation.js";
import { applyTeamBoostsV1 } from "./teamBoostV1.js";
import {
  FRANCHISES_2016,
  type Franchise2016Id,
  type OpponentStrengthProfile,
} from "./simulationV1.js";

export type CuratedXiEntry = {
  position: BattingPosition;
  playerSeasonId: string;
};

export type CuratedOpponentXi2016 = {
  franchiseId: Franchise2016Id;
  entries: readonly CuratedXiEntry[];
};

const ids = (values: readonly string[]): CuratedXiEntry[] =>
  values.map((playerSeasonId, index) => ({
    position: (index + 1) as BattingPosition,
    playerSeasonId,
  }));

export const CURATED_OPPONENT_XIS_2016: readonly CuratedOpponentXi2016[] = [
  {
    franchiseId: "delhi-daredevils",
    entries: ids([
      "372455c4-2016-delhi-daredevils", "85ec8e33-2016-delhi-daredevils",
      "944533a5-2016-delhi-daredevils", "a4cc73aa-2016-delhi-daredevils",
      "2e8994e7-2016-delhi-daredevils", "919a3be2-2016-delhi-daredevils",
      "fb66ce1f-2016-delhi-daredevils", "f62772e5-2016-delhi-daredevils",
      "6b19d823-2016-delhi-daredevils", "8cf9814c-2016-delhi-daredevils",
      "91a4a398-2016-delhi-daredevils",
    ]),
  },
  {
    franchiseId: "gujarat-lions",
    entries: ids([
      "b8a55852-2016-gujarat-lions", "b8d490fd-2016-gujarat-lions",
      "1dc12ab9-2016-gujarat-lions", "c03f1114-2016-gujarat-lions",
      "35205dfc-2016-gujarat-lions", "fe93fd9d-2016-gujarat-lions",
      "87e562a9-2016-gujarat-lions", "e938e1bc-2016-gujarat-lions",
      "d2a989fc-2016-gujarat-lions", "6aed7e79-2016-gujarat-lions",
      "1da489ff-2016-gujarat-lions",
    ]),
  },
  {
    franchiseId: "kings-xi-punjab",
    entries: ids([
      "4b57e452-2016-kings-xi-punjab", "c03e2850-2016-kings-xi-punjab",
      "fe11caa6-2016-kings-xi-punjab", "d67d5f00-2016-kings-xi-punjab",
      "b681e71e-2016-kings-xi-punjab", "6eb146d2-2016-kings-xi-punjab",
      "d9273ee7-2016-kings-xi-punjab", "2e171977-2016-kings-xi-punjab",
      "759ac88f-2016-kings-xi-punjab", "edb3d4f8-2016-kings-xi-punjab",
      "ce820073-2016-kings-xi-punjab",
    ]),
  },
  {
    franchiseId: "kolkata-knight-riders",
    entries: ids([
      "bb345e0b-2016-kolkata-knight-riders", "1c17e270-2016-kolkata-knight-riders",
      "93b4fc78-2016-kolkata-knight-riders", "3c6ffae8-2016-kolkata-knight-riders",
      "bbd41817-2016-kolkata-knight-riders", "7dc35884-2016-kolkata-knight-riders",
      "271f83cd-2016-kolkata-knight-riders", "98ae73b1-2016-kolkata-knight-riders",
      "9d430b40-2016-kolkata-knight-riders", "cc1e8c68-2016-kolkata-knight-riders",
      "5bb5a915-2016-kolkata-knight-riders",
    ]),
  },
  {
    franchiseId: "mumbai-indians",
    entries: ids([
      "b5da6c24-2016-mumbai-indians", "740742ef-2016-mumbai-indians",
      "70d205c9-2016-mumbai-indians", "99b75528-2016-mumbai-indians",
      "a757b0d8-2016-mumbai-indians", "5b8c830e-2016-mumbai-indians",
      "dbe50b21-2016-mumbai-indians", "8b5b6769-2016-mumbai-indians",
      "13c35c9e-2016-mumbai-indians", "51a3c5ef-2016-mumbai-indians",
      "462411b3-2016-mumbai-indians",
    ]),
  },
  {
    franchiseId: "rising-pune-supergiants",
    entries: ids([
      "29e95537-2016-rising-pune-supergiants", "3355b542-2016-rising-pune-supergiants",
      "30a45b23-2016-rising-pune-supergiants", "4a8a2e3b-2016-rising-pune-supergiants",
      "0f12f9df-2016-rising-pune-supergiants", "709b0bac-2016-rising-pune-supergiants",
      "33a364a6-2016-rising-pune-supergiants", "495d42a5-2016-rising-pune-supergiants",
      "66b30f71-2016-rising-pune-supergiants", "e2db2409-2016-rising-pune-supergiants",
      "5bb1a1c4-2016-rising-pune-supergiants",
    ]),
  },
  {
    franchiseId: "royal-challengers-bangalore",
    entries: ids([
      "db584dad-2016-royal-challengers-bangalore", "ba607b88-2016-royal-challengers-bangalore",
      "c4487b84-2016-royal-challengers-bangalore", "b17e2f24-2016-royal-challengers-bangalore",
      "4329fbb5-2016-royal-challengers-bangalore", "dc9dd038-2016-royal-challengers-bangalore",
      "bd17b45f-2016-royal-challengers-bangalore", "ffe699c0-2016-royal-challengers-bangalore",
      "957532de-2016-royal-challengers-bangalore", "57ee1fde-2016-royal-challengers-bangalore",
      "85aae393-2016-royal-challengers-bangalore",
    ]),
  },
  {
    franchiseId: "sunrisers-hyderabad",
    entries: ids([
      "dcce6f09-2016-sunrisers-hyderabad", "0a476045-2016-sunrisers-hyderabad",
      "32198ae0-2016-sunrisers-hyderabad", "1c914163-2016-sunrisers-hyderabad",
      "73ad96ed-2016-sunrisers-hyderabad", "2e11c706-2016-sunrisers-hyderabad",
      "890946a0-2016-sunrisers-hyderabad", "c18496e1-2016-sunrisers-hyderabad",
      "2e81a32d-2016-sunrisers-hyderabad", "0a8fce53-2016-sunrisers-hyderabad",
      "d8b2f218-2016-sunrisers-hyderabad",
    ]),
  },
] as const;

export function buildOpponentStrengthProfiles2016(pool: DraftPool): OpponentStrengthProfile[] {
  if (CURATED_OPPONENT_XIS_2016.length !== FRANCHISES_2016.length) {
    throw new Error("Exactly one curated XI is required for every 2016 franchise.");
  }
  return CURATED_OPPONENT_XIS_2016.map((xi) => buildOpponentStrengthProfile2016(pool, xi));
}

export function buildOpponentStrengthProfile2016(
  pool: DraftPool,
  xi: CuratedOpponentXi2016,
): OpponentStrengthProfile {
  const state = buildCuratedOpponentState2016(pool, xi);
  const evaluation = evaluateCompletedTeam(state);
  const boosted = applyTeamBoostsV1(evaluation);
  const franchiseName = FRANCHISES_2016.find((franchise) => franchise.id === xi.franchiseId)?.name;
  if (!franchiseName) {
    throw new Error(`Unknown 2016 franchise: ${xi.franchiseId}`);
  }
  return {
    franchiseId: xi.franchiseId,
    franchiseName,
    season: 2016,
    baseStrength: {
      battingComposite: evaluation.battingComposite,
      bowlingComposite: evaluation.bowlingComposite,
      overallTeamRating: evaluation.overallTeamRating,
    },
    adjustedStrength: {
      battingComposite: boosted.adjustedBattingComposite,
      bowlingComposite: boosted.adjustedBowlingComposite,
      overallTeamRating: boosted.adjustedOverallTeamRating,
    },
    boostVersion: boosted.version,
    appliedBoostIds: boosted.appliedBoosts.map((boost) => boost.id),
  };
}

export function buildCuratedOpponentState2016(
  pool: DraftPool,
  xi: CuratedOpponentXi2016,
): ClassicDraftState {
  if (xi.entries.length !== XI_SIZE) {
    throw new Error(`${xi.franchiseId} curated XI must contain exactly ${XI_SIZE} players.`);
  }
  const expectedPositions = new Set(Array.from({ length: XI_SIZE }, (_, index) => index + 1));
  const positions = new Set(xi.entries.map((entry) => entry.position));
  if (positions.size !== XI_SIZE || [...expectedPositions].some((position) => !positions.has(position as BattingPosition))) {
    throw new Error(`${xi.franchiseId} curated XI must use batting positions 1-11 exactly once.`);
  }
  const byId = new Map(pool.players.map((player) => [player.id, player]));
  const selected = xi.entries.map((entry) => {
    const player = byId.get(entry.playerSeasonId);
    if (!player) {
      throw new Error(`${xi.franchiseId} curated XI references missing player-season ${entry.playerSeasonId}.`);
    }
    return { position: entry.position, player };
  });
  validateSelectedPlayers(xi, selected.map((slot) => slot.player));
  return {
    ...createClassicDraftState(),
    slots: selected.sort((left, right) => left.position - right.position),
    currentSquadKey: `2016 ${xi.franchiseId}`,
    completed: true,
  };
}

function validateSelectedPlayers(xi: CuratedOpponentXi2016, players: readonly DraftPlayerSeason[]): void {
  if (new Set(players.map((player) => player.id)).size !== XI_SIZE ||
      new Set(players.map((player) => player.playerId)).size !== XI_SIZE) {
    throw new Error(`${xi.franchiseId} curated XI must contain 11 unique players.`);
  }
  const franchiseName = FRANCHISES_2016.find((franchise) => franchise.id === xi.franchiseId)?.name;
  for (const player of players) {
    if (player.season !== 2016 || player.franchise !== franchiseName) {
      throw new Error(`${player.id} does not belong to ${franchiseName} 2016.`);
    }
  }
  if (players.filter((player) => player.isOverseas).length > MAX_OVERSEAS) {
    throw new Error(`${xi.franchiseId} curated XI exceeds the overseas-player limit.`);
  }
  if (!players.some((player) => player.isWicketkeeper)) {
    throw new Error(`${xi.franchiseId} curated XI must contain a wicketkeeper.`);
  }
}
