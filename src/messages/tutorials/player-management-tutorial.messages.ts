import type React from 'react'

import { def, rt } from '@/models/messages.models'

// Copy for the player management tutorial, in tour order. The steps are src/systems/tutorials/player-management.steps.ts.
// A {commands} or {command} parameter is a rendered list of chat commands, each linking to its entry on the
// commands page, built from the install's own triggers.

export const welcome = {
	title: def('Welcome'),
	body: def(
		rt(
			`<p>This tutorial covers finding, moderating and moving players.</p>
<p>It runs on a sandbox server of its own, with sixteen made-up players on it. Nothing you do here reaches a real server.</p>`,
		),
	),
}

export namespace Activity {
	export const panel = {
		title: def('Server Activity'),
		body: def(
			rt(
				`<p><em>Server Activity</em> is a live log of the current match: chat, players joining and leaving, admin actions, warnings, and what SLM itself does.</p>
<p>Everything you do in this tutorial shows up here too.</p>`,
			),
		),
	}
	export const filter = {
		title: def('Filter the log'),
		body: def(
			rt(
				`<p>Pick which events the log shows:</p>
<ul>
<li><em>All</em>: everything.</li>
<li><em>Default</em>: everything except the killfeed and players joining or leaving squads. Teamkills still show, including of vehicles, deployables and FOB radios.</li>
<li><em>Chat</em>: chat on every channel, broadcasts, and warnings sent through SLM.</li>
<li><em>SLM Events</em>: what SLM and its users did, such as setting the next layer or warning a player.</li>
<li><em>Admin</em>: SLM events plus admin chat, broadcasts, admins joining and leaving, and admin actions such as kicks, bans and entering admin camera.</li>
<li><em>Killfeed</em>: kills, wounds, vehicles and deployables destroyed, and FOB radios under attack.</li>
<li><em>Vehicles & Deployables</em>: vehicles and deployables destroyed, and FOB radios under attack.</li>
</ul>
<p><em>Selected Only</em> narrows the log to the players you have selected in the teams table. We will get to selecting players shortly.</p>`,
			),
		),
	}
	export const select = {
		title: def('Select events'),
		body: def(
			rt("Click an event's time to select it. Shift+click another time, or drag down the times, to select everything between them."),
		),
	}
	export const copy = {
		title: def('Copy events'),
		body: def(
			rt(
				`<p>Press Ctrl+C to copy the selected events as text.</p>
<p>Right-click the selection for <em>Copy selection as text</em> and <em>Copy link to selection</em>. The link opens the same events on the history page. Press Esc to clear the selection.</p>`,
			),
		),
	}
	export const warnBox = {
		title: def('Message the server'),
		body: def(
			rt(
				`<p>Send messages from the box under the log. Pick who it goes to here:</p>
<ul>
<li><em>Admins</em> warns every admin online.</li>
<li><em>Broadcast</em> shows the message to everyone on the server.</li>
<li><em>Selected</em> warns the players you have selected in the teams table.</li>
</ul>
<p>Press Enter to send.</p>`,
			),
		),
	}
	export const warnSelected = {
		title: def('Warn the selection'),
		body: def(
			rt(
				`<p>With players selected, the box under the log switches to <em>Selected</em> on its own, so one message warns all of them. Try it.</p>
<p>Clearing the selection switches it back to <em>Admins</em>.</p>`,
			),
		),
	}
}

