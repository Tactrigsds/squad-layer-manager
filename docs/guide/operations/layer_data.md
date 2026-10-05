# Layer data

SLM depends on a pair of artifacts, always of the same version:

- `layers_v<version>.bin.gz`: every possible layer configuration (layer + factions + units), plus the scores
  attributed to each layer. It is stored factored instead of row by row, so it takes a few hundred kilobytes
  instead of the tens of megabytes the combinations would take written out.
- `layer-data_v<version>.json`: the components (maps, factions, units, extra-column definitions) that the table's
  encoded values refer to.

Neither half is usable without the other. A table read against the wrong components resolves to the wrong layers
without reporting an error. The two are therefore only used as a pair, from the same directory and at the same
version. Half a pair is a startup error.

Both are checked in under `assets/layers` and ship inside the docker image, so the app boots with nothing to
download.

To run a different layer version, drop a complete pair into `data/`, the directory a deployment mounts, and restart.
Any complete pair there wins over the one in the image, including an older one. `<version>` is parsed as semver, and
the highest one in the winning directory is used unless `LAYERS_VERSION` pins a version. `LAYERS_DIR` adds a
directory that is searched ahead of both.

To build your own pair, with different scoring, extra columns, or different layers and game versions, see
[Building custom layer data](../../developers/custom_layer_data.md).

## Layer sources and mods

Layers come from sources under `data/sources/`. Each source is one directory:

- `layers.json`: a [SquadLayerList](https://github.com/fantinodavide/SquadLayerList) export, current format.
- `source.json`: the source manifest: the collection the source's layers belong to, abbreviations for its maps,
  gamemodes and unit types, and per-layer fixes for broken mod data. `vanilla` is itself a source.

To add a mod, create a directory with the mod's export and a manifest, then run `pnpm preprocess`. Preprocess fails
and names the layer whenever the manifest is missing an abbreviation or two layers are indistinguishable. Fix each
failure with another manifest entry. `data/sources/supermod/source.json` is a complete example.

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
about 5% of a mod. It takes only the dedicated-server containers, which strip art but keep every gameplay asset.
Within those, it fetches the container indexes first and takes only the containers that `LayerExtractor --plan`
finds layer data in. It uses DepotDownloader. Squad's workshop content is available to the anonymous
dedicated-server login, so no Steam account is needed. The base game must still be installed, because mods reference
its assets.

Every source's layers are in the pool of every query. The Collection column records which source each layer came from. A server that only
runs vanilla should carry a `Collection == OWI` term in its pool filter. Generated votes draw whatever the pool
filter admits.

## Vehicle icons

The layer details panel draws each vehicle with the map icon the game gives it. Those are textures in the base
game, checked in under `src/assets/vehicle-icons` and rebuilt when Squad changes them:

```sh
cd tools/layer-extractor
dotnet run -- --vanilla textures:VehicleMapIcons --out /tmp/squad-icons
cd ../.. && pnpm build:vehicle-icons /tmp/squad-icons
```

Mod vehicles name icons that ship in the mod's own paks, and those are not extracted: `fetch-workshop-mod.sh`
pulls the dedicated-server cook, which strips art. Their rows show the class without an icon.
