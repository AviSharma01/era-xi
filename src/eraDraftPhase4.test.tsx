import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DraftExperience, RevealedExperience, SeasonExperience } from "./eraDraftApp.js";
import { canonicalJson } from "./eraDraftCanonical.js";
import {
  loadEraDraftCatalog,
  loadEraDraftCatalogDocuments,
  type EraDraftCatalog,
  type EraDraftPlayerRecord,
} from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import {
  compareDraftCandidatesForPresentation,
  projectDraftDisplayRole,
  projectEraDraftGameCompleteState,
  projectEraDraftPublicState,
} from "./eraDraftProjection.js";
import type {
  AwaitingPickState,
  DraftCandidateIdentityView,
  EraDraftState,
  GameCompleteState,
  RevealedState,
  XiCompleteState,
} from "./eraDraftTypes.js";
import { createEraDraftUiSave, loadAndRestoreEraDraftUiSave, type EraDraftPresentationCursor } from "./eraDraftUiPersistence.js";
import { createEraDraftWebAssets } from "./eraDraftWebArtifacts.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();
const allRounder = allPlayers(catalog).find((player) => player.role.derivedRole === "ALL_ROUNDER")!;

test("display role follows the approved current-season thresholds and frozen fallbacks", () => {
  assert.equal(displayVariant(90, 9, "BATTING", "SUPPORT"), "ALL_ROUNDER");
  assert.equal(displayVariant(90, 8, "BOWLING", "FRONTLINE"), "BATTER");
  assert.equal(displayVariant(89, 9, "BATTING", "SUPPORT"), "BOWLER");
  assert.equal(displayVariant(89, 8, "BATTING", "SUPPORT"), "BATTER");
  assert.equal(displayVariant(89, 8, "BOWLING", "FRONTLINE"), "BOWLER");
  assert.equal(displayVariant(89, 8, "BALANCED", "FRONTLINE"), "BATTER");
  assert.equal(displayVariant(89, 8, "BALANCED", "SUPPORT"), "BOWLER");
  assert.throws(() => displayVariant(89, 8, "BALANCED", "OCCASIONAL"), /unsupported presentation fallback/i);
  assert.equal(allRounder.role.derivedRole, "ALL_ROUNDER");
});

test("frozen all-rounder population projects to 123 all-rounders, 207 batters, and 457 bowlers", () => {
  const profiles = allPlayers(catalog).filter((player) => player.role.derivedRole === "ALL_ROUNDER");
  const counts = { ALL_ROUNDER: 0, BATTER: 0, BOWLER: 0 };
  const eras = new Set<EraId>();
  for (const player of profiles) {
    const role = projectDraftDisplayRole(player);
    if (role !== "ALL_ROUNDER" && role !== "BATTER" && role !== "BOWLER") assert.fail(`Unexpected role ${role}`);
    counts[role] += 1;
    eras.add(player.eraId);
    assert.equal(player.role.derivedRole, "ALL_ROUNDER");
  }
  assert.equal(profiles.length, 787);
  assert.deepEqual(counts, { ALL_ROUNDER: 123, BATTER: 207, BOWLER: 457 });
  assert.deepEqual([...eras].sort(), [...ERA_IDS].sort());

  const wicketkeeper = allPlayers(catalog).find((player) => player.role.derivedRole === "WICKETKEEPER_BATTER")!;
  assert.equal(projectDraftDisplayRole(wicketkeeper), "WICKETKEEPER_BATTER");
});

test("all five eras group and sort candidates by display role without quality influence", () => {
  for (const eraId of ERA_IDS) {
    let state = accepted(reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed: `phase4-order:${eraId}` }),
      { type: "CHOOSE_ERA", eraId }));
    state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
    if (state.phase !== "AWAITING_PICK") assert.fail("Expected candidates.");
    const view = projectEraDraftPublicState(catalog, state);
    if (view.phase !== "AWAITING_PICK") assert.fail("Expected candidate projection.");
    const ranks = view.candidates.map((candidate) => ["BATTERS", "ALL_ROUNDERS", "BOWLERS"].indexOf(candidate.presentationGroup));
    assert.deepEqual(ranks, [...ranks].sort((left, right) => left - right));
    assert.ok(view.candidates.every((candidate) => candidate.displayRole === projectDraftDisplayRole(catalog.getPlayer(candidate.playerTeamSeasonId)!)));
    assert.ok(view.candidates.filter((candidate) => candidate.displayRole === "WICKETKEEPER_BATTER")
      .every((candidate) => candidate.presentationGroup === "BATTERS"));
    const withQuality = view.candidates.map((candidate, index) => ({ ...candidate, qualityTier: index % 2 ? "S" : "D" }));
    withQuality.sort(compareDraftCandidatesForPresentation);
    assert.deepEqual(withQuality.map((candidate) => candidate.playerTeamSeasonId),
      view.candidates.map((candidate) => candidate.playerTeamSeasonId));
  }
});

