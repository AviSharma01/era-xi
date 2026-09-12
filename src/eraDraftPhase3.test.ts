import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { canonicalJson } from "./eraDraftCanonical.js";
import { SeasonExperience } from "./eraDraftApp.js";
import { loadEraDraftCatalog, loadEraDraftCatalogDocuments, type EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import {
  compareDraftCandidatesForPresentation,
  projectEraDraftGameCompleteState,
  projectEraDraftHistoricalStats,
  projectEraDraftPublicState,
} from "./eraDraftProjection.js";
import type {
  AwaitingPickState,
  EraDraftState,
  GameCompleteState,
  RevealedState,
} from "./eraDraftTypes.js";
import {
  createEraDraftUiSave,
  loadAndRestoreEraDraftUiSave,
  parseEraDraftUiSave,
  validateEraDraftPresentationCursor,
  type EraDraftPresentationCursor,
} from "./eraDraftUiPersistence.js";
import { createEraDraftWebAssets } from "./eraDraftWebArtifacts.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();

test("historical presentation stats use exact frozen counts and transparent era peaks", () => {
  const kohli = catalog.getPlayer("pts:ba607b88:ipl-2016:team-royal-challengers-bangalore")!;
  const kohliStats = projectEraDraftHistoricalStats(catalog, kohli);
  assert.deepEqual(kohliStats.currentSeason.batting, {
    innings: 16, runs: 973, average: 81.08, strikeRate: 152.03,
  });
  assert.equal(kohliStats.eraBest.batting?.seasonYear, 2016);
  assert.equal(kohliStats.eraBest.batting?.runs, 973);

  const bhuvneshwar = catalog.getPlayer("pts:2e81a32d:ipl-2017:team-sunrisers-hyderabad")!;
  const bowlerStats = projectEraDraftHistoricalStats(catalog, bhuvneshwar);
  assert.deepEqual(bowlerStats.currentSeason.bowling, {
    innings: 14, wickets: 26, legalBalls: 314, economy: 7.05,
  });
  assert.equal(bowlerStats.eraBest.bowling?.seasonYear, 2017);
  assert.equal(bowlerStats.eraBest.bowling?.wickets, 26);

  const allRounder = allPlayers(catalog).find((player) => player.role.derivedRole === "ALL_ROUNDER")!;
  const allRounderStats = projectEraDraftHistoricalStats(catalog, allRounder);
  const variants = catalog.getPlayerVariantsForEra(allRounder.eraId, allRounder.playerId);
  assert.equal(allRounderStats.eraBest.batting?.runs, Math.max(...variants.map((item) => item.historicalStats.batting.runs)));
  assert.equal(allRounderStats.eraBest.bowling?.wickets, Math.max(...variants.map((item) => item.historicalStats.bowling.wickets)));
  assert.doesNotMatch(canonicalJson(allRounderStats), /rating|quality|internalScore|evaluation|bandDistance/i);
});

test("historical stat coverage is complete and nullable rates degrade without invented values", () => {
  const players = allPlayers(catalog);
  assert.equal(players.length, 2_992);
  assert.ok(players.every((player) => Number.isInteger(player.historicalStats.batting.runs)
    && Number.isInteger(player.historicalStats.bowling.wickets)));
  const noDismissal = players.find((player) => player.historicalStats.batting.dismissals === 0)!;
  assert.equal(noDismissal.historicalStats.batting.average, null);
  const noBowling = players.find((player) => player.historicalStats.bowling.legalBalls === 0)!;
  assert.equal(noBowling.historicalStats.bowling.economy, null);
  for (const eraId of ERA_IDS) {
    assert.ok(players.filter((player) => player.eraId === eraId).every((player) =>
      player.historicalStats.playerTeamSeasonId === player.playerTeamSeasonId));
  }
});

test("equal peak totals resolve by season, team, and PTS identity without a quality formula", () => {
  const players = allPlayers(catalog);
  const tied = players.find((player) => {
    const variants = catalog.getPlayerVariantsForEra(player.eraId, player.playerId);
    const max = Math.max(...variants.map((item) => item.historicalStats.batting.runs));
    return max > 0 && variants.filter((item) => item.historicalStats.batting.runs === max).length > 1;
  });
  assert.ok(tied, "expected at least one transparent batting peak tie");
  const variants = catalog.getPlayerVariantsForEra(tied.eraId, tied.playerId);
  const maximum = Math.max(...variants.map((item) => item.historicalStats.batting.runs));
  const expected = variants.filter((item) => item.historicalStats.batting.runs === maximum)
    .sort((left, right) => left.seasonYear - right.seasonYear
      || left.teamId.localeCompare(right.teamId)
      || left.playerTeamSeasonId.localeCompare(right.playerTeamSeasonId))[0]!;
  assert.equal(projectEraDraftHistoricalStats(catalog, tied).eraBest.batting?.playerTeamSeasonId, expected.playerTeamSeasonId);
});

test("all five eras use deterministic batter, all-rounder, bowler presentation order", () => {
  for (const eraId of ERA_IDS) {
    let state = accepted(reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed: `phase3-order:${eraId}` }),
      { type: "CHOOSE_ERA", eraId }));
    state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
    assert.equal(state.phase, "AWAITING_PICK");
    const view = projectEraDraftPublicState(catalog, state as AwaitingPickState);
    assert.equal(view.phase, "AWAITING_PICK");
    if (view.phase !== "AWAITING_PICK") assert.fail("expected candidates");
    const ranks = view.candidates.map((candidate) => ["BATTERS", "ALL_ROUNDERS", "BOWLERS"].indexOf(candidate.presentationGroup));
    assert.deepEqual(ranks, [...ranks].sort((left, right) => left - right), eraId);
    const wicketkeepers = view.candidates.filter((candidate) => candidate.derivedRole === "WICKETKEEPER_BATTER");
    assert.ok(wicketkeepers.every((candidate) => candidate.presentationGroup === "BATTERS"));
    assert.deepEqual(view.candidates.map((candidate) => candidate.playerTeamSeasonId),
      projectEraDraftPublicState(catalog, state as AwaitingPickState).phase === "AWAITING_PICK"
        ? (projectEraDraftPublicState(catalog, state as AwaitingPickState) as typeof view).candidates.map((candidate) => candidate.playerTeamSeasonId)
        : []);
    const withPostRevealQuality = view.candidates.map((candidate, index) => ({ ...candidate, qualityTier: index % 2 ? "S" : "D" }));
    withPostRevealQuality.sort(compareDraftCandidatesForPresentation);
    assert.deepEqual(withPostRevealQuality.map((candidate) => candidate.playerTeamSeasonId),
      view.candidates.map((candidate) => candidate.playerTeamSeasonId));
    assert.doesNotMatch(canonicalJson(view.candidates), /battingRating|bowlingRating|overallRating|qualityTier|internalScore|evaluation|bandDistance/i);
  }
});

