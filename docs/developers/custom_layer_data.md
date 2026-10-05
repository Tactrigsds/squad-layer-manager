# Building custom layer data

SLM reads its layers from a pair of artifacts: `layers_v<version>.bin.gz`, the layer table with its scores, and
`layer-data_v<version>.json`, the maps, factions, units and column definitions the table refers to.
[Layer data](../guide/operations/layer_data.md) describes how SLM loads a pair. This page describes how to build one,
to support a mod the shipped pair does not cover, or to score layers your own way.

`pnpm preprocess` (`src/scripts/preprocess.ts`) builds both halves of the pair from three inputs:

| Input                        | Holds                                                        | Tracked in git |
| ---------------------------- | ------------------------------------------------------------ | -------------- |
| `data/sources/<name>/`       | every layer and the factions and units it can be played with | yes            |
| `data/layers_v<version>.csv` | the scores, one row per layer and matchup                    | no (~150MB)    |
| `layer-db.json`              | the definitions of the score columns the csv carries         | no             |

The sources decide which layers exist. The csv and `layer-db.json` only attach values to layers the sources produce. A
layer without a csv row is still in the table, with no scores.

## Setting up

Work in a checkout of SLM with its dependencies installed (`pnpm install`). The csv and `layer-db.json` are not in the
repo, so fetch the ones the shipped pair was built from.

Each Layer Data release on GitHub carries the csv it was built from:

```sh
gh release download layer-db-v10.6.0 -R Tactrigsds/squad-layer-manager -p '*.csv' -D data
```

Preprocess bakes the column definitions it used into `layer-data.json`, so the shipped pair carries its own
`layer-db.json`:

```sh
jq '{columns: .extraColumns}' assets/layers/layer-data_v10.6.0.json > layer-db.json
```

## Building

```sh
LAYERS_OUTPUT_DIR=./out pnpm preprocess
```

Preprocess writes both halves of the pair into `LAYERS_OUTPUT_DIR`, which defaults to `assets/layers`, the pair the
image ships. Set it to keep the build out of the checkout's own artifacts.

The version of a build comes from the csv's file name: `data/layers_v10.6.0.csv` builds `layers_v10.6.0.bin.gz` and
`layer-data_v10.6.0.json`. With several csvs in `data/`, the highest semver wins unless `LAYERS_VERSION` pins one.
Rename the csv to give a custom build a version of its own, such as `layers_v10.6.0-myscores.1.csv`.

| Variable               | Default                               | Purpose                                      |
| ---------------------- | ------------------------------------- | -------------------------------------------- |
| `EXTRA_COLS_CSV_PATH`  | `data/layers_v{{LAYERS_VERSION}}.csv` | the scores csv, and the version of the build |
| `LAYER_DB_CONFIG_PATH` | `./layer-db.json`                     | the score column definitions                 |
| `LAYERS_OUTPUT_DIR`    | `assets/layers`                       | where the pair is written                    |
| `LAYERS_VERSION`       | `@latest`                             | pins which csv version to build              |

Without a `layer-db.json`, preprocess builds a table with no score columns.

## Extracting layers from the game

