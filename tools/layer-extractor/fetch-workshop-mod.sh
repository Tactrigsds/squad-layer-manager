#!/usr/bin/env sh
# Fetches just enough of a Squad workshop mod to extract its layer list, without a full download.
#
# Two ideas stack up. Mods ship three platform cooks of every container and the dedicated-server ones
# (-LinuxServer) strip all art while keeping every gameplay asset, so only those are fetched: ~6% of the item.
# A mod without a -LinuxServer cook is an error, not a fallback case: everything the extractor reads must ship to
# dedicated servers anyway. Within that, the .utoc container indexes (KBs) come first, `LayerExtractor --plan`
# reads them to name the containers that actually hold layer data, and only those .ucas files are fetched.
#
# usage: fetch-workshop-mod.sh <workshopId> <outDir> [DepotDownloader args...]
#   e.g. fetch-workshop-mod.sh 2428425228 /tmp/gc
# Squad's workshop content is available to the anonymous dedicated-server login, so no credentials are needed. Then: dotnet run --project tools/layer-extractor -- <outDir> --out layers.json
set -eu
ID=$1
OUT=$2
shift 2
TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DD="${DEPOT_DOWNLOADER:-$HOME/.local/opt/depotdownloader/DepotDownloader}"
[ -x "$DD" ] || { echo "error: DepotDownloader not found at $DD; set DEPOT_DOWNLOADER" >&2; exit 1; }

FILELIST=$(mktemp)
trap 'rm -f "$FILELIST"' EXIT
printf '%s\n' 'regex:.*-LinuxServer\.(utoc|pak)$' > "$FILELIST"
"$DD" -app 393380 -pubfile "$ID" -dir "$OUT" -filelist "$FILELIST" "$@"
find "$OUT" -name '*-LinuxServer.utoc' -o -name '*-LinuxServer.pak' | grep -q . \
	|| { echo "error: item $ID publishes no -LinuxServer cook" >&2; exit 1; }

# dotnet mixes MSBuild/NuGet warnings into stdout, so keep only container names
dotnet run --project "$TOOL_DIR" -- --plan "$OUT" | grep '\.ucas$' > "$OUT/container-plan.txt" || true
[ -s "$OUT/container-plan.txt" ] || { echo "error: no layer data in any of item $ID's containers" >&2; exit 1; }
echo "planned containers:" >&2
cat "$OUT/container-plan.txt" >&2

# the plan pass left zero-byte .ucas stubs; -validate makes DepotDownloader replace them
sed -e 's/[.[\*^$()+?{|]/\\&/g' -e 's#^#regex:.*/#' -e 's#$#$#' "$OUT/container-plan.txt" > "$FILELIST"
"$DD" -app 393380 -pubfile "$ID" -dir "$OUT" -filelist "$FILELIST" -validate "$@"

echo "done: $OUT is ready for LayerExtractor" >&2