test("one reducer call freezes a complete season and cursor movement never mutates or resimulates it", () => {
  const revealed = strongestRevealed(catalog, "era-foundation", "p3-seed-0");
  const simulated = reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" });
  assert.equal(simulated.ok, true);
  if (!simulated.ok || simulated.state.phase !== "GAME_COMPLETE") assert.fail("expected game complete");
  assert.equal(simulated.state.history.filter((entry) => entry.command === "SIMULATE_SEASON").length, 1);
  const frozen = canonicalJson(simulated.state);
  const rejectedSecondCall = reduceEraDraft(catalog, simulated.state, { type: "SIMULATE_SEASON" });
  assert.equal(rejectedSecondCall.ok, false);
  assert.equal(canonicalJson(rejectedSecondCall.state), frozen);
  for (const cursor of cursorCheckpoints(simulated.state)) {
    validateEraDraftPresentationCursor(simulated.state, cursor);
    createEraDraftUiSave(simulated.state, cursor);
    assert.equal(canonicalJson(simulated.state), frozen);
  }
});

test("game-complete projection matches every frozen user match, checkpoint, final table, and playoff result", () => {
  const complete = completeSeason(catalog, "era-foundation", "p3-seed-0");
  const view = projectEraDraftGameCompleteState(catalog, complete);
  assert.equal(view.league.userMatches.length, 14);
  assert.deepEqual(view.league.userMatches[13]!.standings, view.league.finalStandings);
  assert.equal(view.league.userMatches[13]!.record.won, view.league.userRecord.won);
  assert.equal(view.league.userMatches[13]!.record.lost, view.league.userRecord.lost);
  assert.equal(view.playoffs.allMatches.length, 4);
  assert.equal(view.champion.teamId, complete.season.league.championTeamId);
  const frozenUserMatches = complete.season.league.leagueMatches.filter((match) =>
    match.firstBattingTeamId === "user" || match.chasingTeamId === "user");
  assert.deepEqual(view.league.userMatches.map((checkpoint) => checkpoint.match.matchId), frozenUserMatches.map((match) => match.matchId));
  assert.ok(view.league.userMatches.slice(0, 13).every((checkpoint) => checkpoint.standings.every((row) => row.qualified === null)));
  assert.ok(view.league.finalStandings.slice(0, 4).every((row) => row.qualified === true));
  assert.doesNotMatch(canonicalJson(view), /simulationSeed|compositionSeed|strength|evaluation|catalogFingerprint|hash|quality/i);
});

