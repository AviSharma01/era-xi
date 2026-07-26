import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  type DraftPool,
  createClassicDraftState,
  createSeededRandom,
  getCurrentSquad,
  pickPlayer,
  spinFranchiseSeason,
  useVoluntaryRespin,
} from "./draftClassic.js";
import {
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
import {
  type SeasonRunOpeningStage,
  type SeasonRunSeason,
  type SeasonRunUiState,
  renderSeasonRun,
} from "./seasonRun.js";
import { buildOpponentStrengthProfiles2016 } from "./opponentProfiles2016.js";
import {
  type Franchise2016Id,
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
  scrollToSection?: (id: "league-stage" | "playoffs") => void;
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

const V1_REPLACEMENT_FRANCHISE_ID: Franchise2016Id = "delhi-daredevils";

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
  const scrollToSection = options.scrollToSection ?? ((id: "league-stage" | "playoffs") => {
    const target = document.getElementById(id);
    if (!target || typeof target.scrollIntoView !== "function") return;
    const view = document.defaultView;
    const reducedMotion = view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  });
  let state = options.initialState ?? createClassicDraftState();
  let revealState: RevealState = "hidden";
  let revealedTeam: RevealedTeamState | null = null;
  let seasonUiState: SeasonRunUiState = { phase: "setup" };
  let openingStage: SeasonRunOpeningStage = null;
  let pendingScrollTarget: "league-stage" | "playoffs" | null = null;
  let temporaryState: DraftRoomUiState = createDraftRoomUiState();

  function clearTemporaryState(): void {
    temporaryState = createDraftRoomUiState();
  }

  function setError(error: unknown): void {
    temporaryState.error = error instanceof Error ? error.message : String(error);
  }

  function render(): void {
    options.root.replaceChildren(renderApp());
    if (pendingScrollTarget) {
      scrollToSection(pendingScrollTarget);
      pendingScrollTarget = null;
    }
    openingStage = null;
  }

  function renderApp(): HTMLElement {
    const shell = element("section", "app-shell");
    if (state.completed && revealState === "revealed") {
      const revealed = requiredRevealedTeam();
      shell.append(renderSeasonRun({
        state,
        evaluation: revealed.evaluation,
        boostedEvaluation: revealed.boostedEvaluation,
        uiState: seasonUiState,
        error: temporaryState.error,
        openingStage,
        actions: {
          beginSeason,
          beginPlayoffs,
          simulateNextPlayoff: simulateNextPlayoffMatch,
          progressPlayoffsToEnd,
          startNewDraft,
        },
      }));
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
      const season: SeasonRunSeason = { replacementFranchiseId, seed, leagueResult, playoffResult };
      seasonUiState = { phase: "league_progress", season, revealedLeagueMatches: 0 };
      temporaryState.error = null;
      openingStage = "league";
      pendingScrollTarget = "league-stage";
      render();
      scheduleNextProgressStep(season);
    } catch (error) {
      setError(error);
      render();
    }
  }

  function scheduleNextProgressStep(season: SeasonRunSeason): void {
    scheduleProgressStep(() => {
      if (seasonUiState.phase !== "league_progress" || seasonUiState.season !== season) return;
      const nextCount = seasonUiState.revealedLeagueMatches + 1;
      if (nextCount >= season.leagueResult.userMatchSummaries.length) {
        seasonUiState = { phase: "league_complete", season };
        render();
        return;
      }
      seasonUiState = { phase: "league_progress", season, revealedLeagueMatches: nextCount };
      render();
      scheduleNextProgressStep(season);
    });
  }

  function beginPlayoffs(): void {
    if (seasonUiState.phase !== "league_complete" || !seasonUiState.season.playoffResult.qualified) return;
    seasonUiState = {
      phase: "playoff_progress",
      season: seasonUiState.season,
      revealedPlayoffMatches: 0,
    };
    openingStage = "playoffs";
    pendingScrollTarget = "playoffs";
    render();
  }

  function simulateNextPlayoffMatch(): void {
    if (seasonUiState.phase !== "playoff_progress") return;
    const season = seasonUiState.season;
    const userPathLength = season.playoffResult.matches.filter((match) =>
      match.firstBattingTeamId === "user" || match.chasingTeamId === "user").length;
    const nextCount = seasonUiState.revealedPlayoffMatches + 1;
    seasonUiState = nextCount >= userPathLength
      ? { phase: "season_complete", season }
      : { phase: "playoff_progress", season, revealedPlayoffMatches: nextCount };
    render();
  }

  function progressPlayoffsToEnd(): void {
    if (seasonUiState.phase !== "playoff_progress") return;
    seasonUiState = { phase: "season_complete", season: seasonUiState.season };
    render();
  }

  function startNewDraft(): void {
    state = createClassicDraftState();
    revealState = "hidden";
    revealedTeam = null;
    seasonUiState = { phase: "setup" };
    openingStage = null;
    pendingScrollTarget = null;
    clearTemporaryState();
    render();
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

  render();

  return {
    getState: () => state,
    setStateForTest: (nextState: ClassicDraftState) => {
      state = nextState;
      revealState = "hidden";
      revealedTeam = null;
      seasonUiState = { phase: "setup" };
      openingStage = null;
      pendingScrollTarget = null;
      clearTemporaryState();
      render();
    },
  };
}

function element<K extends keyof HTMLElementTagNameMap>(tagName: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  return node;
}
