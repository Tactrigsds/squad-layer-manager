# Layer rotation

These settings decide what SLM plays next: the next layer, the repeat rules, generated votes, and how SLM picks layers
at random.

## Next layer

The _Next Layer_ tab holds two settings, both off by default. They decide how SLM reacts when the server's next
layer changes underneath it.

_Override the next layer when it is set outside SLM_ covers the case where something other than SLM sets the next
layer, such as an in-game admin or another RCON tool. On, SLM sets it straight back to the next layer in the queue.
Off, SLM adopts the change instead, and puts that layer at the front of the queue.

_Warn admins when the next layer changes_ sends every in-game admin the new next layer whenever it changes. A change
SLM overrides is not announced, so turning both on warns admins only about changes SLM accepted.

![the Next Layer tab of the pool configuration window](../../images/configuring/pool_configuration_next_layer.png)

## Disabling SLM updates

SLM normally writes the next layer to the server over RCON. Use _Disable SLM Updates_, in the _Server Actions_ menu,
to stop SLM writing the next layer. The queue still runs and tracks what is played. SLM never sets the map itself,
and stops sending the recurring reminders and announcements that describe the queue as the rotation. Disable
updates to run SLM alongside something else that owns the rotation.

![Disable SLM Updates in the Server Actions menu](../../images/configuring/disable_slm_updates.png)

While updates are off, the queue panel carries an _SLM Updates Disabled_ alert naming who turned them off. Use
_Re-enable SLM Updates_ to turn them back on. Both need `squad-server:disable-slm-updates`.

![the SLM Updates Disabled alert above the queue](../../images/configuring/slm_updates_disabled.png)

SLM also stands down on its own when Squad's built-in vote is deciding the next layer, or when it infers that
voting was turned on with `AdminEnableVoting 1`. It reports that voting is enabled, and stops updating the next
layer until someone turns updates back on. Turning them back on disables voting.

![the dashboard while an in-game vote decides the next layer](../../images/features/ingame_vote.png)

## Repeat rules

A _repeat rule_ sets how soon a map, layer or faction may be played again, counting across both the queue and the
recent match history. Each rule covers one attribute.

Repeat rules are kept in _repeat rulesets_. A repeat ruleset is a named list of repeat rules that several servers and
rotations can share. Each server uses one repeat ruleset, and a new server gets a repeat ruleset of its own, named after
the server.

To change a server's repeat rules:

1. Open the _Repeat Rules_ tab of the pool configuration window.
2. Pick a repeat ruleset under _Repeat ruleset_, or keep the one shown.
3. Edit the rules.
4. Press _Save Changes_.

_Save Changes_ saves the rules into the repeat ruleset, so every server using that repeat ruleset gets the new rules.

Use _New repeat ruleset_, beside the picker, to create a repeat ruleset. It starts with a copy of the rules shown, and
the server switches to it once _Save Changes_ is pressed. Use the pencil beside the picker to rename the repeat ruleset
shown. The settings page lists every repeat ruleset under _Repeat Rulesets_. A repeat ruleset can only be deleted
there, and only while no server or rotation uses it.

These are the rules a new server's repeat ruleset starts with:

![the repeat rules a new server's repeat ruleset starts with](../../images/configuring/default_repeat_rules.png)

They treat a layer as a repeat when it reuses:

- its `Map` within 4 matches
- its `Layer`, which is the map, gamemode and version together, within 7 matches
- its `Faction`, on the same side, within 3 matches

A rule on a team-specific attribute such as `Faction` or `Unit` reads that side's own history, not both. One side can
still play a faction the other side played recently.

Use _Target Values_ to narrow a rule to named values:

![a repeat rule narrowed to Skorpo, over 10 matches](../../images/configuring/skorpo_repeat_rule.png)

That rule covers Skorpo alone, over 10 matches. A _Within_ of 0 turns a rule off.

A rule always hides its repeats behind the layer table's _Hide Repeats_. _Options_ decides what else it does:

- _Indicate_ marks a layer that breaks the rule wherever it is shown: the repeat icon on the queue item and in the
  layer table, and the underline on the field that repeats.
- _Warn_ warns the editor before saving a layer that breaks the rule, and warns in-game admins when one is about
  to be played.
- _Autogen_ applies the rule when autogenerating layers as well. It is on for all three defaults, and off for the
  Skorpo rule above.
- _Cross-team_ pools both teams together, so a value one team played counts as a repeat when the other team plays
  it. Only a rule on a team-specific attribute can take it.

A rule is named after its attribute, unless _Add label_ gives it a name of its own.

A seeding or training layer never breaks a repeat rule. A repeat rule looks back only as far as the most recent
seeding or training layer, whether played or queued. A vote ends the lookback the same way only when every choice is
a seeding or training layer.

### Fixing repeats

While editing the queue, use _Fix Repeats_ (the wand icon) to clear repeat warnings automatically. SLM reorders the
queue and swaps layers' teams to clear as many warnings as possible, with as few changes as possible. Moving a layer
one place and swapping a layer's teams each count as one change. SLM never swaps the teams of:

- an Invasion, Destruction or Insurgency layer
- a layer whose swapped matchup falls outside the pool
- a layer with a tag that has _Prevent swaps_ turned on

A layer that another admin is editing stays where it is. The changes stay in the draft until the queue is saved.

A repeat rule checks a layer against every choice of an earlier vote that has not taken place yet, because any of
those choices could still be played. Once the vote picks a winner, or ends with too few votes, the rule checks only
the layer the vote settled on. Aborting a vote puts all of its choices back in play.

## Generated votes

When the queue runs out of layers, SLM generates a single layer by default. Switch on _Generate votes_, in the
_Generation_ tab of the pool configuration window, to have SLM generate a vote between 3 layers instead.

![the Generation tab, with generated votes switched on](../../images/configuring/pool_config_generation.png)

Each choice of a generated vote is on a different map. SLM draws the choices under the pool filter, the _Constrain
generated pool for_ filters and the repeat rules, the same as a single generated layer. When a
[layer request](../../features/layer_selection.md#layer-requests) is pending, SLM generates the requested layer on its
own. When the repeat rules leave fewer than 2 maps, SLM generates a single layer.

_Vote Display Options_ sets which parts of each choice players see when a generated vote starts. The map is always
shown, because the map is the one part the choices are certain to differ by.

## Randomization

_Layer Generation Weights_ controls how SLM picks layers at random. It covers layer generation, which runs when
the queue runs out of layers, vote generation, and the layer table's random sort.

Generation walks down a configurable pick order of layer columns and matchups:

![the pick order of Layer Generation Weights](../../images/configuring/layer_weights_pick_order.png)

At each step it draws one value at random, using the weights configured for that column, and the draw narrows the pool
the next step draws from:

![the weight of each map, and the share of picks it works out to](../../images/configuring/layer_weights_maps.png)

An unlisted value weighs 0.1. Matchups are unordered, so `[ADF, PLA]` and `[PLA, ADF]` are one entry.

Generation keeps going down the pick order until one layer remains, or until the pick order runs out, in which case
it picks one of the remaining layers at random.

The weights are relative, not probabilities. SLM normalizes them against the values actually available at pick time, and
a value with no layers left is never picked. Your background filtering and the values already picked both narrow what
remains, so configured weights do not map cleanly onto the resulting distributions.
