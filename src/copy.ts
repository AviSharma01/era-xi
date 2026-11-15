// Player-facing words live here, so the voice stays consistent. Screens move in as their batch touches them.
import type { DraftPresentationFit, EraDraftSelectionRejectionCode } from "./eraDraftTypes.js";
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

const SHORT_ROLES: Readonly<Record<string, string>> = { WICKETKEEPER_BATTER: "WK-batter", ALL_ROUNDER: "All-rounder" };
/** Small cards have one line for the role. */
export function shortRole(role: string): string {
  return SHORT_ROLES[role] ?? friendly(role);
}

export function fitLabel(fit: DraftPresentationFit): string {
  // Approved UI fallback only: authoritative UNKNOWN remains neutral and unchanged.
  return friendly(fit === "UNKNOWN" ? "ACCEPTABLE" : fit);
}

const FIT_LABELS: Readonly<Record<DraftPresentationFit, string>> = {
  NATURAL: "Natural", ACCEPTABLE: "Acceptable", STRETCH: "Stretch", MAJOR_STRETCH: "Major stretch", UNKNOWN: "Untested",
};
/** The projection's "major stretch" spans two losses; the extreme one is only ever at the far ends of the order. */
const OUT_OF_POSITION_PERCENT = 30;

export type FitDisplay = { readonly label: string; readonly percent: string | null; readonly loss: boolean; readonly text: string };
/** V3 games carry nominalDeductionPercent. Historical games have no percentage and keep their labels. `text` is the accessible wording. */
export function fitDisplay(fit: DraftPresentationFit, nominalDeductionPercent: number | undefined): FitDisplay {
  if (nominalDeductionPercent === undefined) {
    const label = fitLabel(fit);
    return { label, percent: null, loss: false, text: label };
  }
  const label = fit === "MAJOR_STRETCH" && nominalDeductionPercent >= OUT_OF_POSITION_PERCENT ? "Out of position" : FIT_LABELS[fit];
  // Only a loss shows a number; no loss is the word alone, with "no loss" kept for assistive technology.
  if (nominalDeductionPercent <= 0) return { label, percent: null, loss: false, text: `${label}, no loss` };
  const percent = `\u2212${nominalDeductionPercent}%`;
  return { label, percent, loss: true, text: `${label} ${percent}` };
}

export function slotLabel(position: number, fit: string | null, unavailableReasons: string | null): string {
  if (fit === null) return `Position ${position} · Open position`;
  return `Position ${position} · ${fit} · ${unavailableReasons ?? "Available for preview"}`;
}

const SLOT = (position: number): string => String(position).padStart(2, "0");