export namespace MatchHistory {
	export const overview = {
		title: def('Match History'),
		body: def(
			rt(
				`<p><em>Match History</em> lists the matches played on this server, oldest at the top. The one marked with <play></play> is being played now, and the numbers beside the others count back from it.</p>
<p>This server has played two matches before yours.</p>`,
			),
		),
	}
	export const time = {
		title: def('When and how long'),
		body: def(rt('When the match started and how long it ran. Hover it to see how long ago that was.')),
	}
	export const outcome = {
		title: def('Result'),
		body: def(rt("Which team won, with each team's tickets left at the end.")),
	}
	export const kd = {
		title: def('Kills and deaths'),
		body: def(
			rt("The kill/death ratio of the team that did better, pointing at that team. Hover it for both teams' kills, wounds and deaths."),
		),
	}
	export const setBy = {
		title: def('Set by'),
		body: def(
			rt("Who set the layer: a user, SLM's queue generator, a vote, a plugin or the game server itself. Hover the icon to see which."),
		),
	}
	export const open = {
		title: def('Look back at a match'),
		body: def(rt('Click a finished match to look back at it.')),
	}
	export const viewing = {
		title: def('Viewing a past match'),
		body: def(
			rt(
				`<p><em>Server Activity</em> now shows that match's log instead of the live one, and the <em>Charts</em> panel shows who played in it.</p>
<p>Switch between the log and a list of the match's teams at the top of the panel.</p>`,
			),
		),
	}
	export const arrows = {
		title: def('Step between matches'),
		body: def(rt('These arrows move to the match before or after the one you are viewing.')),
	}
	export const live = {
		title: def('Back to live'),
		body: def(rt('Click here to go back to the match being played now.')),
	}
	export const days = {
		title: def('Earlier days'),
		body: def(rt('Matches are listed a day at a time. Page back through earlier days here.')),
	}
}

export const findTeamsTab = {
	title: def('Open the teams'),
	body: def(rt('The players on the server are listed under <em>Teams</em>. Click the tab to open it.')),
}

export const findTeamsStacked = {
	title: def('The teams'),
	body: def(rt('The players on the server are listed here, under <em>Teams</em>.')),
}

export const teamsHeader = {
	title: def('Teams header'),
	body: def(
		rt(
			`<p>Each team's name and faction are at either end, with the player count for each side between them.</p>
<p>The controls below are for searching, filtering and selecting players. We will come back to them.</p>`,
		),
	),
}

export const groupingsColumn = {
	title: def('Groups'),
	body: def(
		rt(
			`<p>The <em>Group</em> column shows each player's group. A grouping mode sorts players into groups by rules, such as the admin list or a BattleMetrics flag, so different kinds of players are easy to tell apart. Players who match no rule are counted as <em>Other</em>.</p>
<p>Grouping modes are set up by users with sufficient permissions. See the <groupingsDocs>grouping modes documentation</groupingsDocs> for how.</p>`,
		),
	),
}

export const groupingModes = {
	title: def('Grouping modes'),
	body: def(
		rt(
			'Each <em>grouping mode</em> is a different way of sorting the same players, for a job such as team balance, clans or a watchlist. Pick which one the table and the breakdown use here.',
		),
	),
}

export const breakdown = {
	title: def('Teams Breakdown'),
	body: def(
		rt(
			`<p>The <em>Teams Breakdown</em> chart in the <em>Charts</em> panel counts everyone on the server by team, split into the groups of the chosen grouping mode.</p>
<p>It follows the grouping mode picked in the teams header.</p>`,
		),
	),
}

export const breakdownHover = {
	title: def('Who is in a group'),
	body: def(rt('Hover a segment to list the players in that group on that team.')),
}

export const breakdownFilter = {
	title: def('Filter by a group'),
	body: def((group: string) =>
		rt('Click a segment to filter the teams table to that group. Try clicking <em>{group}</em>.', {
			group,
		}),
	),
}

export const breakdownSelect = {
	title: def('Select a group'),
	body: def(
		rt(
			`<p>The table now shows only that group. Clicking the same segment again lifts the filter.</p>
<p>Shift+click a segment to select that team's players in the group. Ctrl+Shift+click selects the group on both teams. Try one of them.</p>`,
		),
	),
}

export const breakdownUnmatched = {
	title: def('Unmatched groups'),
	body: def(rt("Groups with nobody in them on this server are collected here, so they don't take up room in the chart.")),
}

