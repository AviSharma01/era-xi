import { renderCompletedTeam } from "./completedTeam.js";
import { type ClassicDraftState } from "./draftClassic.js";
import { type BoostedTeamEvaluationV1 } from "./teamBoostV1.js";
import { type TeamEvaluation } from "./teamEvaluation.js";
import {
  type Franchise2016Id,
  type LeagueSimulationResult,
  type PlayoffMatchResult,
  type PlayoffSimulationResult,
} from "./simulationV1.js";

export type SeasonRunSeason = {
  replacementFranchiseId: Franchise2016Id;
  seed: string;
  leagueResult: LeagueSimulationResult;
  playoffResult: PlayoffSimulationResult;
};

export type SeasonRunUiState =
  | { phase: "setup" }
  | { phase: "league_progress"; season: SeasonRunSeason; revealedLeagueMatches: number }
  | { phase: "league_complete"; season: SeasonRunSeason }
  | { phase: "playoff_progress"; season: SeasonRunSeason; revealedPlayoffMatches: number }
  | { phase: "season_complete"; season: SeasonRunSeason };

export type SeasonRunOpeningStage = "league" | "playoffs" | null;

type SeasonRunOptions = {
  state: ClassicDraftState;
  evaluation: TeamEvaluation;
  boostedEvaluation: BoostedTeamEvaluationV1;
  uiState: SeasonRunUiState;
  error: string | null;
  openingStage: SeasonRunOpeningStage;
  actions: {
    beginSeason: () => void;
    beginPlayoffs: () => void;
    simulateNextPlayoff: () => void;
    progressPlayoffsToEnd: () => void;
    startNewDraft: () => void;
  };
};

export function renderSeasonRun(options: SeasonRunOptions): HTMLElement {
  const { uiState } = options;
  const screen = element("section", `season-run-screen season-run-${uiState.phase}`);
  screen.append(renderCompletedTeam({
    state: options.state,
    evaluation: options.evaluation,
    boostedEvaluation: options.boostedEvaluation,
    error: options.error,
    onBeginSeason: uiState.phase === "setup" ? options.actions.beginSeason : undefined,
    quiet: uiState.phase !== "setup",
  }));

  if (uiState.phase === "setup") return screen;

  const leagueComplete = uiState.phase !== "league_progress";
  const league = renderLeagueStage(
    uiState.season,
    uiState.phase === "league_progress"
      ? uiState.revealedLeagueMatches
      : uiState.season.leagueResult.userMatchSummaries.length,
    leagueComplete,
    uiState.phase === "league_progress" || uiState.phase === "league_complete",
    options.openingStage === "league",
    options.actions,
  );
  screen.append(league);

  if (uiState.phase === "playoff_progress" || uiState.phase === "season_complete") {
    screen.append(renderPlayoffs(
      uiState.season,
      uiState.phase === "playoff_progress"
        ? uiState.revealedPlayoffMatches
        : getUserPath(uiState.season).length,
      uiState.phase === "season_complete",
      options.openingStage === "playoffs",
      options.actions,
    ));
  }

  return screen;
}

function renderLeagueStage(
  season: SeasonRunSeason,
  revealedCount: number,
  complete: boolean,
  current: boolean,
  opening: boolean,
  actions: SeasonRunOptions["actions"],
): HTMLElement {
  const league = season.leagueResult;
  const classes = [
    "season-run-stage",
    "league-stage",
    current ? "season-run-stage-active" : "season-run-stage-quiet",
    opening ? "season-run-stage-opening" : "",
  ].filter(Boolean).join(" ");
  const section = element("section", classes);
  section.id = "league-stage";

  const heading = element("h2");
  heading.textContent = "League Stage";
  const revealed = league.userMatchSummaries.slice(0, revealedCount);
  const wins = revealed.filter((summary) => summary.result === "W").length;
  const losses = revealed.length - wins;
  const summary = element("div", "league-stage-summary");
  summary.append(
    stageMetric("Matches", `${revealedCount} of ${league.userMatchSummaries.length} matches complete`),
    stageMetric("Record", `${wins}–${losses}`),
  );
  if (complete) {
    summary.append(
      stageMetric("Table Position", String(league.userRecord.tablePosition)),
      stageMetric("Status", league.userQualified ? "Qualified" : "Missed Playoffs"),
    );
  }

  section.append(heading, summary, renderLeagueSegments(league, revealedCount));

  if (complete) {
    const completed = element("div", "league-stage-completed");
    completed.append(
      renderFinalTable(league),
      renderLeagueLeaders(league),
    );
    section.append(completed);

    if (league.userQualified) {
      if (current) {
        const action = element("div", "season-stage-action");
        const begin = button("Begin Playoffs", actions.beginPlayoffs);
        begin.className = "season-primary-action begin-playoffs-button";
        action.append(begin);
        section.append(action);
      }
    } else {
      section.append(renderTerminalOutcome("Missed Playoffs", actions.startNewDraft));
    }
  }

  return section;
}

