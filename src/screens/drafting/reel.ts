import type { EraId } from "../../teamEvaluationV2.js";

/**
 * Display only: which franchise-seasons the reel can show, by abbreviation. The result is decided
 * before the reel starts and never comes from this table; a test keeps it equal to the catalog.
 */
export const ERA_REEL_SEASONS: Readonly<Record<EraId, Readonly<Record<number, string>>>> = {
  "era-foundation": {
    2008: "CSK DEC DD KXIP KKR MI RR RCB",
    2009: "CSK DEC DD KXIP KKR MI RR RCB",
    2010: "CSK DEC DD KXIP KKR MI RR RCB",
  },
  "era-expansion": {
    2011: "CSK DEC DD KXIP KTK KKR MI PWI RR RCB",
    2012: "CSK DEC DD KXIP KKR MI PWI RR RCB",
    2013: "CSK DD KXIP KKR MI PWI RR RCB SRH",
  },
  "era-transition": {
    2014: "CSK DD KXIP KKR MI RR RCB SRH",
    2015: "CSK DD KXIP KKR MI RR RCB SRH",
    2016: "DD GL KXIP KKR MI RPS RCB SRH",
    2017: "DD GL KXIP KKR MI RPS RCB SRH",
  },
  "era-modern-pre-impact": {
    2018: "CSK DD KXIP KKR MI RR RCB SRH",
    2019: "CSK DC KXIP KKR MI RR RCB SRH",
    2020: "CSK DC KXIP KKR MI RR RCB SRH",
    2021: "CSK DC KKR MI PBKS RR RCB SRH",
    2022: "CSK DC GT KKR LSG MI PBKS RR RCB SRH",
  },
  "era-impact": {
    2023: "CSK DC GT KKR LSG MI PBKS RR RCB SRH",
    2024: "CSK DC GT KKR LSG MI PBKS RR RCB SRH",
    2025: "CSK DC GT KKR LSG MI PBKS RR RCB SRH",
    2026: "CSK DC GT KKR LSG MI PBKS RR RCB SRH",
  },
};

export type ReelTile = { readonly kind: "season" | "result"; readonly abbreviation: string; readonly year: number };
export type ReelKind = "SPIN" | "RESPIN";

/** Each spin travels a different distance, so the stop can't be read from the speed. A respin is the same reel, faster. */
export const REEL_TRAVEL = { min: 18, max: 28 } as const;
/** Real tiles either side of the start and the result, so the window is full from the first frame to the last. */
const EDGE_TILES = 4;

/** Presentation order from a hash of the seed: never the engine's RNG, never Math.random. */
function seeded(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state;
  };
}
function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = next() % (index + 1);
    [output[index], output[other]] = [output[other]!, output[index]!];
  }
  return output;
}
function eraSeasons(eraId: EraId): { abbreviation: string; year: number }[] {
  return Object.entries(ERA_REEL_SEASONS[eraId]).flatMap(([year, teams]) => teams.split(" ").map((abbreviation) => ({ abbreviation, year: Number(year) })));
}

/**
 * The strip for one spin. The result is decided before the reel starts and only placed here: every other tile is a
 * real franchise-season of the era, drawn in a seeded order that never repeats a neighbour and never shows the result early.
 */
export function reelStrip(input: {
  readonly eraId: EraId;
  readonly abbreviation: string;
  readonly year: number;
  readonly seed: string;
}): { readonly tiles: readonly ReelTile[]; readonly startIndex: number; readonly resultIndex: number } {
  const next = seeded(input.seed);
  const travel = REEL_TRAVEL.min + (next() % (REEL_TRAVEL.max - REEL_TRAVEL.min + 1));
  const order = shuffled(eraSeasons(input.eraId).filter((tile) => !(tile.abbreviation === input.abbreviation && tile.year === input.year)), next);
  const startIndex = EDGE_TILES, resultIndex = startIndex + travel;
  const tiles = Array.from({ length: resultIndex + EDGE_TILES + 1 }, (_, index): ReelTile => index === resultIndex
    ? { kind: "result", abbreviation: input.abbreviation, year: input.year }
    : { kind: "season", ...order[(index < resultIndex ? index : index - 1) % order.length]! });
  return { tiles, startIndex, resultIndex };
}

/** The reel at rest before a spin: real franchise-seasons of the era, still, under the marker. */
export function reelRest(input: { readonly eraId: EraId; readonly seed: string }): { readonly tiles: readonly ReelTile[]; readonly centerIndex: number } {
  const order = shuffled(eraSeasons(input.eraId), seeded(input.seed));
  return { tiles: order.slice(0, EDGE_TILES * 2 + 1).map((tile) => ({ kind: "season", ...tile })), centerIndex: EDGE_TILES };
}
