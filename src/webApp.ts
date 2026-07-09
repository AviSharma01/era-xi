import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  type DraftPool,
  type Tier,
  createClassicDraftState,
  createSeededRandom,
  getCurrentSquad,
  getOpenPositions,
  getOverseasCount,
  getPositionFit,
  hasWicketkeeper,
  isLegalPlayerSelection,
  pickPlayer,
  spinFranchiseSeason,
  useVoluntaryRespin,
} from "./draftClassic.js";

type ClassicDraftAppOptions = {
  root: HTMLElement;
  pool: DraftPool;
  seed?: string;
  initialState?: ClassicDraftState;
};

export type ClassicDraftApp = {
  getState: () => ClassicDraftState;
  setStateForTest: (nextState: ClassicDraftState) => void;
};

type SquadFilter = "all" | "batters" | "wicketkeepers" | "all-rounders" | "bowlers";
type ActiveDetails = { source: "squad"; playerId: string } | { source: "drafted"; position: BattingPosition };
type RevealState = "hidden" | "revealed";

type TemporaryUiState = {
  activeDetails: ActiveDetails | null;
  pendingPosition: BattingPosition | null;
  error: string | null;
};

type SquadGroup = {
  filter: Exclude<SquadFilter, "all">;
  heading: string;
  roles: string[];
  sortMetric: "runs" | "wickets";
};