function renderLeagueSegments(league: LeagueSimulationResult, revealedCount: number): HTMLElement {
  const segments = element("div", "league-progress-segments");
  segments.setAttribute("aria-label", `${revealedCount} of ${league.userMatchSummaries.length} matches complete`);
  league.userMatchSummaries.forEach((summary, index) => {
    const segment = element("span", "league-progress-segment");
    if (index < revealedCount) {
      segment.classList.add(summary.result === "W" ? "league-progress-win" : "league-progress-loss");
      segment.textContent = summary.result;
      segment.setAttribute(
        "aria-label",
        `League match ${index + 1}: ${summary.result === "W" ? "win" : "loss"}`,
      );
    } else {
      segment.setAttribute("aria-label", `League match ${index + 1}: pending`);
    }
    segments.append(segment);
  });
  return segments;
}

function renderFinalTable(league: LeagueSimulationResult): HTMLElement {
  const section = element("section", "final-table");
  const heading = element("h3");
  heading.textContent = "Final Standings";
  const table = document.createElement("table");
  const columns = [
    { label: "Pos", className: "standings-position" },
    { label: "Team", className: "standings-team" },
    { label: "P", className: "standings-played" },
    { label: "W", className: "standings-won" },
    { label: "L", className: "standings-lost" },
    { label: "Pts", className: "standings-points" },
    { label: "NRR", className: "standings-nrr standings-mobile-optional" },
    { label: "Q", className: "standings-qualified standings-mobile-optional" },
  ];
  const header = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.className = column.className;
    cell.scope = "col";
    cell.textContent = column.label;
    header.append(cell);
  }
  const head = document.createElement("thead");
  head.append(header);
  table.append(head);

  const body = document.createElement("tbody");
  for (const row of league.pointsTable) {
    const tr = document.createElement("tr");
    tr.dataset.teamId = row.teamId;
    const values = [
      row.position,
      row.teamId === "user" ? "Your XI" : row.displayName,
      row.played,
      row.won,
      row.lost,
      row.points,
      `${row.netRunRate >= 0 ? "+" : ""}${row.netRunRate.toFixed(3)}`,
      row.qualified ? "Yes" : "—",
    ];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      cell.className = columns[index]!.className;
      cell.textContent = String(value);
      tr.append(cell);
    });
    body.append(tr);
  }
  table.append(body);
  section.append(heading, table);
  return section;
}

function renderLeagueLeaders(league: LeagueSimulationResult): HTMLElement {
  const section = element("section", "league-leaders");
  const heading = element("h3");
  heading.textContent = "Team Leaders";
  const grid = element("div", "league-leaders-grid");
  grid.append(
    renderLeaders("Top Run Scorers", league.topRunScorers, "runs"),
    renderLeaders("Top Wicket Takers", league.topWicketTakers, "wickets"),
  );
  section.append(heading, grid);
  return section;
}

