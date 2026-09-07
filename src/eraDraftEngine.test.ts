import assert from "node:assert/strict";
import test from "node:test";

import { loadEraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { evaluateFutureCompletion, evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import { selectNormalSpinTeamSeason } from "./eraDraftRng.js";
import { EraDraftInvariantError, type AwaitingPickState } from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();

test("new game and accepted commands follow SETUP -> AWAITING_SPIN -> AWAITING_PICK", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "phase-1-trace" });
  assert.equal(setup.phase, "SETUP");
  assert.equal(setup.revision, 0);
  assert.deepEqual(setup.rngCounters, { normalSpin: 0, voluntaryRespin: 0, deadSpinRecovery: 0 });
  assert.deepEqual(setup.history, []);
  assert.deepEqual(setup.picks, []);

  const chosen = reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" });
  assert.equal(chosen.ok, true);
  if (!chosen.ok) return;
  assert.equal(chosen.state.phase, "AWAITING_SPIN");
  assert.equal(chosen.state.revision, 1);

  const spun = reduceEraDraft(catalog, chosen.state, { type: "SPIN" });
  assert.equal(spun.ok, true);
  if (!spun.ok || spun.state.phase !== "AWAITING_PICK") return;
  assert.deepEqual(spun.state.currentSpin, {
    spinOrdinal: 0,
    origin: "NORMAL",
    teamSeasonId: "ts:team-mumbai-indians:ipl-2008",
    seasonId: "ipl-2008",
    teamId: "team-mumbai-indians",
    franchiseId: "franchise-mumbai-indians",
    recovery: null,
  });
  assert.equal(spun.state.revision, 2);
  assert.equal(spun.state.rngCounters.normalSpin, 1);
  assert.deepEqual(spun.state.history, [
    {
      revision: 1,
      command: "CHOOSE_ERA",
      payload: { eraId: "era-foundation" },
      resultingPhase: "AWAITING_SPIN",
    },
    {
      revision: 2,
      command: "SPIN",
      payload: {},
      resultingPhase: "AWAITING_PICK",
      spinOrdinal: 0,
      triggeringTeamSeasonId: "ts:team-mumbai-indians:ipl-2008",
      skippedDeadTeamSeasonIds: [],
      selectedTeamSeasonId: "ts:team-mumbai-indians:ipl-2008",
    },
  ]);
  assertEraDraftState(catalog, spun.state);
});

test("CHOOSE_ERA and SPIN reject invalid phases without changing authoritative state", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "rejection" });
  const badSpin = reduceEraDraft(catalog, setup, { type: "SPIN" });
  assert.equal(badSpin.ok, false);
  assert.equal(badSpin.state, setup);
  assert.equal(JSON.stringify(badSpin.state), JSON.stringify(setup));

  const chosen = requiredState(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  const repeatedEra = reduceEraDraft(catalog, chosen, { type: "CHOOSE_ERA", eraId: "era-expansion" });
  assert.equal(repeatedEra.ok, false);
  assert.equal(repeatedEra.state, chosen);

  const spun = requiredState(reduceEraDraft(catalog, chosen, { type: "SPIN" }));
  const snapshot = JSON.stringify(spun);
  const secondSpin = reduceEraDraft(catalog, spun, { type: "SPIN" });
  assert.equal(secondSpin.ok, false);
  assert.equal(secondSpin.state, spun);
  assert.equal(JSON.stringify(secondSpin.state), snapshot);
  assert.equal(secondSpin.state.revision, 2);
  assert.deepEqual(secondSpin.state.rngCounters, { normalSpin: 1, voluntaryRespin: 0, deadSpinRecovery: 0 });
  assert.equal(secondSpin.state.history.length, 2);
});

test("unknown era is a gameplay rejection and does not mutate SETUP", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "unknown-era" });
  const command = { type: "CHOOSE_ERA", eraId: "era-unknown" as EraId } as const;
  const result = reduceEraDraft(catalog, setup, command);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "UNKNOWN_ERA");
  assert.equal(result.state, setup);
});

