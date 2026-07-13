#!/usr/bin/env bash
# Runs once, after the container is created. Everything here is either something a volume mount broke
# (ownership) or something the image can't carry (the install, and the two artifacts that are
# gitignored because they're secret or generated).
set -euo pipefail

# docker creates named volumes owned by root; pnpm writes to both as `node`
sudo chown -R node:node node_modules "$NPM_CONFIG_STORE_DIR" 2>/dev/null || true

pnpm install --frozen-lockfile

# no-op when the browser baked into the image is the one @playwright/test wants, a download when the
# pinned version in .devcontainer/Dockerfile has drifted from package.json
pnpm exec playwright install chromium

missing=()
[[ -f .env ]] || missing+=(".env  -- secrets and local overrides; see src/server/env.ts for the schema. The container has no copy and cannot generate one.")
compgen -G "data/layers_v*.sqlite3.gz" > /dev/null \
	|| missing+=("data/layers_v*.sqlite3.gz  -- the layer db, a generated artifact. Run \`pnpm preprocess\` (needs network).")

if (( ${#missing[@]} )); then
	echo
	echo "Dev container is built, but the app won't boot until these exist in the workspace:"
	printf '  - %s\n' "${missing[@]}"
fi

cat <<'EOF'

Ready. Notes specific to running in here:
  - `pnpm client:dev --host`  the --host is needed: vite binds to localhost otherwise, which is not
                              reachable from your machine through the container's published ports.
  - `pnpm server:dev`         already binds 0.0.0.0 (HOST is set in devcontainer.json).
  - otel / the CI-parity test image run on the HOST, not in here (this container has no docker).
    `docker compose up -d otel` on the host and the app in here will export to it; grafana stays at
    localhost:3001 on the host.
EOF
