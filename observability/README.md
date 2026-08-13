# Observability stack

Five containers in `docker-compose.yaml`, configured from this directory. Nothing here is read by the
app itself.

| Service            | Image                                          | What it does                                        |
| ------------------ | ---------------------------------------------- | --------------------------------------------------- |
| `victoria-metrics` | `victoriametrics/victoria-metrics:v1.111.0`    | metrics, served over the Prometheus API             |
| `victoria-logs`    | `victoriametrics/victoria-logs:v1.52.0`        | logs, queried with LogsQL                           |
| `victoria-traces`  | `victoriametrics/victoria-traces:v0.5.0`       | traces, served over the Jaeger query API            |
| `otel-collector`   | `otel/opentelemetry-collector-contrib:0.157.0` | receives OTLP from the app and routes it per signal |
| `grafana`          | `grafana/grafana:13.1.1`                       | serves the dashboards                               |

The app ships OTLP over HTTP to the collector on `:4318` (`OTLP_COLLECTOR_ENDPOINT`). Grafana is on
<http://localhost:3001>. Each store's HTTP port is published on loopback for ad-hoc queries:

```sh
curl -s 'http://localhost:9428/select/logsql/query' --data-urlencode 'query=severity_text:ERROR' --data-urlencode 'limit=10'
curl -s 'http://localhost:8428/api/v1/query' --data-urlencode 'query=slm_rcon_connected'
```

`docker compose up -d victoria-metrics victoria-logs victoria-traces otel-collector grafana` brings the
stack up without the app, which is what you want when pointing a dev instance at it.

## One store per signal, and why that is not three problems

Each store is a single zero-config binary with no external dependencies, and each speaks the query API
its tooling already expects. That is what keeps the Grafana side boring: **two of the three datasources
are Grafana's own**, because VictoriaMetrics serves the Prometheus API and VictoriaTraces the Jaeger
one. Only logs need a plugin.

| Datasource   | uid            | Type                              | Reads   |
| ------------ | -------------- | --------------------------------- | ------- |
| Prometheus   | `prometheus`   | prometheus (built in)             | metrics |
| Traces       | `tempo`        | jaeger (built in)                 | traces  |
| VictoriaLogs | `victorialogs` | `victoriametrics-logs-datasource` | logs    |

The `prometheus` and `tempo` uids are historical and deliberately kept: dashboards reference
datasources by uid, and renaming them to match what is behind them would mean editing every panel for
nothing.

The logs plugin is in the Grafana catalog and signed by Grafana Labs, so it installs with the single
`GF_INSTALL_PLUGINS` line in `docker-compose.yaml`. No unsigned-plugin flag, no baked image.

That line is unpinned, so the plugin tracks its latest release while `victoria-logs` is pinned, and the
two have to be bumped together: the plugin builds LogsQL out of whatever the current server understands,
so an old server rejects it as a parse error rather than degrading. The level pills in Explore are what
usually catches this first, since they compile to a filter (`contains_common_case`, added server-side in
v1.35.0) that a server older than the plugin has never heard of.

## Two flags that are load-bearing

**`-memory.allowedBytes` on each store.** Left alone they size their caches from the _host's_ RAM, so on
a large machine they grow to fill it and the stack looks far heavier than it is. The flag caps the
caches, not total RSS: measured against a dev instance the three stores settle at about **435MB**
together (VictoriaMetrics ~320, VictoriaTraces ~90, VictoriaLogs ~25), against 653MB for the single
GreptimeDB process this replaced. Raise the caps on a busy install; they are a ceiling on caching, not a
reservation, and lowering them trades query speed for footprint rather than capping ingest.

**`-opentelemetry.usePrometheusNaming` on VictoriaMetrics.** Without it, OTLP metric names keep their
dots (`slm.op.duration`) and every PromQL expression in the dashboards silently matches nothing.

`timeInterval` on the Prometheus datasource must also stay at `60s`, matching the app's
`PeriodicExportingMetricReader` interval. It feeds `$__rate_interval`, and at a shorter value the window
holds fewer than two samples, so every `rate()` panel renders No data while the gauges keep working.

## Dashboards

- **SLM / Overview** (`slm-overview`) is the domain view: rcon liveness, layer queue depth, votes in
  progress, pending teamswaps, BattleMetrics rate-limit headroom, and a warn/error log panel. It is
  backed by the observable gauges in `src/systems/metrics.server.ts`.
- **SLM / Ops (RED)** (`slm-ops`) is rate/errors/duration for every `C.spanOp` in the app, plus Node
  runtime health (event loop, heap, GC). It is backed by the `slm.op.duration` histogram recorded in
  `spanOp`'s `finally` block (`src/server/instrumentation.ts`), so **a new `spanOp` appears here with
  no extra wiring**.
- **SLM / Switch requests** (`slm-switch-requests`) is the `/switch` queue: depth by direction, request
  outcomes, which rule drained each fulfilment, and how long players waited. Backed by the counters and
  wait histogram in `src/systems/switch-requests.server.ts`.
- **SLM / Logs** (`slm-logs`) is the log view: volume by severity, and a log panel filtered by severity
  and module.

## Logs are LogsQL

Every attribute the app attaches is a first-class field, so filtering is direct rather than a JSON path
dig. Fields whose names contain dots need quoting:

```logsql
severity_text:in(WARN,ERROR,FATAL) "slm.module.name":squad-server
```

