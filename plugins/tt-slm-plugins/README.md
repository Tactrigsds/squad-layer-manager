# tt-slm-plugins

Tactical Trigger's plugins for [Squad Layer Manager](https://github.com/Tactrigsds/squad-layer-manager).

| Plugin                       | What it does                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`seed-roller`](seed-roller) | Rolls a training layer onto a seeding layer once the server is busy enough, at the time of day seeding happens. |

## Developing

Plugins build against an SLM checkout: `slm/*` resolves through its tsconfig, and `pnpm plugin:pack` runs
from there. Clone this repo into one, as its own directory under `plugins/`:

```sh
cd <your slm checkout>
git clone git@github.com:Tactrigsds/tt-slm-plugins.git plugins/tt-slm-plugins
echo 'plugins/tt-slm-plugins/' >> .git/info/exclude
```

The exclude line only needs writing once, even across worktrees: `info/exclude` lives in the common git
directory, which every worktree shares. The clone does not. A worktree is its own working tree, so each one
you want to develop in needs its own clone here.

Then `pnpm dev` in the SLM checkout picks both plugins up from source, with no registration step. Enable them
once in settings and it sticks. Editing a component swaps it in place; editing a server module restarts the
app under `tsx watch`.

SLM's own commands cover the rest: `pnpm run check` typechecks these against the exact `slm/*` surface,
`pnpm test` runs the `*.test.ts` files here alongside SLM's, and `pnpm run format` formats them.

## Installing

These are not published, so there is no url to install from. Pack and copy:

```sh
pnpm plugin:pack plugins/tt-slm-plugins/seed-roller
cp -r plugins/tt-slm-plugins/seed-roller/dist/. <slm data dir>/plugins/seed-roller/
```

Then _Rescan folder_ under Plugins in settings. Do this at least once before shipping a change: it is the
only thing that exercises the packed bundles and the shim registry, which the dev loop bypasses entirely.

Installing and enabling are separate. A newly installed plugin does nothing until an admin turns it on.
