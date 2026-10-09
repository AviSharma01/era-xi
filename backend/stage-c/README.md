# M4 Stage C local verification

Uses the existing Stage A catalogs/fixtures and exact pinned Miniflare/workerd dependencies. No new dependency, remote resource or deployment.

```sh
npm run build
node backend/stage-a/prepare.mjs
npm run build --prefix backend/stage-b
npm run build --prefix backend/stage-c
npm run typecheck --prefix backend/stage-c
npm run test --prefix backend/stage-c
```

Native tests need loopback/workerd permissions. Bundles are ignored; SQLite stores are temporary. The runtime uses Stage A/B's `2026-10-01` compatibility date and SQLite configuration. Production contains product HTTP/auth but no debug routes. The isolated loopback harness requires `STAGE_C_ONLY=local-workerd-fixtures-only`; clock offsets, storage inspection/tampering, failure diagnostics and fault injection never enter production.

Tests cover pinned verifier comparison, response-loss recovery including real HTTP/client storage, exact concurrent retries/restart, immutable room-scoped identity, HTTP/CORS/media/byte contracts, spoofed identity/clock/seed/system fields, membership/start/private revisions, atomic companion rollback, full-digest collision checks, sealed/canonical corruption, overdue recovery/retention, configurable native/room limits and record ceilings, safe logs, all eras and production isolation.

Focused quota regressions exhaust rejected command/JOIN traffic, refill durable buckets, evict/restart, then prove rejoin/start, full drafting (including respin), submission and available-slot enrollment still work. They assert shared negative storage bounds, eviction rollback, successful exact retries at positive ceilings, and the limited replay guarantee for evicted rejections. A trusted Stage B fixture created at a valid public-format room code explicitly remains inaccessible to public enrollment/authentication after eviction/restart; its helper exists only in the test bundle.

The eight-player Impact smoke uses only safe views to select a legal XI, submit it and recover deadline resolution. `results/http-smoke.json` retains only aggregate measurement/booleans. This is a small local smoke, not deployed latency or multi-room throughput. Private state and raw logs are not retained as evidence.

See `../cloudflare/README.md` for API, configuration, storage and privacy. Stop at Stage C: no realtime/UI/deployment/commit/push.
