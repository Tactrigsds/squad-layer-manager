# Plugins

Plugins add features to SLM. Manage them under _Plugins_ on the settings page. Doing so takes the `plugins:manage`
permission.

> [!WARNING]
> A plugin can do anything SLM can, including editing the queue, running commands on your game servers, and reading
> and changing SLM's database. Install plugins only from trusted authors.

## Built-in plugins

SLM ships with these plugins. They are installed but stopped by default.

| Plugin           | What it does                                                              |
| ---------------- | ------------------------------------------------------------------------- |
| AFK Kicker       | Kicks AFK players when people are waiting in the queue, longest AFK first |
| Balance Triggers | Watches recent match outcomes and warns admins when they look one-sided   |
| Teamkill Warns   | Warns players when they have been teamkilled                              |

## Installing a plugin

1. Get the url of the plugin's `plugin.json` from its author. The url must start with `https://`.
2. Paste it under _Install a plugin_ and click _Install_.
3. Start the plugin with its toggle.

SLM downloads the plugin and runs its own copy, so the plugin keeps working if the author's site goes down. To
upgrade the plugin, click _Refresh_ to download it again from the same url.

SLM refuses to install a plugin whose id is already installed from another url or from the plugins folder. To switch a
plugin to another url, uninstall it first.

A plugin can also be installed by copying its folder into `data/plugins` and clicking _Rescan folder_. The folder must
be named after the plugin's id. A plugin installed this way has no url, so upgrade it by replacing the folder.

Plugins cannot be installed or refreshed from a url on a demo instance, because anyone who reaches a demo signs in as an
admin.

## Running and configuring a plugin

Use a plugin's toggle to start and stop it. SLM remembers the choice across restarts. The plugin's status reads
_Running_, _Stopped_ or _Failed_. A failed plugin shows the reason, such as a configuration that is not valid, or a
plugin written for a different version of SLM.

A plugin's settings and in-game commands are edited in its row. Its commands take triggers like SLM's own (see
[Command triggers](admin_actions.md#command-triggers)). If another command already owns one of its triggers, SLM warns that the trigger does
nothing. Set a different one.

A plugin can define actions of its own that need a permission. Grant them to a role under _Plugin Grants_ (see
[Assigning permissions to roles](permissions.md#assigning-permissions-to-roles)).

When an upgraded plugin changes what it shows in the browser, open pages ask to reload. They do not reload by
themselves, so nobody loses an edit in progress.

## Uninstalling a plugin

Use _Uninstall_ to remove the plugin. SLM keeps the plugin's settings and data, so reinstalling it restores them. A
reinstalled plugin stays stopped until it is started with its toggle. To remove the settings and data as well, use
_Delete data_ under _Leftover data_. That cannot be undone.
