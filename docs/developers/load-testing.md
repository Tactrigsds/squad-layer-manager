# Load testing

`pnpm load` boots the production server bundle against emulated Squad servers, drives them and a set of simulated
browser tabs, and reports the CPU, memory and latency that cost. `pnpm load:seed` writes a database of synthetic match
history for a run to boot on. Issue #603 uses both to measure the CPU and RAM that operator docs recommend.

```sh
pnpm load:seed --out data/load/1-server.sqlite3 --servers 1 --matches 800
pnpm load --db data/load/1-server.sqlite3 --servers 1 --viewers 4 --duration 15m
pnpm load --db data/load/1-server.sqlite3 --servers 1 --viewers 4 --memory 2048 --sweep-cpus 2,1.5,1,0.75,0.5,0.25
```

## What a run drives

Each emulated server holds a full roster in squads. Players leave at the rate production players do, and a player
from a pool of 1500 (`--pool`) takes each free slot. Matches last an hour (`--match-length`), with the 30 seconds a
real server spends between matches.

The emulator writes log events at the per-minute means of 992 full-population minutes of production logs. The rates
are kept in src/load/profile.ts, and `src/scripts/measure-log-rates.ts` measures them from any SquadGame.log.
Filler lines no parser rule matches make up the rest of the log's 767 lines a minute. Chat arrives over RCON, which
the logs do not record, so its rate of 6 a minute (`--chat-per-min`) is an assumption until production numbers
replace it. `--intensity` multiplies every rate. The p95 minute in production is about twice the mean.

The emulator answers RCON after 65ms, half of production's round trip, and the app polls at production intervals.

Each client signs in, downloads the layer data and opens the streams the dashboard opens, against one server.
Clients are spread across the servers.

- A viewer (`--viewers`) only watches.
- An editor (`--editors`) adds a layer to the queue and saves it every minute, then removes it and saves again.
- A historian (`--historians`) pages through history events, players and matches every 20 seconds, and opens a
  recent match.

Layer table searches run in the browser, against the downloaded layer data, so the download is the only server
cost they carry. Presence updates are not sent. Plugins are not installed, and add load on top of every figure a run
reports.

## The seeded history

`pnpm load:seed` plays each match out on a clock that runs ahead of the wall. It replays the match's log, chat and
rosters through the same event pipeline and writes as the live ingest. One hour-long match on a full server writes
about 5,400 events and 2.8 MB, at about 1.7 seconds a match, so 800 matches write about 2.3 GB in 23 minutes.

The seed then settles the database. The app boots on it and tallies every match's scoreline and population, as a
production database has long since done, and then compacts the matches older than its archive window. The matches end
at the time the seed runs, so compaction ages them as it would real ones. A run on an unsettled database measures the
tallies catch-up, which holds over 100 MB more in worker heaps while it runs. `--no-settle` skips the step, and
`--settle-only` settles a database seeded earlier.

A run copies the database before booting on it, so every step of a sweep starts from the same history.

## Limits and sweeps

`--cpus` and `--memory` (in MB) run the app in a transient systemd user scope with `CPUQuota` and `MemoryMax`, and
with swap off so that a memory cap kills instead of paging. A sweep (`--sweep-cpus` or `--sweep-memory`) runs one
step per value, in order, and stops at the first degraded step. Order the values from generous to tight. The last
step that passed is the knee, the minimum for that shape. The knee plus the peak headroom the report shows is the
recommendation.

A step is degraded when any of these holds:

| Check                                                     | Threshold |
| --------------------------------------------------------- | --------- |
| the app exits, or the cgroup records an OOM kill          | any       |
| event loop delay p99, as the p95 of its samples           | 100 ms    |
| ingest lag (how far behind the log the app has read), p95 | 5 s       |
| p95 of any rpc, edit or history call                      | 1 s       |

The thresholds are `THRESHOLDS` in src/load/run.ts.

## Reading a report

A run writes `report.json` to its directory, or to `--out`. A sweep writes one report per step under `sweep`.

- `resources` summarizes the samples taken after `--warmup`, and `peaks` the whole run. Each figure gives p50, p95,
  p99 and max over samples taken every 5 seconds.
- `cpuCores` is the app's CPU time over each sample interval, in cores, across every thread.
- `rssMb`, `heapUsedMb` and `externalMb` come from the app's own `process.memoryUsage()`.
- `cgroupAnonMb` and `cgroupFileMb` split the scope's memory into anonymous memory and page cache. A large database
  inflates the page cache, which the kernel can reclaim, so size RAM from the anonymous figure plus headroom. The
  kernel charges a cached page to the cgroup that read it first. The harness drops the database from the page cache
  before boot, so the app is charged for the database pages it reads. Pages of the node binary and shared libraries
  that another process loaded first are charged to that process.
- `throttledMsPerSample` is how long the CPU quota held the app back in each sample interval.
- `latencies` holds client-side timings. `first:<stream>` is the time to a stream's first message, which a page
  load waits on.
- `emitted` counts what each emulated server did, by event.
- `memory` breaks the app's memory down when warmup ends and when the run ends. The next section describes it.

The app reports its own figures over the control socket's `runtime-stats` and `memory-breakdown` commands, which the
harness calls.

## Where the memory goes

A run prints a breakdown of the app's resident memory when it ends, and records it under `memory` in the report. The
breakdown combines two views of the process:

- The kernel's view, from `/proc/<pid>/smaps`. `mappings` groups every mapping's resident memory by what backs it:
  anonymous memory, the malloc heap, the node binary, shared libraries, native addons and the database file.
- The app's view. `owners` splits the anonymous memory between the main thread's V8 heap, each worker's V8 heap, the
  layer engine's wasm memory, array buffers and other external memory.

`owners.native` is the anonymous memory that no owner accounts for. It holds sqlite's page caches, libuv's buffers
and the allocators' overhead. The V8 heaps and the wasm memory are counted at what they have committed, which can
exceed what is resident, so `native` is a lower bound.

`pnpm load` runs the app on the system's malloc, which on glibc holds more native memory than the jemalloc the
production image preloads. For figures that go into the operator docs, run on jemalloc with
`--app-env LD_PRELOAD=<path to libjemalloc.so.2>`.

`mainHeapSpaces` splits the main thread's heap into V8's spaces. `sqlite.cacheCapMb` is the main connection's page
cache limit, and each worker's connection holds a cache of its own.

`--heap-snapshot` writes a heap snapshot of the main thread at the end of the run and summarizes it by constructor
under `memory.heap`, to show what fills the heap. Writing the snapshot freezes the app for seconds and can double
its heap, so leave the flag off for a run whose figures matter.

## Calibrating

A production-shaped run must reproduce production's numbers before any other scenario is trusted. Match the shape
first: one server, the admin count production sees, a database seeded to production's size, and telemetry exported
(`--otel <collector url>`), since production exports it. Then compare RSS, CPU, heap, event loop delay p99 and op
duration against the same figures from production, steady state and peak apart.