test("frozen playoff projection covers qualifier, eliminator, qualifier 2, final, champion, and elimination routes", () => {
  const cases = ["p3-seed-0", "p3-seed-3", "p3-seed-6", "p3-seed-8", "p3-seed-10"];
  const stages = new Set<string>();
  let champion = false;
  let eliminated = false;
  for (const seed of cases) {
    const view = projectEraDraftGameCompleteState(catalog, completeSeason(catalog, "era-foundation", seed));
    view.playoffs.userMatches.forEach((match) => stages.add(match.stage));
    champion ||= view.champion.isUser;
    eliminated ||= view.league.qualified && !view.champion.isUser;
  }
  assert.deepEqual([...stages].sort(), ["ELIMINATOR", "FINAL", "QUALIFIER_1", "QUALIFIER_2"]);
  assert.equal(champion, true);
  assert.equal(eliminated, true);
});

test("season UI presents league, final table, playoffs, terminal result, and restart controls", () => {
  const complete = completeSeason(catalog, "era-foundation", "p3-seed-0");
  const league = renderSeason(complete, { phase: "LEAGUE", revealedUserMatches: 1 });
  assert.match(league, /Match 01 \/ 14/);
  assert.match(league, /Next match/);
  assert.match(league, /Sim remaining/);
  assert.match(league, /Provisional table/);
  const matchFourteen = renderSeason(complete, { phase: "LEAGUE", revealedUserMatches: 14 });
  assert.match(matchFourteen, /View final table/);
  assert.match(matchFourteen, /Final standings/);
  assert.doesNotMatch(matchFourteen, /Sim remaining/);
  const leagueComplete = renderSeason(complete, { phase: "LEAGUE_COMPLETE" });
  assert.match(leagueComplete, /Playoffs secured/);
  assert.match(leagueComplete, /Begin playoffs/);
  const playoffs = renderSeason(complete, { phase: "PLAYOFFS", revealedPlayoffMatches: 1 });
  assert.match(playoffs, /Playoffs/);
  assert.match(playoffs, /Sim to end/);
  const terminal = renderSeason(complete, { phase: "COMPLETE" });
  assert.match(terminal, /Season complete/);
  assert.match(terminal, /New Era Draft/);
  assert.match(terminal, /Draft same era again/);
});

