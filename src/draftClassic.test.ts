import test from "node:test";
import assert from "node:assert/strict";
import {
  type DraftPlayerSeason,
  createSeededRandom,
  createClassicDraftState,
  isLegalPlayerSelection,
  loadDraftPool,
  pickPlayer,
  spinFranchiseSeason,
  useVoluntaryRespin,
} from "./draftClassic.js";

test("loadDraftPool validates game-ready wicketkeeper and overseas metadata", () => {
  const pool = loadDraftPool([
    player({ id: "a", playerId: "a", isWicketkeeper: true, isOverseas: false }),
    player({ id: "b", playerId: "b", isWicketkeeper: false, isOverseas: true }),
  ]);

  assert.equal(pool.players.length, 2);
  assert.equal(pool.players[0]?.isWicketkeeper, true);
  assert.equal(pool.players[1]?.isOverseas, true);
});

test("loadDraftPool validates and preserves rated player-season fields", () => {
  const pool = loadDraftPool([
    player({
      id: "rated",
      playerId: "rated",
      battingRating: 75.678,
      bowlingRating: null,
      baseRating: 69.6,
      ratingConfidence: "high",
      absoluteTier: "A",
      draftTier: "S",
      tierAdjustment: "franchise_coverage",
    }),
  ]);

  assert.equal(pool.players[0]?.battingRating, 75.678);
  assert.equal(pool.players[0]?.bowlingRating, null);
  assert.equal(pool.players[0]?.baseRating, 69.6);
  assert.equal(pool.players[0]?.absoluteTier, "A");
  assert.equal(pool.players[0]?.draftTier, "S");
  assert.equal(pool.players[0]?.tierAdjustment, "franchise_coverage");
});

test("loadDraftPool rejects baseRating outside generated rating bounds", () => {
  assert.throws(
    () => loadDraftPool([player({ baseRating: 83.1 })]),
    /baseRating within 30\.\.83/,
  );
  assert.throws(
    () => loadDraftPool([player({ baseRating: 29.9 })]),
    /baseRating within 30\.\.83/,
  );
});

test("a fifth overseas player is illegal", () => {
  const state = createClassicDraftState();
  state.slots = [1, 2, 3, 4].map((position) => ({
    position: position as 1 | 2 | 3 | 4,
    player: player({ id: `o${position}`, playerId: `o${position}`, isOverseas: true }),
  }));

  assert.deepEqual(
    isLegalPlayerSelection(state, player({ id: "extra", playerId: "extra", isOverseas: true })),
    { ok: false, reason: "The XI cannot include more than 4 overseas players." },
  );
});

test("the final XI slot cannot be filled without a wicketkeeper", () => {
  const state = createClassicDraftState();
  state.slots = Array.from({ length: 10 }, (_, index) => ({
    position: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
    player: player({ id: `p${index}`, playerId: `p${index}`, isWicketkeeper: false }),
  }));

  assert.deepEqual(
    isLegalPlayerSelection(state, player({ id: "non-wk", playerId: "non-wk", isWicketkeeper: false })),
    { ok: false, reason: "A completed XI must include a wicketkeeper." },
  );
  assert.deepEqual(isLegalPlayerSelection(state, player({ id: "wk", playerId: "wk", isWicketkeeper: true })), { ok: true });
});

test("picked players lock into their batting position and cannot be duplicated", () => {
  const pool = loadDraftPool([
    player({ id: "wk-season", playerId: "same-player", isWicketkeeper: true, franchise: "Team A" }),
    player({ id: "other-season", playerId: "other", franchise: "Team A" }),
  ]);
  const random = () => 0;
  const spun = spinFranchiseSeason(pool, createClassicDraftState(), random);
  const picked = pickPlayer(pool, spun, "wk-season", 4, random);

  assert.equal(picked.slots[0]?.position, 4);
  assert.equal(picked.slots[0]?.player.id, "wk-season");
  assert.deepEqual(
    isLegalPlayerSelection(picked, player({ id: "duplicate-season", playerId: "same-player" })),
    { ok: false, reason: "That player is already locked in this XI." },
  );
});

