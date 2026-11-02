import { useCallback, useEffect, useRef, useState, type TouchEvent } from "react";

import type { EraDraftPublicView } from "../../eraDraftTypes.js";
import type { ReelKind } from "./reel.js";

export type ActiveDraft = Exclude<EraDraftPublicView, { phase: "SETUP" }>;

/** Reads a duration token, so timers and CSS share one value. Without the stylesheet it is 0. */
export function motionMs(token: string): number {
  if (typeof window === "undefined") return 0;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (value.endsWith("ms")) return Number.parseFloat(value) || 0;
  return value.endsWith("s") ? (Number.parseFloat(value) || 0) * 1000 : 0;
}

/** The screen follows the step below this width, matching the gameplay shell's desktop breakpoint. */
const SMALL_SCREEN_QUERY = "(max-width: 959px)";
export function useSmallScreen(): boolean {
  const [small, setSmall] = useState(() => typeof matchMedia === "function" && matchMedia(SMALL_SCREEN_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(SMALL_SCREEN_QUERY);
    const update = (): void => setSmall(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return small;
}

/**
 * A reel plays when a new spin arrives while the workspace is open, never on a restored game. In
 * AWAITING_PICK only a spin or respin changes the revision. Derived during render, so the squad is
 * never painted before the reel.
 */
export function useSpinReel(draft: ActiveDraft): { active: boolean; kind: ReelKind; land: () => void } {
  const [landedRevision, setLandedRevision] = useState(draft.revision);
  const previousPhase = useRef(draft.phase);
  const current = useRef<{ revision: number; kind: ReelKind } | null>(null);
  const active = draft.phase === "AWAITING_PICK" && draft.revision !== landedRevision;
  if (active && current.current?.revision !== draft.revision) {
    current.current = { revision: draft.revision, kind: previousPhase.current === "AWAITING_PICK" ? "RESPIN" : "SPIN" };
  }
  useEffect(() => { previousPhase.current = draft.phase; });
  const land = useCallback(() => setLandedRevision(draft.revision), [draft.revision]);
  return { active, kind: current.current?.kind ?? "SPIN", land };
}

/** The phone's back gesture steps back through the draft and never out of it. Exit draft is the way out. */
export function useBackStepGuard(active: boolean, onBack: () => void): void {
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    if (!active) return;
    const { history, location } = window;
    const path = location.pathname;
    if (!(history.state as { eraXiDraftGuard?: boolean } | null)?.eraXiDraftGuard) history.pushState({ eraXiDraftGuard: true }, "");
    const onPop = (): void => {
      if (location.pathname !== path) return;
      history.pushState({ eraXiDraftGuard: true }, "");
      handler.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [active]);
}

const SWIPE_DISTANCE_PX = 56;
export function useSwipeDown(onSwipe: () => void): { onTouchStart: (event: TouchEvent) => void; onTouchEnd: (event: TouchEvent) => void } {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (event) => {
      const touch = event.touches[0];
      start.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchEnd: (event) => {
      const touch = event.changedTouches[0], from = start.current;
      start.current = null;
      if (!touch || !from) return;
      const down = touch.clientY - from.y;
      if (down >= SWIPE_DISTANCE_PX && Math.abs(touch.clientX - from.x) < down) onSwipe();
    },
  };
}
