import assert from "node:assert/strict";
import test from "node:test";

import {
  loadEraDraftCatalog,
  type EraDraftCatalog,
  type EraDraftPlayerRecord,
} from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { getOpenBattingPositions } from "./eraDraftLegality.js";
import { projectEraDraftPublicState, projectEraDraftRevealState, toDraftPresentationFit } from "./eraDraftProjection.js";
import { buildEraDraftEvaluationInput } from "./eraDraftReveal.js";
import {
  EraDraftDataError,
  EraDraftInvariantError,
  type DraftCandidateIdentityView,
  type DraftPlayerFactsView,
  type EraDraftState,
  type XiCompleteState,
} from "./eraDraftTypes.js";
import { evaluateCompletedEraXi, type EraCompletedXiInput } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();

type Assert<T extends true> = T;
type ForbiddenDraftField =
  | "quality"
  | "battingRating"
  | "bowlingRating"
  | "overallRating"
  | "qualityTier"
  | "internalScore"
  | "baseStrength"
  | "adjustedStrength"
  | "evaluation"
  | "bandDistance";
const publicFactsHaveNoQualityFields: Assert<
  Extract<keyof DraftPlayerFactsView, ForbiddenDraftField> extends never ? true : false
> = true;
const internalRecordCannotSatisfyCandidateView: Assert<
  EraDraftPlayerRecord extends DraftCandidateIdentityView ? false : true
> = true;
void publicFactsHaveNoQualityFields;
void internalRecordCannotSatisfyCandidateView;

test("draft projections are structurally quality-free from SETUP through XI_COMPLETE", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "phase-3-hidden-boundary" });
  const awaitingSpin = requiredState(reduceEraDraft(catalog, setup, {
    type: "CHOOSE_ERA",
    eraId: "era-foundation",
  }));
  assert.equal(awaitingSpin.phase, "AWAITING_SPIN");
  if (awaitingSpin.phase !== "AWAITING_SPIN") return;
  const awaitingPick = requiredState(reduceEraDraft(catalog, awaitingSpin, { type: "SPIN" }));
  assert.equal(awaitingPick.phase, "AWAITING_PICK");
  if (awaitingPick.phase !== "AWAITING_PICK") return;
  const activeView = projectEraDraftPublicState(catalog, awaitingPick);
  assert.equal(activeView.phase, "AWAITING_PICK");
  if (activeView.phase !== "AWAITING_PICK") return;

  const candidate = activeView.candidates[0]!;
  assert.equal(typeof candidate.playerName, "string");
  assert.ok(["INDIAN", "OVERSEAS"].includes(candidate.rosterStatus));
  assert.ok(["CONFIRMED", "UNKNOWN"].includes(candidate.keeperCapability));
  assert.equal(typeof candidate.derivedRole, "string");
  assert.equal(typeof candidate.bowlingWorkloadClass, "string");
  assert.equal(typeof candidate.bowlingFamily, "string");
  assert.ok(candidate.positions.every((position) =>
    ["NATURAL", "ACCEPTABLE", "STRETCH", "MAJOR_STRETCH", "UNKNOWN"].includes(position.presentationFit)));
  assert.deepEqual(Object.keys(candidate.positions[0]!).sort(), ["available", "battingPosition", "presentationFit", "reasons"]);

  const firstChoice = activeView.candidates
    .flatMap((player) => player.positions.map((position) => ({ player, position })))
    .find(({ position }) => position.available)!;
  const partial = requiredState(reduceEraDraft(catalog, awaitingPick, {
    type: "LOCK_PLAYER",
    playerTeamSeasonId: firstChoice.player.playerTeamSeasonId,
    battingPosition: firstChoice.position.battingPosition,
  }));
  assert.equal(partial.phase, "AWAITING_SPIN");
  if (partial.phase !== "AWAITING_SPIN") return;
  const partialAwaitingPick = requiredState(reduceEraDraft(catalog, partial, { type: "SPIN" }));
  assert.equal(partialAwaitingPick.phase, "AWAITING_PICK");
  if (partialAwaitingPick.phase !== "AWAITING_PICK") return;

  const { complete } = buildCompletedXi("phase-3-hidden-complete");
  const views = [
    projectEraDraftPublicState(catalog, setup),
    projectEraDraftPublicState(catalog, awaitingSpin),
    activeView,
    projectEraDraftPublicState(catalog, partial),
    projectEraDraftPublicState(catalog, partialAwaitingPick),
    projectEraDraftPublicState(catalog, complete),
  ];
  for (const view of views) assertNoDraftLeaks(view);

  const partialView = views[3]!;
  assert.equal(partialView.phase, "AWAITING_SPIN");
  if (partialView.phase === "AWAITING_SPIN") {
    assert.equal(partialView.picks.length, 1);
    assert.equal(typeof partialView.picks[0]!.presentationFit, "string");
  }
  const partialPickView = views[4]!;
  assert.equal(partialPickView.phase, "AWAITING_PICK");
  if (partialPickView.phase === "AWAITING_PICK") assert.equal(partialPickView.picks.length, 1);
  const completeView = views[5]!;
  assert.equal(completeView.phase, "XI_COMPLETE");
  if (completeView.phase === "XI_COMPLETE") assert.equal(completeView.picks.length, 11);
});

