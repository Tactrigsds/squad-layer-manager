# Layer selection

SLM manages the layer rotation of one or more Squad servers. Admins work from a web app that signs in with Discord, and
from in-game commands. To install SLM, see [installing.md](../installing.md). To learn SLM by using it, see
[Learning SLM](learning_slm.md).

## The layer queue

The queue holds upcoming layers for the server, as a list of _queue items_. A queue item is either a single layer, or a
[vote](#votes) between several layers. When a queue item reaches the top, SLM sets the queue item's layer as the
server's next layer. For a vote, that layer is the vote's default choice until the vote ends, and the winning choice
after. When the queue runs out, SLM generates a layer from your layer pool, the set of layers your server may play, and
marks the generated layer with a dice icon. [Filters and the layer pool](#filters-and-the-layer-pool) describes the pool
below.

Several admins can edit the queue at once, and each one sees who else is editing. Layers can be added one at a time, as
a generated vote, or as a whole rotation, pasted in or picked from the [saved rotations](#saved-rotations). Queue items
can carry colour-coded tags and freeform notes.

Right-click a queue item, or use its ⋮ button, to open the queue item's menu. The menu leads with the layer's details,
scores and SquadCalc link, followed by the queue item's edit, tag, note and placement actions.

Use _View history_ in a queue item's menu, or in a match's menu in the match history, to see every edit to the queue
item and who made each edit, the queue item's votes, and the match that played the queue item.

![the layer queue while editing, with the first item's menu open, a tagged and noted layer, a vote and an out-of-pool layer](../images/features/layer_queue.png)

## The layer selection dialog

Use the layer selection dialog to search the full layer catalog for layers to add to the queue. Filters narrow the
catalog, along with constraints on map, gamemode, factions, units and vehicles. The results can be shuffled, weighted
toward preferable layers. Each layer is marked when it falls outside your pool or would break a
[repeat rule](#repeat-rules). A summary of the results lists the values each column holds and how many layers each
filter matches or removes. The selected layers go into the queue as separate queue items or as one vote.

![the Add Layers dialog, with three RAAS layers selected](../images/features/add_layers.png)

SLM works on a phone, and can be installed to your homescreen. See
[Can SLM be installed as an app?](../faq.md#can-slm-be-installed-as-an-app).

![the queue on a phone](../images/features/phone_queue.png)
![the Add Layers dialog on a phone](../images/features/phone_layer_picker.png)

## Filters and the layer pool

The base game offers about 730,000 layers, counting every map, gamemode, faction and unit combination, and mods add
more. A _filter_ is a named expression that picks a subset of them out, such as "no mechanized units on hilly maps". A
filter can reference other filters. Filters can be edited in a visual builder or as YAML text.

![a filter in the builder](../images/configuring/filter_edit.png)

Filters decide which layers admins can select by default and which layers SLM generates when the queue is empty. A
filter can also mark the layers it matches with an emoji, as a category. See
[Layer pool and filters](../guide/configuring/layer_pool.md).

Use the _Filters_ page to search filters by name or description, narrow the list to one author, and sort it. A search
lists the matches as rows and shows what matched. Each filter card's menu, also opened by right-clicking the card,
provides _Clone_, which copies the filter under a new name, and _Delete_. A filter that something still references
cannot be deleted.

## Repeat rules

A _repeat rule_ defines how soon a map, layer, faction or unit may be played again, counting both the queue and the
recent match history. The defaults catch the same map within 4 matches, the same layer within 7, and the same faction
on the same side within 3. A rule can be narrowed to named values, such as Skorpo alone over 10 matches.

![the default repeat rules](../images/configuring/default_repeat_rules.png)

SLM marks each layer that breaks a repeat rule with ![repeat rule icon](../images/icons/repeat.svg), and underlines the
repeated value in pink on both the marked layer and the earlier layer it repeats.

![a repeated map, underlined on both layers, with the rule it breaks](../images/features/repeat_hover.png)

Use _Fix Repeats_ to clear repeat warnings automatically. SLM reorders the queue and swaps layers' teams to clear as
many warnings as possible, with as few changes as possible. See [Fixing repeats](../guide/configuring/layer_rotation.md#fixing-repeats).

## Saved rotations

A _rotation_ is a saved, ordered list of layers and votes, with their tags and notes. Rotations are kept on the
_Rotations_ page, where they can be searched, tagged, cloned and archived.

![the Rotations page, with rotation tag and author filters beside the rotation cards](../images/features/rotations_page.png)

A rotation is edited the same way as the queue, and several admins can edit one at once. Each rotation follows a
[repeat ruleset](../guide/configuring/layer_rotation.md#repeat-rules), and the editor marks every layer that breaks one
of the ruleset's rules. A rotation's layers can also be edited, copied and downloaded as YAML or plain text.
[Rotation files](../guide/configuring/layer_rotation.md#rotation-files) describes both formats.

![a rotation open for editing, with its rotation tags and repeat ruleset beside its layers](../images/features/rotation_editor.png)

Use _Add Rotation_ on the queue to add a saved rotation to any server's queue in one step, or to paste one in. SLM
tags each added item with the rotation's name.

![the Saved Rotation tab of Add Rotation, previewing where each item lands in the queue](../images/features/add_rotation.png)

## Layer details and scores

Each layer shows a balance score and an asymmetry score, and compares its two teams on anti-infantry, armor, logistics
and transportation. The scores are heuristics for how fair a matchup is likely to be. They come from a system
created by community member ZERO, and refined through feedback on the TacTrig server. A custom layer dataset can
replace the scores. See [Building custom layer data](../developers/custom_layer_data.md). The current scores predate recent game changes. A
revised scoring system is in progress.

Right-click a layer wherever it appears to open its details or scores:

![a layer's menu, opened from its name in the match history](../images/features/layer_menu.png)

![a layer's details: each team's unit, tickets and vehicles](../images/features/layer_details.png)
![a layer's scores: balance, asymmetry and each category compared](../images/features/layer_scores.png)

## Votes

A vote lets players choose the next layer from several choices. Use the _Generate Vote_ dialog to generate each choice
from the pool, under optional constraints such as a different map for every choice. A choice can be edited or regenerated on
its own.

![the Generate Vote dialog](../images/features/generate_vote.png)

A vote starts from the dashboard, in game with `/startvote`, or by itself partway into a match. Players vote by typing
a choice's number in chat, and SLM broadcasts the choices and reminders to the server. An internal vote polls only the
admins.

![a vote in progress](../images/features/vote_in_progress.png)

Each vote sets its own duration, and which parts of a layer the choices spell out, such as the map, gamemode or
factions.

## Squad's in-game voting

SLM also works on a server that uses Squad's own in-game voting system. When an in-game vote starts, or SLM infers that
voting was turned on with `AdminEnableVoting 1`, SLM stops setting the next layer, so SLM and the vote never fight over
it. The server's dashboard shows that an in-game vote is deciding the next layer.

![the dashboard while an in-game vote decides the next layer](../images/features/ingame_vote.png)

## Layer requests

An admin can request a kind of layer instead of queuing a particular one. A request names any mix of map, gamemode,
faction, unit or filter. `/reqlayer fallu raas usa rgf` requests Fallujah RAAS with USA against
RGF. When the queue runs out of deliberately queued layers, SLM generates the next layer from the requests, and
satisfies as many of them as it can at once. If one admin requests WPMC and another requests Narva, the generated layer
can be WPMC on Narva.

![the layer requests panel](../images/features/layer_requests.png)

## Mod support

SLM's layer catalog covers vanilla Squad and SuperMod. Resurgence and Galactic Contention are left out until each is
updated for the current version of Squad. More mods can be added on request, as
[Layer data, Mods](../guide/operations/layer_data.md#mods) describes. Each layer's _Collection_ column records whether
the layer is vanilla (`OWI`) or which mod it comes from, so a filter can include or exclude a whole mod. Each server's settings name the mods that server has installed, and SLM never queues, generates or
offers a layer from a mod the server lacks.

A custom layer dataset can replace the built-in one, with other mods, other scoring or extra columns. See
[Layer data](../guide/operations/layer_data.md) and [Building custom layer data](../developers/custom_layer_data.md).

A layer the catalog does not know can still be queued as raw text, in the format `AdminSetNextLayer` takes, such as
`Narva_RAAS_v1 RGF USMC`. Open raw input from the
![text cursor input icon](../images/icons/text-cursor-input.svg) icon in the _Add Layers_ dialog.

![the raw input in the Add Layers dialog](../images/features/raw_layer_input.png)
