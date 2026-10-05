# Frequently asked questions

## Is this project vibe-coded?

When it was started in september 2025, SLM was written entirely by hand, and was for most of its lifetime. However, LLMs, and Claude Code in particular, have since
become a _much_ bigger part of my developer workflow, and they've resulted in a massive increase in the overall featureset, and the overall quality of the project. I (grey275) am a Software Developer by trade, and try to maintain a strong understanding of the codebase, and I do my best to keep the code quality high.

## Is SLM open to contributions?

Yes, and at time of writing, I'm generally available to answer questions/help out. However, I reject LLM-written contributions from anyone who cannot answer for the code they submit, which in practice means
anyone who I judge cannot fluently read and write TypeScript (and rust where applicable). See [CONTRIBUTING.md](../CONTRIBUTING.md).

## I'm not a developer. How can I get a feature added?

- [Open an issue](https://github.com/Tactrigsds/squad-layer-manager/issues) describing the feature.
- Check whether a [plugin](developers/writing_plugins.md) would be a better fit for the feature. A plugin can add command. settings and behaviour without changing SLM itself, and are easy for LLMs to produce if needed. If the plugin api doesn't expose functionality you need access to, file an issue and I'll see what I can do.

## Where can I report issues, request features or ask questions?

- Create an [issue on github](https://github.com/Tactrigsds/squad-layer-manager/issues)
- If you just need help with something or want to ask a question, then Join the [discord](https://discord.gg/Th7g2nhpR)

## How can I support SLM?

Donate at [ko-fi.com/grey275](https://ko-fi.com/grey275).

## Does SLM work with modded layers?

SLM's layer catalog covers vanilla Squad, SuperMod, Resurgence and Galactic Contention. A layer from another mod can
still be queued as raw input. See [layer_selection.md, Mod support](features/layer_selection.md#mod-support). If you want another mod added without having to roll your own layer data, then file an issue.

## Can SLM run alongside Squad's in-game voting?

Yes. While an in-game vote decides the next layer, SLM stops setting it. See
[layer_selection.md, Squad's in-game voting](features/layer_selection.md#squads-in-game-voting).