const POSITIONS: BattingPosition[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const TIER_ORDER: Tier[] = ["S", "A", "B", "C", "D"];
const SQUAD_GROUPS: SquadGroup[] = [
  { filter: "batters", heading: "Batters", roles: ["batter"], sortMetric: "runs" },
  { filter: "wicketkeepers", heading: "Wicketkeepers", roles: ["wicketkeeper_batter"], sortMetric: "runs" },
  { filter: "all-rounders", heading: "All-Rounders", roles: ["batting_all_rounder", "bowling_all_rounder"], sortMetric: "runs" },
  { filter: "bowlers", heading: "Bowlers", roles: ["bowler"], sortMetric: "wickets" },
];

export function createClassicDraftApp(options: ClassicDraftAppOptions): ClassicDraftApp {
  const random = createSeededRandom(options.seed ?? Date.now().toString());
  let state = options.initialState ?? createClassicDraftState();
  let revealState: RevealState = "hidden";
  let squadFilter: SquadFilter = "all";
  let temporaryState: TemporaryUiState = {
    activeDetails: null,
    pendingPosition: null,
    error: null,
  };

  function clearTemporaryState(): void {
    temporaryState = {
      activeDetails: null,
      pendingPosition: null,
      error: null,
    };
  }

  function setError(error: unknown): void {
    temporaryState.error = error instanceof Error ? error.message : String(error);
  }

  function render(): void {
    options.root.replaceChildren(renderApp());
  }

  function renderApp(): HTMLElement {
    const shell = element("section", "app-shell");
    shell.append(renderHeader(), renderCounters(), renderMessage());

    if (state.completed) {
      shell.append(renderCompletedDraft(), renderActiveDetails());
    } else {
      shell.append(renderControls(), renderDraftBoard(), renderActiveDetails(), renderSquad());
    }

    return shell;
  }

  function renderHeader(): HTMLElement {
    const header = element("header", "page-header");
    const title = element("h1");
    title.textContent = "2016 Classic Draft";
    const subtitle = element("p");
    subtitle.textContent = "Spin a franchise-season, inspect a player, preview a batting slot, then confirm the pick.";
    header.append(title, subtitle);
    return header;
  }

  function renderCounters(): HTMLElement {
    const counters = element("section", "counters");
    counters.setAttribute("aria-label", "Draft counters");
    counters.append(
      renderCounter("Drafted", `${state.slots.length}/11`),
      renderCounter("Overseas", `${getOverseasCount(state)}/4`),
      renderCounter("Wicketkeeper", hasWicketkeeper(state) ? "confirmed" : "needed"),
      renderCounter("Respin", state.respinsRemaining > 0 ? "available" : "used"),
    );
    return counters;
  }

  function renderCounter(label: string, value: string): HTMLElement {
    const counter = element("div", "counter");
    const labelNode = element("span", "counter-label");
    labelNode.textContent = label;
    const valueNode = element("strong");
    valueNode.textContent = value;
    counter.append(labelNode, valueNode);
    return counter;
  }

  function renderMessage(): HTMLElement {
    const message = element("p", "message");
    message.setAttribute("role", "status");
    message.textContent = temporaryState.error ?? selectionPrompt();
    if (temporaryState.error) {
      message.classList.add("message-error");
    }
    return message;
  }

  function selectionPrompt(): string {
    if (state.completed) {
      return revealState === "revealed" ? "Team revealed." : "XI complete. Reveal the team when ready.";
    }
    if (state.currentSquadKey === null) {
      return "Ready to start.";
    }
    const active = getActiveDetailsPlayer();
    if (active?.source === "drafted") {
      return `Viewing ${active.player.name} in confirmed position ${active.position}.`;
    }
    if (active?.source === "squad" && temporaryState.pendingPosition) {
      return `Previewing ${active.player.name} at position ${temporaryState.pendingPosition}. Confirm to draft.`;
    }
    if (active?.source === "squad") {
      return `Inspecting ${active.player.name}. Click an open batting slot to preview.`;
    }
    return "Choose a player from the spun squad.";
  }

  function renderControls(): HTMLElement {
    const controls = element("section", "controls");
    const spinButton = button("Spin", () => {
      try {
        state = spinFranchiseSeason(options.pool, state, random);
        clearTemporaryState();
      } catch (error) {
        setError(error);
      }
      render();
    });
    spinButton.disabled = state.currentSquadKey !== null;

    const respinButton = button("Respin", () => {
      try {
        state = useVoluntaryRespin(options.pool, state, random);
        clearTemporaryState();
      } catch (error) {
        setError(error);
      }
      render();
    });
    respinButton.disabled = state.currentSquadKey === null || state.respinsRemaining < 1;

    const confirmButton = button("Confirm Pick", () => {
      confirmPick();
    });
    confirmButton.className = "confirm-button";
    confirmButton.disabled = !canConfirmPick();

    const squad = element("strong", "current-spin");
    squad.textContent = formatCurrentSpin(state.currentSquadKey);

    controls.append(spinButton, respinButton, confirmButton, squad);
    return controls;
  }

  function confirmPick(): void {
    const active = getActiveDetailsPlayer();
    const pendingPosition = temporaryState.pendingPosition;
    if (active?.source !== "squad" || pendingPosition === null) {
      temporaryState.error = "Select a squad player and an open batting position before confirming.";
      render();
      return;
    }

    try {
      state = pickPlayer(options.pool, state, active.player.id, pendingPosition, random);
      clearTemporaryState();
    } catch (error) {
      clearTemporaryState();
      setError(error);
    }
    render();
  }

  function canConfirmPick(): boolean {
    const active = getActiveDetailsPlayer();
    const pendingPosition = temporaryState.pendingPosition;
    if (active?.source !== "squad" || pendingPosition === null) {
      return false;
    }
    if (!getOpenPositions(state).includes(pendingPosition)) {
      return false;
    }
    return isLegalPlayerSelection(state, active.player).ok;
  }

  function renderDraftBoard(): HTMLElement {
    const section = element("section", "draft-board");
    const heading = element("h2");
    heading.textContent = "Batting XI";
    const slots = element("div", "slots");
    const active = getActiveDetailsPlayer();

    for (const position of POSITIONS) {
      const slot = state.slots.find((candidate) => candidate.position === position);
      if (slot) {
        slots.append(renderDraftedSlot(position, slot.player));
        continue;
      }

      const slotButton = button("", () => {
        handleOpenPositionClick(position);
      });
      slotButton.className = "slot";
      slotButton.dataset.position = String(position);

      if (active?.source === "squad" && temporaryState.pendingPosition === position) {
        slotButton.classList.add("slot-pending");
        slotButton.textContent = `${position}. Pending ${active.player.name} - ${formatPositionFitLabel(formatPositionFit(active.player, position))}`;
      } else if (active?.source === "squad") {
        slotButton.textContent = `${position}. Open - ${formatPositionFitLabel(formatPositionFit(active.player, position))}`;
      } else {
        slotButton.disabled = true;
        slotButton.textContent = `${position}. Open`;
      }

      slots.append(slotButton);
    }

    section.append(heading, slots);
    return section;
  }

  function renderDraftedSlot(position: BattingPosition, player: DraftPlayerSeason): HTMLElement {
    const slotButton = button("", () => {
      temporaryState.activeDetails = { source: "drafted", position };
      temporaryState.pendingPosition = null;
      temporaryState.error = null;
      render();
    });
    slotButton.className = "slot slot-locked drafted-mini-card";
    slotButton.dataset.position = String(position);
    if (revealState === "revealed") {
      slotButton.classList.add("drafted-mini-card-revealed", tierClass(player.draftTier));
    }

    const title = element("strong");
    title.textContent = `${position}. ${player.name}`;
    const badges = element("span", "player-badges");
    badges.textContent = formatBadges(player).join(" · ");
    const fit = element("span");
    fit.textContent = formatPositionFitLabel(formatPositionFit(player, position));
    slotButton.append(title, badges);
    if (revealState === "revealed") {
      const rating = element("span", "revealed-rating-line");
      rating.textContent = `${player.draftTier} Tier · Rating ${formatOneDecimal(player.baseRating)}`;
      slotButton.append(rating);
    }
    slotButton.append(fit);
    return slotButton;
  }

  function handleOpenPositionClick(position: BattingPosition): void {
    const active = getActiveDetailsPlayer();
    if (active?.source !== "squad") {
      temporaryState.error = "Select a squad player before choosing a batting position.";
      render();
      return;
    }
    temporaryState.pendingPosition = position;
    temporaryState.error = null;
    render();
  }

  function renderActiveDetails(): HTMLElement {
    const section = element("section", "active-details");
    const active = getActiveDetailsPlayer();
    if (!active) {
      const heading = element("h2");
      heading.textContent = "Player Details";
      const empty = element("p", "empty-state");
      empty.textContent = "Select a squad row or confirmed XI card to inspect player details.";
      section.append(heading, empty);
      return section;
    }

    const heading = element("h2");
    heading.textContent = active.source === "drafted" ? "Confirmed Player" : "Player Details";
    const name = element("strong", "details-name");
    name.textContent = active.player.name;
    const meta = element("p");
    meta.textContent = `${active.player.franchise} ${active.player.season}`;
    const badges = element("p", "player-badges");
    badges.textContent = formatBadges(active.player).join(" · ");

    section.append(heading, name, meta, badges);

    if (active.source === "drafted") {
      section.append(detailLine("Confirmed position", String(active.position)), detailLine("Position fit", formatPositionFitLabel(formatPositionFit(active.player, active.position))));
    } else if (temporaryState.pendingPosition !== null) {
      section.append(detailLine("Pending position", String(temporaryState.pendingPosition)), detailLine("Pending fit", formatPositionFitLabel(formatPositionFit(active.player, temporaryState.pendingPosition))));
    }

    section.append(
      detailLine("Role", active.player.seasonRole),
      detailLine("Matches", String(active.player.displayedStats.matches)),
      detailLine("Batting", formatFullBattingStats(active.player)),
    );

    if (active.source === "drafted" && revealState === "revealed") {
      section.append(
        detailLine("Base rating", formatOneDecimal(active.player.baseRating)),
        detailLine("Draft tier", active.player.draftTier),
        detailLine("Absolute tier", active.player.absoluteTier),
      );
      if (active.player.tierAdjustment === "franchise_coverage") {
        section.append(detailLine("Tier adjustment", "Coverage promotion"), detailLine("Rating note", "Base rating remains unchanged"));
      }
      if (active.player.battingRating !== null) {
        section.append(detailLine("Batting rating", formatOneDecimal(active.player.battingRating)));
      }
      if (active.player.bowlingRating !== null) {
        section.append(detailLine("Bowling rating", formatOneDecimal(active.player.bowlingRating)));
      }
      section.append(detailLine("Rating confidence", active.player.ratingConfidence));
    }

    const bowling = formatFullBowlingStats(active.player);
    if (bowling) {
      section.append(detailLine("Bowling", bowling));
    }

    section.append(
      detailLine("Natural positions", formatPositions(active.player.naturalPositions)),
      detailLine("Acceptable positions", formatPositions(active.player.acceptablePositions)),
      detailLine("Position confidence", active.player.positionConfidence),
      detailLine("Bowling option", active.player.bowlingOptionStrength),
      detailLine("Wicketkeeper", active.player.isWicketkeeper ? "yes" : "no"),
      detailLine("Overseas", active.player.isOverseas ? "yes" : "no"),
    );

    const legality = active.source === "squad" ? isLegalPlayerSelection(state, active.player) : { ok: true as const };
    if (!legality.ok) {
      const reason = element("p", "unavailable-reason");
      reason.textContent = legality.reason;
      section.append(reason);
    }

    return section;
  }

  function renderSquad(): HTMLElement {
    const section = element("section", "squad");
    const heading = element("h2");
    heading.textContent = "Current Squad";
    section.append(heading);

    const squad = getCurrentSquad(options.pool, state);
    if (state.currentSquadKey === null) {
      const empty = element("p", "empty-state");
      empty.textContent = "Spin to reveal a franchise-season squad.";
      section.append(empty);
      return section;
    }

    section.append(renderSquadFilters());

    const groups = getVisibleSquadGroups(squad, squadFilter);
    for (const group of groups) {
      const groupSection = element("section", "squad-group");
      const groupHeading = element("h3");
      groupHeading.textContent = group.heading;
      const rows = element("div", "squad-list");
      for (const player of group.players) {
        rows.append(renderSquadRow(player));
      }
      groupSection.append(groupHeading, rows);
      section.append(groupSection);
    }
    return section;
  }

  function renderSquadFilters(): HTMLElement {
    const filters = element("div", "squad-filters");
    filters.setAttribute("aria-label", "Squad role filters");
    const filterOptions: { filter: SquadFilter; label: string }[] = [
      { filter: "all", label: "All" },
      { filter: "batters", label: "Batters" },
      { filter: "wicketkeepers", label: "Wicketkeepers" },
      { filter: "all-rounders", label: "All-Rounders" },
      { filter: "bowlers", label: "Bowlers" },
    ];

    for (const option of filterOptions) {
      const filterButton = button(option.label, () => {
        squadFilter = option.filter;
        render();
      });
      filterButton.className = "squad-filter";
      filterButton.dataset.filter = option.filter;
      filterButton.setAttribute("aria-pressed", String(option.filter === squadFilter));
      if (option.filter === squadFilter) {
        filterButton.classList.add("squad-filter-active");
      }
      filters.append(filterButton);
    }

    return filters;
  }

  function renderSquadRow(player: DraftPlayerSeason): HTMLElement {
    const legality = isLegalPlayerSelection(state, player);
    const row = button("", () => {
      const currentActive = temporaryState.activeDetails;
      if (currentActive?.source !== "squad" || currentActive.playerId !== player.id) {
        temporaryState.pendingPosition = null;
      }
      temporaryState.activeDetails = { source: "squad", playerId: player.id };
      temporaryState.error = null;
      render();
    });
    row.className = "squad-row";
    row.dataset.playerId = player.id;
    if (temporaryState.activeDetails?.source === "squad" && temporaryState.activeDetails.playerId === player.id) {
      row.classList.add("squad-row-active");
    }

    const name = element("strong", "player-name");
    name.textContent = player.name;
    const badges = element("span", "player-badges");
    badges.textContent = formatBadges(player).join(" · ");
    const stats = element("span", "player-stat-line");
    stats.textContent = formatSquadRowStats(player);
    const positions = element("span");
    positions.textContent = `Natural: ${formatPositions(player.naturalPositions)}`;
    row.append(name, badges, stats, positions);

    if (!legality.ok) {
      const reason = element("span", "unavailable-reason");
      reason.textContent = legality.reason;
      row.append(reason);
    }
    return row;
  }

  function renderCompletedDraft(): HTMLElement {
    const section = element("section", "completed");
    const heading = element("h2");
    heading.textContent = "Completed XI";
    const slots = element("div", "slots completed-slots");

    for (const position of POSITIONS) {
      const slot = state.slots.find((candidate) => candidate.position === position);
      if (slot) {
        slots.append(renderDraftedSlot(position, slot.player));
        continue;
      }
      const open = element("div", "slot");
      open.textContent = `${position}. Open`;
      slots.append(open);
    }

    const actions = element("div", "completed-actions");
    if (revealState === "hidden") {
      const reveal = button("Reveal Team", () => {
        revealState = "revealed";
        temporaryState.error = null;
        render();
      });
      reveal.className = "reveal-button";
      actions.append(reveal);
    }

    const restart = button("Start New Draft", () => {
      state = createClassicDraftState();
      revealState = "hidden";
      clearTemporaryState();
      render();
    });
    restart.className = "restart-button";
    actions.append(restart);

    section.append(heading, slots, actions);
    if (revealState === "revealed") {
      section.append(renderTeamSummary());
    }
    return section;
  }

  function renderTeamSummary(): HTMLElement {
    const summary = calculateTeamSummary(state);
    const section = element("section", "team-summary");
    const heading = element("h2");
    heading.textContent = "Team Summary";
    section.append(
      heading,
      detailLine("Average player rating", formatOneDecimal(summary.averageBaseRating)),
      detailLine("Tiers", TIER_ORDER.map((tier) => `${summary.tierCounts[tier]} ${tier}`).join(" · ")),
      detailLine(
        "Position fit",
        `${summary.positionFitCounts.natural} natural · ${summary.positionFitCounts.acceptable} acceptable · ${summary.positionFitCounts.out_of_position} out of position`,
      ),
      detailLine("Overseas", `${summary.overseasCount}/4`),
      detailLine("Wicketkeeper", summary.hasWicketkeeper ? "Yes" : "Missing"),
      detailLine("Bowling options", String(summary.bowlingOptionsCount)),
    );

    const bowlingBreakdown = ["frontline", "secondary", "part_time"]
      .map((strength) => `${summary.bowlingBreakdown[strength] ?? 0} ${formatBowlingStrengthLabel(strength)}`)
      .join(" · ");
    section.append(detailLine("Bowling breakdown", bowlingBreakdown));
    return section;
  }

  function getActiveDetailsPlayer(): ({ source: "squad"; player: DraftPlayerSeason } | { source: "drafted"; player: DraftPlayerSeason; position: BattingPosition }) | null {
    const activeDetails = temporaryState.activeDetails;
    if (!activeDetails) {
      return null;
    }
    if (activeDetails.source === "drafted") {
      const slot = state.slots.find((candidate) => candidate.position === activeDetails.position);
      return slot ? { source: "drafted", player: slot.player, position: slot.position } : null;
    }
    const player = getCurrentSquad(options.pool, state).find((candidate) => candidate.id === activeDetails.playerId);
    return player ? { source: "squad", player } : null;
  }

  render();

  return {
    getState: () => state,
    setStateForTest: (nextState: ClassicDraftState) => {
      state = nextState;
      revealState = "hidden";
      clearTemporaryState();
      render();
    },
  };
}

function formatPositionFit(player: DraftPlayerSeason, position: BattingPosition): "natural" | "acceptable" | "out_of_position" {
  const fit = getPositionFit(player, position);
  if (fit === "preferred") {
    return "natural";
  }
  if (fit === "acceptable") {
    return "acceptable";
  }
  return "out_of_position";
}

function formatPositionFitLabel(fit: "natural" | "acceptable" | "out_of_position"): string {
  return fit === "out_of_position" ? "out of position" : fit;
}

function formatBowlingStrengthLabel(strength: string): string {
  return strength === "part_time" ? "part-time" : strength;
}

function calculateTeamSummary(state: ClassicDraftState): {
  averageBaseRating: number;
  tierCounts: Record<Tier, number>;
  positionFitCounts: Record<"natural" | "acceptable" | "out_of_position", number>;
  overseasCount: number;
  hasWicketkeeper: boolean;
  bowlingOptionsCount: number;
  bowlingBreakdown: Record<string, number>;
} {
  const tierCounts: Record<Tier, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  const positionFitCounts = { natural: 0, acceptable: 0, out_of_position: 0 };
  const bowlingBreakdown: Record<string, number> = { frontline: 0, secondary: 0, part_time: 0 };
  let ratingTotal = 0;
  let bowlingOptionsCount = 0;

  for (const slot of state.slots) {
    ratingTotal += slot.player.baseRating;
    tierCounts[slot.player.draftTier] += 1;
    positionFitCounts[formatPositionFit(slot.player, slot.position)] += 1;
    if (slot.player.bowlingOptionStrength !== "none") {
      bowlingOptionsCount += 1;
      bowlingBreakdown[slot.player.bowlingOptionStrength] = (bowlingBreakdown[slot.player.bowlingOptionStrength] ?? 0) + 1;
    }
  }

  return {
    averageBaseRating: state.slots.length > 0 ? ratingTotal / state.slots.length : 0,
    tierCounts,
    positionFitCounts,
    overseasCount: getOverseasCount(state),
    hasWicketkeeper: hasWicketkeeper(state),
    bowlingOptionsCount,
    bowlingBreakdown,
  };
}

function getVisibleSquadGroups(
  squad: DraftPlayerSeason[],
  squadFilter: SquadFilter,
): { heading: string; players: DraftPlayerSeason[] }[] {
  const groups = squadFilter === "all" ? SQUAD_GROUPS : SQUAD_GROUPS.filter((group) => group.filter === squadFilter);
  return groups.flatMap((group) => {
    const players = squad
      .filter((player) => group.roles.includes(player.seasonRole))
      .sort((left, right) => comparePlayers(left, right, group.sortMetric));
    return players.length > 0 ? [{ heading: group.heading, players }] : [];
  });
}

function comparePlayers(left: DraftPlayerSeason, right: DraftPlayerSeason, metric: "runs" | "wickets"): number {
  const leftMetric = metric === "runs" ? left.displayedStats.runs : left.displayedStats.wickets;
  const rightMetric = metric === "runs" ? right.displayedStats.runs : right.displayedStats.wickets;
  if (rightMetric !== leftMetric) {
    return rightMetric - leftMetric;
  }
  return left.name.localeCompare(right.name);
}

function formatCurrentSpin(currentSquadKey: string | null): string {
  return currentSquadKey?.replace(/^2016\s+/, "") ?? "No franchise-season spun";
}

function formatBadges(player: DraftPlayerSeason): string[] {
  const badges: string[] = [];
  if (player.seasonRole === "bowler") {
    badges.push("BOWL");
  } else if (player.seasonRole === "batting_all_rounder" || player.seasonRole === "bowling_all_rounder") {
    badges.push("AR");
  } else {
    badges.push("BAT");
  }

  if (player.isWicketkeeper) {
    badges.push("WK");
  }
  if (player.isOverseas) {
    badges.push("OVERSEAS");
  }
  return badges;
}

function formatSquadRowStats(player: DraftPlayerSeason): string {
  if (player.seasonRole === "bowler") {
    return formatBowlingStats(player, "Wkts", false) ?? "";
  }
  if (player.seasonRole === "batting_all_rounder" || player.seasonRole === "bowling_all_rounder") {
    return [formatBattingStats(player, "Bat"), formatBowlingStats(player, "Bowl", true)].filter(Boolean).join(" / ");
  }
  return formatBattingStats(player, "Runs") ?? "";
}

function formatBattingStats(player: DraftPlayerSeason, firstLabel: "Runs" | "Bat"): string | null {
  const stats = player.displayedStats;
  if (firstLabel === "Bat" && stats.runs === 0 && stats.ballsFaced === 0 && stats.inningsBatted === 0) {
    return null;
  }
  const parts = [`${firstLabel} ${stats.runs}`];
  if (stats.battingAverage !== null) {
    parts.push(`Avg ${formatOneDecimal(stats.battingAverage)}`);
  }
  if (stats.strikeRate !== null) {
    parts.push(`SR ${formatOneDecimal(stats.strikeRate)}`);
  }
  return parts.join(" | ");
}

function formatBowlingStats(player: DraftPlayerSeason, firstLabel: "Wkts" | "Bowl", showZeroWickets: boolean): string | null {
  const stats = player.displayedStats;
  const parts: string[] = [];
  if (firstLabel === "Wkts") {
    parts.push(`Wkts ${stats.wickets}`);
  } else if (stats.wickets > 0 || showZeroWickets) {
    parts.push(`Bowl ${stats.wickets} wkts`);
  }
  if (stats.economy !== null) {
    parts.push(`Econ ${formatOneDecimal(stats.economy)}`);
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

function formatFullBattingStats(player: DraftPlayerSeason): string {
  const stats = player.displayedStats;
  const parts = [
    `innings ${stats.inningsBatted}`,
    `runs ${stats.runs}`,
    `balls ${stats.ballsFaced}`,
  ];
  if (stats.battingAverage !== null) {
    parts.push(`avg ${formatOneDecimal(stats.battingAverage)}`);
  }
  if (stats.strikeRate !== null) {
    parts.push(`SR ${formatOneDecimal(stats.strikeRate)}`);
  }
  return parts.join(" | ");
}

function formatFullBowlingStats(player: DraftPlayerSeason): string | null {
  const stats = player.displayedStats;
  const isBowlingRole = player.seasonRole === "bowler" || player.seasonRole === "batting_all_rounder" || player.seasonRole === "bowling_all_rounder";
  if (!isBowlingRole && stats.legalBallsBowled === 0 && stats.wickets === 0 && stats.economy === null) {
    return null;
  }
  const parts = [`wickets ${stats.wickets}`, `balls ${stats.legalBallsBowled}`, `runs conceded ${stats.runsConceded}`];
  if (stats.economy !== null) {
    parts.push(`econ ${formatOneDecimal(stats.economy)}`);
  }
  return parts.join(" | ");
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

function formatOneDecimal(value: number): string {
  return value.toFixed(1);
}

function tierClass(tier: Tier): string {
  return `tier-${tier.toLowerCase()}`;
}

function formatPositions(positions: BattingPosition[]): string {
  return positions.length > 0 ? positions.join(", ") : "-";
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(tagName: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  return node;
}