test("draft presentation fit is coarse and malformed OUT_OF_ROLE data fails closed", () => {
  assert.equal(toDraftPresentationFit("NATURAL", 0), "NATURAL");
  assert.equal(toDraftPresentationFit("ACCEPTABLE", 1), "ACCEPTABLE");
  assert.equal(toDraftPresentationFit("UNKNOWN", null), "UNKNOWN");
  assert.equal(toDraftPresentationFit("OUT_OF_ROLE", 2), "STRETCH");
  assert.equal(toDraftPresentationFit("OUT_OF_ROLE", 3), "MAJOR_STRETCH");
  assert.equal(toDraftPresentationFit("OUT_OF_ROLE", 4), "MAJOR_STRETCH");
  for (const distance of [null, 0, 1, 1.5, -1, 5]) {
    assert.throws(() => toDraftPresentationFit("OUT_OF_ROLE", distance),
      (error) => error instanceof EraDraftDataError && error.code === "INVALID_PRESENTATION_FIT_DISTANCE");
  }
});

test("legal pick eleven atomically reaches a hidden and terminal XI_COMPLETE draft state", () => {
  const { beforeFinalLock, finalPosition, complete } = buildCompletedXi("phase-3-completion");
  assert.equal(beforeFinalLock.picks.length, 10);
  assert.deepEqual(getOpenBattingPositions(beforeFinalLock.picks), [finalPosition]);
  assert.equal(complete.picks.length, 11);
  assert.deepEqual(
    [...complete.picks].map((pick) => pick.battingPosition).sort((left, right) => left - right),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(new Set(complete.picks.map((pick) => pick.playerId)).size, 11);
  assert.equal(new Set(complete.picks.map((pick) => pick.playerTeamSeasonId)).size, 11);
  assert.equal("currentSpin" in complete, false);
  assert.equal("evaluation" in complete, false);
  assert.ok(complete.picks.some((pick) =>
    catalog.getPlayer(pick.playerTeamSeasonId)!.role.keeperMetadata.capabilityStatus === "CONFIRMED"));
  assert.ok(complete.picks.filter((pick) =>
    catalog.getPlayer(pick.playerTeamSeasonId)!.rosterStatus === "OVERSEAS").length <= 4);

  const snapshot = JSON.stringify(complete);
  const draftCommands = [
    { type: "CHOOSE_ERA", eraId: "era-expansion" },
    { type: "SPIN" },
    { type: "RESPIN" },
    { type: "LOCK_PLAYER", playerTeamSeasonId: complete.picks[0]!.playerTeamSeasonId, battingPosition: 1 },
  ] as const;
  for (const command of draftCommands) {
    const result = reduceEraDraft(catalog, complete, command);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, "INVALID_PHASE");
    assert.equal(result.state, complete);
    assert.equal(JSON.stringify(result.state), snapshot);
  }
});

