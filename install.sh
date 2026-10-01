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
# Pick what to install with --channel or --version (see usage below, or pass --help). The choice is written to
# .env as SLM_IMAGE_TAG, which docker-compose.yaml reads for the image tag.
#
# The install runs in two steps. This script resolves the choice to a git ref (the release's v<version> tag, or
# main for latest), fetches install.sh from that ref and runs it with SLM_RESOLVED_REF and SLM_IMAGE_TAG set. That
# copy skips resolution and installs, so the files and how they are set up always match the release. Every
# version of this script must keep honouring those two variables.
#
# Installs into the current directory, or into one given as an argument. Fresh installs only: it writes nothing
# and downloads nothing if any of the files it installs, or ./data, is already there, rather than deciding on
# your behalf what of an existing deployment it may overwrite. Upgrading is `docker compose pull && docker
# compose up -d`.
set -euo pipefail

REPO="${SLM_REPO:-Tactrigsds/squad-layer-manager}"
DIR="${SLM_DIR:-.}"
RESOLVED_REF="${SLM_RESOLVED_REF:-}"
IMAGE_TAG="${SLM_IMAGE_TAG:-}"

say() { printf '%s\n' "$*"; }
err() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

need() { command -v "$1" > /dev/null 2>&1 || err "$1 is required but not installed"; }

usage() {
	cat <<-'EOF'
		usage: install.sh [--channel stable|latest | --version <release>] [dir]

		  --channel stable   follow the newest release (the default)
		  --channel latest   follow every change on main as soon as it passes tests
		  --version <v>      pin one release, e.g. 2026.9.4
	EOF
}

# anything curl can fetch a file from, including a file:// path. Only worth setting to install from somewhere
# that isn't github, or to try a change to this script before it's pushed.
base_for() { printf '%s' "${SLM_BASE:-https://raw.githubusercontent.com/${REPO}/$1}"; }

need curl
need docker
docker compose version > /dev/null 2>&1 || err "docker compose (v2) is required. 'docker compose version' failed"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

resolve_and_rerun() {
	local channel="${SLM_CHANNEL:-}" version="${SLM_VERSION:-}" dir=$DIR positional=""
	while (($#)); do
		case $1 in
			--channel)
				[[ $# -ge 2 ]] || err "--channel needs a value: stable or latest"
				channel=$2
				shift 2
				;;
			--channel=*)
				channel=${1#*=}
				shift
				;;
			--version)
				[[ $# -ge 2 ]] || err "--version needs a release, e.g. 2026.9.4"
				version=$2
				shift 2
				;;
			--version=*)
				version=${1#*=}
				shift
				;;
			-h | --help)
				usage
				exit 0
				;;
			-*) err "unknown option $1" ;;
			*)
				[[ -z $positional ]] || err "only one install directory can be given"
				positional=$1
				shift
				;;
		esac
	done
	[[ -z $positional ]] || dir=$positional

	[[ -z $channel || -z $version ]] || err "--channel and --version cannot be used together"
	[[ -n $version ]] || channel="${channel:-stable}"

	local release_pattern='^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$'
	[[ -z $version ]] || [[ $version =~ $release_pattern ]] \
		|| err "'$version' is not a release version. Releases are named year.month.number, e.g. 2026.9.4"

	# A release is tagged v<version> in git once CI has published its image, so the tags are what can be installed.
	local api="https://api.github.com/repos/${REPO}" ref tag tags newest
	case $channel in
		latest)
			tag=latest
			ref=main
			;;
		stable)
			tags=$(curl -fsSL "${api}/git/matching-refs/tags/v") || err "could not list releases from ${api}"
			newest=$(grep -o '"ref": *"refs/tags/v[^"]*"' <<< "$tags" | sed 's|.*refs/tags/v||; s|"$||' \
				| grep -E "$release_pattern" | sort -V | tail -n 1 || true)
			[[ -n $newest ]] || err "SLM has no releases yet, so there is no stable version to install. Install the latest build instead:

       curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --channel latest${positional:+ $positional}"
			tag=stable
			ref="v${newest}"
			;;
		'')
			curl -fsSL "${api}/git/ref/tags/v${version}" > /dev/null 2>&1 || err "release ${version} does not exist"
			tag=$version
			ref="v${version}"
			;;
		*) err "unknown channel '$channel': use stable or latest" ;;
	esac
	ref="${SLM_REF:-$ref}"

	local base
	base=$(base_for "$ref")
	curl -fsSL "${base}/install.sh" -o "$tmp/install.sh" || err "could not fetch ${base}/install.sh"
	SLM_RESOLVED_REF=$ref SLM_IMAGE_TAG=$tag bash "$tmp/install.sh" "$dir"
}

if [[ -z $RESOLVED_REF ]]; then
	resolve_and_rerun "$@"
	exit
fi
[[ -n $IMAGE_TAG ]] || err "SLM_RESOLVED_REF is set without SLM_IMAGE_TAG"
[[ $# -eq 0 ]] || DIR=$1
BASE=$(base_for "$RESOLVED_REF")

# what a deployment reads and the image does not carry. .env and .env.secrets are handled on their own below:
# they are the files here the operator owns.
FILES=(
	docker-compose.yaml
	.env.example
	.env.secrets.example
	edit-global-settings.sh
	restore.sh
	observability/README.md
	observability/otel-collector.yaml
	observability/grafana/provisioning/datasources/datasources.yaml
	observability/grafana/provisioning/dashboards/dashboards.yaml
	observability/grafana/dashboards/slm-overview.json
	observability/grafana/dashboards/slm-ops.json
	observability/grafana/dashboards/slm-logs.json
)

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

       If that is an SLM install, upgrade it with 'docker compose pull && docker compose up -d' instead. To
       switch channel or version, change SLM_IMAGE_TAG in its .env first."

# fetch everything before writing anything, so a download that dies halfway leaves the directory as it was
say "installing SLM ${IMAGE_TAG} from ${BASE}"
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

INSTALLING_URL="https://github.com/${REPO}/blob/${RESOLVED_REF}/docs/installing.md"

for file in .env.example .env.secrets.example; do
	printf '\n# Installing and configuring SLM: %s\n' "$INSTALLING_URL" >> "$DIR/$file"
done

cp "$DIR/.env.example" "$DIR/.env"
cat >> "$DIR/.env" <<EOF

# ---- Image -------------------------------------------------------------------------------------------------
# the SLM image docker-compose.yaml runs: stable, latest, or one release such as 2026.9.4. Change it, then run
# \`docker compose pull && docker compose up -d\`. See "Upgrading" in ${INSTALLING_URL}
SLM_IMAGE_TAG=${IMAGE_TAG}
EOF
say "  + .env (from .env.example, with SLM_IMAGE_TAG=${IMAGE_TAG})"

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
say "  1. create the discord app SLM logs users in through: ${INSTALLING_URL}"
say "  2. fill in the vars .env and .env.secrets leave uncommented (the commented ones are optional and show their defaults)"
if [[ $DIR == "." ]]; then
	say "  3. docker compose up -d"
else
	say "  3. cd $DIR && docker compose up -d"
fi
