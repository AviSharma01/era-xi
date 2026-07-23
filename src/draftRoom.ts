import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  type DraftPool,
  type SelectionBlockReason,
  getCurrentSquad,
  getOpenPositions,
  getOverseasCount,
  getPositionFit,
  hasWicketkeeper,
  isLegalPlayerSelection,
} from "./draftClassic.js";
import { getBattingPositionDistance } from "./teamEvaluation.js";

export type SquadFilter = "all" | "batters" | "wicketkeepers" | "all-rounders" | "bowlers";
export type ActiveDetails =
  | { source: "squad"; playerId: string }
  | { source: "drafted"; position: BattingPosition };

export type DraftRoomUiState = {
  activeDetails: ActiveDetails | null;
  pendingPosition: BattingPosition | null;
  squadFilter: SquadFilter;
  error: string | null;
};

export type DraftRoomActions = {
  spin: () => void;
  respin: () => void;
  setFilter: (filter: SquadFilter) => void;
  selectPlayer: (playerId: string) => void;
  selectPosition: (position: BattingPosition) => void;
  openDraftedPlayer: (position: BattingPosition) => void;
  confirmPick: () => void;
  revealTeam: () => void;
};

type DraftRoomOptions = {
  state: ClassicDraftState;
  pool: DraftPool;
  uiState: DraftRoomUiState;
  actions: DraftRoomActions;
};

type SquadGroup = {
  filter: Exclude<SquadFilter, "all">;
  heading: string;
  roles: string[];
  sortMetric: "runs" | "wickets";
};

type PlacementFit = "natural" | "acceptable" | "out_of_position" | "severely_out_of_position";

const POSITION_GROUPS: { heading: string; positions: BattingPosition[] }[] = [
  { heading: "Top Order", positions: [1, 2, 3] },
  { heading: "Middle Order", positions: [4, 5, 6, 7] },
  { heading: "Lower Order", positions: [8, 9, 10, 11] },
];

const SQUAD_GROUPS: SquadGroup[] = [
  { filter: "batters", heading: "Batters", roles: ["batter"], sortMetric: "runs" },
  {
    filter: "wicketkeepers",
    heading: "Wicketkeepers",
    roles: ["wicketkeeper_batter"],
    sortMetric: "runs",
  },
  {
    filter: "all-rounders",
    heading: "All-Rounders",
    roles: ["batting_all_rounder", "bowling_all_rounder"],
    sortMetric: "runs",
  },
  { filter: "bowlers", heading: "Bowlers", roles: ["bowler"], sortMetric: "wickets" },
];

export function createDraftRoomUiState(): DraftRoomUiState {
  return {
    activeDetails: null,
    pendingPosition: null,
    squadFilter: "all",
    error: null,
  };
}

export function renderDraftRoom(options: DraftRoomOptions): HTMLElement {
  const room = element("section", "draft-room");
  room.append(renderHeader(options));

  const layout = element("div", "draft-room-layout");
  const left = element("div", "draft-room-left");
  left.append(renderCurrentFranchise(options), renderSpinControls(options));
  if (!options.state.completed && options.state.currentSquadKey !== null) {
    left.append(renderAvailablePlayers(options));
  }
  if (!options.state.completed && getActivePlayer(options) !== null) {
    left.append(renderSelectedPlayerDetail(options));
  }

  const right = element("div", "draft-room-right");
  right.append(renderPlayingXI(options), renderTeamBuildingGuide(options));
  layout.append(left, right);
  room.append(layout);
  return room;
}

function renderHeader({ state }: DraftRoomOptions): HTMLElement {
  const header = element("header", "page-header");
  const title = element("h1");
  title.textContent = "2016 Classic Draft";
  const subtitle = element("p");
  subtitle.textContent = `Pick ${Math.min(state.slots.length + 1, 11)} of 11`;
  header.append(title, subtitle);
  return header;
}