The level field is `severity_text` (uppercase, alongside a numeric `severity_number`), which is what
OTLP's severityText lands in as of VictoriaLogs v1.50.0; before that it was a custom `severity`. The old
name still resolves against records ingested by an older server, so during the retention window after an
upgrade a query for one name reads as a gap rather than an error.

Two things worth knowing when editing the log panels:

The **Module** variable's values are whole filter terms (`"slm.module.name":db`), not bare names, which
is what lets its All case be a bare `*`. A `*` matches every record; `"slm.module.name":*` would quietly
drop the handful of boot lines written before the logger attaches a module.

**`VL-Stream-Fields` on the logs exporter is not optional.** VictoriaLogs derives the stream key from
resource attributes, and the app's include a multi-kilobyte `process.command_args`. Without pinning the
stream fields to `service.name,service.instance.id`, every process restart creates a new stream.

## What a log record carries, and what Explore shows

Which fields Explore renders inline on each line is **Grafana UI state**, held per user in the browser
and not settable from a datasource. There is no `defaultFields` option and provisioning cannot seed one.
What the config can do is make the field list worth reading in the first place, which is what these two
settings are for.

`resource/trim-log-fields` in `otel-collector.yaml` drops the resource attributes that are the same
static JSON on every line. Measured before it: 31 fields and 2307 bytes per record, of which **80% was
`process.*`, `host.*` and `telemetry.sdk.*`**, `process.command_args` alone being ~1.3KB. After: 18
fields, 540 bytes. The list is deliberately shorter than the metrics one, since a log field is cheap
where a label is not: `host.name`, `process.pid` and `process.runtime.version` stay because they are
worth having in a bug report.

The **`otelPreset`** block on the VictoriaLogs datasource generates the `trace_id` derived field and the
log level rules that colour Explore by severity. Its `detection` block is not optional when provisioning:
auto-detection only runs in the settings UI, so `enabled: true` on its own silently gets you neither.

## Retention

Traces are kept **3 days**, logs **14 days**, metrics **90 days**, each a `-retentionPeriod` flag on its
own store. Changing one is an edit and a restart, with no migration and nothing to apply after the fact.

Traces and logs carry over the windows the otel-lgtm stack used (Tempo `block_retention: 72h`, Loki
`retention_period: 336h`). **Metrics are the one deliberate change.** Nothing there ever configured
Prometheus, so metrics ran on its built-in 15 day default, which quietly made the paragraph below untrue.
90 days is the value that keeps the promise.

Traces are also head-sampled. `OTEL_TRACE_SAMPLE_RATIO` unset means everything outside production and a
quarter of root traces in it; set it to 1 there when you need full fidelity for a while. The ratio is
worth having because most of the volume is not interesting: of ~4M spans over 14 days, the rcon execute,
event-insert and roster-poll paths alone were about 40%, and they look the same every time. Sampling is
`ParentBased`, so a trace is kept or dropped whole rather than arriving with holes in it.

Traces are the highest-volume signal (one span per `C.spanOp`, plus auto-instrumented http/rcon/dns
spans underneath each), so they get the shortest window. That's affordable because the RED metrics
derived from them outlive them: you can still ask "when did `dispatchOp` start getting slow" a month
later, you just can't open an individual trace from back then. Logs outlive traces because they are what
you go back to when someone asks what happened last week; the trace is gone by then, but the log line
that carried its `trace_id` is not.

## Cross-linking

Both directions work, and both are configured in `grafana/provisioning/datasources/datasources.yaml`.

A **log line links to its trace** through the `trace_id` derived field the `otelPreset` generates. This
works because `server/logger.ts` stamps `trace_id` and `span_id` onto every record (see
`LOG.mapSpanAttrs`), and VictoriaLogs stores them as real fields, so the link targets a field rather than
regexing the body. The message text does not need to carry the id, and it doesn't.

A **span links back to its logs** through `tracesToLogsV2` on the Traces datasource, which runs
`trace_id:"<id>"` against VictoriaLogs. A span also links to its op's RED metrics via `tracesToMetrics`.

## Cardinality

Metrics behave the way they do in Prometheus: the cost is the number of distinct label combinations.
`slm_squad_server_id` is bounded by the number of servers; keep anything unbounded (player ids, layer
ids, trace ids) off metric attributes.

The bigger trap is the one the `resource/trim-metric-labels` processor exists for. VictoriaMetrics
promotes **every** OTLP resource attribute to a label, and the SDK sends far more than a dashboard ever
groups by: measured before the trim, each series carried 25 labels including a 1.3KB
`process.command_args` JSON blob, and `process.pid` changed on every restart so each restart orphaned
the entire series set. After the trim it is 10 labels and nothing restart-scoped. If you add a resource
attribute and it does not show up in PromQL, that processor is why.

Logs are different, and the thing to watch is the **stream** rather than the field count. Fields are
cheap and unindexed-until-queried, so adding one costs nothing. Stream fields are the expensive axis,
which is why they are pinned to two (see `VL-Stream-Fields` above).

## Changing histogram bucket boundaries

If you change `explicitBucketBoundaries` on `slm.op.duration`, the old series stay until they age out,
and `sum by (le)` across both boundary sets produces non-monotonic buckets and therefore garbage
quantiles. It is transient, but if a quantile panel looks impossible right after such a change, this is
why. Filter to a single `service_instance_id` to confirm.
