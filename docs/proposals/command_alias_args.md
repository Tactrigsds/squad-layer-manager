# Proposal: arguments for command aliases

Status: proposal, not implemented.

## What exists today

A command alias is a plain text substitution: `{ alias: '/rules', command: '/broadcast Read the rules' }`. At dispatch
(`commands.server.ts` `handleCommand`) the first word of the chat message is matched against the alias list, and if it
hits, the whole message is replaced by the alias's `command` before parsing. Everything typed after the alias is
dropped.

That restriction is why migration `0080_command_aliases` had to _delete_ the old `timeoutCommandAliases` rather than
convert them: a fixed-duration timeout pins the middle argument and takes `<player>` and `[reason]` from chat, and no
fixed command text can express that. This proposal makes that expressible again, and generalises it.

## Syntax

The alias's `command` becomes a Mustache template, rendered with the words typed after the alias. Same engine and same
lenient behaviour as reason texts (`src/lib/templating.ts`).

Variables, where the caller typed `<alias> w1 w2 w3 ...`:

| Variable                      | Value                                            |
| ----------------------------- | ------------------------------------------------ |
| `{{arg1}}`, `{{arg2}}`, ...   | the Nth word after the alias, or empty           |
| `{{rest2}}`, `{{rest3}}`, ... | words N onwards, joined by a space, or empty     |
| `{{rest}}`                    | every word after the alias (same as `{{rest1}}`) |

Worked examples:

```
/to2h   -> /timeout {{arg1}} 2h {{rest2}}          # /to2h Alice spamming
/say    -> /broadcast {{rest}}                     # /say server restarting in 5
/rules  -> /broadcast Read the rules               # unchanged, no placeholders
/warnsp -> /warn {{arg1}} {{^rest2}}spam{{/rest2}}{{rest2}}   # default when omitted
```

Optionality comes out of Mustache without new syntax:

- an omitted word renders empty and the token disappears from the expansion, so `{{rest2}}` feeding an optional
  `[reason]` is simply optional;
- `{{^argN}}default{{/argN}}` supplies a default when the caller omits the word;
- `{{#argN}}...{{/argN}}` conditionally includes surrounding literal text.

Words the template never references are ignored, which is what happens today for every alias.

Interpolated values are _not_ re-rendered by Mustache, so a caller typing `{{rest}}` as an argument gets it back
literally. Verified against the pinned mustache 4.2.

## Expansion at dispatch

`handleCommand` currently does a substitution and moves on. It becomes:

1. `CMD.findAlias(...)` as today.
2. `CMD.expandAlias(alias, tokensAfterAlias)` -> the rendered command string, whitespace-collapsed.
3. `parseCommand` / `resolveArgs` on the expansion, unchanged.

Errors need to be reported in the alias's own terms, not the expansion's. If `resolveArgs` comes back
`err:missing-arg`, reply with the alias's derived usage line (below) instead of the target command's, because
`/to2h` with no words expands to `/timeout 2h`, whose honest complaint ("Missing `<duration>`") names an argument the
alias pins and the caller cannot supply. Attribute the failure to the alias parameter feeding that slot when the slot
map has one, and fall back to the bare usage line otherwise.

The existing `log.info('Command alias expanded: %s -> %s')` should log the rendered text. No app-event change: handlers
already emit their own events, and the alias is not an action of its own.

## Static analysis: one function, three consumers

Settings validation, the alias usage strings, and the dispatch error path all need the same thing: which target
argument slot each placeholder lands in. Compute it once.

`analyzeAlias(command, configs)` extends today's `resolveAliasCommand`:

1. Scan the template for `arg<N>` / `rest<N>` / `rest` references (mustache interpolations and section names).
2. Render it with each reference replaced by a distinct single-word sentinel.
3. Split, resolve the command word, and run the existing `assignArgTokens` with the same permissive predicates
   `resolveAliasCommand` uses today.
4. Map each sentinel back to the window it landed in.

Result: `{ code: 'ok', cmdId, tokens, params: AliasParam[] }` where
`AliasParam = { ref: string; def: ArgDef; optional: boolean; wholeSlot: boolean }`, ordered by the position the
placeholder occupies in the expansion. The existing `ok` shape gains a field, so `command-help.models.ts`,
`commands-page.tsx` and `settings-form.tsx` keep compiling untouched.

