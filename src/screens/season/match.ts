// Display-only readings of a finished league match. They read the projected result and never change it.
import type { SeasonMatchView } from "../../eraDraftTypes.js";

/** A chase finished in the last over: the chase innings lasted 115 balls or more. */
export const LAST_OVER_BALLS = 115;
/** A defended total won by this many runs or fewer. */
export const CLOSE_RUNS_MARGIN = 6;

export type MatchMargin =
  | { readonly kind: "RUNS"; readonly value: number }
  | { readonly kind: "WICKETS"; readonly value: number }
  | { readonly kind: "SUPER_OVER" };

/** The winning margin as the scorecard states it: level scores went to a Super Over. */
export function matchMargin(match: SeasonMatchView): MatchMargin {
  const { firstInnings: first, secondInnings: chase } = match;
  if (first.runs === chase.runs) return { kind: "SUPER_OVER" };
  if (match.winnerTeamId === first.teamId) return { kind: "RUNS", value: first.runs - chase.runs };
  return { kind: "WICKETS", value: 10 - chase.wickets };
}

/**
 * Presentation-only close-match rule (decided, rule B): a defended win or loss by 6 runs or fewer, a chase finished in
 * the last over, or a Super Over. It reads the finished result only.
 */
export function isCloseMatch(match: SeasonMatchView): boolean {
  const margin = matchMargin(match);
  if (margin.kind === "SUPER_OVER") return true;
  if (margin.kind === "RUNS") return margin.value <= CLOSE_RUNS_MARGIN;
  return match.secondInnings.balls >= LAST_OVER_BALLS;
}

/** Overs as cricket writes them: 120 balls is "20", 111 balls is "18.3". */
export function formatOvers(balls: number): string {
  const overs = Math.floor(balls / 6);
  const rest = balls % 6;
  return rest === 0 ? String(overs) : `${overs}.${rest}`;
}

/** All out shows the runs alone; otherwise runs/wickets. */
export function formatScore(runs: number, wickets: number): string {
  return wickets === 10 ? String(runs) : `${runs}/${wickets}`;
}

export function formatNetRunRate(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(3)}`;
}
