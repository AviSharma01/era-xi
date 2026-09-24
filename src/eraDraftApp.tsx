import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from "react";

import type { EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftGameCompleteState, projectEraDraftPublicState, projectEraDraftRevealState } from "./eraDraftProjection.js";
import type {
  DraftCandidateIdentityView,
  DraftPickView,
  DraftPresentationFit,
  EraDraftRevealView,
  EraDraftGameCompleteView,
  EraDraftPublicView,
  EraDraftTransitionResult,
  RevealPlayerView,
} from "./eraDraftTypes.js";
import {
  clearEraDraftUiSave,
  loadAndRestoreEraDraftUiSave,
  persistAcceptedEraDraftTransition,
  readEraDraftUiSave,
  writeEraDraftUiSave,
  EraDraftUiSaveError,
  type EraDraftPresentationCursor,
  type EraDraftUiSaveSummary,
  type EraDraftUiSaveReadResult,
  type PersistableEraDraftState,
  type Phase2EraDraftState,
} from "./eraDraftUiPersistence.js";
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

type DraftSession = {
  readonly catalog: EraDraftCatalog;
  readonly state: PersistableEraDraftState;
  readonly presentationCursor: EraDraftPresentationCursor | null;
};

type PendingOperation =
  | { readonly kind: "START"; readonly eraId: EraId; readonly source: "LANDING" | "TERMINAL" }
  | { readonly kind: "CONTINUE" };

export function EraDraftApp(): ReactElement {
  const [route, setRoute] = useState<AppRoute | null>(() => matchAppRoute(window.location.pathname));
  const [manifest, setManifest] = useState<EraDraftWebManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [manifestRequest, setManifestRequest] = useState(0);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [selectedEra, setSelectedEra] = useState<EraId | null>(null);
  const [session, setSession] = useState<DraftSession | null>(null);
  const [savedGame, setSavedGame] = useState<EraDraftUiSaveReadResult>(() => readEraDraftUiSave());
  const [overwriteEra, setOverwriteEra] = useState<EraId | null>(null);
  const [landingNotice, setLandingNotice] = useState<string | null>(null);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const operationIdRef = useRef(0);
  const operationPendingRef = useRef(false);

  useEffect(() => {
    const onPopState = (): void => setRoute(matchAppRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [route]);

  useEffect(() => {
    if (route !== "ERA_DRAFT" || session) return;
    setLandingNotice("No active draft is loaded. Continue a saved game or start a new draft.");
    navigateToAppRoute("HOME", { replace: true });
  }, [route, session]);

  useEffect(() => {
    let active = true;
    const url = eraDraftManifestUrl(import.meta.env.BASE_URL);
    setManifestLoading(true);
    setManifestError(null);
    void fetchEraDraftManifest(url).then((value) => {
      if (active) setManifest(value);
    }).catch((error: unknown) => {
      if (active) setManifestError(error instanceof Error ? error.message : "Era data could not be loaded.");
    }).finally(() => {
      if (active) setManifestLoading(false);
    });
    return () => { active = false; };
  }, [manifestRequest]);

  const navigate = (next: AppRoute): void => navigateToAppRoute(next);

  const acceptTransition = (
    catalog: EraDraftCatalog,
    result: EraDraftTransitionResult,
    presentationCursor: EraDraftPresentationCursor | null = null,
  ): string | null => {
    if (!result.ok) return null;
    if (result.state.phase === "SETUP") throw new Error("The web UI cannot present SETUP.");
    setSession({ catalog, state: result.state, presentationCursor });
    try {
      const persisted = persistAcceptedEraDraftTransition(result, undefined, presentationCursor);
      if (persisted.kind === "SAVED") setSavedGame({ kind: "CANDIDATE", save: persisted.save });
      setPersistenceWarning(null);
      return null;
    } catch (error) {
      const warning = error instanceof Error ? error.message : "This update could not be saved locally.";
      setPersistenceWarning(warning);
      return warning;
    }
  };

  const startDraft = async (eraId: EraId, source: "LANDING" | "TERMINAL" = "LANDING"): Promise<void> => {
    if (!manifest || operationPendingRef.current) return;
    operationPendingRef.current = true;
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    setPendingOperation({ kind: "START", eraId, source });
    if (source === "TERMINAL") setTerminalError(null);
    else setManifestError(null);
    try {
      const manifestUrl = eraDraftManifestUrl(import.meta.env.BASE_URL);
      const catalog = await fetchScopedEraDraftCatalog({ manifest, manifestUrl, eraId });
      const setup = createEraDraftGame({ catalog, rootSeed: createRootSeed() });
      const chosen = reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId });
      if (!chosen.ok || chosen.state.phase !== "AWAITING_SPIN") throw new Error("The selected era could not start.");
      if (operationId !== operationIdRef.current) return;
      acceptTransition(catalog, chosen);
      setOverwriteEra(null);
      navigate("ERA_DRAFT");
    } catch (error) {
      if (operationId !== operationIdRef.current) return;
      const message = error instanceof Error ? error.message : "The selected era could not be loaded.";
      if (source === "TERMINAL") setTerminalError(message);
      else setManifestError(message);
    } finally {
      if (operationId === operationIdRef.current) {
        operationPendingRef.current = false;
        setPendingOperation(null);
      }
    }
  };

  const requestStart = (eraId: EraId): void => {
    if (!session && savedGame.kind === "INVALID") {
      setLandingNotice("Discard the invalid local save before starting a new draft.");
      return;
    }
    if (session || savedGame.kind === "CANDIDATE") {
      setOverwriteEra(eraId);
      return;
    }
    void startDraft(eraId);
  };

  const continueGame = async (): Promise<void> => {
    if (operationPendingRef.current) return;
    if (session) {
      setLandingNotice(null);
      navigate("ERA_DRAFT");
      return;
    }
    if (!manifest || savedGame.kind !== "CANDIDATE") return;
    operationPendingRef.current = true;
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    setPendingOperation({ kind: "CONTINUE" });
    setLandingNotice(null);
    try {
      const manifestUrl = eraDraftManifestUrl(import.meta.env.BASE_URL);
      const restored = await loadAndRestoreEraDraftUiSave({ save: savedGame.save, manifest, manifestUrl });
      if (operationId !== operationIdRef.current) return;
      setSession(restored);
      setPersistenceWarning(null);
      navigate("ERA_DRAFT");
    } catch (error) {
      if (operationId !== operationIdRef.current) return;
      const message = error instanceof Error ? error.message : "The local save could not be restored.";
      if (classifySaveRestoreFailure(error) === "INVALID") setSavedGame({ kind: "INVALID", message });
      else setLandingNotice(`${message} Your saved game was kept. Try again when the era data is available.`);
    } finally {
      if (operationId === operationIdRef.current) {
        operationPendingRef.current = false;
        setPendingOperation(null);
      }
    }
  };

  const discardSave = (): boolean => {
    try {
      clearEraDraftUiSave();
      setSavedGame({ kind: "EMPTY" });
      setOverwriteEra(null);
      setLandingNotice("Local save discarded. You can start a new draft.");
      return true;
    } catch (error) {
      setLandingNotice(error instanceof Error ? error.message : "The local save could not be removed.");
      return false;
    }
  };

  const chooseNewEra = (): void => {
    const cleared = discardSave();
    setSession(null);
    setSelectedEra(null);
    setTerminalError(null);
    if (cleared) setLandingNotice(null);
    else setLandingNotice("The saved game could not be removed. You can still choose an era; starting will ask before replacing it.");
    navigate("HOME");
  };

  const setSeasonCursor = (cursor: EraDraftPresentationCursor): void => {
    if (!session || session.state.phase !== "GAME_COMPLETE") return;
    setSession({ ...session, presentationCursor: cursor });
    try {
      const save = writeEraDraftUiSave(session.state, undefined, cursor);
      setSavedGame({ kind: "CANDIDATE", save });
      setPersistenceWarning(null);
    } catch (error) {
      setPersistenceWarning(error instanceof Error ? error.message : "This checkpoint could not be saved locally.");
    }
  };

  const resumeSummary: EraDraftUiSaveSummary | null = session
    ? { eraId: session.state.eraId, phase: session.state.phase, pickCount: session.state.picks.length, revision: session.state.revision }
    : savedGame.kind === "CANDIDATE" ? savedGame.save.summary : null;
  const loadingEra = pendingOperation?.kind === "START" ? pendingOperation.eraId : null;
  const loadingContinue = pendingOperation?.kind === "CONTINUE";

  if (route === "ERA_DRAFT") {
    if (!session) return <LoadingSession />;
    if (session.state.phase === "GAME_COMPLETE") {
      if (!session.presentationCursor) throw new Error("Completed season is missing its presentation cursor.");
      return <SeasonExperience session={{ catalog: session.catalog, state: session.state, cursor: session.presentationCursor }}
        persistenceWarning={persistenceWarning} onCursor={setSeasonCursor} onExit={() => navigate("HOME")}
        restartPending={pendingOperation?.kind === "START" && pendingOperation.source === "TERMINAL"}
        restartError={terminalError} onSameEra={() => void startDraft(session.state.eraId, "TERMINAL")}
        onNewEra={chooseNewEra} />;
    }
    return session.state.phase === "REVEALED"
      ? <RevealedExperience session={{ catalog: session.catalog, state: session.state }} persistenceWarning={persistenceWarning}
          onBeginSeason={() => {
            const result = reduceEraDraft(session.catalog, session.state, { type: "SIMULATE_SEASON" });
            if (!result.ok || result.state.phase !== "GAME_COMPLETE") throw new Error("The season could not be simulated.");
            acceptTransition(session.catalog, result, { phase: "LEAGUE", revealedUserMatches: 1 });
          }} onExit={() => navigate("HOME")} />
      : <DraftExperience session={{ catalog: session.catalog, state: session.state }}
          persistenceWarning={persistenceWarning} onAccepted={(result) => acceptTransition(session.catalog, result)} onExit={() => navigate("HOME")} />;
  }
  if (route === null) return <NotFound onExit={() => navigate("HOME")} />;
  return <Landing manifest={manifest} manifestLoading={manifestLoading} error={manifestError} loadingEra={loadingEra} selectedEra={selectedEra}
    savedGame={savedGame} loadingContinue={loadingContinue} overwriteEra={overwriteEra} notice={landingNotice}
    resumeSummary={resumeSummary} resumeCursor={session?.presentationCursor ?? null} pendingOperation={pendingOperation}
    onContinue={() => void continueGame()} onDiscardSave={discardSave} onCancelOverwrite={() => setOverwriteEra(null)}
    onRetryManifest={() => setManifestRequest((request) => request + 1)}
    onConfirmOverwrite={(eraId) => void startDraft(eraId)}
    onSelect={(eraId) => {
      setSelectedEra(eraId);
      setOverwriteEra(null);
      setManifestError(null);
    }} onStart={requestStart} />;
}