test("normal spin uses root seed, era, and ordinal deterministically without cooldown", () => {
  const sequence = (seed: string) => Array.from({ length: 20 }, (_, ordinal) =>
    selectNormalSpinTeamSeason(catalog, seed, "era-foundation", ordinal).teamSeasonId);
  assert.deepEqual(sequence("stable-normal-spins"), sequence("stable-normal-spins"));
  assert.ok(new Set(sequence("stable-normal-spins")).size > 1);

  let repeated: { seed: string; teamSeasonId: string } | undefined;
  for (let seedIndex = 0; seedIndex < 1_000 && !repeated; seedIndex += 1) {
    const values = sequence(`repeat-${seedIndex}`);
    const index = values.findIndex((value, position) => position > 0 && value === values[position - 1]);
    if (index > 0) repeated = { seed: `repeat-${seedIndex}`, teamSeasonId: values[index]! };
  }
  assert.ok(repeated, "normal spin sampling should permit an immediate repeat because no cooldown exists");
});

test("successful transitions are immutable and do not mutate prior states", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "immutable" });
  const setupSnapshot = JSON.stringify(setup);
  const chosen = requiredState(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-impact" }));
  assert.equal(JSON.stringify(setup), setupSnapshot);
  assert.ok(Object.isFrozen(setup));
  assert.ok(Object.isFrozen(setup.rngCounters));
  assert.ok(Object.isFrozen(setup.history));
  assert.ok(Object.isFrozen(chosen));
  assert.notEqual(chosen, setup);

  const chosenSnapshot = JSON.stringify(chosen);
  const spun = requiredState(reduceEraDraft(catalog, chosen, { type: "SPIN" }));
  assert.equal(JSON.stringify(chosen), chosenSnapshot);
  assert.ok(Object.isFrozen(spun));
  assert.ok(Object.isFrozen(spun.history));
  assert.ok(Object.isFrozen(spun.rngCounters));
});

test("current spin and safe projection contain only the selected team-season candidates", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "safe-projection" });
  const chosen = requiredState(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-modern-pre-impact" }));
  const spun = requiredState(reduceEraDraft(catalog, chosen, { type: "SPIN" }));
  assert.equal(spun.phase, "AWAITING_PICK");
  const state = spun as AwaitingPickState;
  const view = projectEraDraftPublicState(catalog, state);
  assert.equal(view.phase, "AWAITING_PICK");
  if (view.phase !== "AWAITING_PICK") return;
  assert.ok(view.candidates.length > 0);
  assert.ok(view.candidates.every((candidate) => {
    const internal = catalog.getPlayer(candidate.playerTeamSeasonId);
    return internal?.teamSeasonId === state.currentSpin.teamSeasonId && internal.eraId === state.eraId;
  }));
  const candidateKeys = [
    "available", "franchiseId", "franchiseName", "playerId", "playerName", "playerTeamSeasonId", "positions",
    "seasonId", "seasonYear", "teamId", "teamName",
  ];
  assert.deepEqual(Object.keys(view.candidates[0]!).sort(), candidateKeys);
  assertNoHiddenQuality(view);
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.candidates));
  assert.ok(Object.isFrozen(view.candidates[0]!));
});

