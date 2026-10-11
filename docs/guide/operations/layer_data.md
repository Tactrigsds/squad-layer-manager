# Layer data

SLM depends on a pair of artifacts, always of the same version:

- `layers_v<version>.bin.gz`: every possible layer configuration (layer + factions + units), plus the scores
  attributed to each layer.
- `layer-data_v<version>.json`: the components (maps, factions, units, extra-column definitions) that the table's
  encoded values refer to.

The two are only used as a pair, from the same directory and at the same version. Half a pair is a startup error.

Both ship inside the docker image, so the app boots with nothing to download.

To run a different layer version, drop a complete pair into `data/`, the directory a deployment mounts, and restart.
Any complete pair there wins over the one in the image, including an older one. `<version>` is parsed as semver, and
the highest one in the winning directory is used unless `LAYERS_VERSION` pins a version. `LAYERS_DIR` adds a
directory that is searched ahead of both.

To build your own pair, with different scoring, extra columns, or different layers and game versions, see
[Building custom layer data](../../developers/custom_layer_data.md).

## Mods

The shipped pair covers vanilla Squad, SuperMod, Resurgence and Galactic Contention. The _Collection_ column records
which of them each layer comes from. Each server names the mods it has installed, under _Installed Mods_ in its
settings, and SLM never queues, generates or offers a vote choice from a mod the server lacks. See
[Installed mods](../configuring/servers.md#installed-mods).

To support another mod, build a pair that includes it. See
[Adding a mod](../../developers/custom_layer_data.md#adding-a-mod).
