import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { TEAM_ABBREVIATIONS } from "../copy.js";
import { loadEraDraftCatalog } from "../eraDraftData.js";
import type { DraftTierAppearance } from "../eraDraftTypes.js";
import { PlayerCard, playerCardName, type PlayerCardPlayer, type PlayerCardProps } from "./PlayerCard.js";

const TIERS: readonly DraftTierAppearance[] = ["violet", "gold", "cobalt", "emerald", "slate"];
const peak = { seasonId: "s", seasonYear: 2014, teamId: "t", teamName: "T" };
const player: PlayerCardPlayer = {
  playerTeamSeasonId: "pts-duminy-2014", playerName: "JP Duminy", teamId: "team-delhi-daredevils", teamName: "Delhi Daredevils",
  seasonYear: 2014, displayRole: "BATTER", rosterStatus: "OVERSEAS", keeperCapability: "UNKNOWN", tierAppearance: "violet",
  historicalStats: {
    currentSeason: { batting: { innings: 12, runs: 410, average: 41, strikeRate: 132.26 }, bowling: { innings: 4, wickets: 2, legalBalls: 48, economy: 8.25 } },
    eraBest: {
      batting: { ...peak, playerTeamSeasonId: "pts-duminy-2014", innings: 12, runs: 410, average: 41, strikeRate: 132.26 },
      bowling: { ...peak, playerTeamSeasonId: "pts-duminy-2016", innings: 9, wickets: 8, legalBalls: 120, economy: 7.5 },
    },
  },
};
const markup = (props: Partial<PlayerCardProps>) => renderToStaticMarkup(<PlayerCard player={player} size="slot" {...props} />);

function mountDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.test/" });
  const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, env: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  return {
    element, dom,
    render: (node: ReactElement) => act(async () => root.render(node)),
    close: async () => {
      await act(async () => root.unmount());
      Object.assign(globalThis, { window: previous.window, document: previous.document, HTMLElement: previous.HTMLElement, IS_REACT_ACT_ENVIRONMENT: previous.env });
      dom.window.close();
    },
  };
}

test("the accessible name carries the tier, and no tier letter is drawn", () => {
  assert.equal(playerCardName(player), "JP Duminy, S tier, Delhi Daredevils 2014, Batter");
  const letters: Record<DraftTierAppearance, string> = { violet: "S", gold: "A", cobalt: "B", emerald: "C", slate: "D" };
  for (const tierAppearance of TIERS) {
    const node = new JSDOM(markup({ player: { ...player, tierAppearance } })).window.document.querySelector(".player-card")!;
    assert.match(node.getAttribute("aria-label")!, new RegExp(`, ${letters[tierAppearance]} tier,`));
    assert.doesNotMatch(node.textContent!, /\b[SABCD]\b(?! ·)/);
    assert.ok(!/\btier\b/i.test(node.textContent!));
  }
});

test("decorative layers are hidden and the ribbon slot renders nothing by default", () => {
  const document = new JSDOM(markup({})).window.document;
  assert.equal(document.querySelector(".player-card-surface")!.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector(".player-card-portrait")!.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector(".player-card-ribbon"), null);
  assert.ok(new JSDOM(markup({ ribbon: "Orange Cap" })).window.document.querySelector(".player-card-ribbon"));
});

test("slot cards use the abbreviation and two role-relevant stats; big cards the full name", () => {
  const slot = new JSDOM(markup({ slotNumber: 3, fit: "STRETCH" })).window.document.querySelector(".player-card")!;
  assert.match(slot.textContent!, /03/);
  assert.match(slot.querySelector(".player-card-team")!.textContent!, /^DD · 2014$/);
  assert.equal(slot.querySelector(".player-card-name")!.tagName, "STRONG");
  assert.deepEqual([...slot.querySelectorAll(".player-card-stat")].map((node) => node.textContent), ["410 runs", "132.3 SR"]);
  assert.match(slot.querySelector(".player-card-tags")!.textContent!, /Batter.*Stretch/);

  const bowler = new JSDOM(markup({ player: { ...player, displayRole: "BOWLER" } })).window.document;
  assert.deepEqual([...bowler.querySelectorAll(".player-card-stat")].map((node) => node.textContent), ["2 wkts", "8.25 econ"]);
  const allRounder = new JSDOM(markup({ size: "big", player: { ...player, displayRole: "ALL_ROUNDER" } })).window.document;
  assert.deepEqual([...allRounder.querySelectorAll(".player-card-stat")].map((node) => node.textContent), ["410 runs", "2 wickets"]);

  const big = new JSDOM(markup({ size: "big" })).window.document.querySelector(".player-card")!;
  assert.equal(big.querySelector("h3")!.textContent, "JP Duminy");
  assert.match(big.querySelector(".player-card-team")!.textContent!, /^Delhi Daredevils · 2014$/);
  assert.match(big.querySelector(".player-card-meta")!.textContent!, /Batter.*Overseas/);
});