export const DRAFTING_COPY = {
  pickOf: (pick: number) => `Pick ${SLOT(pick)} / 11`,
  spin: "Spin franchise",
  tapToSkip: "Tap to skip",
  respinTitle: "Respin",
  respinning: "Respinning…",
  respinHint: "The squad is replaced when the reel lands. Your selection is cleared; nothing was locked.",
  squadAfterSpin: "The squad appears here after the spin.",
  pickAPlayer: "Pick a player",
  pickAPlayerHint: "Choose anyone from the squad to see their card.",
  reelSkip: "Spinning. Skip to the result",
  spinning: "Spinning a franchise-season",
  respinAvailable: "Respin · 1 left",
  respinUsed: "Respin used",
  readyFirst: "Ready to draft",
  readyNext: "Ready for the next spin",
  squadEmpty: "Spin a franchise-season, then pick one player.",
  squadEmptyPrivate: "Spin, then pick one player. Your picks stay private.",
  squadTitle: "Eligible squad",
  squadCount: (count: number) => `${count} players`,
  squadLegend: "Eligible player-season choices",
  keeperShort: "WK",
  dockLabel: "Selected player",
  clear: "Clear",
  inspectSeason: "Inspect season",
  chooseSlot: "Choose a slot. Natural fits are brightest.",
  clickAgain: "Click again to lock",
  clickSlotAgain: (position: number) => `Click slot ${SLOT(position)} again to lock`,
  inSlot: (position: number) => `In slot ${SLOT(position)}:`,
  tapLock: "Tap Lock to confirm",
  tapSlot: "Tap an open slot to preview",
  chooseFirst: "Choose a player from the squad first",
  lock: "Lock",
  lockIn: (position: number) => `Lock in ${SLOT(position)}`,
  waiting: "Waiting for server…",
  placeInXi: "Place in XI",
  changePlayer: "Change player",
  backToSquad: "← Squad",
  yourXi: "Your XI",
  lockedCount: (count: number) => `${count} / 11 locked`,
  overseas: "Overseas",
  topOrder: "Top order",
  middleOrder: "Middle order",
  lowerOrder: "Lower order",
  slotUnavailable: "Unavailable",
  noLoss: ", no loss",
  stripLabel: (count: number) => `Your XI, ${count} of 11 locked. View your XI`,
  lockedSlotLabel: (name: string, position: number, fit: string) => `Inspect ${name}, position ${position}, confirmed, ${fit}`,
  previewSlotLabel: (name: string, position: number, fit: string, small: boolean) => `${small ? "Preview" : "Confirm pick"} ${name}, position ${position}, preview, ${fit}`,
  lockingSlotLabel: (name: string, position: number, fit: string) => `${name}, position ${position}, locking, waiting for the server, ${fit}`,
  spinPrompt: "Spin to reveal a franchise-season.",
  spinResult: (team: string, year: number) => `${team} ${year} revealed. Choose one player.`,
  selectionCleared: "Player selection cleared.",
  playerSelected: (name: string) => `${name} selected. Choose an open batting position.`,
  slotPreview: (position: number, fit: string) => `Preview in position ${position}: ${fit}. Lock to confirm.`,
  pickLocked: (pick: number) => `Pick ${pick} locked. Spin again.`,
  xiComplete: "Pick 11 locked. Your XI is complete.",
  soloCompleteTitle: "XI complete",
  soloCompleteCount: "11 / 11 confirmed",
  soloCompleteStatus: (overseas: number, keeperCovered: boolean) => `Overseas ${overseas} / 4 · Wicketkeeper ${keeperCovered ? "covered" : "needed"}`,
  soloCompleteNext: "Reveal your team’s ratings and construction.",
  soloReveal: "Reveal team",
  roomCompleteTitle: "Your XI is ready.",
  roomCompleteCount: "11 / 11 locked",
  roomCompleteAutoSubmit: "Submit to freeze your team and wait for the room. If you stay unsubmitted, the backend automatically submits a complete legal XI at the deadline.",
  roomCompleteHidden: "Ratings and everyone else’s picks stay hidden during drafting.",
  roomSubmit: "Submit XI",
  limitsLabel: "Draft limits",
  overseasShort: "OS",
  keeperChip: "WK",
  keeperChipNeeded: "needed",
  keeperChipCovered: "covered",
  tierS: "S",
  tierSA: "S+A",
  limitFull: "full",
  limitChipLabel: (name: string, count: number, limit: number, full: boolean) => `${name} ${count} of ${limit}${full ? ", full" : ""}`,
  keeperChipLabel: (covered: boolean) => `Wicketkeeper ${covered ? "covered" : "needed"}`,
  sTierName: "S tier",
  saTierName: "S and A tiers combined",
  cantPick: (reason: string) => `Can’t pick · ${reason}`,
  cantPlace: (name: string, reason: string) => `${name} can’t be placed: ${reason}`,
  blockedSlotLabel: (position: number, name: string, reason: string) => `Position ${position} · Open position · ${name} can’t be placed: ${reason}`,
  slotNotAvailable: "Not available",
  slotNotAvailableNotice: (position: number, reason: string) => `Position ${position} is not available: ${reason}.`,
  cantPickNotice: (name: string, reason: string) => `${name}. Can’t pick: ${reason}.`,
  lockingNotice: (name: string, position: number) => `Locking ${name} in position ${position}. Waiting for the server.`,
  lockRejected: (reason: string) => `Not locked · ${reason}`,
  lockRejectedNotice: (name: string, position: number, reason: string) => `${name} was not locked in position ${position}. ${reason}. The slot is open again.`,
  lockNotAccepted: "Not accepted, try again",
  lockTimeUp: "Time’s up",
  lockDraftChanged: "Your draft changed in another tab",
} as const;

/** Short, always-visible reasons for each engine rejection code. The engine's own sentences are never shown. */
export const REJECTION_COPY: Readonly<Record<EraDraftSelectionRejectionCode, string>> = {
  DUPLICATE_CANONICAL_PLAYER: "Already in your XI",
  PLAYER_NOT_IN_CURRENT_SPIN: "Not in this squad",
  PLAYER_NOT_G2_ELIGIBLE: "Not eligible",
  PLAYER_NOT_FOUND: "Not available",
  ROSTER_STATUS_UNRESOLVED: "Roster status unknown",
  OVERSEAS_LIMIT: "Overseas limit reached",
  S_TIER_LIMIT: "S limit reached",
  SA_TIER_LIMIT: "S+A limit reached",
  FUTURE_XI_IMPOSSIBLE: "Would leave no legal XI",
  POSITION_OCCUPIED: "Position taken",
  INVALID_POSITION: "Not a batting position",
};
/** When several codes apply, the most specific player-level one is shown first. */
const REJECTION_ORDER = Object.keys(REJECTION_COPY) as EraDraftSelectionRejectionCode[];
export function rejectionReason(codes: readonly EraDraftSelectionRejectionCode[]): string | undefined {
  const code = REJECTION_ORDER.find((item) => codes.includes(item));
  return code && REJECTION_COPY[code];
}

/** The room clock. Amber at 2:00 or less, red at 0:30 or less, grey while the server checks at zero. */
export const CLOCK_COPY = {
  normal: "Time left",
  amber: "2 min or less",
  red: "30 sec or less",
  timeUp: "Time’s up",
  checking: "Checking…",
  label: (time: string, checking: boolean) => (checking ? "Time’s up. Checking with the server" : `${time} remaining`),
} as const;