Each source's `layers.json` comes from the game's own files. `tools/layer-extractor` reads the cooked containers of a
Squad install and a mod with [CUE4Parse](https://github.com/FabianFG/CUE4Parse), and writes the maps, layers, faction
setups, units and vehicles they define in the [SquadLayerList](https://github.com/fantinodavide/SquadLayerList)
format. It needs no Squad SDK, and works on whatever version of the game and mods is on disk.

The extractor needs the .NET 10 SDK, which the repo's nix flake provides, and a Squad install. It looks for the game
at `~/.local/share/Steam/steamapps/common/Squad`. Pass `--game <squadInstall>` for an install elsewhere. Run it from
its directory:

```sh
cd tools/layer-extractor
nix develop path:../../nix -c dotnet run -- --vanilla --out ../../data/sources/vanilla/layers.json
```

### The base game

`--vanilla` exports the base game's layers, and takes about a minute. Re-export `data/sources/vanilla/layers.json`
after every game update that adds or changes layers, factions or units, then rebuild the pair.

An update can relabel a vehicle, or ship a vehicle setting without its vehicle type. Compare each unit's vehicle names
and classes in the new pair with the previous one, and pin anything that changed in the override tables of
`src/models/vehicles.models.ts`, such as `VEH_TYPE_OVERRIDES`. `pnpm release:layers <version> --dry-run --csv <path>`
builds a pair and stops, so it can be inspected before a release.

### Mods from the Steam Workshop

Squad mods are published on the Steam Workshop, where each one has a numeric workshop id: the `id` in the mod's
workshop page URL. Pass the extractor the directory that holds the mod's files:

```sh
nix develop path:../../nix -c dotnet run -- <modDir> --out ../../data/sources/<name>/layers.json
```

The base game must still be installed, because a mod's layers refer to base game assets.

There are two ways to get a mod's files.

**Subscribe in Steam.** Steam downloads a subscribed mod into
`~/.local/share/Steam/steamapps/workshop/content/393380/<workshopId>`, where `393380` is Squad's app id. That
directory is the `<modDir>`. Steam downloads the whole mod, art included.

**Fetch only what the extractor reads.** `fetch-workshop-mod.sh` downloads about 5% of a mod with
[DepotDownloader](https://github.com/SteamRE/DepotDownloader):

```sh
./fetch-workshop-mod.sh <workshopId> <outDir>
```

1. A workshop item ships its containers once per platform. The script takes only the dedicated-server ones
   (`-LinuxServer`), which strip the art and keep every gameplay asset. A mod with no dedicated-server cook is an error.
2. Of those, it fetches the container indexes (`.utoc`) first, a few kilobytes each.
3. `LayerExtractor --plan` reads the indexes and names the containers that hold layer, faction, availability and
   vehicle data.
4. The script fetches only those containers (`.ucas`).

Squad's workshop content is open to Steam's anonymous dedicated-server login, so the script needs no Steam account.
It looks for DepotDownloader at `~/.local/opt/depotdownloader/DepotDownloader`. Set `DEPOT_DOWNLOADER` to use another
path. `<outDir>` is then the `<modDir>` to extract from.

### Inspecting game files

Three commands help when an export comes out wrong or a mod lays its files out unusually:

| Command                | Does                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `list:<substring>`     | prints the mounted file paths that contain the substring                                                             |
| `dump:<substring>`     | prints the raw exports of the first package whose path contains the substring                                        |
| `textures:<substring>` | writes each matching texture to `--out`, as for the [vehicle icons](../guide/operations/layer_data.md#vehicle-icons) |

Each takes the same `<modDir>` or `--vanilla` as an export, such as `dotnet run -- --vanilla list:FactionSetups`.

## Custom scoring

### The csv

Each row of the csv scores one layer with one matchup. These columns identify the row:

| Column                   | Value                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `Layer`                  | the layer's name in game, such as `AlBasrah_AAS_v1` or `SU_GoingDark_Kohat_AAS_v1`                 |
| `Faction_1`, `Faction_2` | each team's faction, such as `ADF`                                                                 |
| `SubFac_1`, `SubFac_2`   | each team's unit type, such as `CombinedArms`. `Unit_1` and `Unit_2` are read when these are empty |
| `Scored`                 | optional. A row reading `False` is skipped                                                         |

Every other column is read only when `layer-db.json` defines it, and ignored otherwise. A row whose layer and matchup
the sources do not produce is skipped. Two rows for the same layer and matchup keep the first, with a warning. A
`Layer` value that names no layer and does not parse as one stops the build.

A RAAS row also scores the layer's FRAAS twin, and a row for a layer also scores its world partition (`_WP`) version,
so the csv needs neither.

### Column definitions

`layer-db.json` lists one definition per score column:

```json
{
	"columns": [
		{ "name": "Armor_1", "displayName": "Armor 1", "type": "float" },
		{ "name": "Armor_2", "displayName": "Armor 2", "type": "float" },
		{ "name": "Armor_Diff", "displayName": "Armor Diff", "type": "float" },
		{ "name": "Balance_Differential", "displayName": "Balance", "shortName": "BAL", "type": "float" },
		{ "name": "Z_Pool", "displayName": "Z Pool", "type": "boolean" }
	]
}
```

| Field         | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `name`        | the csv header, and the column name filters and the layer table use |
| `displayName` | the column's label in the app                                       |
| `shortName`   | optional. A narrow label for table headers                          |
| `type`        | `float`, `integer` or `boolean`. String columns are rejected        |
| `precision`   | `float` only. Decimal places kept, 3 by default                     |

A name may not repeat a built-in column, such as `Map` or `Faction_1`. Preprocess writes a JSON schema for the file
to `assets/db-config-schema.json`, for editor completion.

### How the app shows scores

A score column is a column like any other: it can be shown in the layer table, filtered on, and sorted by. The layer
details panel also groups `float` columns by name:

| Name                   | Shown as                                            |
| ---------------------- | --------------------------------------------------- |
| `Balance_Differential` | the layer's headline balance score                  |
| `<X>_1` and `<X>_2`    | dimension `<X>` for each team                       |
| `<X>_Diff`             | the difference between the teams on dimension `<X>` |
| anything else          | listed with the layer's other scores                |

A dimension is charted per team only when `assets/score-ranges.json` lists it under `paired`, with the axis range to
draw it on. The `regular` entries set the range and pool cutoff drawn for `Balance_Differential` and `Asymmetry_Score`.
The file is compiled into the client, so charting a new dimension means editing it and building the image.

## Adding a mod

A mod adds a source: a directory under `data/sources/` holding the mod's `layers.json` and a `source.json` manifest.
[Mods from the Steam Workshop](#mods-from-the-steam-workshop) describes how to extract the mod's `layers.json`.

`source.json` describes how to read the export. `data/sources/supermod/source.json` is a complete example.

| Field                   | Meaning                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `name`                  | the directory's name                                                                |
| `collection`            | the name and abbreviation of the collection every layer of the source lands in      |
| `layerNames`            | `structured` to read the map and gamemode from the export's fields, which mods need |
| `fraasVariants`         | whether to add a FRAAS twin for every RAAS layer                                    |
| `mapAbbreviations`      | an abbreviation for every map the core table does not know                          |
| `gamemodeAbbreviations` | an abbreviation for every gamemode the core table does not know                     |
| `gamemodeRenames`       | maps the export's spelling of a gamemode onto the one layer names use               |
| `extraUnitTypes`        | unit types beyond the core ones, with an abbreviation and short name                |
| `unitTypeOverrides`     | the unit type of a unit object whose name cannot be parsed                          |
| `layerOverrides`        | per-layer fixes for an export whose fields are wrong, keyed by level name           |

Run `pnpm preprocess` after adding the source. It fails on the first gap in the manifest and names the layer, such as a
map with no abbreviation or two layers that come out with the same id. Add a manifest entry for each failure and run
it again.

A mod's layers have no scores until the csv has rows for them. Score them like any other layer, by their in-game name.

## Deploying

Copy both halves of the pair into the `data/` directory of the deployment and restart SLM. A pair in `data/` takes
precedence over the one in the image. See [Layer data](../guide/operations/layer_data.md).

> [!WARNING]
> Filters, the layer table's columns and layer generation weights refer to score columns by name. When a new pair
> renames or removes a column, update every filter and setting that names it.