test("the era-best line shows only for a role-relevant best season, as plain text", () => {
  const line = (props: Partial<PlayerCardProps>) => new JSDOM(markup({ size: "big", eraTitle: "Transition", ...props })).window.document.querySelector(".player-card-era-best");
  assert.equal(line({})!.textContent, "His best Transition season");
  assert.equal(line({ eraTitle: undefined }), null);
  assert.equal(line({ size: "slot" }), null);
  assert.equal(line({ player: { ...player, displayRole: "BOWLER" } }), null, "best batting season is not a bowler's best");
  assert.ok(line({ player: { ...player, displayRole: "ALL_ROUNDER" } }));
  assert.equal(line({ player: { ...player, playerTeamSeasonId: "pts-duminy-2015" } }), null);
});

test("each state has its own shape and words; pending has no ivory edge", () => {
  const card = (state: PlayerCardProps["state"], extra: Partial<PlayerCardProps> = {}) => new JSDOM(markup({ state, ...extra })).window.document.querySelector(".player-card")!;
  assert.equal(card("default").querySelector(".player-card-state-edge"), null);
  assert.ok(card("selected").querySelector(".player-card-state-edge"));
  assert.match(card("preview").querySelector(".player-card-marker")!.textContent!, /Preview/);
  assert.ok(card("preview").querySelector(".player-card-state-edge"));

  const pending = card("pending");
  assert.match(pending.querySelector(".player-card-marker")!.textContent!, /Locking…/);
  assert.ok(pending.querySelector(".player-card-pulse"));
  assert.equal(pending.querySelector(".player-card-state-edge"), null, "no ivory edge until the server confirms");

  const locked = card("locked");
  assert.ok(locked.querySelector(".player-card-state-edge"));
  assert.ok(locked.querySelector('svg[aria-label="Locked"]'));
  assert.equal(locked.querySelector(".player-card-pulse"), null);

  assert.match(card("unavailable", { unavailableReason: "S limit reached" }).querySelector(".player-card-reason")!.textContent!, /S limit reached/);
  assert.match(card("unavailable").querySelector(".player-card-reason")!.textContent!, /Unavailable/);
  assert.equal(card("default", { unavailableReason: "S limit reached" }).querySelector(".player-card-reason"), null);
});

test("the flash fires per tier, never for D or an unavailable card, and replays on a new key", async () => {
  const flashing = (tierAppearance: DraftTierAppearance, state: PlayerCardProps["state"] = "default") =>
    /player-card-flash-active/.test(markup({ player: { ...player, tierAppearance }, state, flashKey: 1 }));
  for (const tier of ["violet", "gold", "cobalt", "emerald"] as const) assert.equal(flashing(tier), true, tier);
  assert.equal(flashing("slate"), false);
  for (const tier of TIERS) assert.equal(flashing(tier, "unavailable"), false, `${tier} unavailable`);
  assert.doesNotMatch(markup({}), /player-card-flash/);

  const ui = mountDom();
  try {
    await ui.render(<PlayerCard player={player} size="big" flashKey={1} />);
    const first = ui.element.querySelector(".player-card-flash");
    assert.ok(first);
    await ui.render(<PlayerCard player={player} size="big" flashKey={1} />);
    assert.equal(ui.element.querySelector(".player-card-flash"), first, "same key does not replay");
    await ui.render(<PlayerCard player={player} size="big" flashKey={2} />);
    assert.notEqual(ui.element.querySelector(".player-card-flash"), first, "new key remounts the flash layers");
  } finally { await ui.close(); }
});