test("non-qualifier UI skips playoff progression and surfaces the stored champion", () => {
  const complete = findNonQualifier();
  const finalTable = renderSeason(complete, { phase: "LEAGUE_COMPLETE" });
  assert.match(finalTable, /Season ends here/);
  assert.match(finalTable, /Not qualified/);
  assert.match(finalTable, new RegExp(projectEraDraftGameCompleteState(catalog, complete).champion.teamName));
  assert.match(finalTable, /View season result/);
  assert.doesNotMatch(renderSeason(complete, { phase: "COMPLETE" }), /Playoff route/);
});

test("all five browser-scoped eras complete and expose exactly fourteen user league matches", async () => {
  const assets = createEraDraftWebAssets(loadEraDraftCatalogDocuments());
  const manifestUrl = new URL("https://example.test/data/era-draft/v1/manifest.json");
  for (const entry of assets.manifest.eras) {
    const { fetchScopedEraDraftCatalog } = await import("./eraDraftWebData.js");
    const scoped = await fetchScopedEraDraftCatalog({ manifest: assets.manifest, manifestUrl, eraId: entry.eraId,
      fetcher: async () => new Response(assets.artifacts.get(entry.path)!.json),
      subtle: webcrypto.subtle as unknown as SubtleCrypto });
    const complete = completeSeason(scoped, entry.eraId, `phase3-all-era:${entry.eraId}`);
    assert.equal(projectEraDraftGameCompleteState(scoped, complete).league.userMatches.length, 14, entry.eraId);
  }
});

test("GAME_COMPLETE saves restore exact early, mid, league-complete, playoff, and terminal cursors", async () => {
  const assets = createEraDraftWebAssets(loadEraDraftCatalogDocuments());
  const complete = completeSeason(catalog, "era-foundation", "p3-seed-0");
  const entry = assets.manifest.eras.find((item) => item.eraId === complete.eraId)!;
  for (const cursor of cursorCheckpoints(complete)) {
    const save = createEraDraftUiSave(complete, cursor);
    const restored = await loadAndRestoreEraDraftUiSave({ save, manifest: assets.manifest,
      manifestUrl: new URL("https://example.test/data/era-draft/v1/manifest.json"),
      fetcher: async () => new Response(assets.artifacts.get(entry.path)!.json),
      subtle: webcrypto.subtle as unknown as SubtleCrypto });
    assert.deepEqual(restored.state, complete);
    assert.deepEqual(restored.presentationCursor, cursor);
  }
});

test("impossible and out-of-range presentation cursors fail closed", async () => {
  const qualified = completeSeason(catalog, "era-foundation", "p3-seed-0");
  const nonQualifier = findNonQualifier();
  assert.throws(() => validateEraDraftPresentationCursor(qualified, { phase: "LEAGUE", revealedUserMatches: 15 }));
  assert.throws(() => validateEraDraftPresentationCursor(nonQualifier, { phase: "PLAYOFFS", revealedPlayoffMatches: 1 }));
  assert.throws(() => validateEraDraftPresentationCursor(qualified, {
    phase: "PLAYOFFS", revealedPlayoffMatches: qualified.season.league.playoffs.length + 1,
  }));
  const save = createEraDraftUiSave(qualified, { phase: "LEAGUE", revealedUserMatches: 1 });
  const raw = JSON.parse(save.raw) as Record<string, unknown>;
  raw.presentationCursor = { phase: "LEAGUE", revealedUserMatches: 99 };
  assert.throws(() => parseEraDraftUiSave(JSON.stringify(raw)));
});

function completeSeason(catalogValue: EraDraftCatalog, eraId: EraId, seed: string): GameCompleteState {
  const revealed = strongestRevealed(catalogValue, eraId, seed);
  const result = accepted(reduceEraDraft(catalogValue, revealed, { type: "SIMULATE_SEASON" }));
  if (result.phase !== "GAME_COMPLETE") assert.fail("expected complete season");
  return result;
}

