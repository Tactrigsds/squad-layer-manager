---
audience: operators
kind: added
---

`install.sh` installs the newest release by default. Pass `--channel latest` to follow every change, or
`--version 2026.9.4` to pin one release.

The choice is saved as `SLM_IMAGE_TAG` in `.env`, and `docker-compose.yaml` reads the image tag from it. To switch
channel or pin a build, change `SLM_IMAGE_TAG` and run `docker compose pull && docker compose up -d`. The installer
also fetches the files for the release it installs, so `docker-compose.yaml` and `.env.example` match the image.

An existing install keeps following `:latest` and needs no change. To set its tag from `.env`, change the `image:`
line of the `app` service in `docker-compose.yaml` to `ghcr.io/tactrigsds/squad-layer-manager:${SLM_IMAGE_TAG:-latest}`.
