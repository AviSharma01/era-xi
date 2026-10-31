import { evaluateCompletedEraXi, TEAM_EVALUATION_V2_VERSION, type EraCompletedXiInput, type TeamEvaluationV2 } from "./teamEvaluationV2.js";
import { evaluateCompletedEraXiV3, TEAM_EVALUATION_V3_VERSION, type TeamEvaluationV3 } from "./teamEvaluationV3.js";

export type TeamEvaluationVersion = typeof TEAM_EVALUATION_V2_VERSION | typeof TEAM_EVALUATION_V3_VERSION;
export type EraTeamEvaluation = TeamEvaluationV2 | TeamEvaluationV3;

/** Absence belongs exclusively to legacy contracts. Never substitute today's creation default. */
export function evaluationVersionOf(state: { readonly teamEvaluationVersion?: TeamEvaluationVersion }): TeamEvaluationVersion {
  if (!Object.hasOwn(state, "teamEvaluationVersion")) return TEAM_EVALUATION_V2_VERSION;
  if (state.teamEvaluationVersion === TEAM_EVALUATION_V2_VERSION || state.teamEvaluationVersion === TEAM_EVALUATION_V3_VERSION) return state.teamEvaluationVersion;
  throw new Error(`Unsupported team evaluation version ${String(state.teamEvaluationVersion)}.`);
}

export function evaluateEraXiByVersion(input: EraCompletedXiInput, version: TeamEvaluationVersion): EraTeamEvaluation {
  if (version === TEAM_EVALUATION_V2_VERSION) return evaluateCompletedEraXi(input);
  if (version === TEAM_EVALUATION_V3_VERSION) return evaluateCompletedEraXiV3(input);
  throw new Error(`Unsupported team evaluation version ${String(version)}.`);
}
