# Monitoring and history

SLM records what happens on your servers. Follow the live match in the activity feed, chart the teams, the score and
the player count, and search every past event, player and match.

## Server activity

The activity feed records events from the Squad server and from SLM as they happen: chat, kills, joins and leaves,
admin actions, queue edits and more. SLM collapses repeats of noisy events into one line, and the feed can be filtered
by event type.

![the activity feed](../images/features/activity_feed.png)

A range of events can be selected and copied as text, or shared as a link that opens on those events.

![a selection of events with its context menu](../images/features/history_selection.png)

### Messaging admins and players

Use the chat box at the bottom of the activity feed to message the server without joining the game. A message can warn
every online admin, broadcast to the whole server, or warn the players selected in the teams panel, and can carry the
sender's name.

![the chat box's targets](../images/features/chat_box.png)

## Match history

The match history lists each match's layer, length, outcome and who set it. Open a match to read its log and how the
teams were made up, or drag the match into the queue to play its layer again.

![the match history](../images/features/match_history.png)

The activity feed and the match history each fill a tab of their own on a phone.

![the activity feed on a phone](../images/features/phone_activity.png)
![the match history on a phone](../images/features/phone_matches.png)

## Charts

The _Charts_ panel displays charts of the live match, or of a match opened from the match history. Each chart can also
open in a window of its own.

### Teams breakdown

The _Teams Breakdown_ chart counts each team's players by group of the chosen grouping mode. A grouping mode sorts
players into groups, such as by admin list group or BattleMetrics flag (see
[Teams and balance](player_management.md#teams-and-balance)). A segment of the chart filters the teams panel to its
group.

![group counts per team](../images/features/teams_breakdown.png)

### Scoreline

The _Scoreline_ chart lists each team's tickets, kills, deaths and wounds, and plots kills, deaths or the kill lead
across the match. The kill lead is how far one team's kills are ahead of the other's, shaded in the leading team's
colour.

![the kill lead across a match](../images/features/scoreline.png)

### Population

The _Population_ chart plots how many players were on the server, over one match or over the last 6 hours, 24 hours or
7 days. The chart splits the players into active and idle players (see
[Idle players](../guide/configuring/players.md#idle-players)), or draws a line per team. Lines mark where each match
started and where its round ended, and a match picked on the chart opens in the panel and the activity feed.

![the player count across a match, split into active and idle players](../images/features/population.png)

![the player count of each team across the same match](../images/features/population_teams.png)

_Stats_ lists figures over the same time: the peak and lowest player count, the average and median, how long the
server was full, the share of idle players, the gap between the teams, joins and leaves per hour, and the churn rate,
the share of the players who leave each hour.

![population figures over six hours](../images/features/population_stats.png)

## The history page

Use the history page to search past events, players and matches by player, time, event type, layer, outcome and more.
A query can be saved privately or shared with other admins, and results export as text or CSV.

A player can be searched by a Steam or EOS ID, or by part of any username they have gone by, including previous ones.

![the history page](../images/features/history.png)

### Time zones

The history page shows times in the browser's time zone by default. Use the _Time zone_ field to show them in UTC, in a
server's time zone, or in any IANA time zone such as `Europe/Berlin`. The _From_ and _To_ bounds are entered in the same
zone. A saved query or a shared link keeps its time zone.

A server's time zone is set by its `timeZone` setting, which is UTC by default.

### Players and matches

The _Players_ and _Matches_ tabs group the events a query finds by player or by match. Each row counts the events
behind it. Expand a row to read those events in place.

A player row lists the player's Steam and EOS IDs, how many matches they played, how many chat messages they sent, and
when they were last seen. A query can find regulars by their match count, or every player who was warned in the last
week.

![players grouped with their events, one expanded](../images/features/history_players.png)

A match row lists the match's layer, outcome, ticket and kill differences, length, and who set the layer. Matches can
be narrowed by outcome, ticket difference, length, kills or map, such as to find every one-sided match on a map.

![matches grouped with their events, one expanded](../images/features/history_matches.png)

When a link to a selection of events is posted in Discord, SLM replies with the events attached as a text file. See
[Discord](integrations_and_hosting.md#discord).