test("adversarial real-era drafting remains completable through ten picks and finishes with a keeper", () => {
  const eraId = "era-foundation" as const;
  const keeperIds = new Set(catalog.getKeeperCapablePlayerIds(eraId));
  let state = requiredState(reduceEraDraft(
    catalog,
    createEraDraftGame({ catalog, rootSeed: "adversarial-0" }),
    { type: "CHOOSE_ERA", eraId },
  ));
  let duplicateCandidatesEncountered = 0;

  for (let pickIndex = 0; pickIndex < 10; pickIndex += 1) {
    state = requiredState(reduceEraDraft(catalog, state, { type: "SPIN" }));
    assert.equal(state.phase, "AWAITING_PICK");
    if (state.phase !== "AWAITING_PICK") return;
    const activeState = state;
    const draftedIds = new Set(activeState.picks.map((pick) => pick.playerId));
    const candidates = catalog.getCandidatesForTeamSeason(activeState.currentSpin.teamSeasonId);
    duplicateCandidatesEncountered += candidates.filter((player) => draftedIds.has(player.playerId)).length;
    const overseasCount = activeState.picks.filter((pick) =>
      catalog.getPlayer(pick.playerTeamSeasonId)!.rosterStatus === "OVERSEAS").length;
    const orderedCandidates = [...candidates].sort((left, right) => {
      const keeperOrder = Number(keeperIds.has(left.playerId)) - Number(keeperIds.has(right.playerId));
      if (keeperOrder !== 0) return keeperOrder;
      if (overseasCount < 4) {
        const overseasOrder = Number(right.rosterStatus === "OVERSEAS") - Number(left.rosterStatus === "OVERSEAS");
        if (overseasOrder !== 0) return overseasOrder;
      }
      return left.playerTeamSeasonId.localeCompare(right.playerTeamSeasonId);
    });
    const awkwardPositions = [...getOpenBattingPositions(activeState.picks)]
      .sort((left, right) => Math.abs(right - 6) - Math.abs(left - 6) || right - left);
    const choice = orderedCandidates.flatMap((player) => awkwardPositions.map((battingPosition) => ({ player, battingPosition })))
      .find(({ player, battingPosition }) => evaluateSelectionLegality(catalog, {
        eraId,
        picks: activeState.picks,
        activeTeamSeasonId: activeState.currentSpin.teamSeasonId,
      }, { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition }).available);
    assert.ok(choice);
    state = requiredState(reduceEraDraft(catalog, state, {
      type: "LOCK_PLAYER",
      playerTeamSeasonId: choice.player.playerTeamSeasonId,
      battingPosition: choice.battingPosition,
    }));
    assert.equal(evaluateFutureCompletion(catalog, eraId, state.picks).feasible, true);
  }

  assert.equal(state.phase, "AWAITING_SPIN");
  assert.equal(state.picks.length, 10);
  assert.equal(state.picks.filter((pick) => catalog.getPlayer(pick.playerTeamSeasonId)!.rosterStatus === "OVERSEAS").length, 4);
  assert.equal(state.picks.some((pick) => keeperIds.has(pick.playerId)), false);
  assert.ok(duplicateCandidatesEncountered > 0);
  assert.deepEqual(state.picks.map((pick) => pick.battingPosition), [11, 1, 10, 2, 9, 3, 8, 4, 7, 5]);

  state = requiredState(reduceEraDraft(catalog, state, { type: "SPIN" }));
  assert.equal(state.phase, "AWAITING_PICK");
  if (state.phase !== "AWAITING_PICK") return;
  const finalSpinState = state;
  const finalChoice = catalog.getCandidatesForTeamSeason(finalSpinState.currentSpin.teamSeasonId)
    .find((player) => evaluateSelectionLegality(catalog, {
      eraId,
      picks: finalSpinState.picks,
      activeTeamSeasonId: finalSpinState.currentSpin.teamSeasonId,
    }, { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition: 6 }).available)!;
  state = requiredState(reduceEraDraft(catalog, state, {
    type: "LOCK_PLAYER",
    playerTeamSeasonId: finalChoice.playerTeamSeasonId,
    battingPosition: 6,
  }));
  assert.equal(state.phase, "XI_COMPLETE");
  assert.equal(state.picks.length, 11);
  assert.equal(state.picks.some((pick) => keeperIds.has(pick.playerId)), true);
  assertEraDraftState(catalog, state);
});

test("invariant violations are typed system failures rather than command rejections", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "bad-state" });
  const corrupt = { ...setup, revision: 1 };
  assert.throws(
    () => assertEraDraftState(catalog, corrupt),
    (error) => error instanceof EraDraftInvariantError && error.code === "INVALID_REVISION",
  );

  const chosen = requiredState(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  const spun = requiredState(reduceEraDraft(catalog, chosen, { type: "SPIN" })) as AwaitingPickState;
  const mismatchedHistory = {
    ...spun,
    history: [spun.history[0]!, { ...spun.history[1]!, selectedTeamSeasonId: "ts:invalid:ipl-2008" }],
  } as AwaitingPickState;
  assert.throws(
    () => assertEraDraftState(catalog, mismatchedHistory),
    (error) => error instanceof EraDraftInvariantError && error.code === "HISTORY_TEAM_SEASON_MISMATCH",
  );
});

function requiredState(result: ReturnType<typeof reduceEraDraft>) {
  if (!result.ok) assert.fail(result.error.message);
  return result.state;
}

function assertNoHiddenQuality(value: unknown): void {
  const forbidden = /battingRating|bowlingRating|overallRating|qualityTier|internalScore|primaryInternalScore|adjustedStrength|baseStrength|evaluation|numericEffect/i;
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (typeof item === "object" && item !== null) {
      for (const [key, nested] of Object.entries(item)) {
        assert.doesNotMatch(key, forbidden);
        visit(nested);
      }
    }
  };
  visit(value);
}
