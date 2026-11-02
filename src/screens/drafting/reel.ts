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

export type ReelTile =
  | { readonly kind: "season"; readonly abbreviation: string; readonly year: number }
  | { readonly kind: "result"; readonly abbreviation: string; readonly year: number }
  | { readonly kind: "blank" };
export type ReelKind = "SPIN" | "RESPIN";

/** Named tiles the reel runs through before the approach, so a respin keeps a spin's speed in less time. */
const NAMED_TILES: Readonly<Record<ReelKind, number>> = { SPIN: 24, RESPIN: 14 };
/**
 * Blanks either side of the result. The last named tile leaves the marker while the reel is still at
 * full speed, so the reel can never slow past, or come to rest beside, another franchise-season.
 */
const APPROACH_BLANKS = 2;

/** Presentation order from a hash of the seed: never the engine's RNG, never Math.random. */
function shuffled<T>(items: readonly T[], seed: string): T[] {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  const next = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state;
  };
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = next() % (index + 1);
    [output[index], output[other]] = [output[other]!, output[index]!];
  }
  return output;
}

export function reelStrip(input: {
  readonly eraId: EraId;
  readonly abbreviation: string;
  readonly year: number;
  readonly kind: ReelKind;
  readonly seed: string;
}): { readonly tiles: readonly ReelTile[]; readonly resultIndex: number } {
  const pool = Object.entries(ERA_REEL_SEASONS[input.eraId])
    .flatMap(([year, teams]) => teams.split(" ").map((abbreviation) => ({ abbreviation, year: Number(year) })))
    .filter((tile) => !(tile.abbreviation === input.abbreviation && tile.year === input.year));
  const order = shuffled(pool, input.seed);
  const named: ReelTile[] = Array.from({ length: NAMED_TILES[input.kind] },
    (_, index) => ({ kind: "season", ...order[index % order.length]! }));
  const blanks: ReelTile[] = Array.from({ length: APPROACH_BLANKS }, () => ({ kind: "blank" }));
  return {
    tiles: [...named, ...blanks, { kind: "result", abbreviation: input.abbreviation, year: input.year }, ...blanks],
    resultIndex: named.length + blanks.length,
  };
}
