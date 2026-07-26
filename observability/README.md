# Observability stack

Three containers in `docker-compose.yaml`, configured from this directory. Nothing here is read by the
app itself.

| Service          | Image                                          | What it does                                        |
| ---------------- | ---------------------------------------------- | --------------------------------------------------- |
| `greptimedb`     | `greptime/greptimedb:v1.1.4`                   | stores metrics, logs and traces in one engine       |
| `otel-collector` | `otel/opentelemetry-collector-contrib:0.157.0` | receives OTLP from the app and routes it per signal |
| `grafana`        | `grafana/grafana:13.1.1`                       | serves the dashboards                               |

The app ships OTLP over HTTP to the collector on `:4318` (`OTLP_COLLECTOR_ENDPOINT`). Grafana is on
<http://localhost:3001>. GreptimeDB's HTTP and MySQL ports are published on loopback only, for ad-hoc
queries:

```sh
curl -s -X POST 'http://localhost:4000/v1/sql?db=public' --data-urlencode 'sql=select 1'
```

`docker compose up -d greptimedb otel-collector grafana` brings the stack up without the app, which is
what you want when pointing a dev instance at it.

## One engine, three query languages

GreptimeDB serves each signal through the protocol its tooling already speaks, so the datasources in
`grafana/provisioning/datasources/` are ordinary Prometheus, Jaeger and MySQL datasources rather than
anything GreptimeDB-specific. No plugin is installed.

| Datasource     | uid            | Type       | Endpoint                               | Reads   |
| -------------- | -------------- | ---------- | -------------------------------------- | ------- |
| Prometheus     | `prometheus`   | prometheus | `/v1/prometheus`                       | metrics |
| Traces         | `tempo`        | jaeger     | `/v1/jaeger`                           | traces  |
| GreptimeDB SQL | `greptime-sql` | mysql      | MySQL protocol on `:4002`, db `public` | logs    |

The `prometheus` and `tempo` uids are historical and deliberately kept: dashboards reference
datasources by uid, and renaming them to match the engine would mean editing every panel for nothing.

`timeInterval` on the Prometheus datasource must stay at `60s`, matching the app's
`PeriodicExportingMetricReader` interval. It feeds `$__rate_interval`, and at a shorter value the
window holds fewer than two samples, so every `rate()` panel renders No data while the gauges keep
working. This fails silently, which is what makes it worth stating.

GreptimeDB's PromQL is close to complete but not identical, and where it differs it returns an empty
vector rather than an error, so a panel written against it just goes blank. The one case hit so far:
**`topk()` over `histogram_quantile()`** yields nothing, though `topk()` over a gauge or over
`sum(rate(...))` is fine. Slowest ops (p95) ranks with a `sortBy` + `limit` transformation instead,
which is why its query has no `topk`. If a panel you have just written is empty against data you can
see in SQL, take the expression apart a layer at a time against `/api/v1/query` before assuming the
data is missing.

## Dashboards

- **SLM / Overview** (`slm-overview`) is the domain view: rcon liveness, layer queue depth, votes in
  progress, pending teamswaps, BattleMetrics rate-limit headroom, and a warn/error log table. It is
  backed by the observable gauges in `src/systems/metrics.server.ts`.
- **SLM / Ops (RED)** (`slm-ops`) is rate/errors/duration for every `C.spanOp` in the app, plus Node
  runtime health (event loop, heap, GC). It is backed by the `slm.op.duration` histogram recorded in
  `spanOp`'s `finally` block (`src/server/instrumentation.ts`), so **a new `spanOp` appears here with
  no extra wiring**.
- **SLM / Logs** (`slm-logs`) is the log view: volume by severity, and a filterable table with a link
  from each `trace_id` to its trace.

## Logs are SQL

`otel_logs` is a table, so the log panels are `SELECT`s rather than LogQL. Three things about writing
them:

`trace_id`, `span_id`, `severity_text`, `severity_number` and `body` are real columns. Everything else
the app attaches is JSON: per-record fields in `log_attributes`, service identity in
`resource_attributes`. Reading a key out of either needs the quoted-path form, because the keys
themselves contain dots:

```sql
json_get_string(log_attributes, '$."slm.module.name"')
```