test("REVEAL_XI delegates the exact drafted XI to Team Evaluation V2 without RNG or identity drift", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "phase-3-reveal-only" });
  const earlyReveal = reduceEraDraft(catalog, setup, { type: "REVEAL_XI" });
  assert.equal(earlyReveal.ok, false);
  assert.equal(earlyReveal.state, setup);

  const { complete } = buildCompletedXi("phase-3-reveal-success");
  const picksSnapshot = JSON.stringify(complete.picks);
  const countersSnapshot = JSON.stringify(complete.rngCounters);
  const input = buildEraDraftEvaluationInput(catalog, complete);
  assert.deepEqual(
    input.players.map((player) => player.quality.playerTeamSeasonId),
    complete.picks.map((pick) => pick.playerTeamSeasonId),
    "adapter input must retain draft order before Team Evaluation V2 validates/orders positions",
  );
  const direct = evaluateCompletedEraXi(input);
  assert.deepEqual(evaluateCompletedEraXi(input), direct);
  const result = reduceEraDraft(catalog, complete, { type: "REVEAL_XI" });
  assert.equal(result.ok, true);
  if (!result.ok || result.state.phase !== "REVEALED") return;
  const revealed = result.state;

  assert.equal(revealed.revision, complete.revision + 1);
  assert.equal(revealed.history.at(-1)?.command, "REVEAL_XI");
  assert.deepEqual(revealed.history.at(-1), {
    revision: revealed.revision,
    command: "REVEAL_XI",
    payload: {},
    resultingPhase: "REVEALED",
  });
  assert.equal(JSON.stringify(revealed.picks), picksSnapshot);
  assert.equal(JSON.stringify(revealed.rngCounters), countersSnapshot);
  assert.deepEqual(revealed.evaluation, direct);
  assert.equal(revealed.evaluation.eraId, complete.eraId);

  for (const pick of complete.picks) {
    const evaluated = revealed.evaluation.players.find((player) => player.position === pick.battingPosition)!;
    assert.equal(evaluated.quality.playerTeamSeasonId, pick.playerTeamSeasonId);
    assert.equal(evaluated.quality.playerId, pick.playerId);
    assert.equal(evaluated.quality.seasonId, pick.seasonId);
    assert.equal(evaluated.quality.teamId, pick.teamId);
    assert.equal(evaluated.role.franchiseId, pick.franchiseId);
    assert.equal(evaluated.position, pick.battingPosition);
    assert.equal(evaluated.rosterStatus, catalog.getPlayer(pick.playerTeamSeasonId)!.rosterStatus);
    assert.equal("cricketNationId" in evaluated, false);
  }

  const revealView = projectEraDraftRevealState(catalog, revealed);
  assert.equal(revealView.players.length, 11);
  assert.deepEqual(revealView.evaluation.strength, {
    overall: direct.adjustedStrength.overall,
    batting: direct.adjustedStrength.batting,
    bowling: direct.adjustedStrength.bowling,
  });
  assert.deepEqual(revealView.evaluation.tierCounts, direct.diagnostics.tierCounts);
  assert.equal(revealView.evaluation.construction.deployedBowlingUnits, direct.diagnostics.deployedBowlingUnits);
  assert.equal(revealView.status.pickCount, 11);
  assert.equal("role" in revealView.players[0]!, false);
  assert.equal("quality" in revealView.players[0]!, false);
  assert.equal(typeof revealView.players[0]!.overallRating, "number");
  assert.equal(typeof revealView.players[0]!.qualityTier, "string");
  for (const player of revealView.players) {
    const draftPick = revealView.picks.find((pick) => pick.battingPosition === player.battingPosition)!;
    assert.equal(player.presentationFit, draftPick.presentationFit);
  }
  assertNoRevealInternals(revealView);
  assertEraDraftState(catalog, revealed);

  const corruptedEvaluation = {
    ...revealed,
    evaluation: {
      ...revealed.evaluation,
      adjustedStrength: {
        ...revealed.evaluation.adjustedStrength,
        overall: revealed.evaluation.adjustedStrength.overall + 1,
      },
    },
  };
  assert.throws(
    () => assertEraDraftState(catalog, corruptedEvaluation),
    (error) => error instanceof EraDraftInvariantError && error.code === "REVEAL_EVALUATION_MISMATCH",
  );

  const repeated = reduceEraDraft(catalog, revealed, { type: "REVEAL_XI" });
  assert.equal(repeated.ok, false);
  if (!repeated.ok) {
    assert.equal(repeated.error.code, "INVALID_PHASE");
    assert.equal(repeated.state, revealed);
  }
});