New validation errors (all `err:invalid-args`, alongside today's missing-arg and int/duration checks):

- an unknown placeholder (`{{palyer}}`, `{{arg}}`) -- almost always a typo, and it would silently render empty;
- a placeholder that lands in no slot, i.e. the target takes fewer arguments than the alias feeds it;
- a `{{restN}}` in a single-word slot that is not the last one, since its extra words would silently shift every
  following argument.

Int and duration slots keep their literal-token checks, and skip them when a placeholder occupies the slot.

## Derived usage strings

An alias with parameters needs a signature wherever it is listed: `/to2h <player> [reason|message]`.

`formatAliasUsage(alias, params)` renders `alias.alias` followed by, per param, either the slot's existing
`formatArg(def)` output when the placeholder is the whole slot, or `<ref>` when it only part-fills one (as in
`/broadcast Round ends in {{arg1}} minutes`, where `<reason|message>` would be a lie). `optional` follows the target
slot's own optionality, including `requireReasonFor`, so it stays consistent with every other signature in the app.

Consumers:

- `Messages.GENERAL.command.aliasDescription` -- the in-game `!help` line becomes
  `[/to2h <player> [reason]]: Shortcut for "/timeout {{arg1}} 2h {{rest2}}"`, keeping the expansion visible so an admin
  can see what it actually does.
- `commands-page.tsx` `AliasEntry` -- show the signature next to the copyable string, and generate examples by feeding
  the params' `def`s through the existing `sampleTokens` machinery in `command-help.models.ts`, so an alias documents
  itself the way commands already do.
- `settings-form.tsx` `CommandAliasesField` -- add a derived "Takes" column showing the signature, and reuse the
  existing mustache-syntax hint component (`TEMPLATE_SYNTAX_URL`, ~line 1620) plus a short list of the `argN`/`restN`
  variables. `aliasStatus` already renders broken/disabled state and needs no change.

## Scope and safety

Scope enforcement is unchanged and stays after expansion: an alias runs in the scopes of the command it points at, so
argument splicing cannot escalate a public alias into an admin command. What it _can_ do is let an admin deliberately
build a public alias that splices caller text into a public command's free-text argument. That is the admin's call and
matches what a public command with a `text` arg already allows, but it is worth a line in `docs/configuring.md`.

## Persisted data

No schema change: `commandAliases` stays `{ alias, command }[]`, so no migration.

There is a semantics change on persisted data that needs flagging. An existing alias whose command text happens to
contain `{{` would now be templated, and under the validation above an unknown placeholder is a hard zod issue -- which
`loadGlobalSettings` treats as fatal, refusing to boot. The risk is close to nil (aliases have only ever been literal
text and the editor validates before save), but it is cheap to confirm rather than assume: before shipping, read the
stored aliases off the live db read-only and check none contain `{{`. If any do, either escape them in a migration or
downgrade unknown-placeholder to the lenient treatment `err:unknown-command` already gets (surfaces as broken in the
editor and drops out of help listings, never blocks boot).

## Files touched

- `src/models/command.models.ts` -- placeholder scanning, `analyzeAlias` (extending `resolveAliasCommand`),
  `expandAlias`, `formatAliasUsage`. Delete the outdated "if aliases ever need to take arguments, pin them by name"
  note above `CommandAlias`; named pinning is what this supersedes.
- `src/systems/commands.server.ts` -- expand with the typed words; report arg errors against the alias usage.
- `src/models/settings.models.ts` -- the alias `superRefine` picks up the new error cases for free; update the
  `commandAliases` `.describe()`, which currently states aliases take no arguments.
- `src/models/command-help.models.ts` -- alias listings carry a signature; alias examples.
- `src/messages.ts` -- `aliasDescription`.
- `src/components/commands-page.tsx`, `src/components/settings-form.tsx` -- as above.
- `docs/configuring.md` -- the alias section.

## Tests

`command.models.test.ts` (unit, this is the self-contained complex part):

- expansion: positional, `restN`, omitted-word collapse, inverted-section default, unreferenced words ignored, a
  caller-supplied `{{...}}` staying literal;
- `analyzeAlias`: slot mapping for the `/to2h` shape, unknown placeholder, over-fed target, `restN` in a single-word
  non-final slot, int/duration checks skipped under a placeholder;
- `formatAliasUsage`: whole-slot vs part-slot labels, optionality following `requireReasonFor`;
- a no-placeholder alias behaving exactly as it does today.

Plus one e2e pass driving `pnpm emuctl chat` through a fixed-duration timeout alias, since the payoff case is the one
migration 0080 had to drop.

## Alternatives considered

**Named pinning** (`/timeout duration=2h`), the approach the current code comments anticipate. Expresses the fixed
duration case but nothing else: no defaults, no reordering, no literal text around a value, and it needs its own parser
and its own error vocabulary. Templating covers it and reuses an engine, a syntax and a settings-form hint the app
already ships.

**Per-alias declared parameters** (`args: [{ name, kind }]` on the alias, referenced as `{{player}}`). Better error
messages and self-documenting names, at the cost of a schema change, a migration, and an editor for argument
declarations -- while the parameter's real type is already knowable from the slot it feeds. Worth revisiting only if
positional references prove hard to read in practice; `analyzeAlias`'s slot map is the piece that would carry over.
