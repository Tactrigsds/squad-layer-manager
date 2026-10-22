---
name: debug-ci-failure
description: Find the cause of a failed CI e2e or integration job. Use when a CI test job fails, especially one that passes locally.
---

# Debug a CI test failure

CI's runners are about half as fast as a development machine. A race that never shows locally can fail every CI run.

## Read the trace

A failed e2e job uploads a `playwright-results` artifact with a `trace.zip` per failure.

```sh
gh run download <run-id> -R Tactrigsds/squad-layer-manager -n playwright-results -D <dir>
cd <dir>/<test-dir> && mkdir tr && cd tr && unzip -oq ../trace.zip
```

- `test.trace` holds the test's actions as JSON lines (`type: before/after`, `startTime`, `title`, `params`). Only an
  `after` event with an `error` is a failure. A soft assertion's message (`expect.soft(x, 'msg')`) appears as an
  action title, so a title such as "could not be set up" is not a failure by itself.
- `1-trace.trace` holds `screencast-frame` events with a `timestamp` on the same clock as the actions, and a `file`
  under `screencast/`. Read the frames between two action timestamps to see what the page did in between.
- Console lines are recorded in the trace too. Temporary `console.debug` lines in the app can be read back from a
  CI run this way.
- In a journey spec, read the first failure. The tests after it fail because the worker restarted on a fresh app.
- CI browsers run in UTC. When a run crossed midnight UTC, check whether the failure involves anything grouped by
  day. To reproduce at any time of day, open the spec's context with a custom minute offset, such as
  `browser.newContext({ timezoneId: 'GMT-05:31' })`, computed to put local time just after midnight.

## Reproduce at CI speed

```sh
docker build --target test -t slm-test:local .
docker run --rm --cpus=1.5 -e CI=true slm-test:local pnpm exec playwright test --project=chromium <spec> --repeat-each=3
```

The image's default command is `pnpm run test:ci`, integration then e2e. `--repeat-each` is fine here for a spec
that is not a journey. Run a journey spec as several separate containers instead. Three containers in parallel get
through a batch faster.

To tell a regression from a pre-existing flake, build a baseline image from `main`: `git archive --format=tar -o <tar>
origin/main`, extract it to the scratchpad, and `docker build` from there.

To keep a failing integration run's database and app log:

```sh
docker run --rm --cpus=1.5 -e CI=true -e SLM_KEEP_TEST_TMP=1 -e TMPDIR=/keep -v <host dir>:/keep slm-test:local <command>
docker run --rm -v <host dir>:/d --entrypoint chown slm-test:local -R "$(id -u):$(id -g)" /d
```

The container writes root-owned files, so mount a fresh results directory for each run.

## Report

A failure the branch caused is a regression: fix it on the branch. Otherwise search the issues
(`gh issue list --search`) and file one with the failing test, the error and the trace if none covers it.