function renderCurrentFranchise({ state }: DraftRoomOptions): HTMLElement {
  const section = panel("current-franchise compact-control", "Current Franchise");
  const current = element("strong", "current-spin");
  current.textContent = state.currentSquadKey === null
    ? state.completed
      ? "Draft complete"
      : state.slots.length > 0
        ? "Ready for next spin"
        : "No franchise selected"
    : state.currentSquadKey.replace(/^2016\s+/, "");
  const note = element("p", "empty-state");
  note.textContent = state.completed
    ? "Your Playing XI is locked."
    : state.currentSquadKey === null
      ? "Spin to choose the next player pool."
      : "Choose one player from this franchise-season.";
  section.append(current, note);
  return section;
}

function renderSpinControls(options: DraftRoomOptions): HTMLElement {
  const { state, uiState, actions } = options;
  const section = panel("controls compact-control", "Spin / Respin");
  const status = element("p", "message");
  status.setAttribute("role", "status");
  status.textContent = uiState.error ?? selectionPrompt(options);
  if (uiState.error) status.classList.add("message-error");
  section.append(status);

  const actionsRow = element("div", "control-actions");
  if (state.completed) {
    const reveal = button("Reveal Team", actions.revealTeam);
    reveal.className = "reveal-button";
    actionsRow.append(reveal);
  } else {
    const spin = button("Spin", actions.spin);
    spin.disabled = state.currentSquadKey !== null;
    const respin = button("Respin", actions.respin);
    respin.disabled = state.currentSquadKey === null || state.respinsRemaining < 1;
    const remaining = element("span", "respin-count");
    remaining.textContent = `${state.respinsRemaining} respin remaining`;
    actionsRow.append(spin, respin, remaining);
  }
  section.append(actionsRow);
  return section;
}

function selectionPrompt(options: DraftRoomOptions): string {
  const { state, uiState } = options;
  if (state.completed) return "XI complete. Reveal the team when ready.";
  if (state.currentSquadKey === null) return state.slots.length === 0
    ? "Ready to start."
    : "Pick confirmed. Spin for the next franchise.";
  const active = getActivePlayer(options);
  if (active?.source === "drafted") {
    return `Viewing ${active.player.name} in confirmed position ${active.position}.`;
  }
  if (active?.source === "squad" && uiState.pendingPosition !== null) {
    return `Previewing ${active.player.name} at position ${uiState.pendingPosition}. Confirm to draft.`;
  }
  if (active?.source === "squad") {
    return `Inspecting ${active.player.name}. Choose an open batting slot.`;
  }
  return "Choose a player from the available list.";
}

function renderAvailablePlayers(options: DraftRoomOptions): HTMLElement {
  const { state, pool, uiState, actions } = options;
  const section = panel("squad available-players", "Available Players");
  if (state.completed) {
    section.append(emptyState("Draft complete. No more players are available."));
    return section;
  }
  if (state.currentSquadKey === null) {
    section.append(emptyState("Spin to view available players."));
    return section;
  }

  const filters = element("div", "squad-filters");
  filters.setAttribute("aria-label", "Player role filters");
  const filterOptions: { filter: SquadFilter; label: string }[] = [
    { filter: "all", label: "All" },
    { filter: "batters", label: "Batters" },
    { filter: "wicketkeepers", label: "Wicketkeepers" },
    { filter: "all-rounders", label: "All-Rounders" },
    { filter: "bowlers", label: "Bowlers" },
  ];
  for (const option of filterOptions) {
    const filter = button(option.label, () => actions.setFilter(option.filter));
    filter.className = "squad-filter";
    filter.dataset.filter = option.filter;
    filter.setAttribute("aria-pressed", String(option.filter === uiState.squadFilter));
    if (option.filter === uiState.squadFilter) filter.classList.add("squad-filter-active");
    filters.append(filter);
  }

  const scroll = element("div", "available-players-scroll");
  for (const group of getVisibleSquadGroups(getCurrentSquad(pool, state), uiState.squadFilter)) {
    const groupSection = element("section", "squad-group");
    const heading = element("h3");
    heading.textContent = group.heading;
    const rows = element("div", "squad-list");
    for (const player of group.players) rows.append(renderPlayerRow(options, player));
    groupSection.append(heading, rows);
    scroll.append(groupSection);
  }
  section.append(filters, scroll);
  return section;
}

