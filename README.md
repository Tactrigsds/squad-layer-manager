# Squad Layer Manager

A Tool for managing the upcoming layers of a squad server.

## Deployment

Deployment is done via docker.

An image reflecting the `main` branch of the repository is available at `ghcr.io/tactrigsds/squad-layer-manager:latest`. the /app/data folder is expected to be bind-mounted for persistence

## Configuration

- `.env` contains sensitive secrets, and can be overridden by environment
  variables. Reference [src/server/env.ts](src/server/env.ts) for available
  options.

- The rest of the configuration is done via the app, though there is a script included `edit-global-settings.sh` if you need to manage it from outside the app

## Testing

Three suites, in increasing order of what they cost and what they cover:

- `pnpm test` — unit tests. No app, no server.
- `pnpm test:integration` — boots the real app against an emulated squad server (RCON + game log)
  and drives it as an admin would from in-game chat, asserting against the app's database and the
  commands the emulator received.
- `pnpm test:e2e` — the same, driven through the real client in a browser.

Both of the latter need the layer db (`data/layers_v*.sqlite3.gz`), which is a generated artifact:
run `pnpm preprocess` if you don't have one.

To run them the way CI does — inside the production image, driving the very server bundle that gets
deployed:

```sh
docker compose -f docker-compose.test.yaml run --rm --build tests
```

The image is the production one plus a browser, the test sources, and dev dependencies (see the
Dockerfile's `test` stage). The layer db is mounted rather than baked in, exactly as in production.

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

## Logging

Logging and traces can be managed via the otel-ltm stack, see [docker-compose.yaml](docker-compose.yaml) for an example.

## Battlemetrics

TODO double-check some of this
BM_PAT should be set to a personal access token for Battlemetrics. It needs permissions for:

- player flags (add/remove player flags. don't need to add new flags)
- player notes(read & createe)
- rcon(read, unclear why we need this one tbqh but experimentally we do)
