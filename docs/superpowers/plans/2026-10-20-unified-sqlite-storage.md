# Unified SQLite Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all structured local business data into SQLite, preserve unlimited queue tasks, work history, and statistical events, and make every statistics view respond to one preset/custom date range.

**Architecture:** The Electron main process owns one SQLite database and repository layer. `better-sqlite3` provides synchronous transactions; JSON files are imported idempotently and kept until row/count checks pass. Statistics are queried from immutable event rows, history uses cursor pagination, and renderer receives only typed bounded results through the existing IPC bridge.

**Tech Stack:** Electron 44, TypeScript, `better-sqlite3`, Zod IPC contracts, React, Vitest.

**Spec:** [2026-10-20-global-stats-date-range-design.md](../specs/2026-10-20-global-stats-date-range-design.md)

## Global Constraints

- `userData` SQLite is the only read/write source for settings, kernel config, queue, history, statistics events, and migration metadata after successful migration.
- Queue tasks, work history, and statistics events have no automatic count or age retention limit.
- SQLite events contain no URL, Cookie, filename, author name, or media content; history keeps its existing allowed fields and Cookie stays main-process-only.
- All IPC payload shapes are declared once in `types/ipc-contract.ts`; changes update all six contract locations and increment `CONTRACT_VERSION`.
- Platform identifiers are normalized through `resolveKey()`; no duplicate platform list is introduced.
- Downloaded media, temporary/cache files, and rotating diagnostic logs stay on the filesystem.
- Select a native SQLite package compatible with Electron ABI, rebuild it for packaged Windows, and complete L4 binary/package verification because this adds a native runtime dependency.

## Review Focus

- Interrupted first-run migration or a corrupt database must never erase the source JSON; task 2 tests fail-before-commit and idempotent retry.
- Cookie values must never appear in logs, errors, renderer payloads, or exported diagnostics; task 3 adds redaction regression assertions.
- A repeated parse of the same work remains two `stats_events` rows while `history_entries` keeps current upsert semantics; task 4 verifies both.
- A multi-file download group must paginate as one history work and not split across pages; task 5 pins grouped pagination.
- Date boundaries are local inclusive days even across DST and midnight; task 6 pins single-day and adjacent-day queries.

---

## File Map

- `electron/main/database.ts`: open/close database, PRAGMAs, schema migrations, transactions, health/backup handling.
- `electron/main/repositories.ts`: typed settings/kernel, queue, history, event, and statistics query operations; no IPC or UI dependencies.
- `electron/main/store.ts`: transitional JSON reader/importer only, then remove legacy JSON read/write paths after migration.
- `electron/main/index.ts`, `electron/main/ipc.ts`, `electron/main/downloader.ts`: wire repositories and record lifecycle events.
- `types/ipc-contract.ts`, `types/ipc.ts`, `electron/preload/index.ts`, `renderer/src/lib/bridge.ts`, `renderer/src/dev/mock-bridge.ts`: typed IPC contract and dev implementation.
- `renderer/src/pages/HistoryPage.tsx`, `renderer/src/lib/history-works.ts`, `renderer/src/lib/local-limits.ts`: query-based filtering, grouped cursor pagination, selection and page-size behavior.
- `renderer/src/pages/DownloadsPage.tsx`: queue pagination from SQLite; active tasks remain live while terminal tasks load by page.
- `renderer/src/pages/StatsPage.tsx`, `renderer/src/lib/stats.ts`, `renderer/src/components/ui/`: unified date selector and range query presentation.
- `docs/ARCHITECTURE.md`, `docs/UIUX-DESIGN.md`: persisted-data source, event model, migration, and statistics behavior.

## Interfaces Locked by This Plan