function renderPlayerRow(options: DraftRoomOptions, player: DraftPlayerSeason): HTMLElement {
  const { state, uiState, actions } = options;
  const legality = isLegalPlayerSelection(state, player);
  const row = button("", () => actions.selectPlayer(player.id));
  row.className = "squad-row";
  row.dataset.playerId = player.id;
  row.disabled = !legality.ok;
  if (uiState.activeDetails?.source === "squad" && uiState.activeDetails.playerId === player.id) {
    row.classList.add("squad-row-active");
    row.setAttribute("aria-pressed", "true");
  }

  const name = element("strong", "player-name");
  name.textContent = player.name;
  name.title = player.name;
  const badges = element("span", "player-badges");
  badges.textContent = formatBadges(player).join(" · ");
  const stats = element("span", "player-stat-line");
  stats.textContent = formatSquadRowStats(player);
  const positions = element("span", "player-position-line");
  positions.textContent = `Natural: ${formatPositions(player.naturalPositions)}`;
  row.append(name, badges, stats, positions);

  if (!legality.ok) {
    const reason = element("span", "unavailable-reason");
    reason.textContent = formatSelectionBlockReason(legality.code);
    row.append(reason);
  }
  return row;
}

function renderSelectedPlayerDetail(options: DraftRoomOptions): HTMLElement {
  const { state, uiState, actions } = options;
  const section = panel("active-details selected-player-detail", "Selected Player Detail");
  const active = getActivePlayer(options);
  if (!active) {
    section.classList.add("detail-state-empty");
    section.append(emptyState(
      state.currentSquadKey === null
        ? "Select a player after spinning a franchise."
        : "Select an available player or a locked XI slot to inspect details.",
    ));
    if (!state.completed) section.append(disabledConfirmButton());
    return section;
  }
  section.classList.add(
    active.source === "drafted"
      ? "detail-state-locked"
      : uiState.pendingPosition === null
        ? "detail-state-player"
        : "detail-state-preview",
  );

  const name = element("strong", "details-name");
  name.textContent = active.player.name;
  const meta = element("p");
  meta.textContent = `${active.player.franchise} ${active.player.season}`;
  const badges = element("p", "player-badges");
  badges.textContent = formatBadges(active.player).join(" · ");
  section.append(name, meta, badges);

  if (active.source === "drafted") {
    section.append(
      detailLine("Confirmed position", String(active.position)),
      detailLine("Position fit", getPlacementFitLabel(active.player, active.position)),
    );
  } else if (uiState.pendingPosition !== null) {
    section.append(
      detailLine("Preview position", String(uiState.pendingPosition)),
      detailLine("Position fit", getPlacementFitLabel(active.player, uiState.pendingPosition)),
    );
  }

  section.append(
    detailLine("Role", active.player.seasonRole),
    detailLine("Matches", String(active.player.displayedStats.matches)),
    detailLine("Batting", formatFullBattingStats(active.player)),
  );
  const bowling = formatFullBowlingStats(active.player);
  if (bowling) section.append(detailLine("Bowling", bowling));
  section.append(
    detailLine("Natural positions", formatPositions(active.player.naturalPositions)),
    detailLine("Acceptable positions", formatPositions(active.player.acceptablePositions)),
    detailLine("Bowling option", formatBowlingStrength(active.player.bowlingOptionStrength)),
    detailLine("Wicketkeeper", active.player.isWicketkeeper ? "Yes" : "No"),
    detailLine("Overseas", active.player.isOverseas ? "Yes" : "No"),
  );

  if (active.source === "squad") {
    const preview = element("div", "pick-preview");
    if (uiState.pendingPosition === null) {
      preview.append(
        emptyState("Choose an open batting slot to preview this pick."),
        disabledConfirmButton(),
      );
    } else {
      preview.classList.add("pick-preview-ready");
      const summary = element("p", "pick-preview-summary");
      summary.textContent = `${active.player.name} at ${uiState.pendingPosition} · ${getPlacementFitLabel(active.player, uiState.pendingPosition)}`;
      const confirm = button("Confirm Pick", actions.confirmPick);
      confirm.className = "confirm-button";
      preview.append(summary, confirm);
    }
    section.append(preview);
  } else if (!state.completed) {
    section.append(disabledConfirmButton());
  }
  return section;
}

