import { def, rt } from '@/models/messages.models'

export const welcome = {
	title: def('Welcome'),
	body: def(
		'Welcome to the player management tutorial! Here, you will learn how to monitor, manage and communicate with players on the server.',
	),
}

export const navToTeamsTab = {
	title: def('Navigate to the teams tab'),
	body: def(rt('Click here to navigate to the <em>teams tab</em>')),
}

export const intro = {
	title: def('Teams Tab'),
	body: def(rt("Let's go on a quick tour:")),
}

export const basicInfo = {
	title: def('Teams Info'),
	body: def('basic info about each team is shown here'),
}

export const teamsTable = {
	title: def('Player tables'),
	body: def(
		'All players currently on the server are shown here. There may be a separate table for each team if the viewport is large enough, but otherwise players will be merged into a single table.',
	),
}
export const showSpoilers = {
	title: def('Hidden Columns'),
	body: def(
		rt(
			'Some of the columns that are likely to provide an ingame advantage are hidden by default. click <em>Show Spoilers</em> to reveal them.',
		),
	),
}
export const groupingsColumn = {
	title: def('Groupings'),
	body: def(
		rt(
			'The groupings column displays the chosen <em>Grouping</em> for each player. <em>Player Groupings</em> are a powerful categorization tool that make it easy to distinguish between diferent <i>kinds</i> of players at a glance. <a>click here</a> for documentation on how to set up player groupings for your SLM instance, if you have permissions to do so.',
		),
	),
}
export const filterGroups = {
	title: def('filter groupings'),
}

export const groupingModes = {
	title: def('grouping modes'),
	body: def(
		rt(
			'Different <em>grouping modes</em> may be configured for different tasks, like determining team balance, distinguishing clans, or to highlight watchlisted players. Switch between them here.',
		),
	),
}

export const teamsBreakdown = {
	title: def('Teams Breakdown'),
	body: def(
		rt(
			'An overview of the different <em>groups</em> of players can be seen here. Mouse over a group to see a list of all players in that group, and Click on a group to filter the table to show only that group.',
		),
	),
}

export const killDeathRatio = {
	title: def('Kill/death ratio'),
	body: def(
		rt(
			"Each team's kill and wound/down ratios are displayed here. These ratios are often meaningfully different depending on the number of revives each team is getting.",
		),
	),
}

export const filterColumns = {
	title: def('Filter columns'),
	body: def((filterGroup: string) =>
		rt(
			'Click here to filter columns to only display players with specific criteria. Try filtering to only display players of group "{group}. Note that selecting the filter on either teams table applies <i>across</i> teams"',
			{ group: filterGroup },
		),
	),
}
export const removeFilter = {
	title: def('Remove the filter filter'),
	body: def(rt('Select "All" instead, or middle-click on it to remove the filter.')),
}

export const searchingPlayers = {
	title: def('Searching players'),
	body: def(
		rt(
			'Search for players by name, or any known player id(steamid, eos, etc). name searches are case-insensitive and ignore whitespace, but require exact substring matches.',
		),
	),
}

export const squadSorting = {
	title: def('Squads'),
	body: def(rt('By default, the table is sorted by <em>Squad</em>. In this mode, you can <em>select</em> ')),
}

export const openPlayerScoreSorting = {
	title: def('Open player score sorting'),
	body: def(rt('Advanced sorting is available for player scores. Click the here to see it:')),
}

export const playerScoreSorting = {
	title: def('Player score sorting'),
	body: def(
		rt(
			'Players can be sorted by <em>kills</em>, <em>wounds</em>, and <em>deaths</em>, in either <em>descending</em> or <em>ascending</em> order.',
		),
	),
}
export namespace PlayerDetailsWindow {
	export const openPlayerDetails = {
		title: def('Open player Details'),
		body: def(rt('More information about a player can be viewed by clicking on their username.')),
	}
	export const playerDetails = {
		title: def('Player Details'),
		body: def(rt('This is the player details window. A quick tour:')),
	}
	export const flags = {
		title: def('Player Flags'),
		body: def(
			rt(
				'They may not be available in our tutorial sandbox, but <em>Player flags</em>, sourced from battlemetrics, will be shown, and can be added/removed here.',
			),
		),
	}
	export const idsAndLinks = {
		title: def('ids and links'),
		body: def(rt('Player Ids and external links are available here')),
	}
	export const serverActivity = {
		title: def('Server Activity'),
		body: def(rt("The player's server activity is shown here. By default, only events from current match are shown.")),
	}
	export const warnPlayer = {
		title: def('Warn the player'),
		body: def(rt('Allows communicating with this player in the form of a warning.')),
	}
	export const warnOptions = {
		title: def('Warn Options'),
		body: def(rt('Choose whether to notify admins of your warn, or whether to include your name in the warning here.')),
	}
	export const presetWarns = {
		title: def('Preset warnings'),
		body: def((settingsHref: string) =>
			rt(
				`Preset warning texts are available here. If you have access, these are configurable in the settings <a href="{settingsHref}" target="_blank">here</a>.
Try selecting one of the preset reasons. and sending the warn.`,
				{ settingsHref },
			),
		),
	}
	export const ingameWarns = {
		title: def('warning from ingame'),
		body: def((warnTrigger: string, docsHref: string) =>
			rt(`Warns can also be issued from ingame with {warnTrigger}. For more, <a href="{docsHref}" target="_blank">click here</a>`, {
				warnTrigger,
				docsHref,
			}),
		),
	}
}

// TODO make sure we clear all inadvertent player selections when setting up this step
export const showPlayerActions = {
	title: def('Show Player Actions'),
	body: def(
		rt(
			"Many actions can be performed for any player. Right click on a player's row, or their username anywhere where it appears to access the actions.",
		),
	),
}

export const playerActions = {
	title: def('Player Actions'),
	body: def(rt("Let's try <em>timing out</em> a player.")),
}

export const timeoutDuration = {
	title: def('Timeout Duration'),
	body: def(
		rt(
			'Here, you can choose a timeout duration for players, and a reason for the timeout. As with warns, preset reasons are available. Try timing out this player for 15 minutes(15m).',
		),
	),
}

export namespace PlayerActions {
	export const intro = {
		title: def('Player Actions'),
		body: def(
			rt(
				"Many actions can be performed for any player. Right click on a player's row, or their username anywhere in the ui to see what actions are available.",
			),
		),
	}
	export const openWarn = {
		title: def(''),
		body: def(rt('')),
	}
}

export namespace PlayerSelection {
	export const basicSelection = {
		title: def('Basic Player Selection'),
		body: def(rt("Click <i>anywhere</i> on a player's row other than their username to select them.")),
	}
}