```ts
type DateKey = string; // validated YYYY-MM-DD, local calendar date
interface StatsDateRange { from: DateKey; to: DateKey }
interface StatsQueryResult {
  range: StatsDateRange;
  availableFrom: DateKey | null;
  totals: { downloads: number; failures: number; canceled: number; bytes: number;
    elapsedMs: number; elapsedCount: number; elapsedBytes: number;
    parses: number; parseFailures: number };
  byDay: Record<DateKey, { downloads: number; failures: number; canceled: number;
    bytes: number; parses: number; parseFailures: number }>;
  byPlatform: Record<string, { downloads: number; failures: number; bytes: number;
    parses: number; parseFailures: number }>;
  byKind: Record<string, { downloads: number; bytes: number }>;
  authors: Array<{ name: string; parsedWorks: number; downloadedFiles: number; downloadedBytes: number }>;
}
interface HistoryCursor { createdAt: number; workKey: string }
interface HistoryPage { rows: HistoryEntry[]; nextCursor: HistoryCursor | null }
interface QueueCursor { createdAt: number; taskId: string }
interface QueuePage { rows: DownloadTask[]; nextCursor: QueueCursor | null }
```

`stats:get(range: StatsDateRange): Promise<StatsQueryResult>` replaces the no-argument stats snapshot read. `history:list(filter): Promise<HistoryPage>` accepts optional platform, date range, query, cursor, and a bounded page size (`1..100`). Main process groups matching entries by `groupId || id`, orders groups by latest `createdAt` descending then work key, selects at most the requested number of groups, and returns every underlying entry for those groups so galleries are never split. History selection/deletion commands operate on keys, not entire database payloads.

`download:list(filter): Promise<QueuePage>` accepts optional status, platform, query, cursor, and page size (`1..100`), ordered by `createdAt DESC, taskId DESC`. Active tasks stay in the downloader's live map and overlay query rows; terminal tasks can be retired from the map after final persistence and are paged from SQLite. `queueRepository.loadRecoverable()` returns only nonterminal tasks needed for restart recovery. Queue storage has no count/age limit.

---

### Task 1: SQLite Runtime and Schema Foundation

