# Player management

SLM helps admins moderate and balance the players on their servers, from the dashboard or in game.

## Teams and balance

The teams panel lists both teams by squad, each in its own table. When the panel is too narrow for two tables side by
side, it lists both teams in one table. A _grouping mode_ sorts players into coloured groups by
[BattleMetrics](integrations_and_hosting.md#battlemetrics) flag, Discord role, a pattern on their name, or their group
in a standard Squad admin list. A player's username takes their group's colour wherever it is shown. Most servers want
two grouping modes: one for balance and one for admin purposes. The built-in _Party_ grouping mode groups players by
the in-game party they queued with.

With the _Party_ grouping mode picked, the _Group_ column shows each player's party. Filter or sort the table by party
from that column, or shift+click a party to select its members on that team.

The _Teams Breakdown_ chart counts each team's players by group. See [Charts](server_monitoring.md#charts).

![the teams panel](../images/features/teams_panel.png)

## Player details

Click a player for their IDs and profile links, their groups and BattleMetrics flags, their team and squad, and their
recent chat.

![a player's details](../images/features/player_details.png)

## BattleMetrics notes

A note is free text on a player's [BattleMetrics](integrations_and_hosting.md#battlemetrics) profile. Admins use notes
to brief each other: why a player was warned, or what to watch for next match. SLM signs each note it posts with the
name of the admin who created it.

Click _Load notes_ in a player's details window to list their notes, newest first. A note that records a flag change
shows the flag and the reason given for it.

![a player's BattleMetrics notes](../images/features/bm_notes.png)

To add a note, click the notebook button beside the player's flags, or right-click a player, a squad or a selection and
choose _Add Note..._. In game, type `/note Kestrel mic spam in local`.

![the Add Note dialog](../images/features/add_note.png)

### BattleMetrics personal access tokens

When flags are modified/notes are made, SLM will attribute the user who made them, but by default it cannot perform actions on behalf of the user.
However, it's possible to set up a personal access token so that SLM can act directly on your behalf.

## Permissions

Roles decide which of these actions each admin may take, and can cap some of them, such as the longest timeout. See
[Permissions and access control](permissions.md).

## Admin actions

Right-click a player's name or row wherever it appears to warn, kick, time out, kill or swap them, to manage their
BattleMetrics flags, or to add a note to their BattleMetrics profile. In game, admins can also remove a player from
their squad, demote a squad leader, or disband a squad. Many actions can be done in bulk against an arbitrary
selection of players.

A timeout kicks the player, and kicks them again whenever they rejoin any server SLM manages, until the timeout
expires or is cancelled. Type `/timeout Kestrel 2h spamming in command chat` to time Kestrel out for two hours. Each
role caps how long a timeout its members may give.

![the player actions menu](../images/features/player_actions.png)

On a phone, tap the menu button at the end of a player's row for the same actions.

![the teams panel on a phone](../images/features/phone_teams.png)
![a player's actions on a phone](../images/features/phone_player_menu.png)

### Action reasons

An action reason is a preset message for a common offence, such as teamkilling or wasting assets. Each reason holds
one message per action, such as a warn, a kick, a timeout or a broadcast. A warn for teamkilling can read "Do not team
kill." while a kick for the same reason reads "You have been kicked for team killing." A reason is offered only for the
actions it holds a message for.

When acting from the dashboard, pick a reason from the action's dialog, or choose _Custom_ and type a message of your
own.

![choosing a reason in the Kick Players dialog](../images/configuring/kick_dialog.png)

In game, type a reason's keyword where the message goes. `/kick Kestrel tk` kicks Kestrel with the _Teamkilling_
reason's kick message. A message of two or more words is sent as written instead.

Reasons are configured in the _Warns & Broadcasts_ settings, which can also make a reason required for chosen actions.
See [Admin actions and commands](../guide/configuring/admin_actions.md#warns-broadcasts-and-admin-actions).

![the Admin Action Reasons settings, with a preview of each message](../images/configuring/admin_action_reasons.png)

## Team swaps

Admins move players between teams from the teams panel. Right-click a player, a selection of players or a squad,
and choose _Swap Next_ or _Swap Now_.

![the swaps panel above the teams](../images/features/team_swaps.png)

- Use _Swap Next_ to add the players to the swaps panel. The panel lists each pending swap under the team the player is
  moving to, and counts how the teams will stand after the swaps. Save to commit the swaps. Several admins can edit the
  swaps at once, as with the layer queue. On the next map roll, SLM moves everyone on the list, and retries a swap that
  does not land.
- Use _Swap Now_ to move the players at once. SLM asks for confirmation first. Use _Swap Now_ on the panel to run
  every saved swap at once.

SLM warns each player in game when they are marked for a swap, when their swap is removed, and when an admin swaps
them on the spot. A swap keeps its destination across the map roll, even though the teams change sides. A player who
leaves, or reaches their destination on their own, is dropped from the list.

Admins can do the same in game with `/swapnext`, `/swapnow`, `/swapsquadnext`, `/swapsquadnow`, `/swaps` and
`/clearswaps`. Turn on _Warn on GUI Teamswaps_ to warn your in-game admins whenever someone swaps players from the
dashboard.

### Counterbalance

Turn on _Counterbalance_ in the swaps panel to keep the teams the same size while admins edit the swaps. Whenever an
admin queues or removes a swap, SLM re-picks swaps from the other team so that the teams end up as even as possible.
Counterbalance swaps carry a scale icon and a dashed outline.

- A party is always swapped together.
- If players joining, leaving or switching teams leave the saved swaps more than one player from even for 2 minutes,
  SLM re-picks the counterbalance swaps and records the re-pick in the activity feed. Unsaved edits are never changed.
  _Roster Change Delay_ sets how long SLM waits.
- Swaps queued with an in-game command are not counterbalanced.
- Remove a counterbalance swap to have SLM pick a different player.

Use the _Teamswap Counterbalance_ server settings to choose who SLM picks:

- _Never Picked Groups_: players in these groups, from your
  [player grouping modes](../guide/configuring/players.md#player-grouping-modes), are never picked.
- _Never Picked Above_: a player with more kills or wounds, or a higher K/D, than the limit in the current match is
  never picked.
- _Picked First_: SLM ranks the remaining players by these lines, from top to bottom. A lower line only breaks ties
  left by the lines above it. A line can prefer a group, or the lowest or highest K/D, kills or wounds.

A party is skipped when any member may not be picked, and is ranked by the member who ranks lowest. A party that would
make the teams uneven again is passed over for a smaller one.

## Switch requests

Players ask to switch teams themselves with `/switch` (or a [trigger](ingame_commands.md#triggers-and-shortcuts) of
your own, such as `!switch`). Unlike an admin swap, a switch request waits for room on the other team, and lasts only
for the current match.

- If the player's team has more players than the other, SLM switches them at once.
- Otherwise they wait in line, first come first served on each side, and SLM reports each player's place.
- The first players in the two lines trade places.
- When a new player joins the team someone is waiting for, SLM moves the new player across and switches the waiting
  player into their slot.

Players type `/cancelswitch` to leave the line, and the line clears at every map roll. Admins see both lines in the
_Switch requests_ window, with each player's place and the next pair to trade, and can switch any player in it straight
away.
