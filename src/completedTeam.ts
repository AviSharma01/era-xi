import {
  type ClassicDraftState,
  type DraftPlayerSeason,
  type PositionFit,
} from "./draftClassic.js";
import {
  type BoostedTeamEvaluationV1,
  type TeamBoostV1Id,
} from "./teamBoostV1.js";
import { type TeamEvaluation } from "./teamEvaluation.js";

export type CompletedTeamOptions = {
  state: ClassicDraftState;
  evaluation: TeamEvaluation;
  boostedEvaluation: BoostedTeamEvaluationV1;
  error: string | null;
  onBeginSeason?: () => void;
  quiet?: boolean;
};

const BOOST_LABELS: Record<TeamBoostV1Id, string> = {
  strong_opening_pair: "Strong Opening Pair",
  sufficient_bowling_coverage: "Bowling Coverage",
  balanced_construction: "Balanced Construction",
};

const BOOST_ORDER: TeamBoostV1Id[] = [
  "strong_opening_pair",
  "sufficient_bowling_coverage",
  "balanced_construction",
];

export function renderCompletedTeam(options: CompletedTeamOptions): HTMLElement {
  const screen = element(
    "section",
    `completed-team-screen${options.quiet ? " completed-team-screen-quiet" : ""}`,
  );
  const header = element("header", "completed-team-header");
  const title = element("h1");
  title.textContent = "Completed XI";
  const eyebrow = element("p");
  eyebrow.textContent = "Team revealed";
  header.append(title, eyebrow);

  const layout = element("div", "completed-team-layout");
  const playingXI = renderPlayingXI(options);
  const sidebar = element("aside", "completed-team-sidebar");
  sidebar.append(renderTeamRating(options.boostedEvaluation), renderBoosts(options.boostedEvaluation));

  const action = element("div", "completed-team-action");
  if (options.onBeginSeason) {
    if (options.error) {
      const error = element("p", "completed-team-error");
      error.setAttribute("role", "alert");
      error.textContent = options.error;
      action.append(error);
    }
    const begin = button("Begin Season", options.onBeginSeason);
    begin.className = "begin-season-button";
    action.append(begin);
  }

  layout.append(playingXI, sidebar);
  if (action.childElementCount > 0) layout.append(action);
  screen.append(header, layout);
  return screen;
}

function renderPlayingXI({ state, evaluation }: CompletedTeamOptions): HTMLElement {
  const panel = element("section", "completed-team-panel completed-playing-xi");
  const heading = element("h2");
  heading.textContent = "Playing XI";

  const table = element("div", "completed-xi-table");
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", "Revealed Playing XI");

  const header = element("div", "completed-xi-header completed-xi-grid");
  header.setAttribute("role", "row");
  for (const [label, className] of [
    ["Player", "completed-xi-player"],
    ["Slot", "completed-xi-slot"],
    ["Role", "completed-xi-role"],
    ["Fit", "completed-xi-fit"],
    ["Rating / Tier", "completed-xi-rating"],
  ]) {
    const cell = element("span", className);
    cell.setAttribute("role", "columnheader");
    cell.textContent = label;
    header.append(cell);
  }
  table.append(header);

  const body = element("ol", "completed-xi-body");
  body.setAttribute("role", "rowgroup");
  const contributionsByPosition = new Map(
    evaluation.players.map((contribution) => [contribution.slot.position, contribution]),
  );
  const sortedSlots = [...state.slots].sort((left, right) => left.position - right.position);

  for (const slot of sortedSlots) {
    const contribution = contributionsByPosition.get(slot.position);
    if (!contribution) {
      throw new Error(`Missing team evaluation for batting position ${slot.position}.`);
    }
    const row = element("li", "completed-xi-row completed-xi-grid");
    row.setAttribute("role", "row");
    row.dataset.position = String(slot.position);

    const player = cell("completed-xi-player completed-xi-player-name", slot.player.name, "cell");
    const position = cell("completed-xi-slot", String(slot.position), "cell");
    const role = cell("completed-xi-role", formatRole(slot.player), "cell");
    const fit = cell(
      `completed-xi-fit completed-xi-fit-${contribution.positionFit}`,
      formatFit(contribution.positionFit),
      "cell",
    );
    const rating = cell(
      "completed-xi-rating",
      `${slot.player.baseRating.toFixed(1)} · ${slot.player.draftTier}`,
      "cell",
    );

    row.append(player, position, role, fit, rating);
    body.append(row);
  }

  table.append(body);
  panel.append(heading, table);
  return panel;
}

function renderTeamRating(boosted: BoostedTeamEvaluationV1): HTMLElement {
  const panel = element("section", "completed-team-panel completed-team-rating");
  const heading = element("h2");
  heading.textContent = "Team Rating";

  const metrics = element("div", "team-rating-metrics");
  metrics.append(
    ratingMetric("Overall Team Rating", boosted.adjustedOverallTeamRating, true),
    ratingMetric("Batting", boosted.adjustedBattingComposite),
    ratingMetric("Bowling", boosted.adjustedBowlingComposite),
  );
  panel.append(heading, metrics);
  return panel;
}

function renderBoosts(boosted: BoostedTeamEvaluationV1): HTMLElement {
  const panel = element("section", "completed-team-panel completed-team-boosts");
  const heading = element("h2");
  heading.textContent = "Boosts";
  const list = element("ul", "boost-state-list");
  const activeBoosts = new Set(boosted.appliedBoosts.map((boost) => boost.id));

  for (const id of BOOST_ORDER) {
    const active = activeBoosts.has(id);
    const item = element("li", `boost-state${active ? " boost-state-active" : " boost-state-inactive"}`);
    item.dataset.boostId = id;
    const label = element("span", "boost-state-label");
    label.textContent = BOOST_LABELS[id];
    const state = element("span", "boost-state-value");
    state.textContent = active ? "Active" : "Inactive";
    item.append(label, state);
    list.append(item);
  }

  panel.append(heading, list);
  return panel;
}

function ratingMetric(label: string, value: number, overall = false): HTMLElement {
  const metric = element("div", `team-rating-metric${overall ? " team-rating-metric-overall" : ""}`);
  const metricLabel = element("span", "team-rating-label");
  metricLabel.textContent = label;
  const metricValue = element("strong", "team-rating-value");
  metricValue.textContent = value.toFixed(1);
  metric.append(metricLabel, metricValue);
  return metric;
}

function formatRole(player: DraftPlayerSeason): string {
  const roles: Record<string, string> = {
    batter: "Batter",
    wicketkeeper_batter: "Wicketkeeper",
    batting_all_rounder: "Batting All-Rounder",
    bowling_all_rounder: "Bowling All-Rounder",
    bowler: "Bowler",
  };
  return roles[player.seasonRole] ?? player.seasonRole.replaceAll("_", " ");
}

function formatFit(fit: PositionFit): string {
  const labels: Record<PositionFit, string> = {
    natural: "Natural",
    acceptable: "Acceptable",
    out_of_position: "Out of Position",
  };
  return labels[fit];
}

function cell(className: string, text: string, role: string): HTMLSpanElement {
  const node = element("span", className);
  node.setAttribute("role", role);
  node.textContent = text;
  return node;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}
