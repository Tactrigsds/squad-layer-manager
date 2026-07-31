# Layer data

SLM depends on a pair of artifacts, always of the same version:

- `layers_v<version>.bin.gz` - every possible layer configuration (layer + factions + units) in a columnar format,
  plus the scores attributed to each layer.
- `layer-data_v<version>.json` - the components (maps, factions, units, extra-column definitions) that the table's
  encoded values refer to.

Neither half is usable without the other, and a table read against the wrong components resolves to the wrong layers
without reporting an error. So the two are only ever used as a pair, from the same directory and at the same
version. Half a pair is a startup error.

Both are checked in under `assets/layers` and ship inside the docker image, so the app boots as-is with nothing to
download.

To run a different layer version, drop a complete pair into `data/`, the directory a deployment mounts. Any complete
pair there wins over the one in the image, including an older one, so moving a deployment between layer versions is
a matter of dropping in files and restarting. `<version>` is parsed as semver, and the highest one in the winning
directory is used unless `LAYERS_VERSION` pins a version. `LAYERS_DIR` adds a directory that is searched ahead of
both.

To build your own pair, with different scoring, extra columns, or different layers and game versions, see
`src/scripts/preprocess.ts` (`pnpm preprocess`). It writes both halves into `assets/layers`, or into
`LAYERS_OUTPUT_DIR` if that is set.

## Layer sources and mods

Layers come from sources under `data/sources/`. Each source is one directory:

- `layers.json` - a [SquadLayerList](https://github.com/fantinodavide/SquadLayerList) export, current format.
- `source.json` - the source manifest: the collection the source's layers belong to, abbreviations for its maps,
  gamemodes and unit types, and per-layer fixes for broken mod data. `vanilla` is itself a source.

To add a mod, create a directory with the mod's export and a manifest, then run `pnpm preprocess`. Preprocess fails
with a named layer whenever the manifest is missing an abbreviation or two layers are indistinguishable; each
failure is fixed by another manifest entry. `data/sources/supermod/source.json` is a complete example.

A mod's `layers.json` can come from the SquadLayerList repo, or be extracted directly from a local Squad install
with `tools/layer-extractor` (requires the .NET 10 SDK):

```sh
cd tools/layer-extractor
dotnet run -- ~/.local/share/Steam/steamapps/workshop/content/393380/<workshopId> --out layers.json
```

It reads the cooked game files, so it works on whatever version of the mod Steam has downloaded, with no SDK
involved. SquadLayerList's `exporter.py` only runs inside the Squad SDK against the mod author's project, which is
why its exports lag behind workshop updates.

A full workshop download is not needed. `tools/layer-extractor/fetch-workshop-mod.sh <workshopId> <outDir>` pulls
about 5% of a mod: only the dedicated-server containers (which strip art but keep every gameplay asset), and within
those only the containers that `LayerExtractor --plan` finds layer data in, by fetching the container indexes first.
It uses DepotDownloader, which needs a Steam login that owns Squad on first run. The base game must still be
installed; mods reference its assets.

Mod layers are opt-in per query: pools, generated votes and the layer browser only include layers outside the
default collection when a filter names the Collection column. A vanilla server never sees mod layers unless someone
writes a filter that asks for them.
