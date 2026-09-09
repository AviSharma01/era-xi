import { useEffect, useMemo, useState, type ReactElement } from "react";

import type { EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import type {
  DraftCandidateIdentityView,
  DraftPickView,
  DraftPresentationFit,
  EraDraftHiddenState,
  EraDraftPublicView,
} from "./eraDraftTypes.js";
import { fetchEraDraftManifest, fetchScopedEraDraftCatalog, eraDraftManifestUrl, type EraDraftWebManifest } from "./eraDraftWebData.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";
import { appRoutePath, matchAppRoute, navigateToAppRoute, type AppRoute } from "./webRoutes.js";

const ERA_COPY: Readonly<Record<EraId, { ordinal: string; title: string; years: string; flavor: string }>> = {
  "era-foundation": { ordinal: "01", title: "Foundation", years: "2008–2010", flavor: "The first blueprints. Raw squads, instant icons." },
  "era-expansion": { ordinal: "02", title: "Expansion", years: "2011–2013", flavor: "New teams arrive and the league finds its shape." },
  "era-transition": { ordinal: "03", title: "Transition", years: "2014–2017", flavor: "Power shifts, new homes, and changing dynasties." },
  "era-modern-pre-impact": { ordinal: "04", title: "Modern Pre-Impact", years: "2018–2022", flavor: "Deep analytics meet settled franchise identities." },
  "era-impact": { ordinal: "05", title: "Impact", years: "2023–2026", flavor: "The newest tactical era at full intensity." },
};

type DraftSession = { readonly catalog: EraDraftCatalog; readonly state: EraDraftHiddenState };

export function EraDraftApp(): ReactElement {
  const [route, setRoute] = useState<AppRoute | null>(() => matchAppRoute(window.location.pathname));
  const [manifest, setManifest] = useState<EraDraftWebManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [loadingEra, setLoadingEra] = useState<EraId | null>(null);
  const [selectedEra, setSelectedEra] = useState<EraId | null>(null);
  const [session, setSession] = useState<DraftSession | null>(null);

  useEffect(() => {
    const onPopState = (): void => setRoute(matchAppRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [route]);

  useEffect(() => {
    const url = eraDraftManifestUrl(import.meta.env.BASE_URL);
    void fetchEraDraftManifest(url).then(setManifest).catch((error: unknown) => {
      setManifestError(error instanceof Error ? error.message : "Era data could not be loaded.");
    });
  }, []);

  const navigate = (next: AppRoute): void => navigateToAppRoute(next);

  const chooseEra = async (eraId: EraId): Promise<void> => {
    if (!manifest || loadingEra) return;
    setLoadingEra(eraId);
    setManifestError(null);
    try {
      const manifestUrl = eraDraftManifestUrl(import.meta.env.BASE_URL);
      const catalog = await fetchScopedEraDraftCatalog({ manifest, manifestUrl, eraId });
      const setup = createEraDraftGame({ catalog, rootSeed: createRootSeed() });
      const chosen = reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId });
      if (!chosen.ok || chosen.state.phase !== "AWAITING_SPIN") throw new Error("The selected era could not start.");
      setSession({ catalog, state: chosen.state });
      navigate("ERA_DRAFT");
    } catch (error) {
      setManifestError(error instanceof Error ? error.message : "The selected era could not be loaded.");
    } finally {
      setLoadingEra(null);
    }
  };

  if (route === "ERA_DRAFT") {
    return session
      ? <DraftExperience session={session} onSession={setSession} onExit={() => navigate("HOME")} />
      : <MissingSession onExit={() => navigate("HOME")} />;
  }
  if (route === null) return <NotFound onExit={() => navigate("HOME")} />;
  return <Landing manifest={manifest} error={manifestError} loadingEra={loadingEra} selectedEra={selectedEra}
    onSelect={(eraId) => {
      setSelectedEra(eraId);
      setManifestError(null);
    }} onStart={chooseEra} />;
}

function Landing(props: {
  manifest: EraDraftWebManifest | null;
  error: string | null;
  loadingEra: EraId | null;
  selectedEra: EraId | null;
  onSelect: (eraId: EraId) => void;
  onStart: (eraId: EraId) => Promise<void>;
}): ReactElement {
  const selected = props.selectedEra ? ERA_COPY[props.selectedEra] : null;
  return (
    <main className="era-shell landing-shell">
      <header className="game-header">
        <a className="wordmark" href={appRoutePath("HOME")} aria-label="Era Draft home">
          <span className="wordmark-mark">ED</span><span>ERA DRAFT</span>
        </a>
        <a className="classic-link" href={appRoutePath("CLASSIC")}>Classic 2016 <span aria-hidden="true">↗</span></a>
      </header>

      <section className="landing-intro" aria-labelledby="landing-title">
        <p className="eyebrow">Historical IPL team builder</p>
        <h1 id="landing-title">Build an XI across IPL history.</h1>
        <p className="hero-copy">Choose a period, spin through its franchise-seasons, and make eleven permanent calls.</p>
      </section>

      <section className="era-picker" aria-labelledby="era-picker-title">
        <div className="section-heading">
          <div><p className="eyebrow">Primary mode</p><h2 id="era-picker-title">Choose an era</h2></div>
          <p className="section-note">Five periods. Eleven permanent decisions.</p>
        </div>
        <div className="era-selection-layout">
          <div className="era-grid" aria-label="IPL eras">
            {ERA_IDS.map((eraId) => {
              const era = ERA_COPY[eraId];
              const isSelected = props.selectedEra === eraId;
              return (
                <button className={`era-card${isSelected ? " era-card-selected" : ""}`} key={eraId}
                  disabled={!props.manifest || props.loadingEra !== null} aria-pressed={isSelected}
                  onClick={() => props.onSelect(eraId)} aria-label={`Select ${era.title}, ${era.years}`}>
                  <span className="era-ordinal">{era.ordinal}</span>
                  <span className="era-card-main"><strong>{era.title}</strong><span className="era-years">{era.years}</span></span>
                  <span className="era-arrow" aria-hidden="true">→</span>
                </button>
              );
            })}
          </div>
          <aside className={`era-detail${selected ? " era-detail-selected" : ""}`} aria-live="polite">
            {selected && props.selectedEra ? (
              <>
                <div className="era-detail-kicker"><span>Selected era</span><strong>{selected.ordinal}</strong></div>
                <div><p className="era-detail-years">{selected.years}</p><h3>{selected.title}</h3></div>
                <p className="era-detail-copy">{selected.flavor}</p>
                <div className="era-mode"><span>Game mode</span><strong>Era Draft</strong></div>
                <button className="primary-action start-draft-action" disabled={props.loadingEra !== null}
                  onClick={() => void props.onStart(props.selectedEra!)}>
                  {props.loadingEra === props.selectedEra ? "Loading verified era…" : "Start draft"}<span aria-hidden="true">→</span>
                </button>
              </>
            ) : (
              <div className="era-detail-empty"><span className="era-detail-mark" aria-hidden="true">ED</span>
                <div><h3>Select an era</h3><p>Review its years and character before starting the draft.</p></div></div>
            )}
          </aside>
        </div>
        {!props.manifest && !props.error && <p className="load-status" role="status">Loading era index…</p>}
        {props.error && <p className="load-error" role="alert">{props.error}</p>}
      </section>
    </main>
  );
}

function DraftExperience(props: {
  session: DraftSession;
  onSession: (session: DraftSession) => void;
  onExit: () => void;
}): ReactElement {
  const { catalog } = props.session;
  const state = props.session.state;
  const view = useMemo(() => projectEraDraftPublicState(catalog, state), [catalog, state]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("Spin to reveal a franchise-season.");
  const era = ERA_COPY[view.phase === "SETUP" ? "era-foundation" : view.eraId];

  const transition = (command: Parameters<typeof reduceEraDraft>[2]): void => {
    const result = reduceEraDraft(catalog, state, command);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    props.onSession({ catalog, state: result.state as EraDraftHiddenState });
    setSelectedId(null);
    if (command.type === "LOCK_PLAYER") setMessage(result.state.phase === "XI_COMPLETE"
      ? "Pick 11 locked. Your XI is complete."
      : `Pick ${result.state.picks.length} locked. Spin again.`);
    else if (command.type === "RESPIN") setMessage("Respin used. A new franchise-season is ready.");
    else if (command.type === "SPIN") setMessage("Franchise-season revealed. Choose one player.");
  };

  const selected = view.phase === "AWAITING_PICK" ? view.candidates.find((candidate) => candidate.playerTeamSeasonId === selectedId) : undefined;
  return (
    <main className="era-shell draft-shell">
      <header className="game-header draft-header">
        <button className="wordmark wordmark-button" onClick={props.onExit} aria-label="Return to era selection">
          <span className="wordmark-mark">ED</span><span>ERA DRAFT</span>
        </button>
        <div className="draft-era-id"><span>{era.title}</span><strong>{era.years}</strong></div>
        <button className="quiet-button" onClick={props.onExit}>Exit draft</button>
      </header>

      <div className="draft-layout">
        <section className="draft-stage" aria-labelledby="draft-stage-title">
          {view.phase !== "SETUP" && <DraftControlRegion view={view} era={era} onTransition={transition} />}

          {view.phase === "AWAITING_SPIN" && (
            <div className="roster-empty-state">
              <span className="roster-empty-index" aria-hidden="true">{String(view.status.pickCount + 1).padStart(2, "0")}</span>
              <div><h2>{view.status.pickCount === 0 ? "Your first squad is waiting." : "Ready for the next spin."}</h2>
                <p>The verified roster will appear here without changing your playing XI.</p></div>
            </div>
          )}

          {view.phase === "AWAITING_PICK" && (
            <CandidateGallery view={view} selectedId={selectedId} onSelect={(candidate) => {
              setSelectedId(candidate.playerTeamSeasonId);
              setMessage(`${candidate.playerName} selected. Choose an open batting position.`);
            }} />
          )}

          {view.phase === "XI_COMPLETE" && (
            <div className="complete-state"><p className="eyebrow">Draft complete</p><h2>Your XI is locked.</h2>
              <p>Every position is filled. Team Reveal arrives in Phase 2.</p><button className="primary-action" disabled>Reveal team</button></div>
          )}
          <p className="sr-status" aria-live="polite">{message}</p>
        </section>

        {view.phase !== "SETUP" && <XiPanel view={view} selected={selected} onLock={(playerTeamSeasonId, battingPosition) =>
          transition({ type: "LOCK_PLAYER", playerTeamSeasonId, battingPosition })} />}
      </div>
    </main>
  );
}

function CandidateGallery(props: {
  view: Extract<EraDraftPublicView, { phase: "AWAITING_PICK" }>;
  selectedId: string | null;
  onSelect: (candidate: DraftCandidateIdentityView) => void;
}): ReactElement {
  return (
    <div className="candidate-section">
      <div className="candidate-heading"><h3>Eligible squad</h3><span>{props.view.candidates.length} players</span></div>
      <div className="candidate-grid">
        {props.view.candidates.map((candidate) => {
          const selected = candidate.playerTeamSeasonId === props.selectedId;
          return (
            <button key={candidate.playerTeamSeasonId} className={`candidate-card${selected ? " candidate-card-selected" : ""}`}
              disabled={!candidate.available} aria-pressed={selected}
              title={!candidate.available ? candidate.positions.flatMap((position) => position.reasons)[0]?.message : undefined}
              onClick={() => props.onSelect(candidate)}>
              <span className="portrait-placeholder" aria-hidden="true"><span>{monogram(candidate.playerName)}</span></span>
              <span className="candidate-body"><strong>{candidate.playerName}</strong><span>{friendly(candidate.derivedRole)}</span>
                <span className="candidate-meta">{candidate.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}
                  {candidate.keeperCapability === "CONFIRMED" ? " · WK" : ""}</span></span>
              <span className="select-mark" aria-hidden="true">{selected ? "✓" : "+"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function XiPanel(props: {
  view: Exclude<EraDraftPublicView, { phase: "SETUP" }>;
  selected?: DraftCandidateIdentityView;
  onLock: (playerTeamSeasonId: string, battingPosition: number) => void;
}): ReactElement {
  const positions = Array.from({ length: 11 }, (_, index) => index + 1);
  return (
    <aside className="xi-panel" aria-labelledby="xi-title">
      <div className="xi-heading"><div><p className="eyebrow">Construction</p><h2 id="xi-title">Your playing XI</h2></div>
        <span className="pick-counter">{String(props.view.status.pickCount).padStart(2, "0")}<small>/11</small></span></div>
      <div className="draft-status" aria-label="Draft status">
        <Status label="Overseas" value={`${props.view.status.overseasCount}/4`} />
        <Status label="Keeper" value={props.view.status.hasWicketkeeper ? "Ready" : "Needed"} active={props.view.status.hasWicketkeeper} />
        <Status label="Respin" value={friendly(props.view.status.respinStatus)} />
      </div>
      <div className="xi-slots">
        {positions.map((position) => {
          const pick = props.view.picks.find((item) => item.battingPosition === position);
          const option = props.selected?.positions.find((item) => item.battingPosition === position);
          return pick
            ? <LockedSlot key={position} position={position} pick={pick} />
            : <button key={position} className={`xi-slot${props.selected ? " xi-slot-active" : ""}`}
                disabled={!props.selected || !option?.available}
                title={!option?.available && option?.reasons[0] ? option.reasons[0].message : undefined}
                onClick={() => props.selected && props.onLock(props.selected.playerTeamSeasonId, position)}>
                <span className="position-number">{String(position).padStart(2, "0")}</span>
                <span className="xi-portrait xi-portrait-empty" aria-hidden="true"><span>+</span></span>
                <span className="empty-slot-copy"><strong>{props.selected ? option?.available ? "Lock player here" : "Position unavailable" : "Open position"}</strong>
                  <small>Batting position {String(position).padStart(2, "0")}</small></span>
                <span className="xi-card-rail">{props.selected && option && <FitBadge fit={option.presentationFit} />}</span>
              </button>;
        })}
      </div>
      {props.view.phase === "XI_COMPLETE" && <div className="xi-complete-mark"><span>11/11</span><strong>XI complete</strong></div>}
    </aside>
  );
}

function LockedSlot({ position, pick }: { position: number; pick: DraftPickView }): ReactElement {
  return <article className="xi-slot xi-slot-locked"><span className="position-number">{String(position).padStart(2, "0")}</span>
    <span className="xi-portrait" aria-hidden="true"><span>{monogram(pick.playerName)}</span></span>
    <span className="locked-player"><strong>{pick.playerName}</strong><small>{pick.teamName} · {pick.seasonYear}</small>
      <span>{friendly(pick.derivedRole)} · {pick.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}{pick.keeperCapability === "CONFIRMED" ? " · WK" : ""}</span></span>
    <span className="xi-card-rail"><FitBadge fit={pick.presentationFit} /></span></article>;
}

function DraftControlRegion(props: {
  view: Exclude<EraDraftPublicView, { phase: "SETUP" }>;
  era: (typeof ERA_COPY)[EraId];
  onTransition: (command: Parameters<typeof reduceEraDraft>[2]) => void;
}): ReactElement {
  const spinVisible = props.view.phase === "AWAITING_SPIN";
  const respinVisible = props.view.phase === "AWAITING_PICK" && props.view.status.respinStatus === "AVAILABLE";
  return <div className="draft-control-region">
    <div className="draft-control-labels"><p className="eyebrow">{props.era.title} · {props.era.years}</p>
      <span>Pick {String(Math.min(props.view.status.pickCount + 1, 11)).padStart(2, "0")} / 11</span></div>
    <div className="draft-control-main"><h1 id="draft-stage-title">{stageTitle(props.view)}</h1>
      <div className="draft-control-actions">
        {spinVisible && <button className="primary-action" onClick={() => props.onTransition({ type: "SPIN" })}>Spin franchise <span aria-hidden="true">→</span></button>}
        {respinVisible && <button className="secondary-action" onClick={() => props.onTransition({ type: "RESPIN" })}>Respin</button>}
      </div>
    </div>
    <div className="draft-context-strip">
      <div className="franchise-context">
        {props.view.phase === "AWAITING_PICK" ? <><strong>{props.view.currentSpin.teamName}</strong><span>{props.view.currentSpin.seasonYear}</span></>
          : props.view.phase === "XI_COMPLETE" ? <><strong>Playing XI complete</strong><span>11 locked</span></>
          : <><strong>Franchise-season</strong><span>Awaiting spin</span></>}
      </div>
      <span className={`respin-status respin-${props.view.status.respinStatus.toLowerCase()}`}>Respin · {friendly(props.view.status.respinStatus)}</span>
    </div>
  </div>;
}

function FitBadge({ fit }: { fit: DraftPresentationFit }): ReactElement {
  return <span className={`fit-badge fit-${fit.toLowerCase().replace("_", "-")}`}>{friendly(fit)}</span>;
}

function Status({ label, value, active = false }: { label: string; value: string; active?: boolean }): ReactElement {
  return <span className={active ? "status-ready" : undefined}><small>{label}</small><strong>{value}</strong></span>;
}

function MissingSession({ onExit }: { onExit: () => void }): ReactElement {
  return <main className="era-shell centered-state"><p className="eyebrow">No active draft</p><h1>Choose an era first.</h1>
    <p>Phase 1 keeps the active game in memory. Continue Game and restore arrive in Phase 2.</p><button className="primary-action" onClick={onExit}>Choose an era</button></main>;
}

function NotFound({ onExit }: { onExit: () => void }): ReactElement {
  return <main className="era-shell centered-state"><p className="eyebrow">404</p><h1>That route is outside the boundary.</h1>
    <button className="primary-action" onClick={onExit}>Return home</button></main>;
}

function stageTitle(view: EraDraftPublicView): string {
  if (view.phase === "SETUP") return "Start the draft";
  if (view.phase === "AWAITING_PICK") return "Choose one player";
  if (view.phase === "XI_COMPLETE") return "XI complete";
  return view.status.pickCount === 0 ? "Ready to draft" : "Ready for the next spin";
}

function monogram(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function friendly(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function createRootSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `era-draft-web-v1:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
