#!/usr/bin/env bash
# Lays down the files an SLM deployment is made of and leaves the directory ready for `docker compose up -d`.
# Everything else (the app, its dependencies, the layer data) lives in the image.
#
#   mkdir squad-layer-manager && cd squad-layer-manager
#   curl -fsSL https://raw.githubusercontent.com/Tactrigsds/squad-layer-manager/main/install.sh | bash
#
# Or, to install somewhere other than the current directory:
#
#   curl -fsSL https://raw.githubusercontent.com/Tactrigsds/squad-layer-manager/main/install.sh | bash -s -- /opt/slm
#
# Installs into the current directory, or into one given as an argument. Fresh installs only: it writes nothing
# and downloads nothing if any of the files it installs, or ./data, is already there, rather than deciding on
# your behalf what of an existing deployment it may overwrite. Upgrading is `docker compose pull && docker
# compose up -d`; nothing installed here is version-specific.
set -euo pipefail

REPO="${SLM_REPO:-Tactrigsds/squad-layer-manager}"
REF="${SLM_REF:-main}"
DIR="${1:-${SLM_DIR:-.}}"

# anything curl can fetch a file from, including a file:// path. Only worth setting to install from somewhere
# that isn't github, or to try a change to this script before it's pushed.
BASE="${SLM_BASE:-https://raw.githubusercontent.com/${REPO}/${REF}}"

# what a deployment reads and the image does not carry. .env and .env.secrets are handled on their own below:
# they are the files here the operator owns.
FILES=(
	docker-compose.yaml
	.env.example
	.env.secrets.example
	edit-global-settings.sh
	restore.sh
	observability/README.md
	observability/loki-config.yaml
	observability/tempo-config.yaml
	observability/grafana/provisioning/datasources/datasources.yaml
	observability/grafana/provisioning/dashboards/dashboards.yaml
	observability/grafana/dashboards/slm-overview.json
	observability/grafana/dashboards/slm-ops.json
)

say() { printf '%s\n' "$*"; }
err() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

need() { command -v "$1" > /dev/null 2>&1 || err "$1 is required but not installed"; }

need curl
need docker
docker compose version > /dev/null 2>&1 || err "docker compose (v2) is required. 'docker compose version' failed"

[[ ! -e $DIR || -d $DIR ]] || err "$DIR exists and is not a directory"

# whatever else is in the directory is the operator's business, but nothing this installs may already be there.
# data/ counts: a database in it means this is an install, not an empty directory that happens to share a name.
conflicts=""
for file in "${FILES[@]}" .env .env.secrets data; do
	if [[ -e "$DIR/$file" ]]; then
		conflicts="${conflicts}
         $file"
	fi
done
[[ -z $conflicts ]] || err "refusing to install over what is already in ${DIR}:
${conflicts}

       If that is an SLM install, upgrade it with 'docker compose pull && docker compose up -d' instead. Nothing
       this script installs is version-specific, so an upgrade has no use for it."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# fetch everything before writing anything, so a download that dies halfway leaves the directory as it was
say "fetching from ${BASE}"
for file in "${FILES[@]}"; do
	mkdir -p "$tmp/$(dirname "$file")"
	curl -fsSL "${BASE}/${file}" -o "$tmp/$file" || err "could not fetch ${BASE}/${file}"
done

mkdir -p "$DIR"
# the db and anything you drop in to override the image's layer artifacts. Created here so it isn't docker
# that creates it, since docker would make it root-owned.
mkdir -p "$DIR/data"

for file in "${FILES[@]}"; do
	dest="$DIR/$file"
	mkdir -p "$(dirname "$dest")"
	cp "$tmp/$file" "$dest"
	say "  + $file"
done

chmod +x "$DIR/edit-global-settings.sh" "$DIR/restore.sh"

cp "$DIR/.env.example" "$DIR/.env"
say "  + .env (from .env.example)"

# the credentials, which docker-compose mounts as a file. Owner-readable only: it is the one file in the
# install worth treating like a private key.
cp "$DIR/.env.secrets.example" "$DIR/.env.secrets"
chmod 600 "$DIR/.env.secrets"
say "  + .env.secrets (from .env.secrets.example)"

# provision a strong key for encrypting sensitive settings at rest, so the deployment boots without a manual
# key-generation step. Regenerating it later means re-entering connection secrets on the settings page.
if command -v openssl >/dev/null 2>&1; then
	enc_key="$(openssl rand -base64 32)"
else
	enc_key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
fi
enc_tmp="$(mktemp)"
# written back through the existing file rather than moved over it, so the 600 above survives
sed "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=${enc_key}|" "$DIR/.env.secrets" > "$enc_tmp" && cat "$enc_tmp" > "$DIR/.env.secrets" && rm -f "$enc_tmp"
say "  + generated SETTINGS_ENCRYPTION_KEY into .env.secrets"

say ""
say "installed to $(cd "$DIR" && pwd)"
say ""
say "next:"
say "  1. create the discord app SLM logs users in through: https://github.com/${REPO}#discord-app"
say "  2. fill in the vars .env and .env.secrets leave uncommented (the commented ones are optional and show their defaults)"
if [[ $DIR == "." ]]; then
	say "  3. docker compose up -d"
else
	say "  3. cd $DIR && docker compose up -d"
fi