test("only one S shimmers: the big card at rest, slot cards on hover or selection, never a mini", async () => {
  const ui = mountDom();
  const cards = (extra: ReactElement | null = null) => <>
    <PlayerCard player={player} size="big" className="a" />{extra}
    <PlayerCard player={player} size="slot" className="slot" />
    <PlayerCard player={player} size="mini" className="mini" />
    <PlayerCard player={{ ...player, tierAppearance: "gold" }} size="big" className="gold" />
  </>;
  const names = () => [...ui.element.querySelectorAll(".player-card-shimmer")].map((node) => node.className.match(/\b(a|b|slot|mini|gold|selected-slot)$/)?.[1]);
  try {
    await ui.render(cards());
    assert.deepEqual(names(), ["a"]);
    await ui.render(cards(<PlayerCard player={player} size="big" className="b" />));
    assert.deepEqual(names(), ["b"], "a second big S takes the shimmer");
    await ui.render(cards());
    assert.deepEqual(names(), ["a"], "and hands it back when it closes");

    const slot = ui.element.querySelector<HTMLElement>(".player-card.slot")!;
    await act(async () => { slot.dispatchEvent(new ui.dom.window.Event("focusin", { bubbles: true })); });
    assert.deepEqual(names(), ["slot"], "focus or hover on a slot S takes it");
    await act(async () => { slot.dispatchEvent(new ui.dom.window.Event("focusout", { bubbles: true })); });
    assert.deepEqual(names(), ["a"]);

    await ui.render(<><PlayerCard player={player} size="slot" state="selected" className="selected-slot" /><PlayerCard player={player} size="slot" className="slot" /></>);
    assert.deepEqual(names(), ["selected-slot"]);
    await ui.render(<PlayerCard player={player} size="big" state="unavailable" className="a" />);
    assert.deepEqual(names(), [], "a dimmed S does not shimmer");
    await ui.render(<PlayerCard player={player} size="mini" state="selected" className="mini" />);
    assert.deepEqual(names(), []);
  } finally { await ui.close(); }
});

test("S keeps its holo and prismatic edge at rest on every size; only a shimmer holder moves them", () => {
  const css = readFileSync(new URL("../../src/components/PlayerCard.css", import.meta.url), "utf8");
  // The frozen rest state is the base rule, shared with reduced motion. Nothing size-scoped may hide it.
  assert.match(css, /^\.tier-violet \.player-card-finish \{[^}]*background: var\(--finish-s-holo\);[^}]*transform: translateX\(var\(--card-holo-rest-x\)\);[^}]*\}$/m);
  assert.match(css, /^\.tier-violet \.player-card-edge \{[^}]*background: var\(--finish-s-edge\);[^}]*\}$/m);
  assert.doesNotMatch(css, /^\.tier-violet \.player-card-(finish|edge) \{[^}]*animation/m);
  assert.doesNotMatch(css, /player-card-(slot|mini)[^{]*\.player-card-(finish|edge)/);
  for (const size of ["slot", "mini"] as const) {
    const card = new JSDOM(markup({ size })).window.document.querySelector(".player-card")!;
    assert.ok(card.querySelector(".player-card-finish") && card.querySelector(".player-card-edge"), size);
    assert.equal(card.classList.contains("player-card-shimmer"), false, size);
  }
});

test("S slot cards sweep at rest, taking turns, and reduced motion stops the sweep; big and mini cards do not sweep", () => {
  const css = readFileSync(new URL("../../src/components/PlayerCard.css", import.meta.url), "utf8");
  const base = readFileSync(new URL("../../src/styles/base.css", import.meta.url), "utf8");
  assert.match(css, /^\.tier-violet\.player-card-slot \.player-card-sheen \{[^}]*animation: var\(--anim-sheen-s\)[^}]*animation-delay: calc\(var\(--sheen-turn[^}]*\}$/m);
  assert.doesNotMatch(css, /tier-violet\.player-card-(big|mini) \.player-card-sheen/);
  assert.match(base, /prefers-reduced-motion: reduce[\s\S]*--anim-sheen-s: none;/);
  const card = new JSDOM(markup({ sheenTurn: { index: 1, of: 3 } })).window.document.querySelector<HTMLElement>(".player-card")!;
  assert.match(card.getAttribute("style")!, /--sheen-turn:1;--sheen-turns:3/);
});

