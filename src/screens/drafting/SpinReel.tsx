import { useEffect, useMemo, useRef, type CSSProperties, type ReactElement, type RefObject } from "react";

import { DRAFTING_COPY as COPY } from "../../copy.js";
import type { EraId } from "../../teamEvaluationV2.js";
import { reelRest, reelStrip, type ReelKind, type ReelTile } from "./reel.js";
import { motionMs } from "./behaviour.js";

function Tiles({ tiles }: { tiles: readonly ReelTile[] }): ReactElement {
  return <>{tiles.map((tile, index) => <span key={index} className="spin-reel-tile"><strong>{tile.abbreviation}</strong><small>{tile.year}</small></span>)}</>;
}

/**
 * Only shows a result the engine has already decided. One smooth ease-out from the start tile to the result, with soft
 * speed streaks while it is fast; it never slows past the result or settles back. Any tap on it lands immediately.
 */
export function SpinReel(props: {
  eraId: EraId;
  abbreviation: string;
  year: number;
  kind: ReelKind;
  seed: string;
  reelRef?: RefObject<HTMLButtonElement | null>;
  onLand: () => void;
}): ReactElement {
  const { eraId, abbreviation, year, kind, seed } = props;
  const { tiles, startIndex, resultIndex } = useMemo(() => reelStrip({ eraId, abbreviation, year, seed }), [eraId, abbreviation, year, seed]);
  const land = useRef(props.onLand);
  land.current = props.onLand;
  useEffect(() => {
    const timer = setTimeout(() => land.current(), motionMs(kind === "RESPIN" ? "--motion-respin" : "--motion-spin"));
    return () => clearTimeout(timer);
  }, [kind, seed]);
  return <button type="button" ref={props.reelRef} className={`spin-reel spin-reel-${kind.toLowerCase()}`} aria-label={COPY.reelSkip} onClick={() => land.current()}>
    <span className="spin-reel-strip" style={{ "--reel-start-index": startIndex, "--reel-result-index": resultIndex } as CSSProperties} aria-hidden="true">
      <Tiles tiles={tiles} />
    </span>
    <span className="spin-reel-streaks" aria-hidden="true" />
    <span className="spin-reel-fade" aria-hidden="true" />
    <span className="spin-reel-marker" aria-hidden="true" />
  </button>;
}

/** The reel before a spin: real franchise-seasons of the era, still, under the marker. */
export function ReelAtRest({ eraId, seed }: { eraId: EraId; seed: string }): ReactElement {
  const { tiles, centerIndex } = useMemo(() => reelRest({ eraId, seed }), [eraId, seed]);
  return <div className="spin-reel spin-reel-rest" aria-hidden="true">
    <span className="spin-reel-strip" style={{ "--reel-start-index": centerIndex, "--reel-result-index": centerIndex } as CSSProperties}>
      <Tiles tiles={tiles} />
    </span>
    <span className="spin-reel-fade" />
    <span className="spin-reel-marker" />
  </div>;
}