function strongestRevealed(catalogValue: EraDraftCatalog, eraId: EraId, seed: string): RevealedState {
  let state = accepted(reduceEraDraft(catalogValue, createEraDraftGame({ catalog: catalogValue, rootSeed: seed }),
    { type: "CHOOSE_ERA", eraId }));
  while (state.phase === "AWAITING_SPIN") {
    state = accepted(reduceEraDraft(catalogValue, state, { type: "SPIN" }));
    const view = projectEraDraftPublicState(catalogValue, state as AwaitingPickState);
    if (view.phase !== "AWAITING_PICK") assert.fail("expected candidate projection");
    const choices = view.candidates.flatMap((candidate) => candidate.positions.filter((position) => position.available)
      .map((position) => ({ candidate, position, rating: catalogValue.getPlayer(candidate.playerTeamSeasonId)!.quality.overall.overallRating })));
    choices.sort((left, right) => right.rating - left.rating
      || fitRank(left.position.presentationFit) - fitRank(right.position.presentationFit)
      || left.candidate.playerTeamSeasonId.localeCompare(right.candidate.playerTeamSeasonId));
    const choice = choices[0]!;
    state = accepted(reduceEraDraft(catalogValue, state, { type: "LOCK_PLAYER",
      playerTeamSeasonId: choice.candidate.playerTeamSeasonId, battingPosition: choice.position.battingPosition }));
  }
  if (state.phase !== "XI_COMPLETE") assert.fail("expected complete XI");
  const revealed = accepted(reduceEraDraft(catalogValue, state, { type: "REVEAL_XI" }));
  if (revealed.phase !== "REVEALED") assert.fail("expected reveal");
  return revealed;
}

function fitRank(fit: string): number {
  return ["NATURAL", "ACCEPTABLE", "STRETCH", "MAJOR_STRETCH", "UNKNOWN"].indexOf(fit);
}

function cursorCheckpoints(state: GameCompleteState): EraDraftPresentationCursor[] {
  const result: EraDraftPresentationCursor[] = [
    { phase: "LEAGUE", revealedUserMatches: 1 },
    { phase: "LEAGUE", revealedUserMatches: 7 },
    { phase: "LEAGUE_COMPLETE" },
    { phase: "COMPLETE" },
  ];
  if (state.season.userOutcome.qualified) result.splice(3, 0, { phase: "PLAYOFFS", revealedPlayoffMatches: 1 });
  return result;
}

function renderSeason(state: GameCompleteState, cursor: EraDraftPresentationCursor): string {
  return renderToStaticMarkup(createElement(SeasonExperience, {
    session: { catalog, state, cursor },
    persistenceWarning: null,
    onCursor: () => undefined,
    onExit: () => undefined,
    onSameEra: () => undefined,
    onNewEra: () => undefined,
  }));
}

function findNonQualifier(): GameCompleteState {
  for (let index = 0; index < 100; index += 1) {
    const state = completeSeason(catalog, "era-foundation", `phase3-nonqualifier:${index}`);
    if (!state.season.userOutcome.qualified) return state;
  }
  throw new Error("expected a deterministic non-qualifying fixture");
}

function accepted(result: ReturnType<typeof reduceEraDraft>): Exclude<EraDraftState, { phase: "SETUP" }> {
  if (!result.ok) assert.fail(result.error.message);
  if (result.state.phase === "SETUP") assert.fail("unexpected setup");
  return result.state;
}

function allPlayers(catalogValue: EraDraftCatalog) {
  return catalogValue.getEraIds().flatMap((eraId) => catalogValue.getTeamSeasonsForEra(eraId)
    .flatMap((teamSeason) => catalogValue.getCandidatesForTeamSeason(teamSeason.teamSeasonId)));
}