export function classifySaveRestoreFailure(error: unknown): "INVALID" | "RETRYABLE" {
  return error instanceof EraDraftUiSaveError ? "INVALID" : "RETRYABLE";
}

export function Landing(props: {
  manifest: EraDraftWebManifest | null;
  manifestLoading: boolean;
  error: string | null;
  loadingEra: EraId | null;
  selectedEra: EraId | null;
  savedGame: EraDraftUiSaveReadResult;
  resumeSummary?: EraDraftUiSaveSummary | null;
  resumeCursor?: EraDraftPresentationCursor | null;
  pendingOperation?: PendingOperation | null;
  loadingContinue: boolean;
  overwriteEra: EraId | null;
  notice: string | null;
  basePath?: string;
  onContinue: () => void;
  onDiscardSave: () => boolean;
  onRetryManifest: () => void;
  onCancelOverwrite: () => void;
  onConfirmOverwrite: (eraId: EraId) => void;
  onSelect: (eraId: EraId) => void;
  onStart: (eraId: EraId) => void;
}): ReactElement {
  const selected = props.selectedEra ? ERA_COPY[props.selectedEra] : null;
  const resumeSummary = props.resumeSummary
    ?? (props.savedGame.kind === "CANDIDATE" ? props.savedGame.save.summary : null);
  const operationPending = props.pendingOperation != null || props.loadingEra !== null || props.loadingContinue;
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const eraPickerTitleRef = useRef<HTMLHeadingElement>(null);
  return (
    <main className="era-shell landing-shell">
      <div className="landing-atmosphere" aria-hidden="true" />
      <header className="game-header">
        <a className="wordmark" href={appRoutePath("HOME", props.basePath)} aria-label="Era Draft home">
          <span>ERA DRAFT</span>
        </a>
        <div className="landing-header-actions">
        <a className="classic-link" href={appRoutePath("CLASSIC", props.basePath)}>Classic 2016 <span aria-hidden="true">↗</span></a>
        {resumeSummary && <>
          <span id="continue-summary" className="landing-sr-only">Continue {ERA_COPY[resumeSummary.eraId].title}. {saveSummaryLabel(
            resumeSummary.phase, resumeSummary.pickCount,
            props.resumeCursor ?? (props.savedGame.kind === "CANDIDATE" ? props.savedGame.save.envelope.presentationCursor : null))}</span>
          <button className="secondary-action landing-continue" aria-describedby="continue-summary" aria-busy={props.loadingContinue}
            disabled={(!props.manifest && props.savedGame.kind === "CANDIDATE") || operationPending} onClick={props.onContinue}>
            {props.loadingContinue ? "Restoring verified game…" : "Continue Game"}<span aria-hidden="true">→</span>
          </button>
        </>}
        </div>
      </header>

      <div className="landing-content">
      {props.loadingContinue && <p className="storage-notice" role="status">Loading the saved era and validating its authoritative state.</p>}
      {props.savedGame.kind === "INVALID" && (
        <section className="save-recovery" role="alert" aria-labelledby="save-recovery-title">
          <div><p className="eyebrow">Save recovery</p><h2 id="save-recovery-title">Saved game unavailable</h2>
            <p>We could not safely restore this save. Nothing was silently changed or repaired. {props.savedGame.message}</p></div>
          <button className="secondary-action" onClick={() => {
            if (props.onDiscardSave()) requestAnimationFrame(() => eraPickerTitleRef.current?.focus());
          }}>Discard unusable save</button>
        </section>
      )}
      {props.savedGame.kind === "UNAVAILABLE" && <p className="storage-notice" role="status">{props.savedGame.message} You can still play without autosave.</p>}
      {props.notice && <p className="storage-notice" role="status">{props.notice}</p>}

      <section className="era-picker" aria-labelledby="era-picker-title">
        <div className="section-heading">
          <div><p className="eyebrow">The era index</p><h1 ref={eraPickerTitleRef} tabIndex={-1} id="era-picker-title">Choose your chapter.</h1></div>
        </div>
        <div className="era-selection-layout">
          <div className="era-grid" aria-label="IPL eras">
            {ERA_IDS.map((eraId) => {
              const era = ERA_COPY[eraId];
              const isSelected = props.selectedEra === eraId;
              return (
                <button className={`era-card${isSelected ? " era-card-selected" : ""}`} key={eraId}
                  disabled={!props.manifest || operationPending} aria-pressed={isSelected}
                  onClick={() => props.onSelect(eraId)} aria-label={`Select ${era.title}, ${era.years}`}>
                  <span className="era-card-main"><strong>{era.title}</strong><span className="era-years">{era.years}</span></span>
                </button>
              );
            })}
          </div>
          <aside className={`era-detail${selected ? " era-detail-selected" : ""}`} aria-live="polite" aria-busy={props.loadingEra !== null}>
            {selected && props.selectedEra ? (
              <>
                <h2 className="era-detail-kicker">{selected.title}</h2>
                <p className="era-detail-years">{selected.years}</p>
                <p className="era-detail-copy">{selected.flavor}</p>
                <p className="landing-rules">11 players · Max 4 overseas<br />One respin · Every position locks</p>
                {props.overwriteEra === props.selectedEra ? (
                  <div className="overwrite-confirm" role="alert">
                    <p>Starting a new draft will replace your current saved draft.</p>
                    <div><button className="quiet-button" onClick={() => {
                      props.onCancelOverwrite();
                      requestAnimationFrame(() => startButtonRef.current?.focus());
                    }}>Cancel</button>
                      <button className="secondary-action" onClick={() => props.onConfirmOverwrite(props.selectedEra!)}>Start new draft</button></div>
                  </div>
                ) : (
                  <button ref={startButtonRef} className="primary-action start-draft-action" disabled={operationPending}
                    onClick={() => props.onStart(props.selectedEra!)}>
                    {props.loadingEra === props.selectedEra ? "Loading and verifying…" : "Start Draft"}<span aria-hidden="true">→</span>
                  </button>
                )}
                {props.loadingEra === props.selectedEra && <p className="async-detail" role="status">Downloading {selected.title} data and checking its integrity.</p>}
              </>
            ) : (
              <div className="era-detail-empty"><h2>Select an era</h2><p>Review its years and character before starting the draft.</p></div>
            )}
          </aside>
        </div>
        {!props.manifest && props.manifestLoading && <div className="load-state" role="status" aria-live="polite" aria-busy="true">
          <span className="load-indicator" aria-hidden="true" /><div><strong>Loading era index</strong><p>Preparing the verified era catalog.</p></div>
        </div>}
        {props.error && <div className="load-state load-state-error" role="alert"><div><strong>Era data unavailable</strong><p>{props.error}</p></div>
          {!props.manifest && <button className="secondary-action" disabled={props.manifestLoading} onClick={props.onRetryManifest}>Retry</button>}
        </div>}
      </section>
      </div>
    </main>
  );
}