function renderPlayingXI(options: DraftRoomOptions): HTMLElement {
  const { state } = options;
  const section = panel("draft-board playing-xi", "Playing XI");
  const count = element("p", "xi-count");
  count.textContent = state.completed
    ? "Completed XI · 11/11 locked"
    : `${state.slots.length}/11 locked`;
  section.append(count);

  for (const group of POSITION_GROUPS) {
    const groupSection = element("section", "position-group");
    const heading = element("h3");
    heading.textContent = group.heading;
    const slots = element("div", "slots");
    for (const position of group.positions) slots.append(renderSlot(options, position));
    groupSection.append(heading, slots);
    section.append(groupSection);
  }
  return section;
}

function renderSlot(options: DraftRoomOptions, position: BattingPosition): HTMLElement {
  const { state, uiState, actions } = options;
  const confirmed = state.slots.find((candidate) => candidate.position === position);
  if (confirmed) {
    const slot = button("", () => actions.openDraftedPlayer(position));
    slot.className = `slot slot-locked drafted-mini-card slot-fit-${getPlacementFit(confirmed.player, position)}`;
    slot.dataset.position = String(position);
    const title = element("strong");
    title.textContent = `${position}. ${confirmed.player.name}`;
    const badges = element("span", "player-badges");
    badges.textContent = formatBadges(confirmed.player).join(" · ");
    const fit = element("span", "slot-fit");
    fit.textContent = getPlacementFitLabel(confirmed.player, position);
    slot.append(title, badges, fit);
    return slot;
  }

  const active = getActivePlayer(options);
  const selectedPlayer = active?.source === "squad" ? active.player : null;
  const slot = button("", () => actions.selectPosition(position));
  slot.className = "slot";
  slot.dataset.position = String(position);
  if (!selectedPlayer || !isLegalPlayerSelection(state, selectedPlayer).ok || state.completed) {
    slot.disabled = true;
    slot.textContent = `${position}. Open`;
    return slot;
  }

  const placementFit = getPlacementFit(selectedPlayer, position);
  slot.classList.add(`slot-fit-${placementFit}`);
  if (uiState.pendingPosition === position) {
    slot.classList.add("slot-pending");
    slot.textContent = `${position}. Preview ${selectedPlayer.name} — ${formatPlacementFit(placementFit)}`;
  } else {
    slot.textContent = `${position}. Open — ${formatPlacementFit(placementFit)}`;
  }
  return slot;
}

function renderTeamBuildingGuide({ state }: DraftRoomOptions): HTMLElement {
  const section = panel("team-building-guide", "Team Building Guide");
  const fitCounts: Record<PlacementFit, number> = {
    natural: 0,
    acceptable: 0,
    out_of_position: 0,
    severely_out_of_position: 0,
  };
  const bowlingCounts = { frontline: 0, secondary: 0, part_time: 0 };
  for (const slot of state.slots) {
    fitCounts[getPlacementFit(slot.player, slot.position)] += 1;
    const strength = slot.player.bowlingOptionStrength;
    if (strength === "frontline" || strength === "secondary" || strength === "part_time") {
      bowlingCounts[strength] += 1;
    }
  }

  const statuses = element("div", "guide-status-grid");
  statuses.append(
    guideStatus("Overseas", `${getOverseasCount(state)}/4`),
    guideStatus("Wicketkeeper", hasWicketkeeper(state) ? "Requirement met" : "Still required"),
    guideStatus(
      "Position fit",
      `${fitCounts.natural} Natural · ${fitCounts.acceptable} Acceptable · ${fitCounts.out_of_position} Out of Position · ${fitCounts.severely_out_of_position} Severely Out of Position`,
      true,
    ),
    guideStatus(
      "Bowling coverage",
      `${bowlingCounts.frontline} frontline · ${bowlingCounts.secondary} secondary · ${bowlingCounts.part_time} part-time`,
      true,
    ),
  );
  const guidance = element("p", "guide-note");
  guidance.textContent = "A balanced XI, suitable batting positions, and visible bowling coverage may unlock team boosts after ratings are revealed.";
  const hidden = element("p", "guide-note");
  hidden.textContent = "Boost eligibility and ratings are not confirmed during the draft.";
  section.append(statuses, guidance, hidden);
  return section;
}

