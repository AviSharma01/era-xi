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

/** The reveal, shared by Solo and Draft-Off. Team numbers are the original ratings, never rescaled. */
export const REVEAL_COPY = {
  revealing: "Revealing your XI",
  revealingStatus: "Revealing your XI in batting order. Skip to see the team sheet.",
  skip: "Skip",
  tapToSkip: "Tap to skip",
  teamRating: "Team rating",
  batting: "Batting",
  bowling: "Bowling",
  bat: "Bat",
  bowl: "Bowl",
  base: "Base",
  battingOrder: "Batting order",
  build: "Build",
  buildTitle: "Rating build",
  close: "Close",
  /** Highlights the players behind a line; their names are read with it. */
  buildPlayers: (names: readonly string[]) => `Players behind it: ${names.join(", ")}.`,
  buildLabel: (base: string, loss: string, final: string) => `Base ${base}, batting order minus ${loss}, team rating ${final}`,
  bowlingCovered: (covered: string, required: number) => `${covered} of ${required} bowling slots covered`,
  startLeague: "Start league",
  startingLeague: "Starting league…",
  sheetCaption: "Your XI, in batting order",
  sheetCaptionFor: (name: string) => `${name}’s XI, in batting order`,
  columnPosition: "#",
  columnPositionName: "Batting position",
  columnPlayer: "Player",
  columnTier: "Tier",
  columnOverall: "OVR",
  columnOverallName: "Overall",
  columnBatting: "BAT",
  columnBattingName: "Batting",
  columnBowling: "BWL",
  columnBowlingName: "Bowling",
  columnFit: "Fit",
  noRating: "—",
  noRatingName: "No rating",
  showRatings: ", show batting and bowling",
  inspect: "Inspect ",
  inspectSeason: "Inspect season",
  revealedStatus: "Team revealed. Player and team ratings are now visible.",
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

export function ordinal(value: number): string {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th"
    : value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}

/** A team-season in short: the standard abbreviation plus the season ("MI 2013"); the full name when there is none. */
export function shortTeamSeasonName(teamId: string, teamName: string, seasonYear: number): string {
  return `${teamAbbreviation(teamId, teamName)} ${seasonYear}`;
}

type LeagueMargin = { readonly kind: "RUNS" | "WICKETS"; readonly value: number } | { readonly kind: "SUPER_OVER" };
const marginWords = (margin: LeagueMargin): string => margin.kind === "SUPER_OVER" ? "in a Super Over"
  : margin.kind === "RUNS" ? `by ${margin.value} ${margin.value === 1 ? "run" : "runs"}`
    : `by ${margin.value} ${margin.value === 1 ? "wicket" : "wickets"}`;
const pad = (value: number): string => String(value).padStart(2, "0");

/** Solo league: auto-play, the match feed and the standings. */
export const LEAGUE_COPY = {
  yourXi: "Your XI",
  title: "League stage",
  completeTitle: "League complete",
  matchOf: (played: number, total: number) => `Match ${pad(played)} of ${total}`,
  win: "W",
  loss: "L",
  winName: "Win",
  lossName: "Loss",
  /** "Your XI beat Mumbai Indians 2013 by 6 wickets" / "Mumbai Indians 2013 beat Your XI by 12 runs". */
  resultLine: (won: boolean, opponent: string, margin: LeagueMargin) =>
    `${won ? "Your XI" : opponent} beat ${won ? opponent : "Your XI"} ${marginWords(margin)}`,
  record: "Record",
  position: "Position",
  movement: (movement: "UP" | "DOWN" | "SAME" | "FIRST", previous: number | null) =>
    movement === "UP" ? `Up from ${ordinal(previous!)}` : movement === "DOWN" ? `Down from ${ordinal(previous!)}`
      : movement === "SAME" ? "No change" : "First match",
  pause: "Pause",
  resume: "Resume",
  skip: "Skip to end",
  paused: "Paused",
  pipsLabel: (played: number) => `League matches, ${played} of 14 played`,
  pipLabel: (matchNumber: number, line: string, won: boolean, close: boolean) =>
    `Match ${matchNumber}, ${won ? "win" : "loss"}: ${line}${close ? ". Close match" : ""}. Show scores`,
  pipUpcoming: (matchNumber: number) => `Match ${matchNumber}, still to play`,
  closeMatch: "Close match",
  detailsTitle: (matchNumber: number, opponent: string) => `Match ${matchNumber} · v ${opponent}`,
  overs: (overs: string) => `${overs} ov`,
  oversName: (overs: string) => `${overs} overs`,
  close: "Close",
  tableTitle: "Table",
  finalTableTitle: "Final table",
  tableCaption: "League table",
  columnPosition: "Pos",
  columnPositionName: "Position",
  columnTeam: "Team",
  columnPlayed: "P",
  columnPlayedName: "Played",
  columnWon: "W",
  columnWonName: "Won",
  columnLost: "L",
  columnLostName: "Lost",
  columnPoints: "Pts",
  columnPointsName: "Points",
  columnNetRunRate: "NRR",
  columnNetRunRateName: "Net run rate",
  playoffLine: "Playoff line · top four go through",
  qualified: "Qualified",
  outcomeQualified: (position: number, won: number, lost: number) => `Your XI finished ${ordinal(position)} at ${won}–${lost}. Into the playoffs.`,
  outcomeOut: (position: number, won: number, lost: number) => `Your XI finished ${ordinal(position)} at ${won}–${lost}, outside the top four.`,
  beginPlayoffs: "Begin playoffs",
  seeSeason: "See your season",
  status: (matchNumber: number, line: string, won: number, lost: number, position: number) =>
    `Match ${matchNumber}. ${line}. Record ${won}–${lost}, ${ordinal(position)} in the table.`,
  completeStatus: (position: number, qualified: boolean) =>
    `League complete. Your XI finished ${ordinal(position)} and ${qualified ? "reached the playoffs" : "missed the playoffs"}.`,
} as const;
