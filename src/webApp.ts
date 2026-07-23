import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  type DraftPool,
  type Tier,
  createClassicDraftState,
  createSeededRandom,
  getCurrentSquad,
  getOpenPositions,
  getOverseasCount,
  getPositionFit,
  hasWicketkeeper,
  isLegalPlayerSelection,
  pickPlayer,
  spinFranchiseSeason,
  useVoluntaryRespin,
} from "./draftClassic.js";
import {
  type EvaluatedPlayerContribution,
  type TeamEvaluation,
  evaluateCompletedTeam,
} from "./teamEvaluation.js";
import {
  type BoostedTeamEvaluationV1,
  applyTeamBoostsV1,
} from "./teamBoostV1.js";
import {
  type DraftRoomUiState,
  createDraftRoomUiState,
  renderDraftRoom,
} from "./draftRoom.js";
import { buildOpponentStrengthProfiles2016 } from "./opponentProfiles2016.js";
import {
  type Franchise2016Id,
  type LeagueSimulationResult,
  type PlayoffSimulationResult,
  createLeagueComposition,
  generateDoubleRoundRobinSchedule,
  simulateLeagueV1,
  simulatePlayoffsV1,
} from "./simulationV1.js";

type SimulationServices = {
  buildProfiles: typeof buildOpponentStrengthProfiles2016;
  simulateLeague: typeof simulateLeagueV1;
  simulatePlayoffs: typeof simulatePlayoffsV1;
};

type ClassicDraftAppOptions = {
  root: HTMLElement;
  pool: DraftPool;
  seed?: string;
  initialState?: ClassicDraftState;
  scheduleProgressStep?: (callback: () => void) => void;
  simulationServices?: SimulationServices;
};

export type ClassicDraftApp = {
  getState: () => ClassicDraftState;
  setStateForTest: (nextState: ClassicDraftState) => void;
};

type RevealState = "hidden" | "revealed";

type RevealedTeamState = {
  evaluation: TeamEvaluation;
  boostedEvaluation: BoostedTeamEvaluationV1;
};

type PrecomputedSeason = {
  replacementFranchiseId: Franchise2016Id;
  seed: string;
  leagueResult: LeagueSimulationResult;
  playoffResult: PlayoffSimulationResult;
};

type SeasonUiState =
  | { phase: "setup" }
  | { phase: "league_progress"; season: PrecomputedSeason; revealedUserLeagueMatches: number }
  | { phase: "playoff_progress"; season: PrecomputedSeason; revealedPlayoffMatches: number }
  | { phase: "complete"; season: PrecomputedSeason };