test("tier identity appears only after reveal and survives strict restore and season simulation", async () => {
  const xiComplete = strongestXiComplete(catalog, "era-foundation", "phase4-tier");
  const hiddenMarkup = renderToStaticMarkup(<DraftExperience session={{ catalog, state: xiComplete }}
    persistenceWarning={null} onAccepted={() => null} onExit={() => undefined} />);
  assert.doesNotMatch(hiddenMarkup, /xi-tier-[sabcd]|quality-tier|data-[^=]*tier/i);

  const revealed = accepted(reduceEraDraft(catalog, xiComplete, { type: "REVEAL_XI" }));
  if (revealed.phase !== "REVEALED") assert.fail("Expected reveal.");
  const revealMarkup = renderReveal(revealed);
  assert.match(revealMarkup, /xi-slot-revealed xi-tier-[sabcd]/);
  assert.match(revealMarkup, /quality-tier tier-[sabcd]/);
  assert.match(revealMarkup, /xi-fit-[a-z-]+ xi-slot-revealed xi-tier-[sabcd]/);

  const assets = createEraDraftWebAssets(loadEraDraftCatalogDocuments());
  const entry = assets.manifest.eras.find((item) => item.eraId === revealed.eraId)!;
  const restored = await loadAndRestoreEraDraftUiSave({
    save: createEraDraftUiSave(revealed),
    manifest: assets.manifest,
    manifestUrl: new URL("https://example.test/data/era-draft/v1/manifest.json"),
    fetcher: async () => new Response(assets.artifacts.get(entry.path)!.json),
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
  });
  if (restored.state.phase !== "REVEALED") assert.fail("Expected restored reveal.");
  assert.equal(countMatches(renderReveal(restored.state), /xi-tier-[sabcd]/g), 11);

  const before = revealed.evaluation.players.map((player) => player.quality.overall.qualityTier);
  const simulated = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
  if (simulated.phase !== "GAME_COMPLETE") assert.fail("Expected complete season.");
  assert.deepEqual(simulated.evaluation.players.map((player) => player.quality.overall.qualityTier), before);
});