function renderLeaders(
  headingText: string,
  players: readonly { playerName: string; runs: number; wickets: number }[],
  statistic: "runs" | "wickets",
): HTMLElement {
  const section = element("section", "season-leaders");
  const heading = element("h4");
  heading.textContent = headingText;
  const list = document.createElement("ol");
  for (const player of players) {
    const item = document.createElement("li");
    const name = element("span");
    name.textContent = player.playerName;
    const value = element("strong");
    value.textContent = `${player[statistic]} ${statistic}`;
    item.append(name, value);
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

function renderPlayoffs(
  season: SeasonRunSeason,
  revealedCount: number,
  complete: boolean,
  opening: boolean,
  actions: SeasonRunOptions["actions"],
): HTMLElement {
  if (!season.playoffResult.qualified) {
    throw new Error("Playoffs cannot render for a non-qualified season.");
  }
  const classes = [
    "season-run-stage",
    "playoffs-stage",
    complete ? "season-run-stage-terminal" : "season-run-stage-active",
    opening ? "season-run-stage-opening" : "",
  ].filter(Boolean).join(" ");
  const section = element("section", classes);
  section.id = "playoffs";
  const heading = element("h2");
  heading.textContent = "Playoffs";
  section.append(heading);

  const teamNames = new Map<string, string>(
    season.leagueResult.pointsTable.map((row) => [row.teamId, row.displayName]),
  );
  const userPath = getUserPath(season);
  const history = element("div", "playoff-journey");
  for (const match of userPath.slice(0, revealedCount)) {
    history.append(renderPlayoffMatch(season.seed, match, teamNames));
  }
  if (history.childElementCount > 0) section.append(history);

  if (revealedCount < userPath.length) {
    const pendingMatch = userPath[revealedCount]!;
    const opponentId = getOpponentId(pendingMatch);
    const pending = element("section", "playoff-current-match");
    const stage = element("h3");
    stage.textContent = formatPlayoffStage(pendingMatch.stage);
    const opponent = element("p");
    opponent.textContent = `Opponent: ${teamNames.get(opponentId) ?? opponentId}`;
    pending.append(stage, opponent);

    const controls = element("div", "playoff-actions");
    const finish = button("Progress to End", actions.progressPlayoffsToEnd);
    finish.className = "season-secondary-action";
    const simulate = button("Simulate Next Match", actions.simulateNextPlayoff);
    simulate.className = "season-primary-action";
    controls.append(finish, simulate);
    section.append(pending, controls);
  } else if (complete) {
    section.append(renderTerminalOutcome(
      formatUserPlayoffOutcome(season.playoffResult.userOutcome),
      actions.startNewDraft,
    ));
  }

  return section;
}

function renderPlayoffMatch(
  seed: string,
  match: PlayoffMatchResult,
  teamNames: ReadonlyMap<string, string>,
): HTMLElement {
  const row = element("article", "playoff-match");
  const stage = element("h3");
  stage.textContent = formatPlayoffStage(match.stage);
  const opponentId = getOpponentId(match);
  const opponent = element("p", "playoff-opponent");
  opponent.textContent = `Opponent: ${teamNames.get(opponentId) ?? opponentId}`;
  const toss = element("p", "playoff-toss");
  toss.textContent = formatCosmeticToss(seed, match, teamNames);
  const result = element("p", "playoff-result");
  result.textContent = match.winnerTeamId === "user"
    ? `Win ${formatMatchResult(match)}`
    : `Loss ${formatMatchResult(match)}`;
  row.append(stage, opponent, toss, result);
  return row;
}

function renderTerminalOutcome(label: string, onStartNewDraft: () => void): HTMLElement {
  const section = element("section", "season-terminal-outcome");
  const eyebrow = element("span");
  eyebrow.textContent = "Final Outcome";
  const outcome = element("h3", "season-outcome");
  outcome.textContent = label;
  const restart = button("Start New Draft", onStartNewDraft);
  restart.className = "season-secondary-action restart-button";
  section.append(eyebrow, outcome, restart);
  return section;
}

function stageMetric(label: string, value: string): HTMLElement {
  const metric = element("div", "league-stage-metric");
  const labelNode = element("span");
  labelNode.textContent = label;
  const valueNode = element("strong");
  valueNode.textContent = value;
  metric.append(labelNode, valueNode);
  return metric;
}

function getUserPath(season: SeasonRunSeason): PlayoffMatchResult[] {
  return season.playoffResult.matches.filter((match) =>
    match.firstBattingTeamId === "user" || match.chasingTeamId === "user");
}

function getOpponentId(match: PlayoffMatchResult): string {
  return match.firstBattingTeamId === "user" ? match.chasingTeamId : match.firstBattingTeamId;
}

function formatPlayoffStage(stage: PlayoffMatchResult["stage"]): string {
  const labels = {
    qualifier_1: "Qualifier 1",
    eliminator: "Eliminator",
    qualifier_2: "Qualifier 2",
    final: "Final",
  } as const;
  return labels[stage];
}

function formatUserPlayoffOutcome(
  outcome: Exclude<PlayoffSimulationResult["userOutcome"], "not_qualified">,
): string {
  const labels = {
    eliminated_in_eliminator: "Eliminated in Eliminator",
    eliminated_in_qualifier_2: "Eliminated in Qualifier 2",
    runner_up: "Runner-up",
    champion: "Champion",
  } as const;
  return labels[outcome];
}

function formatMatchResult(match: PlayoffMatchResult): string {
  if (match.resultType === "super_over") return "in a Super Over";
  const unit = match.resultType === "runs" ? "run" : "wicket";
  return `by ${match.margin} ${unit}${match.margin === 1 ? "" : "s"}`;
}

function formatCosmeticToss(
  seed: string,
  match: Pick<PlayoffMatchResult, "matchId" | "firstBattingTeamId" | "chasingTeamId">,
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

function button(text: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}
