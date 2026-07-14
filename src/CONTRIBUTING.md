TODO add more stuff here

## Testing

Three suites, in increasing order of what they cost and what they cover:

- `pnpm test` — unit tests. No app, no server.
- `pnpm test:integration` — boots the real app against an emulated squad server (RCON + game log)
  and drives it as an admin would from in-game chat, asserting against the app's database and the
  commands the emulator received.
- `pnpm test:e2e` — the same, driven through the real client in a browser.

Both of the latter need generated artifacts that a fresh checkout does not have:

- `assets/layer-engine.wasm` — the query engine, built from `layer-engine/` with `pnpm build:engine`
  (needs a rust toolchain).
- `data/layers_v*.bin.gz` and `data/layer-data.json` — the layer table the engine reads, and the
  components that give its encoded values meaning. Both come out of one `pnpm preprocess` run and are
  published together; neither is useful without the other, so keep them in step.

To run them the way CI does — inside the production image, driving the very server bundle that gets
deployed:

```sh
docker compose -f docker-compose.test.yaml run --rm --build tests
```

The image is the production one plus a browser, the test sources, and dev dependencies (see the
Dockerfile's `test` stage). The layer table is mounted rather than baked in, exactly as in production.

### Debugging a failing test with telemetry

A failing integration test is usually easier to read as a trace than as a log tail. The app under test
can export to the otel stack, labelled with the test that produced it:

```sh
docker compose up -d otel          # the collector + grafana, from docker-compose.yaml
SLM_TEST_OTEL=1 pnpm test:integration
```

Every span, log and metric that app emits then carries:

| attribute            | what it is                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `service.name`       | `slm-test` (rather than `squad-layer-manager`, so test telemetry never mixes with a real deployment's) |
| `slm.test.name`      | the test, e.g. `admin actions from the teams panel > disbanding a squad`                               |
| `slm.test.file`      | the spec file it came from                                                                             |
| `slm.test.run_id`    | one id for the whole run, so you can scope to it and then narrow to one test                           |
| `slm.test.server_id` | the emulated server                                                                                    |

Grafana (http://localhost:3001) — traces in Tempo:

```
{ resource.slm.test.name = "admin actions from the teams panel > disbanding a squad" }
```

and the app's logs for the same test in Loki:

```
{service_name="slm-test"} | slm_test_name = "admin actions from the teams panel > disbanding a squad"
```

A test that times out prints its `slm.test.run_id` and `slm.test.name` in the failure, so there's
something to paste. Telemetry is off unless `SLM_TEST_OTEL=1`: exporting costs time, and a test run
shouldn't need a collector to pass.
