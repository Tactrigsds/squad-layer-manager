# Integrations

SLM connects to BattleMetrics, the Squad Browser and Steam, and to Discord through its bot. The first three are
optional, though BattleMetrics is _highly_ recommended. Each service's API token is stored in SLM's settings, under
_Integrations_ on the settings page, rather than in an environment variable. A saved token is encrypted at rest and
cannot be read back from the settings page.

## BattleMetrics

BattleMetrics lets admins set player flags and post notes from the game and the dashboard, and shows a player's flags,
notes and profile beside the actions taken against them. With no token, SLM hides the parts of the app that show flags.

1. Create a personal access token on BattleMetrics with these permissions:
   - player flags: add and remove. It does not need to create new ones.
   - player notes: read and create
   - rcon: read
2. Enter the token under _Integrations_.
3. Set _Organization ID_ to your organization's BattleMetrics ID. SLM shows only the flags that belong to it.

## The join button

The join button on the server dashboard opens the server in Squad. Configure the Squad Browser, Steam or both for the
button to appear.

- **Squad Browser** finds a server by the name it reports over RCON, whether or not anyone is playing. Enter a Squad
  Browser API key, which starts with `sqb_`.
- **Steam** builds the link from the lobby of a player in game. It answers only while someone is on the server, and
  only for players whose Steam profile makes game details public. Enter a web API key from
  https://steamcommunity.com/dev/apikey.

With both configured, SLM asks the Squad Browser first, and Steam covers the servers the Squad Browser does not list.
A sandbox server never shows the button.

## Discord bot

When a link to a selection of events from the history page is posted in Discord, the SLM bot replies with the events
as a text file. The reply names the number of events and the time zone of their times. Times are in the time zone the
link names. A link with no time zone of its own uses the `defaultTimeZone` setting, which by default is the `timeZone`
setting of the server the events are from. The bot replies only to
people whose roles grant `history:query`.

The replies need _Message Content Intent_, on the _Bot_ page of your Discord app. Without it, the
`discord.expandHistoryLinks` setting shows a warning. Turn that setting off to stop the replies.

The bot replies only in channels where its role has these permissions:

- View Channel
- Send Messages
- Read Message History
- Attach Files

Grant them in one of two ways:

- **On a role:** give the bot a role with these permissions, in _Server Settings > Roles_. The bot replies in every
  channel.
- **Per channel:** add the permissions for the bot's role in each channel's _Edit Channel > Permissions_. The bot
  replies only in those channels.
