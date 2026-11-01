// Player-facing words live here, so the voice stays consistent. Screens move in as their batch touches them.
import type { DraftPresentationFit } from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";

export const ERA_COPY: Readonly<Record<EraId, { ordinal: string; title: string; years: string; flavor: string }>> = {
  "era-foundation": { ordinal: "01", title: "Foundation", years: "2008–2010", flavor: "The first blueprints. Raw squads, instant icons." },
  "era-expansion": { ordinal: "02", title: "Expansion", years: "2011–2013", flavor: "New teams arrive and the league finds its shape." },
  "era-transition": { ordinal: "03", title: "Transition", years: "2014–2017", flavor: "Power shifts, new homes, and changing dynasties." },
  "era-modern-pre-impact": { ordinal: "04", title: "Modern Pre-Impact", years: "2018–2022", flavor: "Deep analytics meet settled franchise identities." },
  "era-impact": { ordinal: "05", title: "Impact", years: "2023–2026", flavor: "The newest tactical era at full intensity." },
};

/** Display only: standard abbreviations for small cards, keyed by the projected teamId. */
export const TEAM_ABBREVIATIONS: Readonly<Record<string, string>> = {
  "team-chennai-super-kings": "CSK",
  "team-deccan-chargers": "DEC",
  "team-delhi-capitals": "DC",
  "team-delhi-daredevils": "DD",
  "team-gujarat-lions": "GL",
  "team-gujarat-titans": "GT",
  "team-kings-xi-punjab": "KXIP",
  "team-kochi-tuskers-kerala": "KTK",
  "team-kolkata-knight-riders": "KKR",
  "team-lucknow-super-giants": "LSG",
  "team-mumbai-indians": "MI",
  "team-pune-warriors": "PWI",
  "team-punjab-kings": "PBKS",
  "team-rajasthan-royals": "RR",
  "team-rising-pune-supergiant": "RPS",
  "team-royal-challengers-bangalore": "RCB",
  "team-royal-challengers-bengaluru": "RCB",
  "team-sunrisers-hyderabad": "SRH",
};

export function teamAbbreviation(teamId: string, teamName: string): string {
  return TEAM_ABBREVIATIONS[teamId] ?? teamName;
}

export const PLAYER_CARD_COPY = {
  tier: (letter: string) => `${letter} tier`,
  preview: "Preview",
  locking: "Locking…",
  locked: "Locked",
  unavailable: "Unavailable",
  noStats: "No recorded statistics",
  keeper: "Wicketkeeper",
  eraBest: (era: string) => `His best ${era} season`,
  seasonStats: (year: number) => `${year} current season statistics`,
  runs: (count: number) => (count === 1 ? "run" : "runs"),
  wickets: (count: number) => (count === 1 ? "wicket" : "wickets"),
  wicketsShort: (count: number) => (count === 1 ? "wkt" : "wkts"),
  strikeRate: "SR",
  economy: "econ",
} as const;

export function rosterLabel(status: "INDIAN" | "OVERSEAS"): string {
  return status === "OVERSEAS" ? "Overseas" : "Indian";
}

export function friendly(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function fitLabel(fit: DraftPresentationFit): string {
  // Approved UI fallback only: authoritative UNKNOWN remains neutral and unchanged.
  return friendly(fit === "UNKNOWN" ? "ACCEPTABLE" : fit);
}
