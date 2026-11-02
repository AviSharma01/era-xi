import { useEffect, useMemo, useRef, type CSSProperties, type ReactElement, type RefObject } from "react";

import { DRAFTING_COPY as COPY } from "../../copy.js";
import type { EraId } from "../../teamEvaluationV2.js";
import { reelStrip, type ReelKind } from "./reel.js";
import { motionMs } from "./behaviour.js";

/** Only shows a result the engine has already decided. Any tap on it lands immediately. */
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
  const { tiles, resultIndex } = useMemo(() => reelStrip({ eraId, abbreviation, year, kind, seed }), [eraId, abbreviation, year, kind, seed]);
  const land = useRef(props.onLand);
  land.current = props.onLand;
  useEffect(() => {
    const timer = setTimeout(() => land.current(), motionMs(kind === "RESPIN" ? "--motion-respin" : "--motion-spin"));
    return () => clearTimeout(timer);
  }, [kind, seed]);
  return <button type="button" ref={props.reelRef} className={`spin-reel spin-reel-${kind.toLowerCase()}`} aria-label={COPY.reelSkip} onClick={() => land.current()}>
    <span className="spin-reel-strip" style={{ "--reel-result-index": resultIndex } as CSSProperties} aria-hidden="true">
      {tiles.map((tile, index) => tile.kind === "blank"
        ? <span key={index} className="spin-reel-tile spin-reel-blank" />
        : <span key={index} className="spin-reel-tile"><strong>{tile.abbreviation}</strong><small>{tile.year}</small></span>)}
    </span>
    <span className="spin-reel-marker" aria-hidden="true" />
  </button>;
}

const REST_TILES = 7;
/** The reel before a spin: still, empty tiles under the marker. */
export function ReelAtRest(): ReactElement {
  return <div className="spin-reel spin-reel-rest" aria-hidden="true">
    <span className="spin-reel-strip" style={{ "--reel-result-index": Math.floor(REST_TILES / 2) } as CSSProperties}>
      {Array.from({ length: REST_TILES }, (_, index) => <span key={index} className="spin-reel-tile spin-reel-blank" />)}
    </span>
    <span className="spin-reel-marker" />
  </div>;
}
