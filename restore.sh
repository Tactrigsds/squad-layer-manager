#!/usr/bin/env bash
# Restore the database from a backup, stopping the app around it.
#
#   ./restore.sh --list                  what backups there are
#   ./restore.sh --pre-migration         the snapshot taken before the last migration (undo a bad upgrade)
#   ./restore.sh --latest                the newest backup of any kind
#   ./restore.sh --from <file>           a specific one, e.g. one pulled back off the sftp target into ./data/backups
#
# The app must not be running: it would go on writing to the database being replaced and lose those writes, without
# an error anywhere. This stops it first and starts it again afterwards. The database being replaced is kept, renamed
# aside, because a restore is otherwise the one operation with no undo.
set -euo pipefail

cd "$(dirname "$0")"

command -v docker > /dev/null 2>&1 || { echo "error: docker is required" >&2; exit 1; }
docker compose version > /dev/null 2>&1 || { echo "error: docker compose (v2) is required" >&2; exit 1; }

# --list reads the backups directory and touches nothing, so it has no business stopping anybody's app
for arg in "$@"; do
	if [[ $arg == --list ]]; then
		exec docker compose run --rm app pnpm db:restore:prod "$@"
	fi
done

was_running=""
if [[ -n "$(docker compose ps --status running --quiet app 2>/dev/null)" ]]; then
	was_running=1
	echo "stopping the app..."
	docker compose stop app
fi

# deliberately not `set -e`'d into oblivion: on failure we want to say what state things are in, and a failed restore
# must not silently take the app back up on a database nobody has looked at.
status=0
docker compose run --rm app pnpm db:restore:prod "$@" || status=$?

if [[ $status -ne 0 ]]; then
	echo >&2
	echo "restore failed (exit $status). The app is left stopped: check the message above before starting it." >&2
	[[ -n $was_running ]] && echo "Start it with 'docker compose up -d app' once you are happy." >&2
	exit $status
fi

if [[ -n $was_running ]]; then
	echo "starting the app..."
	docker compose up -d app
fi