test("playoff path reveals chronologically, emphasizes the user, and never mutates the frozen season", () => {
  const complete = completeSeason(catalog, "era-foundation", "p3-seed-0");
  assert.equal(complete.season.userOutcome.qualified, true);
  const view = projectEraDraftGameCompleteState(catalog, complete);
  const firstUserMatch = view.playoffs.userMatches[0]!;
  const revealedThrough = view.playoffs.allMatches.findIndex((match) => match.matchId === firstUserMatch.matchId) + 1;
  const snapshot = canonicalJson(complete);
  const markup = renderSeason(complete, { phase: "PLAYOFFS", revealedPlayoffMatches: 1 });
  assert.equal(countMatches(markup, /<li class="playoff-stage/g), 4);
  assert.equal(countMatches(markup, /playoff-stage-revealed/g), revealedThrough);
  assert.equal(countMatches(markup, /playoff-stage-locked/g), 4 - revealedThrough);
  assert.match(markup, /playoff-user-match/);
  assert.match(markup, /Matchup locked/);
  for (const future of view.playoffs.allMatches.slice(revealedThrough)) assert.equal(markup.includes(future.resultLabel), false);
  assert.equal(canonicalJson(complete), snapshot);
});

test("terminal playoff path exposes all four authoritative games for eliminated users and non-qualifiers", () => {
  const eliminated = findSeason((state) => state.season.userOutcome.qualified && !state.season.userOutcome.champion,
    ["p3-seed-3", "p3-seed-6", "p3-seed-8", "p3-seed-10"]);
  const nonQualifier = findSeason((state) => !state.season.userOutcome.qualified,
    Array.from({ length: 40 }, (_, index) => `phase4-nonqualifier:${index}`));
  for (const complete of [eliminated, nonQualifier]) {
    const view = projectEraDraftGameCompleteState(catalog, complete);
    const markup = renderSeason(complete, { phase: "COMPLETE" });
    assert.equal(countMatches(markup, /<li class="playoff-stage/g), 4);
    assert.equal(countMatches(markup, /playoff-stage-revealed/g), 4);
    assert.doesNotMatch(markup, /playoff-stage-locked|Matchup locked/);
    for (const match of view.playoffs.allMatches) assert.ok(markup.includes(match.resultLabel));
    const final = view.playoffs.allMatches.at(-1)!;
    assert.equal(final.winnerTeamId, view.champion.teamId);
    assert.ok(markup.includes(view.champion.teamName));
    assert.ok(view.playoffs.allMatches.some((match) => match.result === "AI_RESULT"));
  }
});

function displayVariant(
  runs: number,
  wickets: number,
  lean: "BATTING" | "BOWLING" | "BALANCED",
  workload: "NONE" | "OCCASIONAL" | "SUPPORT" | "FRONTLINE",
) {
  const player: EraDraftPlayerRecord = {
    ...allRounder,
    role: { ...allRounder.role, derivedRole: "ALL_ROUNDER", allRounderLean: lean, bowlingWorkloadClass: workload },
    historicalStats: {
      ...allRounder.historicalStats,
      batting: { ...allRounder.historicalStats.batting, runs },
      bowling: { ...allRounder.historicalStats.bowling, wickets },
    },
  };
  return projectDraftDisplayRole(player);
}

function strongestXiComplete(catalogValue: EraDraftCatalog, eraId: EraId, seed: string): XiCompleteState {
  let state = accepted(reduceEraDraft(catalogValue, createEraDraftGame({ catalog: catalogValue, rootSeed: seed }),
    { type: "CHOOSE_ERA", eraId }));
  while (state.phase === "AWAITING_SPIN") {
    state = accepted(reduceEraDraft(catalogValue, state, { type: "SPIN" }));
    if (state.phase !== "AWAITING_PICK") assert.fail("Expected candidates.");
    const view = projectEraDraftPublicState(catalogValue, state as AwaitingPickState);
    if (view.phase !== "AWAITING_PICK") assert.fail("Expected candidates.");
    const choices = view.candidates.flatMap((candidate) => candidate.positions.filter((position) => position.available)
      .map((position) => ({ candidate, position, rating: catalogValue.getPlayer(candidate.playerTeamSeasonId)!.quality.overall.overallRating })));
    choices.sort((left, right) => right.rating - left.rating
      || fitRank(left.position.presentationFit) - fitRank(right.position.presentationFit)
      || left.candidate.playerTeamSeasonId.localeCompare(right.candidate.playerTeamSeasonId));
    const choice = choices[0]!;
    state = accepted(reduceEraDraft(catalogValue, state, { type: "LOCK_PLAYER",
      playerTeamSeasonId: choice.candidate.playerTeamSeasonId, battingPosition: choice.position.battingPosition }));
  }
  if (state.phase !== "XI_COMPLETE") assert.fail("Expected complete XI.");
  return state;
}

function completeSeason(catalogValue: EraDraftCatalog, eraId: EraId, seed: string): GameCompleteState {
  const xi = strongestXiComplete(catalogValue, eraId, seed);
  const revealed = accepted(reduceEraDraft(catalogValue, xi, { type: "REVEAL_XI" }));
  if (revealed.phase !== "REVEALED") assert.fail("Expected reveal.");
  const complete = accepted(reduceEraDraft(catalogValue, revealed, { type: "SIMULATE_SEASON" }));
  if (complete.phase !== "GAME_COMPLETE") assert.fail("Expected complete season.");
  return complete;
}

function findSeason(predicate: (state: GameCompleteState) => boolean, seeds: readonly string[]): GameCompleteState {
  for (const seed of seeds) {
    const state = completeSeason(catalog, "era-foundation", seed);
    if (predicate(state)) return state;
  }
  throw new Error("Expected deterministic season fixture.");
}

function renderReveal(state: RevealedState): string {
  return renderToStaticMarkup(<RevealedExperience session={{ catalog, state }} persistenceWarning={null}
    onBeginSeason={() => undefined} onExit={() => undefined} />);
}

function renderSeason(state: GameCompleteState, cursor: EraDraftPresentationCursor): string {
  return renderToStaticMarkup(<SeasonExperience session={{ catalog, state, cursor }} persistenceWarning={null}
    onCursor={() => undefined} onExit={() => undefined} onSameEra={() => undefined} onNewEra={() => undefined} />);
}

function allPlayers(catalogValue: EraDraftCatalog): EraDraftPlayerRecord[] {
  return catalogValue.getEraIds().flatMap((eraId) => catalogValue.getTeamSeasonsForEra(eraId)
    .flatMap((teamSeason) => catalogValue.getCandidatesForTeamSeason(teamSeason.teamSeasonId)));
}

function accepted(result: ReturnType<typeof reduceEraDraft>): EraDraftState {
  if (!result.ok) assert.fail(result.error.message);
  return result.state;
}

function fitRank(fit: string): number {
  return ["NATURAL", "ACCEPTABLE", "STRETCH", "MAJOR_STRETCH", "UNKNOWN"].indexOf(fit);
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}
