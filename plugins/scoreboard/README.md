# scoreboard

Posts a scoreboard to a Discord channel when a match ends.

The scoreboard names the layer, each team's kills, the winner, its remaining tickets and the match's length. Below
that come the leaderboards, and two charts: each team's kills over the match, and each team's tickets over the match.
The footer shows the match id. Filter SLM's history page by this id to find the match. When more than one enabled
server is a real Squad server rather than a sandbox, the server's name is shown above the title.

## Leaderboards

| Leaderboard         | Counts                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| Top Fraggers        | kills of enemy players, and enemy players wounded, ranked by kills             |
| Squad Kills         | kills by the members of each squad                                             |
| Combat Medic        | revives                                                                        |
| Vehicles            | damage dealt to enemy vehicles, and enemy vehicles destroyed, ranked by damage |
| FOB/HAB Destroyer   | enemy FOB radios taken down to their minimum health, and enemy HABs destroyed  |
| Longest Kill Streak | the most kills a player made without dying in between                          |
| Best K/D            | kills per death, for players with at least `minKillsForKd` kills               |
| Most Deaths         | deaths, including teamkills and suicides                                       |
| Most Teamkills      | teammates killed                                                               |

A leaderboard nobody scored on is left out.

## Settings

- `enabledServers`: the servers to post scoreboards for.
- `channel`: the Discord channel to post to. The SLM bot needs Send Messages, Embed Links and Attach Files there.
- `title`: the scoreboard's title. `{{server}}`, `{{map}}` and `{{layer}}` are replaced with the server's name in
  SLM, the map and the layer.
- `minMatchMinutes`: matches shorter than this many minutes get no scoreboard. Seed and training layers never
  get one.
- `leaderboardSize`: how many players or squads each leaderboard lists.
- `minKillsForKd`: the fewest kills a player needs to appear under Best K/D.

The plugin posts nothing while SLM's Discord integration is off.