export const breakdownHistory = {
	title: def('Past matches'),
	body: def(
		rt(
			`<p>Pick a finished match in Match History and the breakdown shows that match's players instead, each counted for the team they spent most of the match on.</p>
<p>Its segments can't be clicked then, since the teams table only lists who is on the server now.</p>`,
		),
	),
}

export const columnFilter = {
	title: def('Filter a column'),
	body: def((squad: string) =>
		rt(
			'The <em>Group</em>, <em>Squad</em> and <em>Role</em> columns each have a filter under their heading. Try filtering <em>Squad</em> to <em>{squad}</em>.',
			{ squad },
		),
	),
}

export const removeFilter = {
	title: def('Remove the filter'),
	body: def(
		rt(
			`<p>Pick <em>All</em> in the filter to remove it. Middle-clicking a column heading also resets its filter and sorting.</p>
<p>Remove every filter to continue, including the group filter from the breakdown.</p>`,
		),
	),
}

export const search = {
	title: def('Search'),
	body: def(
		rt(
			`<p>Search by name, or by any player ID: Steam, EOS and so on. Names match without regard to case or spaces, but have to contain what you type.</p>
<p>Press Enter to select every player that matches.</p>`,
		),
	),
}

export const squadSorting = {
	title: def('Squads'),
	body: def(
		rt(
			`<p>The table is sorted by squad, with each squad under a header row. Click a header row to fold its squad away. Click any column heading to sort by that column instead.</p>
<p>Click a squad's number to open its details. Shift+click it to select the whole squad.</p>`,
		),
	),
}

export const showSpoilers = {
	title: def('Hidden columns'),
	body: def(
		rt(
			'Role and kills, wounds and deaths are hidden by default, since they can give an in-game advantage. Turn on <em>Show Spoilers</em> to show them.',
		),
	),
}

export const scoreSorting = {
	title: def('Sort by score'),
	body: def(rt('Click <em>K/W/D</em> to sort by kills, wounds or deaths, highest or lowest first.')),
}

export const selecting = {
	title: def('Select players'),
	body: def(
		rt(
			`<p>Click a row anywhere except the name to select that player. Drag across rows to select several.</p>
<p>Selected players are what the bulk actions and the activity feed's <em>Selected Only</em> filter act on. Some shortcuts:</p>
<ul>
<li>Shift+click a squad number to select the squad.</li>
<li>Shift+click an admin or squad leader badge to select every admin or squad leader on that team. Add Ctrl for both teams.</li>
<li>Shift+click the select-all box to select a whole team.</li>
</ul>
<p>Select a player to continue.</p>`,
		),
	),
}

export const resetPanel = {
	title: def('Reset the table'),
	body: def(
		rt(
			`<p><em>Show Selected</em> narrows the table to your selection.</p>
<p>The <trash></trash> button clears selections, filters, sorting and search in one go. Click it to continue.</p>`,
		),
	),
}

export namespace PlayerDetails {
	export const open = {
		title: def('Player details'),
		body: def((player: string) => rt("Click a player's name to open their details. Try <em>{player}</em>.", { player })),
	}
	export const window = {
		title: def('Player details'),
		body: def(rt('The player details window. It stays open while you work elsewhere. A quick tour:')),
	}
	export const ids = {
		title: def('IDs and links'),
		body: def(rt("Click an ID to copy it. The links open the player's profiles on Steam, BattleMetrics and elsewhere.")),
	}
	export const tags = {
		title: def('Groups and flags'),
		body: def(
			rt(
				"The player's in-game groups, BattleMetrics flags and SLM groups are shown here. Flags can be added or removed here too. The made-up players on this server have no flags.",
			),
		),
	}
	export const activity = {
		title: def('Player activity'),
		body: def(
			rt('Everything this player has done on the server: chat, kills, joins, warns and so on. It shows the current match by default.'),
		),
	}
}