test("spins do not repeat a franchise from the previous two displayed franchises when alternatives exist", () => {
  const pool = loadDraftPool([
    player({ id: "a", playerId: "a", franchise: "Team A" }),
    player({ id: "b", playerId: "b", franchise: "Team B" }),
    player({ id: "c", playerId: "c", franchise: "Team C" }),
    player({ id: "d", playerId: "d", franchise: "Team D" }),
  ]);
  const random = () => 0;

  const first = spinFranchiseSeason(pool, createClassicDraftState(), random);
  const second = spinFranchiseSeason(pool, first, random);
  const third = spinFranchiseSeason(pool, second, random);

  assert.equal(first.currentSquadKey, "2016 Team A");
  assert.equal(second.currentSquadKey, "2016 Team B");
  assert.equal(third.currentSquadKey, "2016 Team C");
  assert.deepEqual(third.recentFranchiseCooldownKeys, ["Team B", "Team C"]);
});

test("voluntary respins record both the discarded and displayed franchise in cooldown history", () => {
  const pool = loadDraftPool([
    player({ id: "a", playerId: "a", franchise: "Team A" }),
    player({ id: "b", playerId: "b", franchise: "Team B" }),
    player({ id: "c", playerId: "c", franchise: "Team C" }),
  ]);
  const random = () => 0;

  const spun = spinFranchiseSeason(pool, createClassicDraftState(), random);
  const respun = useVoluntaryRespin(pool, spun, random);

  assert.equal(spun.currentSquadKey, "2016 Team A");
  assert.equal(respun.currentSquadKey, "2016 Team B");
  assert.deepEqual(respun.recentFranchiseCooldownKeys, ["Team A", "Team B"]);
});

test("spin cooldown relaxes the oldest exclusion first for small franchise pools", () => {
  const pool = loadDraftPool([
    player({ id: "a", playerId: "a", franchise: "Team A" }),
    player({ id: "b", playerId: "b", franchise: "Team B" }),
  ]);
  const state = {
    ...createClassicDraftState(),
    recentFranchiseCooldownKeys: ["Team A", "Team B"],
  };

  const spun = spinFranchiseSeason(pool, state, () => 0);

  assert.equal(spun.currentSquadKey, "2016 Team A");
  assert.deepEqual(spun.recentFranchiseCooldownKeys, ["Team B", "Team A"]);
});

test("seeded spin reproducibility remains stable with franchise cooldown", () => {
  const pool = loadDraftPool([
    player({ id: "a", playerId: "a", franchise: "Team A" }),
    player({ id: "b", playerId: "b", franchise: "Team B" }),
    player({ id: "c", playerId: "c", franchise: "Team C" }),
    player({ id: "d", playerId: "d", franchise: "Team D" }),
  ]);

  function spinSequence(): (string | null)[] {
    const random = createSeededRandom("stable-spin");
    let state = createClassicDraftState();
    return Array.from({ length: 6 }, () => {
      state = spinFranchiseSeason(pool, state, random);
      return state.currentSquadKey;
    });
  }

  assert.deepEqual(spinSequence(), spinSequence());
});

function player(overrides: Partial<DraftPlayerSeason>): DraftPlayerSeason {
  return {
    id: "id",
    playerId: "player-id",
    name: "Player",
    franchise: "Team",
    season: 2016,
    sourceSeason: "2016",
    matchesPlayed: 1,
    seasonRole: "batter",
    preferredBattingPositions: [1],
    naturalPositions: [1],
    acceptablePositions: [1, 2],
    positionConfidence: "medium",
    bowlingOptionStrength: "none",
    displayedStats: {
      matches: 1,
      inningsBatted: 1,
      runs: 10,
      ballsFaced: 8,
      battingAverage: 10,
      strikeRate: 125,
      wickets: 0,
      legalBallsBowled: 0,
      runsConceded: 0,
      economy: null,
    },
    draftEligible: true,
    country: "India",
    isOverseas: false,
    isWicketkeeper: false,
    battingRating: 50,
    bowlingRating: null,
    baseRating: 50,
    ratingConfidence: "medium",
    absoluteTier: "C",
    draftTier: "C",
    tierAdjustment: null,
    ...overrides,
  };
}
