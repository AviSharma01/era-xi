import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  createClassicDraftState,
  createSeededRandom,
  getCurrentSquad,
  getOpenPositions,
  getOverseasCount,
  getPositionFit,
  hasWicketkeeper,
  isLegalPlayerSelection,
  loadDraftPool,
  parseBattingPosition,
  pickPlayer,
  spinFranchiseSeason,
  useVoluntaryRespin,
} from "./draftClassic.js";

const DATA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../data/processed/2016/draft_player_seasons.json",
);

async function main(): Promise<void> {
  const seed = process.argv.find((arg) => arg.startsWith("--seed="))?.slice("--seed=".length) ?? Date.now().toString();
  const random = createSeededRandom(seed);
  const raw = JSON.parse(await readFile(DATA_PATH, "utf8")) as unknown;
  const pool = loadDraftPool(raw);
  const rl = createInterface({ input, output });

  let state = spinFranchiseSeason(pool, createClassicDraftState(), random);
  console.log(`Classic Mode draft - seed ${seed}`);
  console.log("Commands: pick <player-number> <batting-position>, respin, xi, help, quit");

  while (!state.completed) {
    renderDraftRound(pool, state);
    const answer = (await rl.question("> ")).trim();
    const [command, firstArg, secondArg] = answer.split(/\s+/);

    try {
      if (command === "pick") {
        state = handlePick(pool, state, firstArg, secondArg, random);
      } else if (command === "respin") {
        state = useVoluntaryRespin(pool, state, random);
      } else if (command === "xi") {
        renderXi(state);
      } else if (command === "help") {
        console.log("Use `pick 3 5` to lock listed player 3 into batting position 5.");
        console.log("Use `respin` once per draft to replace the current franchise-season.");
      } else if (command === "quit" || command === "exit") {
        rl.close();
        return;
      } else if (command !== "") {
        console.log("Unknown command. Try `help`.");
      }
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
    }
  }

  renderCompletedXi(state);
  rl.close();
}

function handlePick(
  pool: ReturnType<typeof loadDraftPool>,
  state: ClassicDraftState,
  playerNumber: string | undefined,
  positionValue: string | undefined,
  random: () => number,
): ClassicDraftState {
  const playerIndex = Number(playerNumber);
  const position = positionValue ? parseBattingPosition(positionValue) : null;
  if (!Number.isInteger(playerIndex) || playerIndex < 1) {
    throw new Error("Pick needs a listed player number, for example: pick 2 4");
  }
  if (position === null) {
    throw new Error("Pick needs an open batting position from 1 to 11.");
  }

  const squad = getCurrentSquad(pool, state);
  const player = squad[playerIndex - 1];
  if (!player) {
    throw new Error("That player number is not in the current spun squad.");
  }

  return pickPlayer(pool, state, player.id, position, random);
}

function renderDraftRound(pool: ReturnType<typeof loadDraftPool>, state: ClassicDraftState): void {
  const squad = getCurrentSquad(pool, state);
  const title = state.currentSquadKey ?? "No squad";
  const openPositions = getOpenPositions(state).join(", ");

  console.log("");
  console.log(`Spin: ${title}`);
  console.log(`Open positions: ${openPositions}`);
  console.log(`Overseas: ${getOverseasCount(state)}/${4} | WK: ${hasWicketkeeper(state) ? "yes" : "needed"} | Respin: ${state.respinsRemaining}`);
  console.log("");
  console.log("Spun squad");

  squad.forEach((player, index) => {
    const legality = isLegalPlayerSelection(state, player);
    const status = legality.ok ? "" : ` | unavailable: ${legality.reason}`;
    console.log(`${index + 1}. ${formatPlayer(player, state)}${status}`);
  });
}

function renderXi(state: ClassicDraftState): void {
  console.log("");
  console.log("Current XI");
  for (const position of getOpenAwarePositions(state)) {
    if ("player" in position) {
      console.log(`${position.position}. ${position.player.name} (${position.player.franchise} ${position.player.season})`);
    } else {
      console.log(`${position.position}. open`);
    }
  }
}

function renderCompletedXi(state: ClassicDraftState): void {
  console.log("");
  console.log("Completed Classic XI");
  renderXi(state);
  console.log("");
  console.log(`Overseas: ${getOverseasCount(state)}/${4}`);
  console.log(`Wicketkeeper: ${hasWicketkeeper(state) ? "yes" : "missing"}`);
}

function formatPlayer(player: DraftPlayerSeason, state: ClassicDraftState): string {
  const stats = player.displayedStats;
  const fitHints = getOpenPositions(state)
    .map((position) => `${position}:${getPositionFit(player, position)}`)
    .join(" ");
  const wk = player.isWicketkeeper ? " WK" : "";
  const overseas = player.isOverseas ? ` overseas ${player.country}` : ` ${player.country}`;
  const bowling = player.bowlingOptionStrength === "none" ? "" : ` | bowling ${player.bowlingOptionStrength}`;
  return [
    `${player.name}${wk}`,
    `${player.seasonRole}`,
    `pref ${player.preferredBattingPositions.join("/") || "-"}`,
    `${stats.matches}m ${stats.runs}r SR ${stats.strikeRate ?? "-"} ${stats.wickets}w`,
    `${overseas}${bowling}`,
    `fit ${fitHints}`,
  ].join(" | ");
}

function getOpenAwarePositions(state: ClassicDraftState): ({ position: BattingPosition; player: DraftPlayerSeason } | { position: BattingPosition })[] {
  return ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as BattingPosition[]).map((position) => {
    const slot = state.slots.find((candidate) => candidate.position === position);
    return slot ?? { position };
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