export namespace Warn {
	export const box = {
		title: def('Warn a player'),
		body: def(
			rt('Type a message here and press Enter to warn this player. A warning shows on their screen in game, and in the activity feed.'),
		),
	}
	export const options = {
		title: def('Warn options'),
		body: def(rt('Choose whether other admins are told about the warning, and whether your name is shown at the start of it.')),
	}
	export const presets = {
		title: def('Preset reasons'),
		body: def(
			rt('Preset warnings are listed here. Users with sufficient permissions can edit them in the settings. Pick one and send it.'),
		),
	}
	export const ingame = {
		title: def('Warning from in game'),
		body: def((commands: React.ReactNode) =>
			rt(
				`<p>Admins can warn from in-game chat too:</p>
{commands}
<p>Close the details window to continue.</p>`,
				{ commands },
			),
		),
	}
	export const squad = {
		title: def('Warn a squad'),
		body: def((squad: string, commands: React.ReactNode) =>
			rt(
				`<p>Right-click a squad's header row for the squad actions menu. Try warning <em>{squad}</em> with <em>Warn Squad</em>.</p>
<p>Most player actions have a squad version in this menu, such as kick, timeout and swap. Each has its own squad command. From in game:</p>
{commands}`,
				{ squad, commands },
			),
		),
	}
}

export const actionsMenu = {
	title: def('Player actions'),
	body: def(
		rt(
			`<p>Right-click a player's row, or their name wherever it appears, to open their actions.</p>
<p>With more than one player selected, right-clicking a selected row acts on all of them.</p>`,
		),
	),
}

export namespace Kick {
	export const kick = {
		title: def('Kick'),
		body: def((player: string) =>
			rt(
				`<p><em>{player}</em> has been abusive in all chat. You can see it in the activity log.</p>
<p>Right-click <em>{player}</em> and pick <em>Kick</em>. Adding a reason is optional, and preset reasons are available.</p>`,
				{ player },
			),
		),
	}
	export const ingame = {
		title: def('Kicking from in game'),
		body: def((commands: React.ReactNode) => rt('<p>The player has left the server. From in-game chat:</p>{commands}', { commands })),
	}
}

export namespace Timeouts {
	export const timeout = {
		title: def('Timeout'),
		body: def((player: string) =>
			rt(
				`<p><em>{player}</em> was already warned for teamkilling. A timeout kicks a player, and kicks them again whenever they rejoin any server SLM manages, until it runs out.</p>
<p>Right-click <em>{player}</em>, pick <em>Timeout</em>, and time them out for <code>15m</code>.</p>`,
				{ player },
			),
		),
	}
	export const openList = {
		title: def('Active timeouts'),
		body: def(rt('Click <em>Timeouts</em> to see every active timeout.')),
	}
	export const list = {
		title: def('Timeouts'),
		body: def(rt('Each timeout shows who it is for, when it runs out, why and who issued it. Cancel the one you just made.')),
	}
	export const ingame = {
		title: def('Timeouts from in game'),
		body: def((commands: React.ReactNode) =>
			rt(
				`<p>From in-game chat:</p>
{commands}
<p>Clearing a timeout works on players who are offline. Close the window to continue.</p>`,
				{ commands },
			),
		),
	}
}

export namespace SwapNow {
	export const swap = {
		title: def('Swap now'),
		body: def((player: string) =>
			rt('<em>Swap Now</em> moves a player to the other team straight away. Right-click <em>{player}</em> and try it.', {
				player,
			}),
		),
	}
	export const ingame = {
		title: def('Swapping from in game'),
		body: def((commands: React.ReactNode) => rt('<p>From in-game chat:</p>{commands}', { commands })),
	}
}

