# Configuring SLM

This guide assumes you have a running instance of SLM. See [installing.md](installing.md) if you do not.

You configure SLM mostly from the settings page. Most settings can keep their defaults, but a few must be set before
SLM can run your server.

Open the settings page from the header:

![settings](configuring_screenshots/settings_nav.png)

Use the table of contents on the left to move between sections:

![toc](configuring_screenshots/toc.png)

Each setting has a **GUI** / **JSON** toggle, so you can also edit it as JSON. Settings that most installs never
change sit in a collapsed **Advanced** disclosure at the bottom of their section. The table of contents still lists
them, and navigating to one opens the disclosure it sits in.

### 1. Admin lists

The admin list settings are under **Permissions & Roles**.

SLM reads the standard admin list format found in `Admins.cfg`. Point it at a file mounted into the container, or at
a copy hosted over SFTP or HTTP(S).

By default, SLM treats a player with the `canseeadminchat` role as an admin. If your list uses a different role,
change this setting:

![adminlist](configuring_screenshots/adminlist.png)

An admin list identifies a player by steam ID or by EOS ID. SLM accepts both, and one list can use a mix of the two.

You can configure more than one admin list. Do this when you run several servers and each server has its own list.
Each server then names the lists that apply to it. See [2.2](#22-server-admin-lists).

The groups in your admin list do more than mark who is an admin. You can also:

- assign [SLM roles](#34-assigning-roles) to the members of a group
- [colour players by group](#6-player-groupings) in the players panel and the activity charts

When you add your first real admin list, add it to the `admins` role as well. The default assignment names only the
sandbox's own list, so a new list grants nobody the `admins` role until you name it there. See
[3.4](#34-assigning-roles).

### 2. Adding your server

One SLM instance can manage several squad servers.

A fresh install already has a server named "Sandbox". It attaches to an emulated squad server, which imitates a real
one closely enough for SLM to work against. Use it to learn the interface without touching anyone real. See
[sandbox_servers.md](sandbox_servers.md).

Click "Add Server" to set up a real one:

![add_managed_server](configuring_screenshots/add_managed_server.png)

#### 2.1. Connecting the server

Each server uses one of three connection modes:

- **local** - SLM shares the machine with the squad server. It reads `SquadGame.log` from disk and dials RCON
  directly. This gives the lowest latency for SLM's event processing. It needs a log file path and RCON details.
- **sftp** - SLM runs elsewhere. It tails the log file over SFTP, polling for new data, and dials RCON over the
  network. Use this with PSG-hosted squad servers, where you cannot run a program on the game host. It needs SFTP
  details and RCON details.
- **server agent (recommended)** - a small program on the game host handles both the log stream and RCON. SLM never
  holds the RCON password, and never has to reach the RCON port. Here it needs only a shared token. See
  [server_agent.md](server_agent.md).

If a server does not behave as you expect, open the [server console](server_console.md). It shows the RCON traffic
and the log lines as SLM receives them, which tells you whether the connection or SLM is at fault.

Squad has a voting system of its own, and it overwrites the layer SLM sets. Read [ingame_voting.md](ingame_voting.md)
before you turn it on.

#### 2.2. Server admin lists

Name which of your [configured admin lists](#1-admin-lists) apply to this server:

![server_adminlists](configuring_screenshots/server_adminlists.png)

A player counts as an admin on this server, and picks up roles from an admin list group, only through a list named
here. If you name none, SLM recognises no in-game admins on this server.

### 3. Permissions

SLM has a role-based access control (RBAC) system. A role holds a set of permissions, and you assign roles to
people. Some permissions are global. Many can be scoped to one squad server.

Unlike discord roles, SLM roles are not hierarchical: no role outranks another. Someone holds the sum of every role
they are assigned, except that a denial in any one role beats an allow in another.

#### 3.1. Super users

A fresh install has no role assignments of its own, so the `SUPER_USERS` and `SUPER_ROLES` you set in `.env` are the
bootstrap. They hold every permission unconditionally, including unlimited kick timeouts, and you cannot change them
from the settings page:

![super_users](configuring_screenshots/super_users.png)

Keep at least one after you assign real roles, so you can still get in if an assignment goes wrong.

#### 3.2. Default roles

Go to the **Permissions & Roles** section of the global settings. Three roles exist by default:

- `admins` - the features needed for day-to-day operations: the queue, votes, filters, and managing, warning,
  broadcasting to and kicking players. Maximum timeout of 2h. It is assigned to the in-game admins of the sandbox's
  own admin list, so the in-game commands work before anyone configures RBAC. Point it at your real lists as you
  add them.
- `managers` - everything `admins` can do, plus policing other people's queue notes, enabling and disabling servers,
  and restarting SLM. It can edit every global setting except the permissions config, and every server setting
  except the connection details. Maximum timeout of 6h. It cannot add a server, because adding one means supplying
  connection details.
- `owners` - every permission. Maximum timeout of 52w. It is assigned to nobody by default.

#### 3.3. Assigning permissions to roles

The **Permissions** table holds everything a role may do. Each row is one permission, with three columns:

| Column         | What it holds                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------- |
| **Effect**     | Allow or Deny. A denial overrides an allow, so use it to carve an exception out of a wider grant. |
| **Permission** | The permission itself, or `*` for all of them.                                                    |
| **Scope**      | What narrows the permission. Leave it empty to grant the permission unrestricted.                 |

A scope names specific servers, specific setting paths, or a cap such as a maximum timeout.

Settings access works the same way:

- `global-settings:write` takes dotted setting paths, such as `vote.voteDuration`, or `vote` for the whole section.
  Leave the scope empty and the role can edit every global setting. Either way it implies `global-settings:read`.
- `server-settings:write` is the same for a server's settings, and its scope can also name specific servers. It
  never reaches the connection details.
- `server-settings:write-sensitive` is a separate permission. It is the only way to view or edit a server's RCON and
  SFTP connection details.

#### 3.4. Assigning roles

You can assign a role to a user or to a player:

- a **user** signs in with their discord account and works from the web interface
- a **player** is in the game and uses the [in-game commands](#5-in-game-commands)

A user can link their discord account to their in-game account. The permissions from both then combine for every
action. This is optional. It matters for people who hold elevated permissions on their user account and want to use
them in game.

The **Assignments** subsection of a role holds five sources. Two of them cover in-game players:

- **In-game admins of these lists** - the role goes to every player an admin list counts as an admin. It applies
  only on servers that use that list.
- **Admin-list groups** - the role goes to the members of a named group in a named list, whether or not that group
  identifies admins. A whitelist reserve-slot group works here. Again, it applies only on servers that use the list.

The other three cover users, and take an individual discord user, a discord role, or every member of your discord
server:

![discord_roles](configuring_screenshots/discord_roles.png)

#### 3.5. Testing assigned permissions

Every user can see the permissions they hold, in the permissions info dialog:

![permissions_info_item](configuring_screenshots/permissions_info_item.png)
![permissions_info_dialog](configuring_screenshots/permissions_info_dialog.png)

The dialog groups permissions by role or by permission, and traces each one back to the role that granted it.

Click "Simulate Permissions" to check and uncheck roles, and see how the interface behaves for someone who holds
them:

![simulate_permissions_1](configuring_screenshots/simulate_permissions_1.png)
![simulate_permissions_2](configuring_screenshots/simulate_permissions_2.png)

The simulation runs in your browser only. The server still checks your real permissions, so any action the interface
does not gate runs with what you actually hold.

### 4. Warns, broadcasts and admin actions

The **Warns & Broadcasts** section holds the messages SLM shows to players: admin warnings, kicks, broadcasts, and
more.

Configure reasons such as teamkilling, spamming or soloing under **Admin Action Reasons**. Each reason carries one
text per action, where an action is a warn, a broadcast, a kick, a timeout, and so on:

![admin_action_reasons](configuring_screenshots/admin_action_reasons.png)

Write the texts as [mustache](https://mustache.github.io/mustache.5.html) templates. **Message Variables** in the
same section holds reusable snippets. You can use one in several texts, or inside another message variable.

**Require a Reason** makes a reason mandatory for the actions you name:

![actions_requiring_reason](configuring_screenshots/actions_requiring_reason.png)

The user can still type a freeform reason instead of choosing a configured one.

Admins then use a configured reason with the in-game `/warn`, `/broadcast`, `/kick`, `/timeout` and other commands,
as long as that reason has text for the action. If the kick action has no text for a reason, you cannot kick a
player with that reason.

![warn_details](configuring_screenshots/warn_details.png)

Reasons are also selectable when you perform an action from the interface:

![kick_dialog](configuring_screenshots/kick_dialog.png)
![kick_text_insert](configuring_screenshots/kick_text_insert.png)

### 5. In-game commands

SLM has a large set of in-game commands. The commands page in your own install documents each command and how to use
it:

![commands_page](configuring_screenshots/commands_page.png)

#### 5.1. Command prefixes

By default, every command has the prefix `/`. Change this prefix, or add another, in **Allowed Prefixes**, under
Advanced in the **In-game Commands** section:

![allowed_prefixes](configuring_screenshots/allowed_prefixes.png)

If you change an existing prefix, SLM moves every [trigger](#52-command-triggers) with that prefix to the new one.

> [!TIP]
> Pick a prefix that does not collide with the commands you already run. Some SLM commands behave differently from
> their squadjs counterparts, which confuses users. Disable the old command instead, with a message that points
> users at the SLM one.

#### 5.2. Command triggers

An in-game command runs from one of its triggers: the strings listed against it under Settings > In-game Commands.
`/timeout` and `/to` are two triggers for the same command, and typing either takes the command's arguments exactly
as written.

A trigger can also pin some of those arguments. Give it an `args` template and it becomes a shortcut, which is what
command aliases used to be:

| Trigger   | Pinned args                                  | Typed in chat           | Runs                         |
| --------- | -------------------------------------------- | ----------------------- | ---------------------------- |
| `/to`     | (none)                                       | `/to Alice 2h spamming` | `/timeout Alice 2h spamming` |
| `/to2h`   | `{{arg1}} 2h {{rest2}}`                      | `/to2h Alice spamming`  | `/timeout Alice 2h spamming` |
| `/rules`  | `Read the rules`                             | `/rules`                | `/broadcast Read the rules`  |
| `/say`    | `{{rest}}`                                   | `/say back in 5`        | `/broadcast back in 5`       |
| `/warnsp` | `{{arg1}} {{^rest2}}spam{{/rest2}}{{rest2}}` | `/warnsp Alice`         | `/warn Alice spam`           |

**The numbers count the words the caller types, not the words of the command that ends up running.** `{{arg1}}` is
the first word typed after the trigger, `{{arg2}}` the second, and so on. `{{restN}}` is the Nth word typed onwards,
joined by spaces, and `{{rest}}` is all of them. Use `{{restN}}` for anything that can be more than one word, such
as a reason.

Pinned text sits outside that counting, which is what makes `{{arg1}} 2h {{rest2}}` read correctly. The caller never
types the duration, so nothing indexes it.

```
they type:   Alice      spamming badly
             {{arg1}}   {{rest2}}          <- the numbers count these words
it runs:     Alice  2h  spamming badly
                    ^^ pinned text, never typed, so no placeholder refers to it
```

Once a trigger has pinned arguments, the command's card in Settings > In-game Commands shows which placeholder fills
which argument (`{{arg1}} <player>  {{arg2}} <duration>  {{rest3}} <reason|message>`), including whether each one is
required under the current reason settings.

A word that is left out renders as nothing and its token drops out, which is what makes it optional: `/to2h Alice`
runs `/timeout Alice 2h` with no reason. `{{^arg2}}fallback{{/arg2}}` puts something in its place instead. Words the
template never mentions are ignored.

A pinned-argument template is not the same as writing `{{rest}}`. A placeholder stands for one word when the
arguments are worked out, so `{{rest}}` alone means "the player, and nothing else" rather than "everything as
typed". Leave the args off entirely for a plain trigger.

Every trigger string across every command shares one namespace, and two commands cannot claim the same one. A
trigger runs in its command's allowed chats, so pinning arguments cannot turn a public trigger into an admin
command. What it can do is let a public trigger pass a player's own words into a public command's free-text
argument, which is worth keeping in mind when writing one.

The commands page lists a command's shortcut triggers under its details, and searching for one finds the command it
runs. `!help` lists each shortcut on its own line, since it asks the caller for something different.

### 6. Player groupings

A player grouping sorts players into named, coloured groups, for administration and for balance. Configure them
under **Players & Balance**.

A grouping is an ordered list of rules. A player joins the group of the first rule they match, so an earlier rule
takes precedence over a later one.

A rule can match on:

- a battlemetrics player flag
- an [admin list group](#1-admin-lists)
- a regex on the player's username, which includes any tags they have configured
- a discord role, if the player's steam account is linked to their discord account

Here is a grouping keyed on admin list groups:

![player_groupings](configuring_screenshots/player_groupings.png)

And here is TacTrig's grouping for balance:

![player_groupings_balance](configuring_screenshots/player_groupings_balance.png)

> [!NOTE]
> Maintaining discord to steam account links is a manual process today. A REST api that lets external tools manage
> the links is planned.

SLM then colour-codes the usernames of grouped players wherever they appear:

![color_coded_usernames](configuring_screenshots/color_coded_usernames.png)

The players panel and the activity charts pick which grouping to show, and the stats panel breaks the population
down by it:

![teams_breakdown](configuring_screenshots/teams_breakdown.png)

### 7. Player flagging

You can apply a battlemetrics flag to a player from in game with the `/flag` command, or from the SLM interface:

![flag_command](configuring_screenshots/flag_command.png)
![flag_gui](configuring_screenshots/flag_gui.png)

A user can add a reason for the flag, which SLM posts as a note on the player's battlemetrics profile. The note is
freeform text for now, and is not connected to the
[admin action reasons](#4-warns-broadcasts-and-admin-actions). This may change.

To require a note for a particular flag, name it in **Player Flags Requiring Note**:

![player_flags_requiring_note](configuring_screenshots/player_flags_requiring_note.png)
![player_flags_requiring_note_enforced](configuring_screenshots/player_flags_requiring_note_enforced.png)

A flag set from the battlemetrics interface can take a while to reach SLM's interface. SLM caches battlemetrics data
aggressively to stay inside their rate limits. To see a change immediately, purge the cache for that player with the
"refresh" button:

![flags_refresh](configuring_screenshots/flags_refresh.png)

SLM refreshes a player's flags automatically when it changes them itself.

### 8. Layer table

#### 8.1. Default displayed columns

The layer table can show more about each layer than it does by default, and each column it shows is another way to
filter. Configure the columns under **Layers > Layer Table**. They apply to the layers table and to every layer
select menu, such as the Explore Layers and Add Layers dialogs:

![layer_table_columns](configuring_screenshots/layer_table_columns.png)

Drag a column to reorder it, and use its toggle to set whether it is visible by default. The same setting holds the
table's default sort and the extra comparison controls its filter menu offers.

See [layer_data.md](layer_data.md) for where this data comes from, and how to build your own.

#### 8.2. Randomization

**Layer Generation Weights** controls how SLM picks layers at random. It covers layer generation, which runs when
the queue runs out of layers, vote generation, and the layer table's random sort.

Generation walks down a configurable pick order of layer columns and matchups:

![layer_weights_pick_order](configuring_screenshots/layer_weights_pick_order.png)

At each step it draws one value at random, weighted by the weights you configure for that column, and the draw
narrows the pool the next step draws from:

![layer_weights_maps](configuring_screenshots/layer_weights_maps.png)

A value you do not list weighs 0.1. Matchups are unordered, so `[ADF, PLA]` and `[PLA, ADF]` are one entry.

Generation keeps going down the pick order until one layer remains, or until the pick order runs out. In that case
it picks one of the remaining layers at random.

The weights are relative, not probabilities. SLM normalizes them against the values actually available at pick time,
and a value with no layers left is never picked. Your background filtering and the values already picked both narrow
what remains, so configured weights do not map cleanly onto the shares you end up seeing.