function getActivePlayer(options: DraftRoomOptions):
  | { source: "squad"; player: DraftPlayerSeason }
  | { source: "drafted"; player: DraftPlayerSeason; position: BattingPosition }
  | null {
  const { state, pool, uiState } = options;
  const active = uiState.activeDetails;
  if (!active) return null;
  if (active.source === "drafted") {
    const slot = state.slots.find((candidate) => candidate.position === active.position);
    return slot ? { source: "drafted", player: slot.player, position: slot.position } : null;
  }
  const player = getCurrentSquad(pool, state).find((candidate) => candidate.id === active.playerId);
  return player ? { source: "squad", player } : null;
}

export function getPlacementFit(
  player: DraftPlayerSeason,
  position: BattingPosition,
): PlacementFit {
  const fit = getPositionFit(player, position);
  if (fit === "natural" || fit === "acceptable") return fit;
  const distance = player.naturalPositions.length === 0
    ? 4
    : Math.min(...player.naturalPositions.map((natural) => getBattingPositionDistance(position, natural)));
  return distance <= 2 ? "out_of_position" : "severely_out_of_position";
}

function getPlacementFitLabel(player: DraftPlayerSeason, position: BattingPosition): string {
  return formatPlacementFit(getPlacementFit(player, position));
}

function formatPlacementFit(fit: PlacementFit): string {
  const labels: Record<PlacementFit, string> = {
    natural: "Natural",
    acceptable: "Acceptable",
    out_of_position: "Out of Position",
    severely_out_of_position: "Severely Out of Position",
  };
  return labels[fit];
}

function formatSelectionBlockReason(reason: SelectionBlockReason): string {
  const reasons: Record<SelectionBlockReason, string> = {
    draft_complete: "Draft complete",
    duplicate_player: "Already drafted",
    overseas_limit: "Overseas limit reached",
    wicketkeeper_required: "Wicketkeeper required for final slot",
  };
  return reasons[reason];
}

function getVisibleSquadGroups(
  squad: DraftPlayerSeason[],
  squadFilter: SquadFilter,
): { heading: string; players: DraftPlayerSeason[] }[] {
  const groups = squadFilter === "all"
    ? SQUAD_GROUPS
    : SQUAD_GROUPS.filter((group) => group.filter === squadFilter);
  return groups.flatMap((group) => {
    const players = squad
      .filter((player) => group.roles.includes(player.seasonRole))
      .sort((left, right) => comparePlayers(left, right, group.sortMetric));
    return players.length > 0 ? [{ heading: group.heading, players }] : [];
  });
}

function comparePlayers(
  left: DraftPlayerSeason,
  right: DraftPlayerSeason,
  metric: "runs" | "wickets",
): number {
  const leftMetric = metric === "runs" ? left.displayedStats.runs : left.displayedStats.wickets;
  const rightMetric = metric === "runs" ? right.displayedStats.runs : right.displayedStats.wickets;
  return rightMetric !== leftMetric ? rightMetric - leftMetric : left.name.localeCompare(right.name);
}

function formatBadges(player: DraftPlayerSeason): string[] {
  const badges: string[] = [];
  if (player.seasonRole === "bowler") badges.push("BOWL");
  else if (player.seasonRole === "batting_all_rounder" || player.seasonRole === "bowling_all_rounder") badges.push("AR");
  else badges.push("BAT");
  if (player.isWicketkeeper) badges.push("WK");
  if (player.isOverseas) badges.push("OVERSEAS");
  return badges;
}

function formatSquadRowStats(player: DraftPlayerSeason): string {
  if (player.seasonRole === "bowler") return formatBowlingStats(player, "Wkts", false) ?? "";
  if (player.seasonRole === "batting_all_rounder" || player.seasonRole === "bowling_all_rounder") {
    return [formatBattingStats(player, "Bat"), formatBowlingStats(player, "Bowl", true)]
      .filter(Boolean)
      .join(" / ");
  }
  return formatBattingStats(player, "Runs") ?? "";
}

