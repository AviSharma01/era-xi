# Draft-Off Cloudflare Stage B adapters

Production-shaped persistence and alarm lifecycle only. `worker.ts` exports the SQLite-backed `DraftOffRoom` class and returns 404 for HTTP. Internal calls require trusted M3 actor contexts supplied by a future Worker adapter. No public enrollment/authentication, fixture actor mapping, reconnect credential, transport, realtime, or deployment is implemented.

The eventual namespace must bind `ROOMS` to `DraftOffRoom` using SQLite storage, with one `idFromName(roomId)` object per room. Local verification uses the pinned Stage A Miniflare/workerd runtime and `useSQLite: true`; no Wrangler deployment configuration or remote resource is created in Stage B.

`catalog.ts` reuses Stage A's generated, content-addressed catalog module. Build that module with the existing Stage A preparation script. Each cold room verifies artifact size/SHA-256 and builds the indexed scoped catalog. `repository.ts` retains unmodified canonical saves and M3 receipts, and commits state, receipts, scheduling metadata, and alarms together. `clock.ts` only registers M3 callbacks; native alarms are durable storage operations. Room expiry removes private room data and receipts, retains a minimal 30-day marker, and then removes it.

Scheduling hints are strictly advisory: every commit replays the canonical bytes, reuses only a matching immutable hint, and repairs all other hints. Warm reconciliation and destructive expiry restore canonical phase/time inside the expiry transaction before repairing wake/alarm metadata or deleting payloads. The canonical save and receipt formats remain unchanged. This adds replay cost; the follow-up small latency check is retained in `../stage-b/results/hint-authority-performance.md`.

See [the architecture boundary](../../docs/DRAFT_OFF_ARCHITECTURE.md#m4-stage-b-durable-persistence-and-alarm-lifecycle) and [local verification](../stage-b/README.md).