export function DraftExperience(props: {
  session: { readonly catalog: EraDraftCatalog; readonly state: Exclude<Phase2EraDraftState, { phase: "REVEALED" }> };
  persistenceWarning: string | null;
  onAccepted: (result: EraDraftTransitionResult) => string | null;
  onExit: () => void;
}): ReactElement {
  const { catalog } = props.session;
  const state = props.session.state;
  const view = useMemo(() => projectEraDraftPublicState(catalog, state), [catalog, state]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = useState<number | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const confirmingRef = useRef(false);
  const [message, setMessage] = useState("Spin to reveal a franchise-season.");
  const nextActionRef = useRef<HTMLButtonElement>(null);
  const completeHeadingRef = useRef<HTMLHeadingElement>(null);
  const era = ERA_COPY[view.phase === "SETUP" ? "era-foundation" : view.eraId];
  useEffect(() => { if (view.phase === "XI_COMPLETE") completeHeadingRef.current?.focus(); }, [view.phase]);

  useEffect(() => {
    if (selectedId === null && inspectedId === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (inspectedId !== null) { setInspectedId(null); return; }
      setSelectedId(null);
      setPreviewPosition(null);
      setMessage("Player selection cleared.");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, inspectedId]);

  useEffect(() => {
    confirmingRef.current = false;
    setSelectedId(null);
    setPreviewPosition(null);
    setInspectedId(null);
  }, [state.revision]);

  const transition = (command: Parameters<typeof reduceEraDraft>[2]): void => {
    const result = reduceEraDraft(catalog, state, command);
    if (!result.ok) {
      confirmingRef.current = false;
      setMessage(result.error.message);
      return;
    }
    const saveWarning = props.onAccepted(result);
    setSelectedId(null);
    setPreviewPosition(null);
    setInspectedId(null);
    const acceptedMessage = command.type === "LOCK_PLAYER"
      ? result.state.phase === "XI_COMPLETE" ? "Pick 11 locked. Your XI is complete." : `Pick ${result.state.picks.length} locked. Spin again.`
      : command.type === "RESPIN" ? "Respin used. A new franchise-season is ready."
        : command.type === "REVEAL_XI" ? "Team revealed. Ratings are now available."
          : "Franchise-season revealed. Choose one player.";
    setMessage(saveWarning ? `${acceptedMessage} ${saveWarning}` : acceptedMessage);
    if (command.type === "LOCK_PLAYER" && result.state.phase !== "XI_COMPLETE") requestAnimationFrame(() => nextActionRef.current?.focus());
  };

  const selected = view.phase === "AWAITING_PICK" ? view.candidates.find((candidate) => candidate.playerTeamSeasonId === selectedId) : undefined;
  const inspected = view.phase === "SETUP" ? undefined : view.picks.find((pick) => pick.playerTeamSeasonId === inspectedId)
    ?? (selected?.playerTeamSeasonId === inspectedId ? selected : undefined);
  const preview = selected?.positions.find((position) => position.battingPosition === previewPosition && position.available);
  const confirmPick = (): void => {
    // Inspection is deliberately not an input to commitment.
    if (!selected || !preview || confirmingRef.current) return;
    confirmingRef.current = true;
    transition({ type: "LOCK_PLAYER", playerTeamSeasonId: selected.playerTeamSeasonId, battingPosition: preview.battingPosition });
  };
  const confirmation = <button className="primary-action confirm-pick" disabled={!selected || !preview}
    onClick={confirmPick}>{preview ? `Confirm Pick · Slot ${String(preview.battingPosition).padStart(2, "0")}` : "Confirm Pick"}</button>;
  return (
    <main className="era-shell draft-shell gameplay-shell">
      <div className="gameplay-atmosphere" aria-hidden="true" />
      <header className="game-header draft-header">
        <button className="wordmark wordmark-button" onClick={props.onExit} aria-label="Return to era selection">
          <span className="wordmark-mark">ED</span><span>ERA DRAFT</span>
        </button>
        <div className="draft-era-id"><span>{era.title}</span><strong>{era.years}</strong></div>
        <button className="quiet-button" onClick={props.onExit}>Exit draft</button>
      </header>

      <div className="draft-layout">
        <section id="draft-players" className="draft-stage" aria-labelledby="draft-stage-title">
          {view.phase !== "SETUP" && view.phase !== "XI_COMPLETE" && <DraftControlRegion view={view} era={era} primaryActionRef={nextActionRef} onTransition={transition} />}
          {props.persistenceWarning && <PersistenceWarning message={props.persistenceWarning} />}

          {view.phase === "AWAITING_SPIN" && (
            <div className="roster-empty-state">
              <span className="roster-empty-index" aria-hidden="true">{String(view.status.pickCount + 1).padStart(2, "0")}</span>
              <div><h2>{view.status.pickCount === 0 ? "Your first squad is waiting." : "Ready for the next spin."}</h2>
                <p>The verified roster will appear here without changing your playing XI.</p></div>
            </div>
          )}

          {view.phase === "AWAITING_PICK" && (
            <CandidateGallery view={view} selectedId={selectedId} onSelect={(candidate) => {
              setPreviewPosition(null);
              setInspectedId(null);
              if (candidate.playerTeamSeasonId === selectedId) {
                setSelectedId(null);
                setMessage("Player selection cleared.");
                return;
              }
              setSelectedId(candidate.playerTeamSeasonId);
              setMessage(`${candidate.playerName} selected. Choose an open batting position.`);
            }} onUnavailable={(reason) => setMessage(reason)} />
          )}

          {view.phase === "AWAITING_PICK" && <>
            {inspected ? <PlayerInspector player={inspected} onClose={() => setInspectedId(null)} />
              : selected ? <SelectedPlayerDetail candidate={selected} />
                : <div className="selected-player-empty">No player selected.</div>}
            <div className="desktop-confirm">
              {inspected && selected && <p className="pending-pick-label">Pending pick: {selected.playerName}</p>}
              {confirmation}
            </div>
            <a className="draft-jump" href="#draft-xi">View XI ↓</a>
          </>}

          {view.phase === "XI_COMPLETE" && (
            <div className="complete-state"><div><p className="eyebrow">{era.title} · {era.years}</p><h1 ref={completeHeadingRef} id="draft-stage-title" tabIndex={-1}>XI complete</h1></div>
              <div className="complete-status"><p>11 / 11 confirmed</p><p>Overseas {view.status.overseasCount} / 4 · Wicketkeeper {view.status.hasWicketkeeper ? "covered" : "needed"}</p></div>
              <p>Reveal your team’s ratings and construction.</p>
              <button ref={nextActionRef} className="primary-action reveal-team-action" onClick={() => transition({ type: "REVEAL_XI" })}>Reveal team <span aria-hidden="true">→</span></button></div>
          )}
          {view.phase !== "AWAITING_PICK" && inspected && <PlayerInspector player={inspected} onClose={() => setInspectedId(null)} />}
          <p className="sr-status" aria-live="polite">{message}</p>
        </section>

        {view.phase !== "SETUP" && <XiPanel view={view} selected={selected} previewPosition={previewPosition}
          onInspect={setInspectedId} onConfirm={confirmPick} onPreview={(position) => {
            setPreviewPosition(position);
            setMessage(`Preview in position ${position}: ${fitLabel(selected!.positions.find((option) => option.battingPosition === position)!.presentationFit)}. Confirm Pick to lock.`);
          }} />}
      </div>
      {view.phase === "AWAITING_PICK" && <div className="draft-bottom-bar">
        <div><strong>{selected?.playerName ?? "No player selected"}</strong><span>{preview ? `Preview · Slot ${String(preview.battingPosition).padStart(2, "0")}` : "No preview position"}</span></div>
        <a href="#draft-players">Back to Players ↑</a>{confirmation}
      </div>}
    </main>
  );
}

function CandidateGallery(props: {
  view: Extract<EraDraftPublicView, { phase: "AWAITING_PICK" }>;
  selectedId: string | null;
  selected?: DraftCandidateIdentityView;
  onSelect: (candidate: DraftCandidateIdentityView) => void;
  onUnavailable: (reason: string) => void;
}): ReactElement {
  let previousGroup: DraftCandidateIdentityView["presentationGroup"] | null = null;
  return (
    <div className="candidate-section">
      <div className="candidate-heading"><h3>Eligible squad</h3><span>{props.view.candidates.length} players</span></div>
      <div className="candidate-grid">
        {props.view.candidates.map((candidate) => {
          const selected = candidate.playerTeamSeasonId === props.selectedId;
          const unavailableReason = !candidate.available
            ? candidate.positions.flatMap((position) => position.reasons)[0]?.message ?? "Unavailable"
            : undefined;
          const unavailableReasonId = `candidate-unavailable-${candidate.playerTeamSeasonId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          const showGroup = candidate.presentationGroup !== previousGroup;
          previousGroup = candidate.presentationGroup;
          return (
            <div className="candidate-entry" key={candidate.playerTeamSeasonId}>
              {showGroup && <div className="candidate-group-label"><span>{friendly(candidate.presentationGroup)}</span></div>}
              <button className={`candidate-card${selected ? " candidate-card-selected" : ""}`}
                aria-disabled={!candidate.available} aria-pressed={selected}
                aria-describedby={unavailableReason ? unavailableReasonId : undefined}
                onClick={() => candidate.available ? props.onSelect(candidate) : props.onUnavailable(unavailableReason!)}>
                <span className="portrait-placeholder" aria-hidden="true"><span>{monogram(candidate.playerName)}</span></span>
                <span className="candidate-body"><strong>{candidate.playerName}</strong><span>{friendly(candidate.displayRole)}</span>
                  <span className="candidate-meta">{candidate.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}
                    {candidate.keeperCapability === "CONFIRMED" && candidate.displayRole !== "WICKETKEEPER_BATTER" ? " · WK" : ""}</span>
                  {unavailableReason && <span id={unavailableReasonId} className="candidate-unavailable">{unavailableReason}</span>}
                </span>
                <span className="candidate-quick-stats">
                  {candidateQuickStats(candidate).map((line) => <span key={line}>{line}</span>)}
                </span>
                <span className="select-mark" aria-hidden="true">{!candidate.available ? "" : selected ? "✓" : "+"}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SelectedPlayerDetail({ candidate }: { candidate: DraftCandidateIdentityView }): ReactElement {
  const showBatting = candidate.displayRole !== "BOWLER" && candidate.displayRole !== "UNKNOWN";
  const showBowling = candidate.displayRole === "BOWLER" || candidate.displayRole === "ALL_ROUNDER";
  return <section className={`selected-player-detail tier-${candidate.tierAppearance}`} aria-labelledby="selected-player-title">
    <span className="selected-player-portrait" aria-hidden="true">{monogram(candidate.playerName)}</span>
    <div className="selected-player-copy">
      <h3 id="selected-player-title">{candidate.playerName}</h3>
      <p>{candidate.teamName} · {candidate.seasonYear}</p>
      <div className="selected-player-meta">
        <span>{friendly(candidate.displayRole)}</span>
        <span>{candidate.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}</span>
        {candidate.keeperCapability === "CONFIRMED" && candidate.displayRole !== "WICKETKEEPER_BATTER" && <span>Wicketkeeper</span>}
      </div>
      <CurrentSeasonStats candidate={candidate} batting={showBatting} bowling={showBowling} />
    </div>
  </section>;
}

function CurrentSeasonStats(props: {
  candidate: Pick<DraftCandidateIdentityView, "historicalStats" | "seasonYear">;
  batting: boolean;
  bowling: boolean;
}): ReactElement {
  const { batting, bowling } = props.candidate.historicalStats.currentSeason;
  const lines: string[] = [];
  if (props.batting) {
    lines.push(`${batting.runs} runs · ${batting.strikeRate === null ? "—" : formatOneDecimal(batting.strikeRate)} SR`);
  }
  if (props.bowling) {
    lines.push(`${bowling.wickets} wickets · ${bowling.economy === null ? "—" : formatTwoDecimals(bowling.economy)} econ`);
  }
  return <div className="current-season-stats" aria-label={`${props.candidate.seasonYear} current season statistics`}>
    <span>{props.candidate.seasonYear} season</span>
    {lines.length > 0 ? lines.map((line) => <strong key={line}>{line}</strong>) : <strong>No recorded statistics</strong>}
  </div>;
}

function PlayerInspector({ player, onClose }: { player: DraftPickView | DraftCandidateIdentityView; onClose: () => void }): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Keep the original opener across StrictMode's effect setup/cleanup replay.
    openerRef.current ??= document.activeElement as HTMLElement | null;
    const opener = openerRef.current;
    dialogRef.current?.showModal(); closeRef.current?.focus();
    return () => {
      // Restore after native dialog removal/cancel has finished its own focus handling.
      requestAnimationFrame(() => { if (!dialogRef.current?.open && opener?.isConnected) opener.focus(); });
    };
  }, []);
  const { batting, bowling } = player.historicalStats.currentSeason;
  const showBat = player.displayRole !== "BOWLER" && player.displayRole !== "UNKNOWN";
  const showBowl = player.displayRole === "BOWLER" || player.displayRole === "ALL_ROUNDER";
  const content = <>
    <header><p className="eyebrow">Player details{'battingPosition' in player ? ` · Slot ${String(player.battingPosition).padStart(2, "0")}` : " · Preview"}</p>
      <button ref={closeRef} className="quiet-button" onClick={onClose} aria-label="Close player details">Close ×</button></header>
    <div className="inspector-identity"><span className="inspector-monogram" aria-hidden="true">{monogram(player.playerName)}</span>
      <div><h3 id="inspector-title">{player.playerName}</h3><p>{player.teamName} · {player.seasonYear}</p></div></div>
    <p>{friendly(player.displayRole)} · {player.rosterStatus === "OVERSEAS" ? "Overseas" : "Indian"}{player.keeperCapability === "CONFIRMED" && player.displayRole !== "WICKETKEEPER_BATTER" ? " · WK" : ""}</p>
    <div className="inspector-metrics" aria-label="Exact season statistics">
      {showBat && <><div><span>Runs</span><strong>{batting.runs}</strong></div><div><span>Strike rate</span><strong>{batting.strikeRate === null ? "—" : formatOneDecimal(batting.strikeRate)}</strong></div></>}
      {showBat && !showBowl && <div><span>Batting average</span><strong>{batting.average === null ? "—" : formatOneDecimal(batting.average)}</strong></div>}
      {showBowl && <><div><span>Wickets</span><strong>{bowling.wickets}</strong></div><div><span>Economy</span><strong>{bowling.economy === null ? "—" : formatTwoDecimals(bowling.economy)}</strong></div></>}
    </div>
  </>;
  return <dialog ref={dialogRef} className={`player-inspector inspector-modal tier-${player.tierAppearance}`} aria-labelledby="inspector-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
      if (event.key === "Escape") event.stopPropagation();
      // Close is the sheet's only interactive control; keep Tab within the dialog.
      if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); }
    }}>{content}</dialog>;
}

export function RevealedExperience(props: {
  session: { readonly catalog: EraDraftCatalog; readonly state: Extract<Phase2EraDraftState, { phase: "REVEALED" }> };
  persistenceWarning: string | null;
  onBeginSeason: () => void;
  onExit: () => void;
}): ReactElement {
  const view = useMemo(
    () => projectEraDraftRevealState(props.session.catalog, props.session.state),
    [props.session.catalog, props.session.state],
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const beginStartedRef = useRef(false);
  const [beginStarted, setBeginStarted] = useState(false);
  const era = ERA_COPY[view.eraId];
  useEffect(() => headingRef.current?.focus(), []);
  return <main className="era-shell draft-shell revealed-shell gameplay-shell">
    <div className="gameplay-atmosphere" aria-hidden="true" />
    <header className="game-header draft-header">
      <button className="wordmark wordmark-button" onClick={props.onExit} aria-label="Return to era selection">
        <span className="wordmark-mark">ED</span><span>ERA DRAFT</span>
      </button>
      <div className="draft-era-id"><span>{era.title}</span><strong>{era.years}</strong></div>
      <button className="quiet-button" onClick={props.onExit}>Exit draft</button>
    </header>
    <div className="draft-layout reveal-layout">
      <section className="draft-stage reveal-stage" aria-labelledby="reveal-title">
        {props.persistenceWarning && <PersistenceWarning message={props.persistenceWarning} />}
        <div className="reveal-intro"><p className="eyebrow">{era.title} · {era.years}</p>
          <h1 ref={headingRef} tabIndex={-1} id="reveal-title">Your team, revealed.</h1>
          <p>Historical player-season ratings, with team strength reflecting your batting order and bowling balance.</p></div>
        <p className="eyebrow strength-label">Team strength</p><div className="strength-grid" aria-label="Team strength ratings">
          <RevealMetric label="Overall" value={view.evaluation.strength.overall} featured />
          <RevealMetric label="Batting" value={view.evaluation.strength.batting} />
          <RevealMetric label="Bowling" value={view.evaluation.strength.bowling} />
        </div>
        <section className="evaluation-summary" aria-labelledby="evaluation-title">
          <div className="candidate-heading"><h2 id="evaluation-title">Team Assessment</h2></div>
          <div className="assessment-section"><h3>Quality mix</h3><div className="quality-mix">{(["S", "A", "B", "C", "D"] as const).filter((tier) => view.evaluation.tierCounts[tier] > 0).map((tier) =>
            <span key={tier} className={`mix-${tier.toLowerCase()}`}>{tier} × {view.evaluation.tierCounts[tier]}</span>)}</div></div>
          <div className="assessment-section"><h3>Batting-order fit</h3>
            <p>{countSummary({ ...view.evaluation.fitCounts, ACCEPTABLE: view.evaluation.fitCounts.ACCEPTABLE + view.evaluation.fitCounts.UNKNOWN }, ["NATURAL", "ACCEPTABLE"])}</p>
            {(["STRETCH", "MAJOR_STRETCH"] as const).filter((fit) => view.evaluation.fitCounts[fit] > 0).map((fit) => <div key={fit}><FitBadge fit={fit} /> <span className={`fit-${fitClass(fit)}`}>{view.evaluation.fitCounts[fit]}</span></div>)}
            <p>Position-fit adjustments are reflected in team strength.</p></div>
          <div className="assessment-section"><h3>Bowling balance</h3>
            <EvaluationRow label="Deployment" value={`${formatRating(view.evaluation.construction.deployedBowlingUnits)} / ${view.evaluation.construction.requiredBowlingUnits} units`} />
            <EvaluationRow label="Options" value={`${view.evaluation.construction.frontlineBowlers} frontline · ${view.evaluation.construction.supportBowlers} support`} /></div>
        </section>
        <div className="phase-boundary">
          <button className="primary-action" disabled={beginStarted} onClick={() => {
            if (beginStartedRef.current) return;
            beginStartedRef.current = true;
            setBeginStarted(true);
            props.onBeginSeason();
          }}>{beginStarted ? "Starting league…" : "Start League"} <span aria-hidden="true">→</span></button></div>
        <p className="sr-status" aria-live="polite">Team revealed. Player and team ratings are now visible.</p>
      </section>
      <RevealedXi view={view} />
    </div>
  </main>;
}

export function SeasonExperience(props: {
  session: {
    readonly catalog: EraDraftCatalog;
    readonly state: Extract<PersistableEraDraftState, { phase: "GAME_COMPLETE" }>;
    readonly cursor: EraDraftPresentationCursor;
  };
  persistenceWarning: string | null;
  restartPending?: boolean;
  restartError?: string | null;
  onCursor: (cursor: EraDraftPresentationCursor) => void;
  onExit: () => void;
  onSameEra: () => void;
  onNewEra: () => void;
}): ReactElement {
  const view = useMemo(() => projectEraDraftGameCompleteState(props.session.catalog, props.session.state),
    [props.session.catalog, props.session.state]);
  const { cursor } = props.session;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), [cursor]);
  const era = ERA_COPY[view.eraId];
  return <main className={`era-shell season-shell gameplay-shell season-phase-${cursor.phase.toLowerCase()}`}>
    <div className="gameplay-atmosphere" aria-hidden="true" />
    <header className="game-header draft-header">
      <button className="wordmark wordmark-button" onClick={props.onExit} aria-label="Return to era selection">
        <span className="wordmark-mark">ED</span><span>ERA DRAFT</span>
      </button>
      <div className="draft-era-id"><span>{era.title}</span><strong>{era.years}</strong></div>
      <button className="quiet-button" onClick={props.onExit}>Exit season</button>
    </header>
    {props.persistenceWarning && <PersistenceWarning message={props.persistenceWarning} />}
    {cursor.phase === "LEAGUE" && <LeagueCheckpoint view={view} revealed={cursor.revealedUserMatches}
      headingRef={headingRef} onNext={() => props.onCursor(cursor.revealedUserMatches < 14
        ? { phase: "LEAGUE", revealedUserMatches: cursor.revealedUserMatches + 1 }
        : { phase: "LEAGUE_COMPLETE" })}
      onSimRemaining={() => props.onCursor({ phase: "LEAGUE_COMPLETE" })} />}
    {cursor.phase === "LEAGUE_COMPLETE" && <LeagueComplete view={view} headingRef={headingRef}
      onContinue={() => props.onCursor(view.league.qualified
        ? { phase: "PLAYOFFS", revealedPlayoffMatches: 1 }
        : { phase: "COMPLETE" })} />}
    {cursor.phase === "PLAYOFFS" && <PlayoffExperience view={view} revealed={cursor.revealedPlayoffMatches}
      headingRef={headingRef} onNext={() => props.onCursor(cursor.revealedPlayoffMatches < view.playoffs.userMatches.length
        ? { phase: "PLAYOFFS", revealedPlayoffMatches: cursor.revealedPlayoffMatches + 1 }
        : { phase: "COMPLETE" })}
      onSimToEnd={() => props.onCursor({ phase: "COMPLETE" })} />}
    {cursor.phase === "COMPLETE" && <TerminalExperience view={view} headingRef={headingRef}
      restartPending={props.restartPending ?? false} restartError={props.restartError ?? null}
      onSameEra={props.onSameEra} onNewEra={props.onNewEra} />}
  </main>;
}

function LeagueCheckpoint(props: {
  view: EraDraftGameCompleteView;
  revealed: number;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onNext: () => void;
  onSimRemaining: () => void;
}): ReactElement {
  const checkpoint = props.view.league.userMatches[props.revealed - 1]!;
  return <div className="season-layout season-layout-progress">
    <section className="season-primary" aria-labelledby="season-match-title">
      <div className="broadcast-match">
      <div className="season-kicker"><p className="eyebrow">League stage</p><span>Match {String(checkpoint.matchNumber).padStart(2, "0")} / 14</span></div>
      <h1 ref={props.headingRef} tabIndex={-1} id="season-match-title">{checkpoint.match.opponent?.teamName}</h1>
      <MatchResult match={checkpoint.match} />
      </div>
      <LeagueProgressStrip matches={props.view.league.userMatches} revealed={props.revealed} />
      <div className="season-progress-summary">
        <div><span>Season record</span><strong>{checkpoint.record.won}–{checkpoint.record.lost}</strong></div>
        <div><span>League position</span><strong>{ordinal(checkpoint.position)}</strong>
          <small>{movementLabel(checkpoint.movement, checkpoint.previousPosition)}</small></div>
      </div>
      <div className="season-actions">
        <button className="primary-action" onClick={props.onNext}>{props.revealed === 14 ? "View final table" : "Next match"}<span aria-hidden="true">→</span></button>
        {props.revealed < 14 && <button className="secondary-action" onClick={props.onSimRemaining}>Sim remaining</button>}
      </div>
      <p className="sr-status" aria-live="polite">Match {checkpoint.matchNumber} revealed. {checkpoint.match.resultLabel}. Record {checkpoint.record.won} wins and {checkpoint.record.lost} losses. Position {checkpoint.position}.</p>
    </section>
    {checkpoint.matchNumber < 14
      ? <details className="league-standings-disclosure"><summary><span>Provisional standings</span>
          <strong>Your XI · {ordinal(checkpoint.position)}</strong></summary>
          <StandingsTable rows={checkpoint.standings} provisional />
        </details>
      : <StandingsTable rows={checkpoint.standings} provisional={false} />}
  </div>;
}

function LeagueProgressStrip(props: {
  matches: EraDraftGameCompleteView["league"]["userMatches"];
  revealed: number;
}): ReactElement {
  return <ol className="league-progress-strip" aria-label={`League progress: ${props.revealed} of 14 matches revealed`}>
    {props.matches.map((checkpoint, index) => {
      const visible = index < props.revealed;
      const result = checkpoint.match.result === "WIN" ? "W" : "L";
      const current = index === props.revealed - 1;
      return <li key={checkpoint.match.matchId} className={visible ? `progress-${result.toLowerCase()}${current ? " progress-current" : ""}` : "progress-upcoming"}
        aria-label={visible ? `Match ${index + 1}: ${result === "W" ? "win" : "loss"}` : `Match ${index + 1}: upcoming`}
        aria-current={current ? "step" : undefined}>
        <span>{String(index + 1).padStart(2, "0")}</span><strong>{visible ? result : "·"}</strong>
      </li>;
    })}
  </ol>;
}

function LeagueComplete(props: {
  view: EraDraftGameCompleteView;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onContinue: () => void;
}): ReactElement {
  return <div className="season-layout">
    <section className="season-primary league-complete-panel" aria-labelledby="league-complete-title">
      <p className="eyebrow">League complete</p>
      <h1 ref={props.headingRef} tabIndex={-1} id="league-complete-title">{props.view.league.qualified ? "Playoffs secured." : "Season ends here."}</h1>
      <p className="season-outcome-copy">Your XI finished {ordinal(props.view.league.userFinalPosition)} with a {props.view.league.userRecord.won}–{props.view.league.userRecord.lost} record.</p>
      <div className={`qualification-state ${props.view.league.qualified ? "qualified" : "eliminated"}`}>
        <span>{props.view.league.qualified ? "Qualified" : "Not qualified"}</span>
        <strong>{props.view.league.qualified ? "The playoff route is ready." : `Eventual champion: ${props.view.champion.teamName}`}</strong>
      </div>
      <button className="primary-action" onClick={props.onContinue}>{props.view.league.qualified ? "Begin playoffs" : "View season result"}<span aria-hidden="true">→</span></button>
      <p className="sr-status" aria-live="polite">Final league standings revealed. Your XI finished position {props.view.league.userFinalPosition} and {props.view.league.qualified ? "qualified" : "did not qualify"}.</p>
    </section>
    <StandingsTable rows={props.view.league.finalStandings} provisional={false} />
  </div>;
}

function PlayoffExperience(props: {
  view: EraDraftGameCompleteView;
  revealed: number;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onNext: () => void;
  onSimToEnd: () => void;
}): ReactElement {
  const match = props.view.playoffs.userMatches[props.revealed - 1]!;
  const allIndex = props.view.playoffs.allMatches.findIndex((item) => item.matchId === match.matchId);
  return <div className="season-layout playoff-layout">
    <section className="season-primary" aria-labelledby="playoff-match-title">
      <div className="broadcast-match">
      <div className="season-kicker"><p className="eyebrow">Playoffs</p><span>{stageLabel(match.stage)}</span></div>
      <h1 ref={props.headingRef} tabIndex={-1} id="playoff-match-title">{match.opponent?.teamName}</h1>
      <MatchResult match={match} />
      </div>
      <div className="season-actions"><button className="primary-action" onClick={props.onNext}>
        {props.revealed < props.view.playoffs.userMatches.length ? "Next match" : "View season result"}<span aria-hidden="true">→</span></button>
        <button className="secondary-action" onClick={props.onSimToEnd}>Sim to end</button></div>
      <p className="sr-status" aria-live="polite">{stageLabel(match.stage)} revealed. {match.resultLabel}.</p>
    </section>
    <PlayoffBracket matches={props.view.playoffs.allMatches} revealedThrough={allIndex + 1} activeMatchId={match.matchId} />
  </div>;
}

function TerminalExperience(props: {
  view: EraDraftGameCompleteView;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onSameEra: () => void;
  onNewEra: () => void;
  restartPending: boolean;
  restartError: string | null;
}): ReactElement {
  return <section className={`terminal-screen${props.view.champion.isUser ? " terminal-champion" : ""}`} aria-labelledby="terminal-title">
    <p className="eyebrow">Season complete · {ERA_COPY[props.view.eraId].title}</p>
    <h1 ref={props.headingRef} tabIndex={-1} id="terminal-title">{props.view.champion.isUser ? "Your XI are champions." : props.view.league.qualified ? props.view.playoffs.userResult : "League campaign complete."}</h1>
    <p className="champion-line">{props.view.champion.isUser ? "Your XI" : props.view.champion.teamName}<span>IPL Era Draft champion</span></p>
    <div className="terminal-summary">
      <div><span>League finish</span><strong>{ordinal(props.view.league.userFinalPosition)}</strong></div>
      <div><span>Record</span><strong>{props.view.league.userRecord.won}–{props.view.league.userRecord.lost}</strong></div>
      <div><span>Playoff outcome</span><strong>{props.view.playoffs.userResult}</strong></div>
    </div>
    <PlayoffBracket matches={props.view.playoffs.allMatches} revealedThrough={props.view.playoffs.allMatches.length} />
    {props.restartError && <p className="draft-warning" role="alert">The new draft could not start. {props.restartError}</p>}
    <div className="terminal-actions"><button className="primary-action" disabled={props.restartPending} onClick={props.onNewEra}>New Era Draft</button>
      <button className="secondary-action" disabled={props.restartPending} aria-busy={props.restartPending} onClick={props.onSameEra}>
        {props.restartPending ? "Starting new draft…" : "Draft same era again"}</button></div>
    <p className="sr-status" aria-live="polite">Season complete. {props.view.champion.teamName} are champions.</p>
  </section>;
}

function MatchResult({ match }: { match: EraDraftGameCompleteView["league"]["userMatches"][number]["match"] }): ReactElement {
  return <article key={match.matchId} className={`match-result match-result-${match.result.toLowerCase()}`} aria-label={match.resultLabel}>
    <div className="innings-row"><span><small>First innings</small><strong>{match.firstInnings.teamId === "user" ? "Your XI" : match.firstInnings.teamName}</strong></span>
      <b>{formatInnings(match.firstInnings.runs, match.firstInnings.wickets)}</b></div>
    <div className="innings-row"><span><small>Second innings</small><strong>{match.secondInnings.teamId === "user" ? "Your XI" : match.secondInnings.teamName}</strong></span>
      <b>{formatInnings(match.secondInnings.runs, match.secondInnings.wickets)}</b></div>
    <div className="match-verdict"><strong>{match.resultLabel}</strong>{match.result !== "AI_RESULT" && <span className="match-outcome">{match.result}</span>}</div>
  </article>;
}

function StandingsTable({ rows, provisional }: { rows: EraDraftGameCompleteView["league"]["finalStandings"]; provisional: boolean }): ReactElement {
  return <section className="standings-panel" aria-labelledby="standings-title">
    <div className="candidate-heading"><h2 id="standings-title">{provisional ? "Provisional table" : "Final standings"}</h2><span>{provisional ? "In progress" : "14 matches"}</span></div>
    <div className="standings-scroll"><table><thead><tr><th scope="col">Pos</th><th scope="col">Team</th><th scope="col">P</th><th scope="col">W</th><th scope="col">L</th><th scope="col">Pts</th><th scope="col">NRR</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.teamId} className={row.isUser ? "user-standing" : undefined}>
        <td>{row.position}</td><th scope="row">{row.teamName}{row.isUser && <small>Your XI</small>}{row.qualified === true && <small>Qualified</small>}</th>
        <td>{row.played}</td><td>{row.won}</td><td>{row.lost}</td><td>{row.points}</td><td>{formatSigned(row.netRunRate)}</td>
      </tr>)}</tbody></table></div>
  </section>;
}

function PlayoffBracket({ matches, revealedThrough, activeMatchId }: {
  matches: EraDraftGameCompleteView["playoffs"]["allMatches"];
  revealedThrough: number;
  activeMatchId?: string;
}): ReactElement {
  return <section className="playoff-bracket" aria-labelledby="playoff-bracket-title">
    <div className="candidate-heading"><h2 id="playoff-bracket-title">Playoff path</h2></div>
    <ol>{matches.map((match, index) => {
      const revealed = index < revealedThrough;
      const userMatch = revealed && (match.firstInnings.teamId === "user" || match.secondInnings.teamId === "user");
      const active = match.matchId === activeMatchId;
      return <li key={match.matchId}
        className={`playoff-stage${revealed ? " playoff-stage-revealed" : " playoff-stage-locked"}${userMatch ? " playoff-user-match" : ""}${active ? " active-playoff" : ""}`}
        aria-current={active ? "step" : undefined}>
        <div className="playoff-stage-heading"><span>{stageLabel(match.stage)}</span><small>{revealed ? userMatch ? "Your match" : "Complete" : "Upcoming"}</small></div>
        {revealed ? <>
          <div className="playoff-teams">
            <PlayoffTeam innings={match.firstInnings} winner={match.winnerTeamId === match.firstInnings.teamId} />
            <PlayoffTeam innings={match.secondInnings} winner={match.winnerTeamId === match.secondInnings.teamId} />
          </div>
          <strong className="playoff-result">{match.resultLabel}</strong>
        </> : <div className="playoff-locked-copy"><strong>Matchup locked</strong></div>}
      </li>;
    })}</ol>
  </section>;
}

function PlayoffTeam({ innings, winner }: {
  innings: EraDraftGameCompleteView["playoffs"]["allMatches"][number]["firstInnings"];
  winner: boolean;
}): ReactElement {
  return <div className={`playoff-team${winner ? " playoff-team-winner" : ""}`}>
    <span>{innings.teamId === "user" ? "Your XI" : innings.teamName}</span>
    <strong>{formatInnings(innings.runs, innings.wickets)}</strong>
  </div>;
}

function RevealMetric({ label, value, featured = false }: { label: string; value: number; featured?: boolean }): ReactElement {
  return <div className={`reveal-metric${featured ? " reveal-metric-featured" : ""}`}><span>{label}</span><strong>{formatRating(value)}</strong></div>;
}

function EvaluationRow({ label, value }: { label: string; value: string }): ReactElement {
  return <div className="evaluation-row"><span>{label}</span><strong>{value}</strong></div>;
}

function XiPanel(props: {
  view: Exclude<EraDraftPublicView, { phase: "SETUP" }> | EraDraftRevealView;
  selected?: DraftCandidateIdentityView;
  previewPosition?: number | null;
  onPreview?: (position: number) => void;
  onInspect?: (id: string) => void;
  onConfirm?: () => void;
}): ReactElement {
  const positions = Array.from({ length: 11 }, (_, index) => index + 1);
  const revealed = props.view.phase === "REVEALED";
  return (
    <aside id="draft-xi" className="xi-panel" aria-labelledby="xi-title">
      <div className="xi-heading"><div><h2 id="xi-title">Your XI</h2></div>
        <span className="pick-counter">{props.view.status.pickCount}<small> / 11 confirmed</small></span></div>
      <div className="draft-status" aria-label="Draft status">
        <Status label="Overseas" value={`${props.view.status.overseasCount}/4`} />
        <Status label="Keeper" value={props.view.status.hasWicketkeeper ? "Ready" : "Needed"} active={props.view.status.hasWicketkeeper} />
        <Status label={revealed ? "State" : "Respin"} value={revealed ? "Revealed" : friendly(props.view.status.respinStatus)} active={revealed} />
      </div>
      {props.selected && <div className="fit-legend" aria-label="Position fit legend">{(["NATURAL", "ACCEPTABLE", "STRETCH", "MAJOR_STRETCH"] as const).map((fit) => <FitBadge key={fit} fit={fit} />)}</div>}
      <div className="xi-slots">
        {positions.map((position) => {
          const pick = props.view.picks.find((item) => item.battingPosition === position);
          const revealPlayer = props.view.phase === "REVEALED"
            ? props.view.players.find((item) => item.battingPosition === position)
            : undefined;
          const option = props.selected?.positions.find((item) => item.battingPosition === position);
          const previewPick: DraftPickView | undefined = !pick && props.previewPosition === position && props.selected && option?.available
            ? { ...props.selected, pickNumber: props.view.status.pickCount + 1, battingPosition: option.battingPosition, presentationFit: option.presentationFit } : undefined;
          return pick || previewPick
            ? <XiPlayerCard key={position} position={position} pick={(pick ?? previewPick)!} preview={!!previewPick}
                onInspect={() => props.onInspect?.((pick ?? previewPick)!.playerTeamSeasonId)} onConfirm={props.onConfirm} />
            : <button key={position} className={`xi-slot${props.selected ? " xi-slot-active" : ""}${option ? ` xi-target-${fitClass(option.presentationFit)}` : ""}`}
                disabled={!props.selected || !option?.available}
                title={!option?.available && option?.reasons[0] ? option.reasons[0].message : undefined}
                aria-label={`Position ${position}${option ? ` · ${fitLabel(option.presentationFit)} · ${option.available ? "Available for preview" : option.reasons.map((reason) => reason.message).join(". ")}` : " · Open position"}`}
                onClick={() => props.onPreview?.(position)}>
                <span className="position-number">{String(position).padStart(2, "0")}</span>
                <span className="xi-portrait xi-portrait-empty" aria-hidden="true"><span>+</span></span>
                <span className="empty-fit-label">{props.selected && option ? fitLabel(option.presentationFit) : ""}</span>
              </button>;
        })}
      </div>
      {(props.view.phase === "XI_COMPLETE" || revealed) && <div className="xi-complete-mark"><span>11/11</span><strong>{revealed ? "Team revealed" : "XI complete"}</strong></div>}
    </aside>
  );
}

function XiPlayerCard({ position, pick, preview, onInspect, onConfirm }: { position: number; pick: DraftPickView; preview?: boolean; onInspect: () => void; onConfirm?: () => void }): ReactElement {
  const style = { "--reveal-order": position - 1 } as CSSProperties;
  return <button type="button" style={style} onClick={(event) => {
    if (preview) onConfirm?.();
    else { event.currentTarget.focus(); onInspect(); }
  }} aria-label={`${preview ? "Confirm pick" : "Inspect"} ${pick.playerName}, position ${position}, ${preview ? "preview" : "confirmed"}, ${fitLabel(pick.presentationFit)}`}
    className={`xi-slot xi-slot-occupied xi-fit-${fitClass(pick.presentationFit)}${preview ? " xi-slot-preview" : " xi-slot-locked"}`}>
    <span className={`collectible-card tier-${pick.tierAppearance}`}>
    <span className="position-number">{String(position).padStart(2, "0")}</span>
    <span className="placement-marker">{preview ? "Preview" : <svg aria-label="Locked" width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor"><rect x="2" y="6" width="8" height="7" rx="1"/><path d="M4 6V4a2 2 0 0 1 4 0v2"/></svg>}</span>
    <span className="xi-portrait" aria-hidden="true"><span>{monogram(pick.playerName)}</span></span>
    <span className="locked-player"><strong>{pick.playerName}</strong><small>{pick.teamName} · {pick.seasonYear}</small>
      <span>{friendly(pick.displayRole)}</span></span>
    <span className="xi-fit-caption">Position fit · <FitBadge fit={pick.presentationFit} /></span>
    {preview && <span className="slot-confirm-hint"><span aria-hidden="true">↑ </span>Click slot to confirm</span>}
    </span>
  </button>;
}

function RevealedXi({ view }: { view: EraDraftRevealView }): ReactElement {
  return <section className="revealed-xi" aria-labelledby="revealed-xi-title"><h2 id="revealed-xi-title">Your Revealed XI</h2>
    <div className="revealed-list" role="table" aria-label="Revealed player ratings">
      <div className="revealed-list-head" role="row">{["Pos", "Player", "Overall", "Batting", "Bowling", "Position fit"].map((label) => <span role="columnheader" key={label}>{label}</span>)}</div>
      {[...view.players].sort((a, b) => a.battingPosition - b.battingPosition).map((player) => <div role="row" key={player.playerTeamSeasonId} className={`revealed-player revealed-tier-${player.qualityTier.toLowerCase()}`}>
        <span role="cell" className="revealed-position">{String(player.battingPosition).padStart(2, "0")}</span>
        <span role="cell" className="revealed-identity"><strong>{player.playerName}</strong><small>{player.teamName} · {player.seasonYear}</small></span>
        <strong role="cell" className="revealed-overall" aria-label={`Overall ${formatRating(player.overallRating)}`}>{formatRating(player.overallRating)}</strong>
        <span role="cell" className="revealed-bat"><small>BAT </small>{nullableRating(player.displayRole === "BOWLER" ? null : player.battingRating)}</span>
        <span role="cell" className="revealed-bowl"><small>BOWL </small>{nullableRating(player.displayRole === "BATTER" || player.displayRole === "WICKETKEEPER_BATTER" ? null : player.bowlingRating)}</span>
        <span role="cell" className="revealed-fit"><FitBadge fit={player.presentationFit} /></span>
      </div>)}
    </div></section>;
}

function DraftControlRegion(props: {
  view: Exclude<EraDraftPublicView, { phase: "SETUP" }>;
  era: (typeof ERA_COPY)[EraId];
  primaryActionRef: RefObject<HTMLButtonElement | null>;
  onTransition: (command: Parameters<typeof reduceEraDraft>[2]) => void;
}): ReactElement {
  const spinVisible = props.view.phase === "AWAITING_SPIN";
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), [props.view.phase]);
  const respinVisible = props.view.phase === "AWAITING_PICK" && props.view.status.respinStatus === "AVAILABLE";
  return <div className="draft-control-region">
    <div className="draft-control-labels"><p className="eyebrow">{props.era.title} · {props.era.years}</p>
      <span>Pick {String(Math.min(props.view.status.pickCount + 1, 11)).padStart(2, "0")} / 11</span></div>
    <div className="draft-control-main"><h1 ref={headingRef} tabIndex={-1} id="draft-stage-title">{stageTitle(props.view)}</h1>
      <div className="draft-control-actions">
        {spinVisible && <button ref={props.primaryActionRef} className="primary-action" onClick={() => props.onTransition({ type: "SPIN" })}>Spin franchise <span aria-hidden="true">→</span></button>}
        {respinVisible && <button className="secondary-action" onClick={() => props.onTransition({ type: "RESPIN" })}>Respin · 1 left</button>}
        {!respinVisible && <span className="respin-status">{props.view.status.respinStatus === "USED" ? "Respin used" : "Respin · 1 left"}</span>}
      </div>
    </div>
    <div className="draft-context-strip">
      <div className="franchise-context">
        {props.view.phase === "AWAITING_PICK" ? <><strong>{props.view.currentSpin.teamName}</strong><span>{props.view.currentSpin.seasonYear}</span></>
          : props.view.phase === "XI_COMPLETE" ? <><strong>Playing XI complete</strong><span>11 locked</span></>
          : <><strong>Franchise-season</strong><span>Awaiting spin</span></>}
      </div>
    </div>
  </div>;
}

function FitBadge({ fit }: { fit: DraftPresentationFit }): ReactElement {
  return <span className={`fit-badge fit-${fitClass(fit)}`}>{fitLabel(fit)}</span>;
}

function fitLabel(fit: DraftPresentationFit): string {
  // Approved UI fallback only: authoritative UNKNOWN remains neutral and unchanged.
  return friendly(fit === "UNKNOWN" ? "ACCEPTABLE" : fit);
}

function Status({ label, value, active = false }: { label: string; value: string; active?: boolean }): ReactElement {
  return <span className={active ? "status-ready" : undefined}><small>{label}</small><strong>{value}</strong></span>;
}

export function LoadingSession(): ReactElement {
  return <main className="era-shell centered-state" aria-live="polite" aria-busy="true"><p className="eyebrow">No active game loaded</p>
    <h1>Returning to era selection…</h1><p>Choose an era or continue a verified local save from the home screen.</p></main>;
}

function PersistenceWarning({ message }: { message: string }): ReactElement {
  return <aside className="draft-warning" role="status"><strong>Autosave unavailable</strong><span>{message}</span></aside>;
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

function fitClass(fit: DraftPresentationFit): string {
  return (fit === "UNKNOWN" ? "ACCEPTABLE" : fit).toLowerCase().replaceAll("_", "-");
}

function formatRating(value: number): string {
  return value.toFixed(1);
}

function nullableRating(value: number | null): string {
  return value === null ? "—" : formatRating(value);
}

function countSummary<T extends string>(counts: Readonly<Record<T, number>>, order: readonly T[]): string {
  return order.filter((key) => counts[key] > 0).map((key) => `${friendly(key)} ${counts[key]}`).join(" · ") || "None";
}

function candidateQuickStats(candidate: DraftCandidateIdentityView): string[] {
  const { batting, bowling } = candidate.historicalStats.currentSeason;
  const battingLine = `${batting.runs} runs · ${batting.strikeRate === null ? "—" : formatOneDecimal(batting.strikeRate)} SR`;
  const bowlingLine = `${bowling.wickets} ${bowling.wickets === 1 ? "wkt" : "wkts"} · ${bowling.economy === null ? "—" : formatTwoDecimals(bowling.economy)} econ`;
  if (candidate.displayRole === "ALL_ROUNDER") return [battingLine, bowlingLine];
  if (candidate.displayRole === "BOWLER" || candidate.displayRole === "UNKNOWN") return [bowlingLine];
  return [battingLine];
}

function formatOneDecimal(value: number): string { return value.toFixed(1); }
function formatTwoDecimals(value: number): string { return value.toFixed(2); }
function formatInnings(runs: number, wickets: number): string { return wickets === 10 ? `${runs}` : `${runs}/${wickets}`; }
function formatSigned(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`; }
function ordinal(value: number): string {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th"
    : value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}
function movementLabel(movement: "UP" | "DOWN" | "SAME" | "FIRST", previous: number | null): string {
  if (movement === "FIRST") return "Opening position";
  if (movement === "SAME") return "No movement";
  return `${movement === "UP" ? "Up" : "Down"} from ${ordinal(previous!)}`;
}
function stageLabel(stage: "LEAGUE" | "QUALIFIER_1" | "ELIMINATOR" | "QUALIFIER_2" | "FINAL"): string {
  if (stage === "QUALIFIER_1") return "Qualifier 1";
  if (stage === "QUALIFIER_2") return "Qualifier 2";
  if (stage === "ELIMINATOR") return "Eliminator";
  if (stage === "FINAL") return "Final";
  return "League";
}

function saveSummaryLabel(
  phase: PersistableEraDraftState["phase"],
  pickCount: number,
  cursor: EraDraftPresentationCursor | null = null,
): string {
  if (phase === "GAME_COMPLETE") {
    if (cursor?.phase === "LEAGUE") return `League match ${cursor.revealedUserMatches} / 14`;
    if (cursor?.phase === "LEAGUE_COMPLETE") return "Final standings ready";
    if (cursor?.phase === "PLAYOFFS") return "Playoffs in progress";
    return "Season complete";
  }
  if (phase === "REVEALED") return "Team revealed · 11/11 locked";
  if (phase === "XI_COMPLETE") return "Ready to reveal · 11/11 locked";
  if (phase === "AWAITING_PICK") return `Player selection open · ${pickCount}/11 locked`;
  return `Ready to spin · ${pickCount}/11 locked`;
}

function createRootSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `era-draft-web-v1:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
