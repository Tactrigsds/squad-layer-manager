#!/usr/bin/env sh
# Fetches just enough of a Squad workshop mod to extract its layer list, without a full download.
#
# Two ideas stack up. Mods ship three platform cooks of every container and the dedicated-server ones
# (-LinuxServer) strip all art while keeping every gameplay asset, so only those are fetched: ~6% of the item.
# Within that, the .utoc container indexes (KBs) come first, `LayerExtractor --plan` reads them to name the
# containers that actually hold layer data, and only those .ucas files are fetched.
#
# usage: fetch-workshop-mod.sh <workshopId> <outDir> [DepotDownloader args...]
#   e.g. fetch-workshop-mod.sh 2428425228 /tmp/gc -username you -remember-password
# Workshop items of a paid app need a logged-in account that owns it; -remember-password makes later runs
# non-interactive. Then: dotnet run --project tools/layer-extractor -- <outDir> --out layers.json
set -eu
ID=$1
OUT=$2
shift 2
TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DD="${DEPOT_DOWNLOADER:-$HOME/.local/opt/depotdownloader/DepotDownloader}"

FILELIST=$(mktemp)
trap 'rm -f "$FILELIST"' EXIT
printf '%s\n' 'regex:.*-LinuxServer\.(utoc|pak)$' > "$FILELIST"
"$DD" -app 393380 -pubfile "$ID" -dir "$OUT" -filelist "$FILELIST" "$@"

dotnet run --project "$TOOL_DIR" -- --plan "$OUT" > "$OUT/container-plan.txt"
echo "planned containers:" >&2
cat "$OUT/container-plan.txt" >&2

# the plan pass left zero-byte .ucas stubs; -validate makes DepotDownloader replace them
sed -e 's/[.[\*^$()+?{|]/\\&/g' -e 's#^#regex:.*/#' -e 's#$#$#' "$OUT/container-plan.txt" > "$FILELIST"
"$DD" -app 393380 -pubfile "$ID" -dir "$OUT" -filelist "$FILELIST" -validate "$@"

echo "done: $OUT is ready for LayerExtractor" >&2