Filter severity on `severity_number`, not `severity_text`. The numbers are ordered (DEBUG 5, INFO 9,
WARN 13, ERROR 17, FATAL 21), so `severity_number >= 13` is the whole warn-and-above set including
levels nothing currently emits.

Do not set `x-greptime-log-extract-keys` for `trace_id` or `span_id` in `otel-collector.yaml`. They are
already columns in the OTLP log schema, and promoting them makes every export fail with a 400.

## Retention

Traces are kept **3 days**, logs **14 days**, metrics **90 days**.

Traces are the highest-volume signal (one span per `C.spanOp`, plus auto-instrumented http/rcon/dns
spans underneath each), so they get the shortest window. That's affordable because the RED metrics
derived from them outlive them: you can still ask "when did `dispatchOp` start getting slow" a month
later, you just can't open an individual trace from back then. Logs outlive traces because they are
what you go back to when someone asks what happened last week; the trace is gone by then, but the log
line that carried its `trace_id` is not.

It is set in two places, because the three signals do not create their tables the same way.

Logs and traces each get one table, created by their first export, so their retention rides in as an
`x-greptime-hints` header on the exporters in `otel-collector.yaml`. Metrics do not: every metric name
becomes a logical table over one physical table that the metric engine creates, and no ingest hint
reaches it. Their window is the **database** default, set by the one-shot `greptime-init` service in
`docker-compose.yaml`, which the collector waits on so it is in place before the first export lands.

**Either way the value is read once, when the table is created, and never again.** Editing a `ttl` in
either file therefore changes nothing on a volume that already has data. To change retention on a
running install, do it in SQL as well, so a rebuilt volume comes back the same:

```sql
ALTER TABLE otel_logs SET 'ttl' = '30d';           -- or opentelemetry_traces
ALTER TABLE greptime_physical_table SET 'ttl' = '30d';  -- every metric at once
```

## Cross-linking

A log line links to its trace: `trace_id` is a column on `otel_logs`, and each log table panel puts a
data link on that column pointing at the `tempo` datasource. This works because `server/logger.ts`
stamps `trace_id` and `span_id` onto every record (see `LOG.mapSpanAttrs`), so the message text does
not need to carry the id, and it doesn't.

The reverse direction is not wired up. Grafana's trace-to-logs setting only accepts log-shaped
datasources (Loki, Elasticsearch, Splunk), and the logs here are behind a SQL datasource. From a span,
copy the trace id into SLM / Logs. A span does still link to its op's RED metrics, via `tracesToMetrics`
on the Traces datasource.

## Cardinality

Metrics become one logical table per metric name over a shared physical table, with each attribute a
TAG column, so cardinality behaves the way it does in Prometheus: the cost is in the number of distinct
tag combinations. `slm_squad_server_id` is bounded by the number of servers; keep anything unbounded
(player ids, layer ids, trace ids) off metric attributes.

Logs have no equivalent concern. `slm_module_name` and friends sit in the `log_attributes` JSON column
rather than in an index, so adding one costs nothing at write time and is queryable with
`json_get_string`.

## Changing histogram bucket boundaries

If you change `explicitBucketBoundaries` on `slm.op.duration`, the old series stay until they age out,
and `sum by (le)` across both boundary sets produces non-monotonic buckets and therefore garbage
quantiles. It is transient, but if a quantile panel looks impossible right after such a change, this is
why. Filter to a single `service_instance_id` to confirm.

## What the otel-lgtm stack had and this one does not

The stack this replaced was the `grafana/otel-lgtm` image (Grafana + Prometheus + Loki + Tempo +
Pyroscope in one process tree). Three things did not survive the move:

**Continuous profiling.** Pyroscope was bundled in that image and GreptimeDB has no equivalent, so the
agent and the `PYROSCOPE_*` env vars were removed rather than left pointing at nothing. Reinstating it
means running `grafana/pyroscope` as its own service.

**The image's generated RED dashboards.** Those came from Tempo's `metrics_generator`, which derived
rate/error/duration from span kind and status and so covered the auto-instrumented http/rcon spans.
SLM / Ops is unaffected: it reads a histogram the app records itself.

**Exemplars.** GreptimeDB's OTLP metric ingest has no exemplar column, so a spike in a RED panel can no
longer be clicked through to a trace that produced it.
