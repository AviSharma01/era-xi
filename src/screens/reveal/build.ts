// Display-only helpers for the reveal. They read the reveal projection and never evaluate an XI.
import { fitDisplay, REVEAL_COPY as COPY, type FitDisplay } from "../../copy.js";
import type { DraftTierAppearance, RevealPlayerView, TeamEvaluationSummaryView } from "../../eraDraftTypes.js";
import type { QualityTier } from "../../playerQualityContract.js";

export const TIER_APPEARANCE: Readonly<Record<QualityTier, DraftTierAppearance>> = { S: "violet", A: "gold", B: "cobalt", C: "emerald", D: "slate" };

/** Team and player ratings to one decimal, exactly as projected. */
export function formatRating(value: number): string {
  return value.toFixed(1);
}

const tenths = (text: string): number => Math.round(Number(text) * 10);
const fromTenths = (value: number): string => (value / 10).toFixed(1);

/**
 * "Base 65.0 · Batting order −0.7", in team-rating points. The final number is strength.overall, the one the
 * simulation uses. Team rating is the mean of batting and bowling, so the batting-order loss moves it by half the
 * batting loss; that is checked against the projected numbers, and the build is left out if they ever disagree.
 * The loss is taken from the two displayed numbers, so base − loss = final to one decimal. Null when nothing is lost
 * at one decimal, and for historical (v2) games, which have no battingAdjustment.
 */
export type RatingBuild = { readonly base: string; readonly loss: string; readonly final: string; readonly baseValue: number };
export function ratingBuild(evaluation: TeamEvaluationSummaryView): RatingBuild | null {
  const adjustment = evaluation.battingAdjustment;
  if (!adjustment) return null;
  const { overall, batting, bowling } = evaluation.strength;
  if (Math.abs(adjustment.adjustedBatting - batting) > 1e-9 || Math.abs((batting + bowling) / 2 - overall) > 1e-9) return null;
  const baseValue = overall + (adjustment.baseBatting - adjustment.adjustedBatting) / 2;
  const base = formatRating(baseValue), final = formatRating(overall);
  const loss = tenths(base) - tenths(final);
  return loss > 0 ? { base, loss: fromTenths(loss), final, baseValue } : null;
}

/** "4 of 5 bowling slots covered", only when the deployment is short. Rounded down, so it never reads as covered. */
export function bowlingCoverage(construction: TeamEvaluationSummaryView["construction"]): string | null {
  const { deployedBowlingUnits: deployed, requiredBowlingUnits: required } = construction;
  if (deployed >= required - 1e-9) return null;
  const covered = Math.floor(deployed * 10 + 1e-9) / 10;
  return COPY.bowlingCovered(Number.isInteger(covered) ? String(covered) : covered.toFixed(1), required);
}

/** The ratings a role is judged on: batting for batters, bowling for bowlers, both for all-rounders. */
export function roleRatings(player: RevealPlayerView): { readonly batting: number | null; readonly bowling: number | null } {
  const role = player.displayRole;
  return {
    batting: role === "BOWLER" ? null : player.battingRating,
    bowling: role === "BATTER" || role === "WICKETKEEPER_BATTER" ? null : player.bowlingRating,
  };
}

/** V3 games carry the slot's nominal loss; historical games show the label alone. */
export function revealFit(player: RevealPlayerView): FitDisplay {
  return fitDisplay(player.presentationFit, player.battingAdjustment?.penaltyPercent);
}

/** The players whose position actually cost batting points (after the contribution floor). */
export function costlyFit(player: RevealPlayerView): boolean {
  return (player.battingAdjustment?.deduction ?? 0) > 0;
}
