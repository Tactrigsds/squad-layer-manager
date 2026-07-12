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

## Logging

Logging and traces can be managed via the otel-ltm stack, see [docker-compose.yaml](docker-compose.yaml) for an example.

## Battlemetrics

TODO double-check some of this
BM_PAT should be set to a personal access token for Battlemetrics. It needs permissions for:

- player flags (add/remove player flags. don't need to add new flags)
- player notes(read & createe)
- rcon(read, unclear why we need this one tbqh but experimentally we do)
