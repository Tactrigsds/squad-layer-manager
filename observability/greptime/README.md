# GreptimeDB observability stack (evaluation)

An alternative to the `grafana/otel-lgtm` container in `docker-compose.yaml`, kept alongside it rather
than replacing it so the two can be compared. GreptimeDB stores metrics, logs and traces in one engine
instead of Prometheus + Loki + Tempo.

```sh
docker compose -f docker-compose.greptime.yaml up -d
OTLP_COLLECTOR_ENDPOINT=http://localhost:4418 pnpm dev
```

Grafana is on <http://localhost:3301>. Ports are deliberately outside the `31N0-31N4` dev slot ranges
and away from the main checkout's 3000/3001.

| Port | What                                              |
| ---- | ------------------------------------------------- |
| 3301 | Grafana                                           |
| 4400 | GreptimeDB HTTP (SQL, PromQL, Jaeger query, OTLP) |
| 4402 | GreptimeDB MySQL protocol                         |
| 4417 | OTLP gRPC                                         |
| 4418 | OTLP HTTP                                         |

Unlike `./observability`, nothing here is a verbatim copy of a file the image ships, so there is no
mount contract to keep in step with the image tag.

## What carries over

The SLM dashboards are mounted unmodified. They reference their datasources by uid, and 28 of their 34
datasource references are prometheus-typed, so serving GreptimeDB's PromQL endpoint under
`uid: prometheus` carries them over with no edits.

Verified rendering against a live dev instance: 23 of the 25 SLM / Overview queries return series,
the two exceptions being the LogQL panel below and RCON failures, which is empty only because no
failures had occurred. Also verified: the `slm_op_duration_seconds` histogram behind SLM / Ops, the
Node runtime metrics (`nodejs_*`, `v8js_*`), trace ingest and the Jaeger query API.

Two things had to be right before any of that rendered, and both fail silently:

`timeInterval` on the Prometheus datasource must be `60s`, matching the app's
`PeriodicExportingMetricReader` interval, exactly as in `../grafana`. It feeds `$__rate_interval`, and
at a shorter value the window holds fewer than two samples, so every `rate()` panel renders No data
while the gauges keep working.

The `loki` and `pyroscope` uids must resolve to something even though GreptimeDB serves neither.
Grafana fails the whole dashboard build on an unresolvable datasource uid, which blanks all 28 working
panels along with the broken ones. The placeholders in `datasources.yaml` point at `.invalid` hosts so
their panels error individually instead.

## What does not

Three panels and two dashboard variables have no GreptimeDB equivalent:

| Dashboard      | Panel                                | Why                                                                  |
| -------------- | ------------------------------------ | -------------------------------------------------------------------- |
| SLM / Ops      | Flame graph, Profile total over time | no profiling store; Pyroscope is bundled in the otel-lgtm image only |
| SLM / Ops      | Op failures                          | LogQL; needs rewriting as SQL                                        |
| SLM / Overview | Warnings and errors                  | LogQL; needs rewriting as SQL                                        |

The two log panels are rewritable against the `otel_logs` table through the `GreptimeDB SQL`
datasource. Profiling is not replaceable within GreptimeDB and would mean keeping a separate Pyroscope
container.

The image's own RED dashboards are also absent. Tempo's `metrics_generator` derives them from span kind
and status, and GreptimeDB has no equivalent, so the auto-instrumented http/rcon spans lose their
generated rate/error/duration view. The app's own `spanOp` RED coverage in SLM / Ops is unaffected,
since that comes from a histogram the app records itself.

## Logs

`otel_logs` carries `trace_id` and `span_id` as real columns rather than as structured metadata, so
log-to-trace cross-linking is available, but the datasource wiring for it is not set up here.

Do not set `x-greptime-log-extract-keys` for `trace_id` or `span_id`. They are already columns in the
OTLP log schema and promoting them makes every export fail with a 400.

Service identity lives in the `resource_attributes` JSON column rather than in an indexed label, which
is the main query-shape difference from Loki.

## Retention

Not configured. The otel-lgtm stack keeps traces 3 days and logs 2 weeks via the Tempo and Loki
configs in `../`; the equivalent here is a TTL on each table, which has not been set, so this stack
currently grows without bound.