test("an unavailable big card names its reason, shows it as a banner and keeps no prismatic edge or finish", () => {
  const card = new JSDOM(markup({ size: "big", state: "unavailable", unavailableReason: "Can’t pick · S limit reached" })).window.document.querySelector(".player-card")!;
  assert.equal(card.getAttribute("aria-label"), "JP Duminy, S tier, Delhi Daredevils 2014, Batter. Can’t pick · S limit reached");
  assert.equal(card.querySelector(".player-card-content")!.firstElementChild!.className, "player-card-reason player-card-banner");
  const css = readFileSync(new URL("../../src/components/PlayerCard.css", import.meta.url), "utf8");
  assert.match(css, /\.player-card-state-unavailable \.player-card-edge \{[^}]*transform: none;[^}]*animation: none;/);
  assert.match(css, /\.player-card-state-unavailable :is\(\.player-card-finish, \.player-card-sheen\) \{ display: none; \}/);
});

test("as a button, the card keeps its name and passes clicks; an enclosing control can name it instead", async () => {
  const ui = mountDom();
  let clicks = 0;
  try {
    await ui.render(<PlayerCard player={player} size="slot" label="Inspect JP Duminy, S tier" onClick={() => { clicks += 1; }} />);
    const button = ui.element.querySelector("button.player-card")!;
    assert.equal(button.getAttribute("aria-label"), "Inspect JP Duminy, S tier");
    assert.equal(button.querySelectorAll("button, h3").length, 0);
    await act(async () => (button as HTMLButtonElement).click());
    assert.equal(clicks, 1);
    await ui.render(<PlayerCard player={player} size="mini" label={null} />);
    assert.equal(ui.element.querySelector(".player-card")!.getAttribute("role"), null);
  } finally { await ui.close(); }
});

test("every catalog team has an abbreviation, and only the RCB brand spells share one", () => {
  const catalog = loadEraDraftCatalog();
  const teams = new Set<string>();
  for (const eraId of catalog.getEraIds()) {
    for (const teamSeason of catalog.getTeamSeasonsForEra(eraId)) {
      for (const candidate of catalog.getCandidatesForTeamSeason(teamSeason.teamSeasonId)) teams.add(candidate.teamId);
    }
  }
  assert.ok(teams.size > 0);
  for (const teamId of teams) assert.ok(TEAM_ABBREVIATIONS[teamId], teamId);
  const values = Object.values(TEAM_ABBREVIATIONS);
  assert.deepEqual(values.filter((value, index) => values.indexOf(value) !== index), ["RCB"]);
});

test("the stylesheet takes its values from tokens and animates only transform and opacity", () => {
  const css = readFileSync(new URL("../../src/components/PlayerCard.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, "no raw colours");
  assert.doesNotMatch(css, /font-family:\s*(?!\s|var\()/, "no font names");
  assert.doesNotMatch(css, /clip-path|polygon\(/, "no cut corners");
  assert.doesNotMatch(css, /\b\d+(\.\d+)?(px|ms|s|rem|deg)\b/, "no raw sizes or timings");
  assert.doesNotMatch(css, /conic-gradient\(|radial-gradient\(/, "finish gradients live in tokens");
  assert.doesNotMatch(css, /transition:[^;]*\b(?!transform\b)(width|height|top|left|background|filter)\b/);
  const keyframes = [...css.matchAll(/@keyframes [\w-]+ \{(.*)\}\s*$/gm)].map((match) => match[1]!);
  assert.ok(keyframes.length >= 8);
  for (const body of keyframes) {
    const properties = [...body.matchAll(/([a-z-]+):/g)].map((match) => match[1]);
    for (const property of properties) assert.ok(property === "transform" || property === "opacity", `${property} in ${body}`);
  }
});