const POSITIONS: BattingPosition[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const V1_REPLACEMENT_FRANCHISE_ID: Franchise2016Id = "delhi-daredevils";
const TIER_ORDER: Tier[] = ["S", "A", "B", "C", "D"];

export function createClassicDraftApp(options: ClassicDraftAppOptions): ClassicDraftApp {
  const appSeed = options.seed ?? Date.now().toString();
  const random = createSeededRandom(appSeed);
  const services: SimulationServices = options.simulationServices ?? {
    buildProfiles: buildOpponentStrengthProfiles2016,
    simulateLeague: simulateLeagueV1,
    simulatePlayoffs: simulatePlayoffsV1,
  };
  const scheduleProgressStep = options.scheduleProgressStep ?? ((callback: () => void) => {
    setTimeout(callback, 150);
  });
  let state = options.initialState ?? createClassicDraftState();
  let revealState: RevealState = "hidden";
  let revealedTeam: RevealedTeamState | null = null;
  let seasonUiState: SeasonUiState = { phase: "setup" };
  let temporaryState: DraftRoomUiState = createDraftRoomUiState();

  function clearTemporaryState(): void {
    temporaryState = createDraftRoomUiState();
  }

  function setError(error: unknown): void {
    temporaryState.error = error instanceof Error ? error.message : String(error);
  }

  function render(): void {
    options.root.replaceChildren(renderApp());
  }

  function renderApp(): HTMLElement {
    const shell = element("section", "app-shell");
    if (state.completed && revealState === "revealed") {
      shell.append(renderCompletedDraft(), renderActiveDetails());
    } else {
      shell.append(renderDraftRoom({
        state,
        pool: options.pool,
        uiState: temporaryState,
        actions: {
          spin: () => {
            try {
              state = spinFranchiseSeason(options.pool, state, random);
              clearTemporaryState();
            } catch (error) {
              setError(error);
            }
            render();
          },
          respin: () => {
            try {
              state = useVoluntaryRespin(options.pool, state, random);
              clearTemporaryState();
            } catch (error) {
              setError(error);
            }
            render();
          },
          setFilter: (filter) => {
            temporaryState.squadFilter = filter;
            render();
          },
          selectPlayer: (playerId) => {
            const current = temporaryState.activeDetails;
            if (current?.source !== "squad" || current.playerId !== playerId) {
              temporaryState.pendingPosition = null;
            }
            temporaryState.activeDetails = { source: "squad", playerId };
            temporaryState.error = null;
            render();
          },
          selectPosition: handleOpenPositionClick,
          openDraftedPlayer: (position) => {
            temporaryState.activeDetails = { source: "drafted", position };
            temporaryState.pendingPosition = null;
            temporaryState.error = null;
            render();
          },
          confirmPick,
          revealTeam,
        },
      }));
    }

    return shell;
  }

  function revealTeam(): void {
    const evaluation = evaluateCompletedTeam(state);
    revealedTeam = { evaluation, boostedEvaluation: applyTeamBoostsV1(evaluation) };
    revealState = "revealed";
    temporaryState.error = null;
    render();
  }

  function confirmPick(): void {
    const active = getActiveDetailsPlayer();
    const pendingPosition = temporaryState.pendingPosition;
    if (active?.source !== "squad" || pendingPosition === null) {
      temporaryState.error = "Select a squad player and an open batting position before confirming.";
      render();
      return;
    }

    try {
      state = pickPlayer(options.pool, state, active.player.id, pendingPosition);
      clearTemporaryState();
    } catch (error) {
      clearTemporaryState();
      setError(error);
    }
    render();
  }

  function renderDraftedSlot(position: BattingPosition, player: DraftPlayerSeason): HTMLElement {
    const contribution = revealState === "revealed" ? getRevealedContribution(position) : null;
    const slotButton = button("", () => {
      temporaryState.activeDetails = { source: "drafted", position };
      temporaryState.pendingPosition = null;
      temporaryState.error = null;
      render();
    });
    slotButton.className = "slot slot-locked drafted-mini-card";
    slotButton.dataset.position = String(position);
    if (revealState === "revealed") {
      slotButton.classList.add("drafted-mini-card-revealed", tierClass(player.draftTier));
    }

    const title = element("strong");
    title.textContent = `${position}. ${player.name}`;
    const badges = element("span", "player-badges");
    badges.textContent = formatBadges(player).join(" · ");
    const fit = element("span");
    fit.textContent = contribution
      ? `Fit ${formatPositionFitLabel(contribution.positionFit)} · distance ${contribution.positionDistance} · x${formatMultiplier(contribution.positionFitMultiplier)}`
      : formatPositionFitLabel(getPositionFit(player, position));
    slotButton.append(title, badges);
    if (contribution) {
      const rating = element("span", "revealed-rating-line");
      rating.textContent = `${player.draftTier} Tier · Base ${formatOneDecimal(player.baseRating)} · Effective ${formatOneDecimal(contribution.effectivePlayerRating)}`;
      const components = element("span", "revealed-rating-line");
      components.textContent = [
        `Bat ${formatNullableRating(contribution.effectiveBattingRating)}`,
        `Bowl ${formatNullableRating(contribution.bowlingContribution)}`,
        `Penalty ${formatOneDecimal(contribution.battingPenalty)}`,
      ].join(" · ");
      slotButton.append(rating);
      slotButton.append(components);
    }
    slotButton.append(fit);
    return slotButton;
  }

  function handleOpenPositionClick(position: BattingPosition): void {
    const active = getActiveDetailsPlayer();
    if (active?.source !== "squad") {
      temporaryState.error = "Select a squad player before choosing a batting position.";
      render();
      return;
    }
    temporaryState.pendingPosition = position;
    temporaryState.error = null;
    render();
  }

  function renderActiveDetails(): HTMLElement {
    const section = element("section", "active-details");
    const active = getActiveDetailsPlayer();
    if (!active) {
      const heading = element("h2");
      heading.textContent = "Player Details";
      const empty = element("p", "empty-state");
      empty.textContent = "Select a squad row or confirmed XI card to inspect player details.";
      section.append(heading, empty);
      return section;
    }

    const heading = element("h2");
    heading.textContent = active.source === "drafted" ? "Confirmed Player" : "Player Details";
    const name = element("strong", "details-name");
    name.textContent = active.player.name;
    const meta = element("p");
    meta.textContent = `${active.player.franchise} ${active.player.season}`;
    const badges = element("p", "player-badges");
    badges.textContent = formatBadges(active.player).join(" · ");

    section.append(heading, name, meta, badges);

    if (active.source === "drafted") {
      section.append(detailLine("Confirmed position", String(active.position)), detailLine("Position fit", formatPositionFitLabel(getPositionFit(active.player, active.position))));
    } else if (temporaryState.pendingPosition !== null) {
      section.append(detailLine("Pending position", String(temporaryState.pendingPosition)), detailLine("Pending fit", formatPositionFitLabel(getPositionFit(active.player, temporaryState.pendingPosition))));
    }

    section.append(
      detailLine("Role", active.player.seasonRole),
      detailLine("Matches", String(active.player.displayedStats.matches)),
      detailLine("Batting", formatFullBattingStats(active.player)),
    );

    const contribution = active.source === "drafted" && revealState === "revealed" ? getRevealedContribution(active.position) : null;
    if (contribution) {
      section.append(
        detailLine("Base rating", formatOneDecimal(active.player.baseRating)),
        detailLine("Position distance", String(contribution.positionDistance)),
        detailLine("Fit multiplier", formatMultiplier(contribution.positionFitMultiplier)),
        detailLine("Effective batting rating", formatNullableRating(contribution.effectiveBattingRating)),
        detailLine("Bowling rating", formatNullableRating(contribution.bowlingContribution)),
        detailLine("Batting position penalty", formatOneDecimal(contribution.battingPenalty)),
        detailLine("Effective player rating", formatOneDecimal(contribution.effectivePlayerRating)),
        detailLine("Draft tier", active.player.draftTier),
        detailLine("Absolute tier", active.player.absoluteTier),
      );
      if (active.player.tierAdjustment === "franchise_coverage") {
        section.append(detailLine("Tier adjustment", "Coverage promotion"), detailLine("Rating note", "Base rating remains unchanged"));
      }
      section.append(detailLine("Generated batting rating", formatNullableRating(active.player.battingRating)));
      section.append(detailLine("Rating confidence", active.player.ratingConfidence));
    }

    const bowling = formatFullBowlingStats(active.player);
    if (bowling) {
      section.append(detailLine("Bowling", bowling));
    }

    section.append(
      detailLine("Natural positions", formatPositions(active.player.naturalPositions)),
      detailLine("Acceptable positions", formatPositions(active.player.acceptablePositions)),
      detailLine("Position confidence", active.player.positionConfidence),
      detailLine("Bowling option", active.player.bowlingOptionStrength),
      detailLine("Wicketkeeper", active.player.isWicketkeeper ? "yes" : "no"),
      detailLine("Overseas", active.player.isOverseas ? "yes" : "no"),
    );

    const legality = active.source === "squad" ? isLegalPlayerSelection(state, active.player) : { ok: true as const };
    if (!legality.ok) {
      const reason = element("p", "unavailable-reason");
      reason.textContent = legality.reason;
      section.append(reason);
    }

    return section;
  }

  function renderCompletedDraft(): HTMLElement {
    const section = element("section", "completed");
    const heading = element("h2");
    heading.textContent = "Completed XI";
    const slots = element("div", "slots completed-slots");

    for (const position of POSITIONS) {
      const slot = state.slots.find((candidate) => candidate.position === position);
      if (slot) {
        slots.append(renderDraftedSlot(position, slot.player));
        continue;
      }
      const open = element("div", "slot");
      open.textContent = `${position}. Open`;
      slots.append(open);
    }

    const actions = element("div", "completed-actions");
    if (revealState === "hidden") {
      const reveal = button("Reveal Team", () => {
        const evaluation = evaluateCompletedTeam(state);
        revealedTeam = { evaluation, boostedEvaluation: applyTeamBoostsV1(evaluation) };
        revealState = "revealed";
        temporaryState.error = null;
        render();
      });
      reveal.className = "reveal-button";
      actions.append(reveal);
    }

    const restart = button("Start New Draft", () => {
      state = createClassicDraftState();
      revealState = "hidden";
      revealedTeam = null;
      seasonUiState = { phase: "setup" };
      clearTemporaryState();
      render();
    });
    restart.className = "restart-button";
    actions.append(restart);

    section.append(heading, slots, actions);
    if (revealState === "revealed") {
      section.append(renderTeamSummary(), renderBoostSummary(), renderSeasonSection());
    }
    return section;
  }

  function renderTeamSummary(): HTMLElement {
    const summary = revealedTeam?.evaluation ?? evaluateCompletedTeam(state);
    const section = element("section", "team-summary");
    const heading = element("h2");
    heading.textContent = "Team Summary";
    section.append(
      heading,
      detailLine("Overall team rating", formatOneDecimal(summary.overallTeamRating)),
      detailLine("Batting composite", formatOneDecimal(summary.battingComposite)),
      detailLine("Bowling composite", formatOneDecimal(summary.bowlingComposite)),
      detailLine("Batting strength", formatOneDecimal(summary.battingStrength)),
      detailLine("Bowling strength", formatOneDecimal(summary.bowlingStrength)),
      detailLine("Batting depth", formatOneDecimal(summary.battingDepth)),
      detailLine("Bowling depth", formatOneDecimal(summary.bowlingDepth)),
      detailLine("Average base rating", formatOneDecimal(summary.averageBaseRating)),
      detailLine("Average effective player rating", formatOneDecimal(summary.averageEffectivePlayerRating)),
      detailLine("Fit rating", formatOneDecimal(summary.fitRating)),
      detailLine("Tiers", TIER_ORDER.map((tier) => `${summary.tierCounts[tier]} ${tier}`).join(" · ")),
      detailLine(
        "Position fit",
        `${summary.positionFitCounts.natural} natural · ${summary.positionFitCounts.acceptable} acceptable · ${summary.positionFitCounts.out_of_position} out of position`,
      ),
      detailLine("Overseas", `${summary.overseasCount}/4`),
      detailLine("Wicketkeeper", summary.hasWicketkeeper ? "Yes" : "Missing"),
      detailLine("Bowling options", String(Object.values(summary.bowlingOptionCounts).reduce((total, count) => total + count, 0))),
    );

    const bowlingBreakdown = ["frontline", "secondary", "part_time"]
      .map((strength) => `${summary.bowlingOptionCounts[strength as keyof TeamEvaluation["bowlingOptionCounts"]]} ${formatBowlingStrengthLabel(strength)}`)
      .join(" · ");
    section.append(detailLine("Bowling breakdown", bowlingBreakdown));
    return section;
  }

  function renderBoostSummary(): HTMLElement {
    const boosted = requiredRevealedTeam().boostedEvaluation;
    const base = boosted.baseTeamEvaluation;
    const section = element("section", "boost-summary");
    const heading = element("h2");
    heading.textContent = "Team Boosts";
    const headline = element("p", "boost-headline");
    headline.textContent = boosted.boostSummaryForUI.headline;
    section.append(
      heading,
      headline,
      detailLine("Batting composite", `${formatOneDecimal(base.battingComposite)} → ${formatOneDecimal(boosted.adjustedBattingComposite)}`),
      detailLine("Bowling composite", `${formatOneDecimal(base.bowlingComposite)} → ${formatOneDecimal(boosted.adjustedBowlingComposite)}`),
      detailLine("Overall team rating", `${formatOneDecimal(base.overallTeamRating)} → ${formatOneDecimal(boosted.adjustedOverallTeamRating)}`),
      detailLine("Overall uplift", `+${formatOneDecimal(boosted.boostSummaryForUI.totalOverallEffect)}`),
    );
    for (const line of boosted.boostSummaryForUI.lines) {
      const item = element("p", "boost-line");
      item.textContent = line;
      section.append(item);
    }
    return section;
  }

  function renderSeasonSection(): HTMLElement {
    if (seasonUiState.phase === "setup") return renderSeasonSetup();
    if (seasonUiState.phase === "league_progress") return renderLeagueProgress(seasonUiState);
    if (seasonUiState.phase === "playoff_progress") return renderPlayoffProgress(seasonUiState);
    return renderCompletedSeason(seasonUiState.season);
  }

  function renderSeasonSetup(): HTMLElement {
    if (seasonUiState.phase !== "setup") throw new Error("Season setup rendered outside setup state.");
    const section = element("section", "season-setup");
    const heading = element("h2");
    heading.textContent = "2016 Season";
    const explanation = element("p");
    explanation.textContent = "Your XI will enter the deterministic 2016 league season.";
    const begin = button("Begin League", beginSeason);
    begin.className = "begin-season-button";
    section.append(heading, explanation, begin);
    return section;
  }

  function beginSeason(): void {
    if (seasonUiState.phase !== "setup") return;
    try {
      const replacementFranchiseId = V1_REPLACEMENT_FRANCHISE_ID;
      const boostedEvaluation = requiredRevealedTeam().boostedEvaluation;
      const profiles = services.buildProfiles(options.pool);
      const teams = createLeagueComposition(replacementFranchiseId, profiles);
      const schedule = generateDoubleRoundRobinSchedule(teams);
      const seed = `web-season-v1|${appSeed}|2016|${replacementFranchiseId}`;
      const leagueResult = services.simulateLeague({
        seed, teams, schedule, userState: state, userBoostedEvaluation: boostedEvaluation,
      });
      const playoffResult = services.simulatePlayoffs({
        leagueResult, teams, userState: state, userBoostedEvaluation: boostedEvaluation,
      });
      const season: PrecomputedSeason = { replacementFranchiseId, seed, leagueResult, playoffResult };
      seasonUiState = { phase: "league_progress", season, revealedUserLeagueMatches: 0 };
      temporaryState.error = null;
      render();
      scheduleNextProgressStep(season);
    } catch (error) {
      setError(error);
      render();
    }
  }

  function scheduleNextProgressStep(season: PrecomputedSeason): void {
    scheduleProgressStep(() => {
      if (seasonUiState.phase !== "league_progress" || seasonUiState.season !== season) return;
      const nextCount = seasonUiState.revealedUserLeagueMatches + 1;
      if (nextCount >= season.leagueResult.userMatchSummaries.length) {
        seasonUiState = season.playoffResult.qualified
          ? { phase: "playoff_progress", season, revealedPlayoffMatches: 0 }
          : { phase: "complete", season };
        render();
        return;
      }
      seasonUiState = { phase: "league_progress", season, revealedUserLeagueMatches: nextCount };
      render();
      scheduleNextProgressStep(season);
    });
  }

  function renderLeagueProgress(progress: Extract<SeasonUiState, { phase: "league_progress" }>): HTMLElement {
    return renderLeagueProgressForSeason(progress.season, progress.revealedUserLeagueMatches);
  }

  function renderLeagueProgressForSeason(season: PrecomputedSeason, revealedCount: number): HTMLElement {
    const section = element("section", "league-progress");
    const heading = element("h2");
    heading.textContent = "League Progress";
    const status = element("p", "league-progress-status");
    status.textContent = `${revealedCount}/14 league matches complete`;
    const segments = element("div", "league-progress-segments");
    segments.setAttribute("aria-label", "User league match progress");
    season.leagueResult.userMatchSummaries.forEach((summary, index) => {
      const segment = element("span", "league-progress-segment");
      if (index < revealedCount) {
        segment.classList.add(summary.result === "W" ? "league-progress-win" : "league-progress-loss");
        segment.textContent = summary.result;
        segment.setAttribute("aria-label", `League match ${index + 1}: ${summary.result === "W" ? "win" : "loss"}`);
      } else {
        segment.textContent = "";
        segment.setAttribute("aria-label", `League match ${index + 1}: pending`);
      }
      segments.append(segment);
    });
    section.append(heading, status, segments);
    return section;
  }

  function renderCompletedSeason(season: PrecomputedSeason): HTMLElement {
    const section = element("section", "season-results");
    section.append(
      renderLeagueProgressForSeason(season, season.leagueResult.userMatchSummaries.length),
      renderFinalTable(season.leagueResult),
      renderLeagueUserSummary(season.leagueResult),
    );
    if (!season.playoffResult.qualified) {
      const ended = element("h2", "season-outcome");
      ended.textContent = "Season ended — missed playoffs";
      section.append(ended);
    } else {
      section.append(renderPlayoffs(season, season.playoffResult.matches.length, true));
    }
    return section;
  }

  function renderFinalTable(league: LeagueSimulationResult): HTMLElement {
    const section = element("section", "final-table");
    const heading = element("h2");
    heading.textContent = "Final Points Table";
    const table = document.createElement("table");
    const header = document.createElement("tr");
    for (const value of ["Pos", "Team", "P", "W", "L", "Pts", "NRR", "Q"]) {
      const cell = document.createElement("th"); cell.textContent = value; header.append(cell);
    }
    const head = document.createElement("thead"); head.append(header); table.append(head);
    const body = document.createElement("tbody");
    for (const row of league.pointsTable) {
      const tr = document.createElement("tr");
      tr.dataset.teamId = row.teamId;
      for (const value of [row.position, row.teamId === "user" ? "Your XI" : row.displayName, row.played, row.won, row.lost, row.points,
        `${row.netRunRate >= 0 ? "+" : ""}${row.netRunRate.toFixed(3)}`, row.qualified ? "Yes" : "—"]) {
        const cell = document.createElement("td"); cell.textContent = String(value); tr.append(cell);
      }
      body.append(tr);
    }
    table.append(body); section.append(heading, table); return section;
  }

  function renderLeagueUserSummary(league: LeagueSimulationResult): HTMLElement {
    const section = element("section", "league-user-summary");
    const heading = element("h2"); heading.textContent = "Your League Season";
    section.append(
      heading,
      detailLine("Record", `${league.userRecord.won}-${league.userRecord.lost}`),
      detailLine("Table position", String(league.userRecord.tablePosition)),
      detailLine("Playoff status", league.userQualified ? "Qualified" : "Missed playoffs"),
      renderLeaders("Top 3 run scorers", league.topRunScorers, "runs"),
      renderLeaders("Top 3 wicket takers", league.topWicketTakers, "wickets"),
    );
    return section;
  }

  function renderLeaders(
    headingText: string,
    players: readonly { playerName: string; runs: number; wickets: number }[],
    statistic: "runs" | "wickets",
  ): HTMLElement {
    const section = element("section", "season-leaders");
    const heading = element("h3"); heading.textContent = headingText; section.append(heading);
    const list = document.createElement("ol");
    for (const player of players) {
      const item = document.createElement("li");
      item.textContent = `${player.playerName}: ${player[statistic]} ${statistic}`;
      list.append(item);
    }
    section.append(list); return section;
  }

  function renderPlayoffProgress(
    progress: Extract<SeasonUiState, { phase: "playoff_progress" }>,
  ): HTMLElement {
    const section = element("section", "season-results");
    section.append(
      renderLeagueProgressForSeason(progress.season, progress.season.leagueResult.userMatchSummaries.length),
      renderFinalTable(progress.season.leagueResult),
      renderLeagueUserSummary(progress.season.leagueResult),
      renderPlayoffs(progress.season, progress.revealedPlayoffMatches, false),
    );
    return section;
  }

  function renderPlayoffs(season: PrecomputedSeason, revealedCount: number, showOutcome: boolean): HTMLElement {
    const playoffs = season.playoffResult;
    if (!playoffs.qualified) throw new Error("Qualified playoff rendering requires playoff matches.");
    const section = element("section", "playoff-results");
    const heading = element("h2"); heading.textContent = "Playoffs"; section.append(heading);
    const teamNames = new Map(season.leagueResult.pointsTable.map((row) => [row.teamId, row.displayName]));
    teamNames.set("user", "Your XI");
    const userPath = playoffs.matches.filter((match) =>
      match.firstBattingTeamId === "user" || match.chasingTeamId === "user");
    userPath.slice(0, revealedCount).forEach((match) => {
      const row = element("div", "playoff-match");
      const title = element("h3"); title.textContent = formatPlayoffStage(match.stage);
      const result = element("p");
      const opponentTeamId = match.firstBattingTeamId === "user" ? match.chasingTeamId : match.firstBattingTeamId;
      result.textContent = match.winnerTeamId === "user"
        ? `Your XI defeated ${teamNames.get(opponentTeamId)} ${formatMatchResult(match)}`
        : `${teamNames.get(opponentTeamId)} defeated Your XI ${formatMatchResult(match)}`;
      const toss = element("p", "playoff-toss");
      toss.textContent = formatCosmeticToss(season.seed, match, teamNames);
      row.append(title, toss, result);
      const userSummary = playoffs.userMatchSummaries.find((summary) => summary.matchId === match.matchId);
      if (userSummary) {
        const compact = element("p", "user-playoff-summary");
        compact.textContent = userSummary.result === "W" ? "Result: Win" : "Result: Loss";
        row.append(compact);
      }
      section.append(row);
    });
    if (revealedCount < userPath.length) {
      const pending = element("p", "playoff-pending");
      pending.textContent = `${formatPlayoffStage(userPath[revealedCount]!.stage)} pending`;
      const simulate = button("Simulate Playoff Match", () => {
        if (seasonUiState.phase !== "playoff_progress" || seasonUiState.season !== season) return;
        const nextCount = seasonUiState.revealedPlayoffMatches + 1;
        seasonUiState = nextCount >= userPath.length
          ? { phase: "complete", season }
          : { phase: "playoff_progress", season, revealedPlayoffMatches: nextCount };
        render();
      });
      const finish = button("Progress to End", () => {
        if (seasonUiState.phase !== "playoff_progress" || seasonUiState.season !== season) return;
        seasonUiState = { phase: "complete", season };
        render();
      });
      const actions = element("div", "playoff-actions");
      actions.append(simulate, finish);
      section.append(pending, actions);
    }
    if (showOutcome) {
      if (playoffs.userOutcome === "champion" || playoffs.userOutcome === "runner_up") {
        const champion = element("p", "playoff-champion");
        champion.textContent = `Champion: ${teamNames.get(playoffs.championTeamId)}`;
        section.append(champion);
      }
      const outcome = element("p", "season-outcome");
      outcome.textContent = `Your outcome: ${formatUserPlayoffOutcome(playoffs.userOutcome)}`;
      section.append(outcome);
    }
    return section;
  }

  function requiredRevealedTeam(): RevealedTeamState {
    if (!revealedTeam) throw new Error("Reveal the completed team before beginning the season.");
    return revealedTeam;
  }

  function getActiveDetailsPlayer(): ({ source: "squad"; player: DraftPlayerSeason } | { source: "drafted"; player: DraftPlayerSeason; position: BattingPosition }) | null {
    const activeDetails = temporaryState.activeDetails;
    if (!activeDetails) {
      return null;
    }
    if (activeDetails.source === "drafted") {
      const slot = state.slots.find((candidate) => candidate.position === activeDetails.position);
      return slot ? { source: "drafted", player: slot.player, position: slot.position } : null;
    }
    const player = getCurrentSquad(options.pool, state).find((candidate) => candidate.id === activeDetails.playerId);
    return player ? { source: "squad", player } : null;
  }

  function getRevealedContribution(position: BattingPosition): EvaluatedPlayerContribution | null {
    if (!state.completed) {
      return null;
    }
    return revealedTeam?.evaluation.players.find((player) => player.slot.position === position) ?? null;
  }

  render();

  return {
    getState: () => state,
    setStateForTest: (nextState: ClassicDraftState) => {
      state = nextState;
      revealState = "hidden";
      revealedTeam = null;
      seasonUiState = { phase: "setup" };
      clearTemporaryState();
      render();
    },
  };
}

function formatPositionFitLabel(fit: "natural" | "acceptable" | "out_of_position"): string {
  return fit === "out_of_position" ? "out of position" : fit;
}

function formatPlayoffStage(stage: "qualifier_1" | "eliminator" | "qualifier_2" | "final"): string {
  const labels = {
    qualifier_1: "Qualifier 1",
    eliminator: "Eliminator",
    qualifier_2: "Qualifier 2",
    final: "Final",
  } as const;
  return labels[stage];
}

function formatUserPlayoffOutcome(
  outcome: "eliminated_in_eliminator" | "eliminated_in_qualifier_2" | "runner_up" | "champion",
): string {
  const labels = {
    eliminated_in_eliminator: "Eliminated in the Eliminator",
    eliminated_in_qualifier_2: "Eliminated in Qualifier 2",
    runner_up: "Runner-up",
    champion: "IPL Champion",
  } as const;
  return labels[outcome];
}

function formatMatchResult(match: {
  resultType: "runs" | "wickets" | "super_over";
  margin: number | null;
}): string {
  if (match.resultType === "super_over") return "in a Super Over";
  const unit = match.resultType === "runs" ? "run" : "wicket";
  return `by ${match.margin} ${unit}${match.margin === 1 ? "" : "s"}`;
}

function formatCosmeticToss(
  seed: string,
  match: { matchId: string; firstBattingTeamId: string; chasingTeamId: string },
  teamNames: ReadonlyMap<string, string>,
): string {
  const tossWinner = stableWebHash(`${seed}|playoff-toss|${match.matchId}`) % 2 === 0
    ? match.firstBattingTeamId
    : match.chasingTeamId;
  const choice = tossWinner === match.firstBattingTeamId ? "bat" : "bowl";
  return `Toss: ${teamNames.get(tossWinner) ?? tossWinner} won the toss and chose to ${choice}.`;
}

function stableWebHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function formatBowlingStrengthLabel(strength: string): string {
  return strength === "part_time" ? "part-time" : strength;
}

function formatBadges(player: DraftPlayerSeason): string[] {
  const badges: string[] = [];
  if (player.seasonRole === "bowler") {
    badges.push("BOWL");
  } else if (player.seasonRole === "batting_all_rounder" || player.seasonRole === "bowling_all_rounder") {
    badges.push("AR");
  } else {
    badges.push("BAT");
  }

  if (player.isWicketkeeper) {
    badges.push("WK");
  }
  if (player.isOverseas) {
    badges.push("OVERSEAS");
  }
  return badges;
}

function formatFullBattingStats(player: DraftPlayerSeason): string {
  const stats = player.displayedStats;
  const parts = [
    `innings ${stats.inningsBatted}`,
    `runs ${stats.runs}`,
    `balls ${stats.ballsFaced}`,
  ];
  if (stats.battingAverage !== null) {
    parts.push(`avg ${formatOneDecimal(stats.battingAverage)}`);
  }
  if (stats.strikeRate !== null) {
    parts.push(`SR ${formatOneDecimal(stats.strikeRate)}`);
  }
  return parts.join(" | ");
}

function formatFullBowlingStats(player: DraftPlayerSeason): string | null {
  const stats = player.displayedStats;
  const isBowlingRole = player.seasonRole === "bowler" || player.seasonRole === "batting_all_rounder" || player.seasonRole === "bowling_all_rounder";
  if (!isBowlingRole && stats.legalBallsBowled === 0 && stats.wickets === 0 && stats.economy === null) {
    return null;
  }
  const parts = [`wickets ${stats.wickets}`, `balls ${stats.legalBallsBowled}`, `runs conceded ${stats.runsConceded}`];
  if (stats.economy !== null) {
    parts.push(`econ ${formatOneDecimal(stats.economy)}`);
  }
  return parts.join(" | ");
}

function detailLine(label: string, value: string): HTMLElement {
  const row = element("p", "detail-line");
  const labelNode = element("span", "detail-label");
  labelNode.textContent = `${label}: `;
  const valueNode = element("span");
  valueNode.textContent = value;
  row.append(labelNode, valueNode);
  return row;
}

function formatOneDecimal(value: number): string {
  return value.toFixed(1);
}

function formatMultiplier(value: number): string {
  return value.toFixed(2);
}

function formatNullableRating(value: number | null): string {
  return value === null ? "-" : formatOneDecimal(value);
}

function tierClass(tier: Tier): string {
  return `tier-${tier.toLowerCase()}`;
}

function formatPositions(positions: BattingPosition[]): string {
  return positions.length > 0 ? positions.join(", ") : "-";
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(tagName: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  return node;
}