**Files:**
- Create: `electron/main/database.ts`
- Create: `electron/main/repositories.ts`
- Create: `tests/database.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, Electron packaging config in `package.json` if needed

**Interfaces:**
- Produces `openDatabase(path: string): DatabaseHandle`, `DatabaseHandle.transaction<T>(fn: () => T): T`, `DatabaseHandle.close(): void`, and versioned SQL migrations.
- Uses `better-sqlite3`; enable `foreign_keys`, WAL, and `busy_timeout`; use prepared statements and transactions.

- [ ] **Step 1: Add regression tests for database creation, migration versioning, transactions, and close/reopen persistence.** Assert schema version increments once, a rolled-back transaction leaves no row, and reopen reads committed rows.
- [ ] **Step 2: Run `pnpm exec vitest run tests/database.test.ts` and confirm the new tests fail before the database API exists.**
- [ ] **Step 3: Add `better-sqlite3` as a production dependency and configure Electron ABI rebuild for Windows packaging.** Keep the API behind `database.ts`; do not import the driver from domain modules.
- [ ] **Step 4: Implement `database.ts` with migrations and typed repository boundaries.** Store the file under `app.getPath("userData")/mediaget.sqlite`; set WAL/foreign keys/busy timeout; close explicitly on app shutdown.
- [ ] **Step 5: Run `pnpm exec vitest run tests/database.test.ts` and confirm migration/transaction tests pass.**
- [ ] **Step 6: Commit as `feat(storage): add sqlite database foundation`.**

### Task 2: Idempotent JSON Migration and Recovery

**Files:**
- Modify: `electron/main/store.ts`
- Modify: `electron/main/database.ts`
- Create: `electron/main/storage-migration.ts`
- Create: `tests/storage-migration.test.ts`

**Interfaces:**
- Produces `migrateJsonStore(input: { userDataDir: string; db: DatabaseHandle }): MigrationReport`.
- Reads current `config.json`, `queue.json`, `history.json`, and `stats.json`; writes rows plus source fingerprints and completion markers in one recoverable migration.

- [ ] **Step 1: Write tests for full import, repeat-run idempotency, interrupt/retry, malformed source JSON, and preservation of the old JSON until verification succeeds.** Include settings/kernel values, all queue rows in the source file, 5000 history rows, and legacy aggregate stats.
- [ ] **Step 2: Run `pnpm exec vitest run tests/storage-migration.test.ts` and confirm the tests fail before migration support exists.**
- [ ] **Step 3: Implement source parsers and normalized row import.** Preserve all currently present history and queue rows without a cap; normalize platform keys and author/work keys with existing shared functions; store legacy totals separately from event-query totals.
- [ ] **Step 4: Make migration transactional and idempotent.** Insert source fingerprint/completion metadata with imported rows; on restart, resume or safely rerun without duplicates; never delete or overwrite JSON source files.
- [ ] **Step 5: Add validation counts and redacted error reporting.** Compare source/target row counts and key aggregate values; errors must not contain Cookie values.
- [ ] **Step 6: Run `pnpm exec vitest run tests/storage-migration.test.ts` and confirm all recovery cases pass.**
- [ ] **Step 7: Commit as `feat(storage): migrate json state into sqlite`.**

### Task 3: Move Settings and Kernel Config to Repositories

**Files:**
- Modify: `electron/main/repositories.ts`
- Modify: `electron/main/store.ts`
- Modify: `electron/main/index.ts`
- Modify: `electron/main/ipc.ts`
- Create: `tests/storage-repositories.test.ts`

**Interfaces:**
- `settingsRepository.loadConfig(): { settings: AppSettings; kernel: Record<string, string> }`
- `settingsRepository.saveConfig(config): void`
- `settingsRepository.getKernelValue(key: string): string | undefined`

- [ ] **Step 1: Add tests for settings round-trip and kernel config read boundary.** Assert serialized/logged errors never include a seeded Cookie sentinel.
- [ ] **Step 2: Run `pnpm exec vitest run tests/storage-repositories.test.ts` and confirm failure before repository implementation.**
- [ ] **Step 3: Implement settings/kernel repository methods with prepared statements and transactions.**
- [ ] **Step 4: Wire startup config and IPC settings reads/writes to repositories.** Remove JSON config writes only after migration success; queue remains on its existing runtime source until task 6.
- [ ] **Step 5: Run `pnpm exec vitest run tests/storage-repositories.test.ts`.**
- [ ] **Step 6: Commit as `refactor(storage): use sqlite for config`.**

### Task 4: Complete Statistical Event Ledger and Range Query

**Files:**
- Modify: `electron/main/repositories.ts`
- Modify: `electron/main/stats.ts`
- Modify: `electron/main/ipc.ts`
- Modify: `electron/main/index.ts`
- Modify: `electron/main/downloader.ts`
- Modify: `types/ipc-contract.ts`, `types/ipc.ts`, `electron/preload/index.ts`, `renderer/src/lib/bridge.ts`, `renderer/src/dev/mock-bridge.ts`
- Create: `tests/stats-events.test.ts`
- Modify: `tests/contract.test.ts` only for the new/changed contract assertions

**Interfaces:**
- `statsRepository.recordEvent(event: StatsEventInput): void` appends one normalized immutable event.
- `statsRepository.query(range: StatsDateRange): StatsQueryResult` aggregates requested dates in the main process.
- `StatsEventInput` is a discriminated union for parse `{ at, platform?, via, ok, durationMs, workKey? }`, download `{ at, platform?, kind, outcome, bytes, transferMs?, workKey? }`, and cancel `{ at, platform?, kind?, workKey? }`.

- [ ] **Step 1: Add tests for repeated same-work parses, parse failures, download success/failure/cancel, platform alias normalization, resource type, local date boundaries, and author work dedupe.**
- [ ] **Step 2: Run `pnpm exec vitest run tests/stats-events.test.ts` and confirm the tests fail before event persistence/query exists.**
- [ ] **Step 3: Implement append-only event recording and SQL range aggregation.** Use local date keys, inclusive range semantics, success-rate source counts, and the schema in the Interfaces block; keep legacy `stats.json` aggregates outside range results.
- [ ] **Step 4: Wire parse outcome, download done/error/cancel event callbacks with timestamps and work references.** Preserve current history behavior and insert associated event/history changes in a transaction where both are written.
- [ ] **Step 5: Change `stats:get` to accept `StatsDateRange` and return `StatsQueryResult`; update all six IPC locations and increment `CONTRACT_VERSION`.** Update mocks with deterministic events.
- [ ] **Step 6: Run `pnpm exec vitest run tests/stats-events.test.ts tests/contract.test.ts` and verify the contract/boundary suite relevant to IPC.**
- [ ] **Step 7: Commit as `feat(stats): persist queryable statistical events`.**

### Task 5: Unlimited History Repository and Cursor Pagination

**Files:**
- Modify: `electron/main/repositories.ts`, `electron/main/ipc.ts`
- Modify: `types/ipc-contract.ts`, `types/ipc.ts`, `electron/preload/index.ts`, `renderer/src/lib/bridge.ts`, `renderer/src/dev/mock-bridge.ts`
- Modify: `renderer/src/pages/HistoryPage.tsx`, `renderer/src/lib/history-works.ts`, `renderer/src/lib/local-limits.ts`
- Create: `tests/history-pagination.test.ts`

**Interfaces:**
- `historyRepository.list(filter): HistoryPage` groups by `groupId || id`; filter inputs are platform/from/to/query/cursor and limit 1..100.
- `historyRepository.listKeys(filter, cursor, limit): { keys: string[]; nextCursor: HistoryCursor | null }` returns at most 5000 row/group keys for cross-page selection.
- `historyRepository.remove(keys): void` accepts up to 5000 explicit keys per IPC batch; repeated batches support all selected result pages without one unbounded request.
- `HistoryPage` contains all underlying `HistoryEntry` rows for at most `limit` work groups plus a stable `nextCursor`.

- [ ] **Step 1: Add tests for stable cursor order, group-not-split behavior, query/platform/date filters, id/group deletion, and records beyond the old 5000 cap.**
- [ ] **Step 2: Run `pnpm exec vitest run tests/history-pagination.test.ts` and confirm the new cases fail.**
- [ ] **Step 3: Implement SQL group-page selection and fetch every underlying entry for selected work keys.** Use `createdAt DESC, workKey DESC` stable ordering and parameterized matching.
- [ ] **Step 4: Update history list/key IPC schemas and outputs in all six contract locations; increment `CONTRACT_VERSION`.** Paginate HistoryPage on scroll or explicit next-page control; move search/time/platform filtering to the main-process query; preserve visible selection and selection across pages.
- [ ] **Step 5: Implement cross-page “select all filtered results” by paging through `listKeys` and removing keys in batches no larger than 5000; keep existing explicit row-key semantics and do not delete stats events.**
- [ ] **Step 6: Remove `HISTORY_MAX = 5000` storage truncation and `HISTORY_WINDOW` one-shot load assumptions.** Keep per-request page size bounded.
- [ ] **Step 7: Run focused pagination tests, `pnpm typecheck`, and the contract/boundary checks required by the changed IPC.**
- [ ] **Step 8: Commit as `feat(history): paginate unlimited sqlite history`.**

### Task 6: Unlimited Queue Storage and Cursor Pagination

**Files:**
- Modify: `electron/main/repositories.ts`, `electron/main/ipc.ts`, `electron/main/downloader.ts`, `electron/main/index.ts`
- Modify: `types/ipc-contract.ts`, `types/ipc.ts`, `electron/preload/index.ts`, `renderer/src/lib/bridge.ts`, `renderer/src/dev/mock-bridge.ts`
- Modify: `renderer/src/pages/DownloadsPage.tsx`
- Create: `tests/queue-pagination.test.ts`

**Interfaces:**
- `queueRepository.list(filter): { rows: PersistedQueueTask[]; nextCursor: QueueCursor | null }` filters status/platform/query and returns up to 100 ordered records plus a stable cursor.
- `download:list(filter): Promise<QueuePage>` returns the same bounded page projected to public `DownloadTask` rows.
- `queueRepository.loadRecoverable(): PersistedQueueTask[]` returns only queued/downloading/paused tasks needed for startup recovery.
- All queue tasks stay in SQLite indefinitely; only active/recoverable tasks stay in downloader's mutable in-memory map.

- [ ] **Step 1: Add tests for more than 2000 persisted tasks, cursor ordering, all status filters, active-task overlay, and restart recovery excluding terminal tasks.**
- [ ] **Step 2: Run `pnpm exec vitest run tests/queue-pagination.test.ts` and confirm cases fail before paginated queue support exists.**
- [ ] **Step 3: Implement queue repository pagination and stable cursor predicates using `createdAt DESC, taskId DESC`.**
- [ ] **Step 4: Persist final task state before retiring terminal tasks from downloader memory; continue emitting existing terminal/progress events for active rows.**
- [ ] **Step 5: Change `download:list` to accept bounded filters and return `QueuePage`; update all six IPC locations and increment `CONTRACT_VERSION`.**
- [ ] **Step 6: Update DownloadsPage filtering/pagination to query main, merge live events for active tasks, and never load terminal task history all at once.**
- [ ] **Step 7: Run `pnpm exec vitest run tests/queue-pagination.test.ts tests/contract.test.ts` and the relevant IPC boundary checks.**
- [ ] **Step 8: Commit as `feat(queue): paginate unlimited sqlite tasks`.**

### Task 7: Global Preset and Custom Date Picker for Statistics

**Files:**
- Modify: `renderer/src/pages/StatsPage.tsx`
- Modify: `renderer/src/lib/stats.ts`
- Create: `renderer/src/components/ui/date-range-picker.tsx` only if existing primitives cannot provide the needed accessible calendar interaction
- Modify: `renderer/src/dev/mock-bridge.ts`
- Create: `tests/stats-date-range.test.ts`

**Interfaces:**
- `StatsPage` keeps one applied `{ from, to }` range, defaulting to the last 30 local calendar days.
- `api.stats.get(range)` returns the bounded aggregate query result from task 4.
- Date picker exposes preset `7 | 30 | 90 | 365` and a custom inclusive local date range; future dates disabled; Apply/Cancel semantics.

- [ ] **Step 1: Add pure tests for preset range calculation, custom single-day range, local midnight bounds, leap day, future-date rejection, and start-after-end rejection.**
- [ ] **Step 2: Run `pnpm exec vitest run tests/stats-date-range.test.ts` and confirm the range helper cases fail.**
- [ ] **Step 3: Implement range helpers in `renderer/src/lib/stats.ts` using local calendar arithmetic, not fixed 24-hour subtraction across DST.**
- [ ] **Step 4: Replace the top refresh button and trend-local selector with one global date-range picker.** Preserve a retry action only in error state; refetch all data once when the applied range changes.
- [ ] **Step 5: Bind all metric cards, trend, platform table, type donut, author table, and daily heatmap to the same `StatsQueryResult`.** Show `availableFrom` if the chosen range predates first event data; never display missing legacy dates as true zero.
- [ ] **Step 6: Run `pnpm exec vitest run tests/stats-date-range.test.ts`; visually inspect dev server at `127.0.0.1:5433` for picker, range state, and all six sections.**
- [ ] **Step 7: Commit as `feat(stats): add global custom date range`.**

### Task 8: Remove JSON Runtime Sources and Update Architecture Docs

**Files:**
- Modify: `electron/main/store.ts`, `electron/main/index.ts`, `electron/main/database.ts`
- Modify: `docs/ARCHITECTURE.md`, `docs/UIUX-DESIGN.md`
- Modify: relevant storage/statistics tests and migration fixtures

- [ ] **Step 1: Search all config/history/queue/stats JSON paths and prove runtime writes/reads now go through repositories.** Keep migration-only readers and recovery backups.
- [ ] **Step 2: Update architecture docs with SQLite tables, no queue/history/event retention cap, migration behavior, and filesystem exceptions.**
- [ ] **Step 3: Verify app startup migration failure is surfaced and source JSON remains intact; database closes after queue flush.**
- [ ] **Step 4: Run `pnpm typecheck`, `pnpm lint`, relevant L1 tests, then the single L3 `pnpm test` closeout.**
- [ ] **Step 5: Run `pnpm run verify:binaries:release` and packaged Windows smoke check because the native dependency changes packaging.**
- [ ] **Step 6: Review the full diff for Cookie/file URL leakage, IPC six-piece completeness, and accidental edits to unrelated dirty files.**
- [ ] **Step 7: Commit as `docs(storage): document unified sqlite source`.**

## Execution Notes

- Tasks are sequential because repositories, downloader state, and IPC interfaces are shared; do not parallelize edits to the same storage/contract files.
- Keep every commit limited to the files listed for its task. The workspace already contains unrelated modified landing/UI files; do not include or revert them.
- Follow `docs/TESTING.md` to choose the minimum test tier per task and run full L3/L4 only at closeout.