function formatBattingStats(player: DraftPlayerSeason, firstLabel: "Runs" | "Bat"): string | null {
  const stats = player.displayedStats;
  if (firstLabel === "Bat" && stats.runs === 0 && stats.ballsFaced === 0 && stats.inningsBatted === 0) {
    return null;
  }
  const parts = [`${firstLabel} ${stats.runs}`];
  if (stats.battingAverage !== null) parts.push(`Avg ${formatOneDecimal(stats.battingAverage)}`);
  if (stats.strikeRate !== null) parts.push(`SR ${formatOneDecimal(stats.strikeRate)}`);
  return parts.join(" | ");
}

function formatBowlingStats(
  player: DraftPlayerSeason,
  firstLabel: "Wkts" | "Bowl",
  showZeroWickets: boolean,
): string | null {
  const stats = player.displayedStats;
  const parts: string[] = [];
  if (firstLabel === "Wkts") parts.push(`Wkts ${stats.wickets}`);
  else if (stats.wickets > 0 || showZeroWickets) parts.push(`Bowl ${stats.wickets} wkts`);
  if (stats.economy !== null) parts.push(`Econ ${formatOneDecimal(stats.economy)}`);
  return parts.length > 0 ? parts.join(" | ") : null;
}

function formatFullBattingStats(player: DraftPlayerSeason): string {
  const stats = player.displayedStats;
  const parts = [`innings ${stats.inningsBatted}`, `runs ${stats.runs}`, `balls ${stats.ballsFaced}`];
  if (stats.battingAverage !== null) parts.push(`avg ${formatOneDecimal(stats.battingAverage)}`);
  if (stats.strikeRate !== null) parts.push(`SR ${formatOneDecimal(stats.strikeRate)}`);
  return parts.join(" | ");
}

function formatFullBowlingStats(player: DraftPlayerSeason): string | null {
  const stats = player.displayedStats;
  const isBowlingRole = player.seasonRole === "bowler"
    || player.seasonRole === "batting_all_rounder"
    || player.seasonRole === "bowling_all_rounder";
  if (!isBowlingRole && stats.legalBallsBowled === 0 && stats.wickets === 0 && stats.economy === null) {
    return null;
  }
  const parts = [
    `wickets ${stats.wickets}`,
    `balls ${stats.legalBallsBowled}`,
    `runs conceded ${stats.runsConceded}`,
  ];
  if (stats.economy !== null) parts.push(`econ ${formatOneDecimal(stats.economy)}`);
  return parts.join(" | ");
}

function formatBowlingStrength(value: string): string {
  return value === "part_time" ? "part-time" : value;
}

function formatPositions(positions: BattingPosition[]): string {
  return positions.length > 0 ? positions.join(", ") : "-";
}

function detailLine(label: string, value: string): HTMLElement {
  const row = element("p", "detail-line");
  const labelNode = element("span", "detail-label");
  labelNode.textContent = `${label}: `;
  const valueNode = element("span");
  valueNode.textContent = value;
  row.append(labelNode, valueNode);
  return row;
}

function guideStatus(label: string, value: string, wide = false): HTMLElement {
  const item = element("div", `guide-status${wide ? " guide-status-wide" : ""}`);
  const labelNode = element("span", "guide-status-label");
  labelNode.textContent = label;
  const valueNode = element("strong", "guide-status-value");
  valueNode.textContent = value;
  item.append(labelNode, valueNode);
  return item;
}

function panel(className: string, headingText: string): HTMLElement {
  const section = element("section", className);
  const heading = element("h2");
  heading.textContent = headingText;
  section.append(heading);
  return section;
}

function emptyState(text: string): HTMLElement {
  const empty = element("p", "empty-state");
  empty.textContent = text;
  return empty;
}

function disabledConfirmButton(): HTMLButtonElement {
  const confirm = button("Confirm Pick", () => undefined);
  confirm.className = "confirm-button";
  confirm.disabled = true;
  return confirm;
}

function formatOneDecimal(value: number): string {
  return value.toFixed(1);
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
