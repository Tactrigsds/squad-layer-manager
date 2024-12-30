# Squad Layer Manager

A Tool for managing the upcoming layers of a squad server.

## Configuration

Configuration is done via two files: `.env` and `config.json`.

- `.env` contains sensitive secrets, and can be overridden by environment
  variables. Reference [src/server/env.ts](src/server/env.ts) for available
  options.
- `config.json` contains various configuration options for the server. Reference
  [src/server/config.ts](src/server/config.ts) for available options.
  `config.json` has a generated schema file at `assets/config-schema.json`. This
  file can be used to validate the configuration file in an editor like VSCode
  by including a reference to the schema definition:

```json5
{
    "$schema": "assets/config-schema.json",
    // ... rest of configuration
}
```

The application must be fully restarted to before changes to the configuration
take effect.

## Deployment

Deployment is generally done through docker. See example script at
[src/scripts/docker-run.sh](src/scripts/docker-run.sh).

## Logging

Logging is done in jsonl format and output from stdout and stderr. When running
in prod mode via `pnpm run server:prod`, `PROD_LOG_PATH` specifies the path to
the log file. When running via the docker image, the logfile is hardcoded to
`/logs/app.jsonl` and is automatically rotated via logrotate. configuration can
be found in [./docker/logrotate.conf](./docker/logrotate.conf).