test("missing or mismatched reveal joins are typed system/data failures and leave the XI unchanged", () => {
  const { complete } = buildCompletedXi("phase-3-reveal-failure");
  const snapshot = JSON.stringify(complete);
  const missingPtsId = complete.picks[0]!.playerTeamSeasonId;
  const missingCatalog = new Proxy(catalog, {
    get(target, property, receiver) {
      if (property === "getPlayer") {
        return (playerTeamSeasonId: string) =>
          playerTeamSeasonId === missingPtsId ? undefined : target.getPlayer(playerTeamSeasonId);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as EraDraftCatalog;
  assert.throws(
    () => reduceEraDraft(missingCatalog, complete, { type: "REVEAL_XI" }),
    (error) => error instanceof EraDraftInvariantError && error.code === "UNKNOWN_PICK_PLAYER",
  );
  assert.equal(JSON.stringify(complete), snapshot);

  const mismatched = {
    ...complete,
    picks: complete.picks.map((pick, index) => index === 0 ? { ...pick, teamId: "team-mismatched" } : pick),
  } as XiCompleteState;
  assert.throws(
    () => buildEraDraftEvaluationInput(catalog, mismatched),
    (error) => error instanceof EraDraftDataError && error.code === "REVEAL_PICK_IDENTITY_MISMATCH",
  );
  assert.equal(JSON.stringify(complete), snapshot);
});

test("reveal uses confirmed keeper capability and IPL roster status semantics", () => {
  const input = capabilityOnlyKeeperInput();
  const keeper = input.players.find((player) =>
    player.role.keeperMetadata.capabilityStatus === "CONFIRMED")!;
  assert.equal(keeper.role.keeperMetadata.seasonUsageStatus, "UNKNOWN");
  assert.notEqual(keeper.role.derivedRole, "WICKETKEEPER_BATTER");
  const evaluation = evaluateCompletedEraXi(input);
  assert.equal(evaluation.diagnostics.hasWicketkeeper, true);
  assert.equal(
    evaluation.diagnostics.overseasCount,
    input.players.filter((player) => player.rosterStatus === "OVERSEAS").length,
  );

  const presentationRoleOnly: EraCompletedXiInput = {
    ...input,
    players: input.players.map((player, index) => ({
      ...player,
      role: {
        ...player.role,
        ...(index === 0 ? { derivedRole: "WICKETKEEPER_BATTER" as const } : {}),
        keeperMetadata: { ...player.role.keeperMetadata, capabilityStatus: "UNKNOWN" as const },
      },
    })),
  };
  assert.ok(presentationRoleOnly.players.some((player) => player.role.derivedRole === "WICKETKEEPER_BATTER"));
  assert.throws(
    () => evaluateCompletedEraXi(presentationRoleOnly),
    /confirmed wicketkeeper capability/,
  );
});

function buildCompletedXi(seed: string): {
  readonly beforeFinalLock: Extract<EraDraftState, { phase: "AWAITING_PICK" }>;
  readonly finalPosition: XiCompleteState["picks"][number]["battingPosition"];
  readonly complete: XiCompleteState;
} {
  let state = requiredState(reduceEraDraft(
    catalog,
    createEraDraftGame({ catalog, rootSeed: seed }),
    { type: "CHOOSE_ERA", eraId: "era-foundation" },
  ));
  let beforeFinalLock: Extract<EraDraftState, { phase: "AWAITING_PICK" }> | undefined;
  let finalPosition: XiCompleteState["picks"][number]["battingPosition"] | undefined;

  for (let pickIndex = 0; pickIndex < 11; pickIndex += 1) {
    state = requiredState(reduceEraDraft(catalog, state, { type: "SPIN" }));
    assert.equal(state.phase, "AWAITING_PICK");
    if (state.phase !== "AWAITING_PICK") assert.fail("SPIN did not produce AWAITING_PICK");
    const view = projectEraDraftPublicState(catalog, state);
    assert.equal(view.phase, "AWAITING_PICK");
    if (view.phase !== "AWAITING_PICK") assert.fail("Projection did not produce AWAITING_PICK");
    const choice = view.candidates
      .flatMap((player) => player.positions.map((position) => ({ player, position })))
      .find(({ position }) => position.available);
    assert.ok(choice, "viable spin must expose at least one legal player-slot pair");
    if (pickIndex === 10) {
      beforeFinalLock = state;
      finalPosition = choice.position.battingPosition;
    }
    state = requiredState(reduceEraDraft(catalog, state, {
      type: "LOCK_PLAYER",
      playerTeamSeasonId: choice.player.playerTeamSeasonId,
      battingPosition: choice.position.battingPosition,
    }));
  }
  assert.equal(state.phase, "XI_COMPLETE");
  if (state.phase !== "XI_COMPLETE" || !beforeFinalLock || finalPosition === undefined) {
    assert.fail("Draft did not reach XI_COMPLETE");
  }
  return { beforeFinalLock, finalPosition, complete: state };
}

function capabilityOnlyKeeperInput(): EraCompletedXiInput {
  const rows = catalog.getTeamSeasonsForEra("era-foundation")
    .flatMap((teamSeason) => catalog.getCandidatesForTeamSeason(teamSeason.teamSeasonId));
  const keeper = rows.find((player) =>
    player.role.keeperMetadata.capabilityStatus === "CONFIRMED"
    && player.role.keeperMetadata.seasonUsageStatus === "UNKNOWN");
  assert.ok(keeper, "fixture requires a capability-confirmed keeper with UNKNOWN season usage");
  const selected = [keeper];
  const playerIds = new Set([keeper.playerId]);
  for (const player of rows) {
    if (
      selected.length === 11
      || playerIds.has(player.playerId)
      || player.rosterStatus !== "INDIAN"
      || player.role.keeperMetadata.capabilityStatus === "CONFIRMED"
    ) continue;
    selected.push(player);
    playerIds.add(player.playerId);
  }
  assert.equal(selected.length, 11);
  return {
    era: { eraId: "era-foundation", seasonIds: catalog.getEra("era-foundation")!.seasonIds },
    players: selected.map((player, index) => ({
      position: (index + 1) as XiCompleteState["picks"][number]["battingPosition"],
      role: player.role,
      quality: player.quality,
      rosterStatus: player.rosterStatus,
    })),
  };
}

function requiredState(result: ReturnType<typeof reduceEraDraft>): EraDraftState {
  if (!result.ok) assert.fail(result.error.message);
  return result.state;
}

function assertNoDraftLeaks(value: unknown): void {
  const forbiddenKeys = new Set([
    "quality", "battingRating", "bowlingRating", "overallRating", "qualityTier", "tierCounts",
    "internalScore", "primaryInternalScore", "secondaryBonus", "baseStrength", "adjustedStrength",
    "evaluation", "nominalFitDeduction", "effectiveRatingBeforeTeamCap", "bandDistance", "bowlingCapacity",
    "phaseBowlingUsage", "fitConfidence", "fitBasis", "effects", "simulationSeed", "compositionSeed",
    "rootSeed", "catalogFingerprint",
  ]);
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item !== "object" || item === null) return;
    for (const [key, nested] of Object.entries(item)) {
      assert.equal(forbiddenKeys.has(key), false, `draft projection leaked forbidden key ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

function assertNoRevealInternals(value: unknown): void {
  const forbiddenKeys = new Set([
    "quality", "role", "bandDistance", "nominalFitDeduction", "effectiveRatingBeforeTeamCap",
    "rawRating", "battingContributions", "bowlingDeployment", "baseStrength", "adjustedStrength",
    "diagnostics", "effects", "rootSeed", "catalogFingerprint", "simulationSeed", "compositionSeed",
  ]);
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item !== "object" || item === null) return;
    for (const [key, nested] of Object.entries(item)) {
      assert.equal(forbiddenKeys.has(key), false, `reveal projection leaked forbidden key ${key}`);
      visit(nested);
    }
  };
  visit(value);
}
