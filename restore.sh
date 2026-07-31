#!/usr/bin/env bash
# Restore the database from a backup.
#
#   ./restore.sh --list                  what backups there are (with the build each belongs to)
#   ./restore.sh --inspect --latest      which build a backup belongs to (which image to pin), without restoring it
#   ./restore.sh --pre-migration         the snapshot taken before the last migration (undo a bad upgrade)
#   ./restore.sh --latest                the newest backup of any kind
#   ./restore.sh --commit-sha <sha>      the newest backup taken by a given build (a git sha or commit-<sha> tag)
#   ./restore.sh --from <file>           a specific one, e.g. one pulled back off the sftp target into ./data/backups
#
# Stop the app first: it would otherwise go on writing to the database being replaced and lose those writes, without
# an error anywhere. This refuses to run while the app is up, and does not start it again afterwards -- point
# docker-compose.yaml at the image the restored database belongs to (`--inspect` names it) before you do. The
# database being replaced is kept, renamed aside, because a restore is otherwise the one operation with no undo.
set -euo pipefail

cd "$(dirname "$0")"

command -v docker > /dev/null 2>&1 || { echo "error: docker is required" >&2; exit 1; }
docker compose version > /dev/null 2>&1 || { echo "error: docker compose (v2) is required" >&2; exit 1; }

# --list and --inspect replace nothing, so a running app is no obstacle to them
replaces_the_db=1
for arg in "$@"; do
	if [[ $arg == --list || $arg == --inspect ]]; then replaces_the_db=""; fi
done

# The restore refuses on its own if anything at all holds the database open. This is that refusal early and with the
# docker commands in it, which the restore itself cannot name because it also runs outside compose.
if [[ -n $replaces_the_db && -n "$(docker compose ps --status running --quiet app 2> /dev/null)" ]]; then
	echo "error: the app is running. Restoring under it would lose every write it makes from here on." >&2
	echo >&2
	echo "  docker compose stop app" >&2
	echo "  $0 $*" >&2
	echo "  docker compose up -d app     # once docker-compose.yaml points at the image the restored database belongs to" >&2
	exit 1
fi

exec docker compose run --rm app pnpm db:restore:prod "$@"