export namespace Teamswaps {
	export const swapNext = {
		title: def('Swap next'),
		body: def((player: string) =>
			rt(
				'<em>Swap Next</em> moves a player to the other team when the next match starts. Right-click <em>{player}</em> and pick <em>Swap Next</em>.',
				{ player },
			),
		),
	}
	export const panel = {
		title: def('Team swaps'),
		body: def(
			rt(
				`<p>Pending swaps are listed under the team each player is moving to. <em>Teams After Swap</em> shows the player counts once they have gone through.</p>
<p>Adding a swap started an edit. Your changes are not saved yet, and other users can see that you are editing.</p>`,
			),
		),
	}
	export const addMore = {
		title: def('Add more swaps'),
		body: def(rt('Select a few more players, right-click one of the selected rows and pick <em>Swap Next</em> to add them all at once.')),
	}
	export const remove = {
		title: def('Remove a swap'),
		body: def(rt('Click <remove></remove> on a swap, or middle-click it, to remove it. The <trash></trash> button clears a whole side.')),
	}
	export const save = {
		title: def('Save'),
		body: def(
			rt(
				`<p>Swaps are edited together, the same way as the layer queue. Everyone edits one shared set of changes, and nothing is saved until everyone editing has finished.</p>
<p>While anyone else is still editing, the button reads <em>Finish Editing</em> instead of <em>Save</em>: it ends your edit and leaves the changes for the last editor to save. <em>Force Save</em> (<sword></sword>) saves them anyway and ends everyone's edit.</p>
<p>Only saved swaps run. Click <em>Save</em> to keep yours.</p>`,
			),
		),
	}
	export const execute = {
		title: def('Swap now'),
		body: def(
			rt(
				`<p>Saved swaps run when the next match starts.</p>
<p>This <em>Swap Now</em> moves everyone in the list straight away, after asking you to confirm. It is unavailable while anyone is editing the swaps.</p>`,
			),
		),
	}
	export const ingame = {
		title: def('Team swaps from in game'),
		body: def((commands: React.ReactNode) => rt('<p>From in-game chat:</p>{commands}', { commands })),
	}
}

export const otherActions = {
	title: def('Other player actions'),
	body: def((commands: React.ReactNode) =>
		rt(
			`<p>The actions menu has a few more:</p>
<ul>
<li><em>Kill</em>, <em>Remove from Squad</em>, <em>Disband Squad</em> and <em>Demote Commander</em> do what they say, and can take a reason.</li>
<li><em>Reset Squad Name</em> renames a squad back to its default.</li>
<li><em>Manage Flags</em> adds or removes BattleMetrics flags, when BattleMetrics is set up.</li>
<li><em>Copy Teleport Command</em> copies the console command that teleports you to the player.</li>
</ul>
<p>From in-game chat:</p>
{commands}`,
			{ commands },
		),
	),
}

export namespace SwitchQueue {
	export const request = {
		title: def('Switch requests'),
		body: def((player: string, command: React.ReactNode) =>
			rt(
				`<p>Players can ask to switch teams by typing {command} in chat. <em>{player}</em> just did.</p>
<p>A player whose team can spare them is moved straight away. Otherwise they wait in line.</p>`,
				{ player, command },
			),
		),
	}
	export const openWindow = {
		title: def('The switch queue'),
		body: def(rt('Click <em>Switch requests</em> to see who is waiting.')),
	}
	export const window = {
		title: def('The switch queue'),
		body: def(
			rt(
				`<p>Players wait in the order they asked, on each side. When two players on opposite sides are both waiting, they trade places automatically. Players also move as space opens up on the other team.</p>
<p>The queue is cleared at the end of every match.</p>`,
			),
		),
	}
	export const switchNow = {
		title: def('Switch now'),
		body: def(rt('Click <swap></swap> to move a waiting player straight away, ahead of the queue. Try it.')),
	}
	export const ingame = {
		title: def('Switching from in game'),
		body: def((commands: React.ReactNode) =>
			rt('<p>What players can type:</p>{commands}<p>Close the window to continue.</p>', { commands }),
		),
	}
}

export const finish = {
	title: def('Done'),
	body: def((help: React.ReactNode) =>
		rt(
			`<p>That's player management.</p>
<p>In game, {help} lists the commands in a section, such as <code>moderation</code>, <code>teamswaps</code> or <code>switchRequests</code>. Every command is also on the <commandsPage>commands page</commandsPage>.</p>`,
			{ help },
		),
	),
}
