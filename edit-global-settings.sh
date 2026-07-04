#!/usr/bin/env bash
# Edit the global settings JSON (globalSettings table) in vim and write it back.
# Usage: ./edit-global-settings.sh [path-to-sqlite-db]   (default: $DB_PATH or ./data/main.sqlite3)
set -euo pipefail

DB="${1:-${DB_PATH:-./data/main.sqlite3}}"
[[ -f $DB ]] || { echo "error: db file not found: $DB" >&2; exit 1; }

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
raw="$tmpdir/raw.json"
edit="$tmpdir/settings.json"

sqlite3 "$DB" "SELECT settings FROM globalSettings WHERE id = 1" > "$raw"
[[ -s $raw ]] || { echo "error: no globalSettings row found" >&2; exit 1; }

# The column holds a superjson envelope ({"json": ..., "meta": ...}); edit only the .json part.
jq .json "$raw" > "$edit"

while true; do
	vim "$edit"

	if ! jq -e . "$edit" > /dev/null 2>&1; then
		read -rp "invalid JSON; re-edit? [Y/n] " ans
		[[ ${ans,,} == n* ]] && { echo "aborted, no changes written" >&2; exit 1; }
		continue
	fi

	if jq -e --slurpfile new "$edit" '.json == $new[0]' "$raw" > /dev/null; then
		echo "no changes"
		exit 0
	fi

	# Re-wrap in the superjson envelope, preserving any existing meta key.
	updated=$(jq -c --slurpfile new "$edit" '.json = $new[0]' "$raw")
	sqlite3 "$DB" "UPDATE globalSettings SET settings = '${updated//\'/\'\'}' WHERE id = 1"
	echo "saved to $DB"
	exit 0
done
