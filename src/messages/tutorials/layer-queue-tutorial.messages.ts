import type React from 'react'

import * as I18n from '@/messages/i18n'
import * as L from '@/models/layer'
import { def, rt } from '@/models/messages.models'

// Copy for the layer queue tutorial. Each entry is one step's card: a title and a body, both message factories,
// which the tour renders through its own translator (see TourTag in src/systems/tour.client.ts).
//
// Markup vocabulary, applied consistently here:
//   <strong>  a domain term this copy is naming or defining -- queue item, layer filter, Team A
//   <em>      a label the reader has to find in the UI, quoted exactly as it is rendered -- <em>Start Editing</em>
//   <code>    something typed or run verbatim -- AdminSetNextLayer, Gorodok_RAAS_v1
//   <p>       one paragraph of a multi-paragraph body; a single-paragraph body uses no wrapper
//   <ul><li>  a list
//   team/mark tags carry the app's real team colours; icon tags render the real icon from the control being
//   described, so the reader matches the card to the screen by shape rather than by name.
//
// ICU has no self-closing tags, so an icon is written <grip></grip>.

export const welcome = {
	title: def('Welcome'),
	body: def("Welcome to the layer queue tutorial. Here we'll learn the basics of editing SLM's layer queue."),
}

export const sandbox = {
	title: def('Sandbox'),
	body: def(rt('This tutorial runs on a <strong>sandbox</strong> server, so you can experiment without affecting your real servers.')),
}

export const matchHistory = {
	title: def('Match history'),
	body: def('This is the match history panel. Right now it holds one entry: the current match.'),
}

export const queuePanel = {
	title: def('The queue'),
	body: def('This is the layer queue. It manages the upcoming layers for the server.'),
}

export const queueItems = {
	title: def('Queue items'),
	body: def(
		rt(
			'A <strong>queue item</strong> occupies one slot in the queue. Once an item reaches the top of the queue, SLM runs <code>AdminSetNextLayer</code> over RCON with the <strong>layer configuration</strong> that item holds.',
		),
	),
}

export const nextBadge = {
	title: def('The Next Layer badge'),
	// The triggers come from the install's command config, already carrying their prefix, so the sentence is built
	// around whatever is configured -- including nothing, when the command is disabled or unbound. Formatting the
	// list needs the locale, which is what the surface function hands us: the separators and the conjunction are
	// the reader's, and each trigger is isolated so an LTR command in an RTL sentence keeps its punctuation.
	body: def((triggers: string[]) => ({
		richText: ({ locale }) =>
			triggers.length === 0
				? rt("This badge means SLM has already set this layer configuration as the server's next layer.")
				: rt(
						"This badge means SLM has already set this layer configuration as the server's next layer. In game, you can type {showNextCommands} to check what layers are next.",
						{ showNextCommands: I18n.tokenList(triggers, locale, { type: 'disjunction', tag: 'code' }) },
					),
	})),
}

// Every example is read off the layer the card points at. The per-team tokens come out of the command rather than
// off the layer, so the bullets and the command line cannot disagree: the command resolves a team's default unit
// and rewrites FRAAS to RAAS, and a hand-built `Faction+Unit` would show neither.
export const layerAnatomy = {
	title: def('Anatomy of a layer configuration'),
	body: def((layer: L.KnownLayer) => {
		const command = L.getLayerCommand(layer, 'set-next')
		const [, layerName, team1, team2] = command.split(' ')
		return rt(
			`A layer configuration is made up of:
<ul>
    <li>the map, gamemode and layer version: <code>{layerName}</code></li>
    <li>the faction and unit (subfaction) for each team: <code>{team1}</code> and <code>{team2}</code></li>
</ul>
<p>For this layer, the RCON command that will be run on the server is <code>{command}</code>.</p>`,
			{ layerName, team1, team2, command },
		)
	}),
}

export const teamNormalize = {
	title: def('Teams and normalization'),
	// the denormalized example is the same layer rendered with normalization off, so the reader sees the difference
	// rather than being asked to picture it
	body: def((denormalized: React.ReactNode) =>
		rt(
			`<p>A Squad server swaps every player between <team1>Team 1</team1> and <team2>Team 2</team2> on each map roll.</p>
<p>To make the queue and the match history more easily scannable, SLM <strong>normalizes</strong> the teams: the two persistent teams are named <teamA>Team A</teamA> and <teamB>Team B</teamB>, and <teamA>Team A</teamA> is always shown on the left. These colors mean the same thing everywhere in the app.</p>
<p>The <mark1>(1)</mark1> and <mark2>(2)</mark2> beside each team indicate which team is <team1>Team 1</team1> and which is <team2>Team 2</team2>.</p>
<p>Turn normalization off with <em>Normalize Teams</em> in the avatar menu, top right. The same layer then reads: {denormalized}</p>`,
			{ denormalized },
		),
	),
}

export const filterIndicators = {
	title: def('Filter indicators'),
	body: def(
		rt(
			"Your SLM install can define rules that categorize layers, called <strong>layer filters</strong>. A filter can show an emoji <strong>indicator</strong> on the layers it matches. Hover an indicator to see which filter put it there. For this tutorial, we'll be working with two tutorial-specific filters: <em>Tutorial Pool</em> <tutorialPoolIcon></tutorialPoolIcon> and <em>Large Layers</em> <largeLayersIcon></largeLayersIcon>.",
		),
	),
}

export const repeatIndicators = {
	title: def('Repeat indicators'),
	body: def(
		rt(
			'SLM can also detect when a layer configuration repeats a map, faction or gamemode that was played recently. A repeat is marked with <repeat></repeat>. Hover it to highlight the parts of the layer that repeat.',
		),
	),
}

export namespace LayerDetails {
	export const openLayerDetails = {
		title: def('Open the details'),
		body: def('Left click a layer to open its details.'),
	}
	export const layerDetails = {
		title: def('Layer details'),
		body: def(
			rt(`This window holds everything else known about the layer:
<ul>
<li>the factions for each team</li>
<li>the special characteristics of each faction</li>
<li>the vehicles each team fields</li>
</ul>`),
		),
	}
	export const openLayerScores = {
		title: def('Open the scores'),
		body: def(rt('Depending on your install, a layer configuration may also carry <strong>scores</strong>. Open them here:')),
	}
	export const layerScores = {
		title: def('Layer scores'),
		body: def(
			rt(
				`<p>SLM precomputes <strong>scores</strong> for a layer from a set of heuristics, as a rough measure of how fair the matchup is. These are SLM's default scores, and they only exist for RAAS, FRAAS, AAS, and TC. The two most important are the <em>Balance Differential</em> and the <em>Asymmetry Score</em>.</p>
<p>These are from the standard set of scores that ship with SLM, but it's possible to introduce your own scoring system. See <scoresDocs>layer_data.md</scoresDocs> for more.</p>
				`,
			),
		),
	}
	// The reading of the number is written for the scenario's head layer (see LQ_TUTORIAL_LAYERS): ADF has the
	// edge, and it is a small one. The number itself comes from the install's own layer data.
	export const balanceScore = {
		title: def('Balance score'),
		body: def((balance: string) =>
			rt(
				`This is a composite score, weighting Armor, Transport, Anti-Infantry capability, and Logistics for each matchup. Positive numbers mean Team 1 is favored and negative numbers mean Team 2 is favored. This layer scores <em>{balance}</em>, so Team 1, ADF Combined Arms, has a small edge, well inside the pool cutoff marked on the gauge.`,
				{ balance },
			),
		),
	}
	export const asymmetryScore = {
		title: def('Asymmetry score'),
		body: def((asymmetry: string) =>
			rt(
				`This score is meant to give you an idea of the "asymmetry" of the matchup. Similar <em>unit types</em> are generally more symmetric, such as Combined Arms versus Combined Arms or Support versus Support, because similar unit types get similar vehicle loadouts. This layer, ADF Combined Arms versus AFU Light Infantry, scores <em>{asymmetry}</em>: quite asymmetric, though not asymmetric enough to fall out of the main pool. When reading these scores, focus on the <em>relative magnitudes</em> rather than the specific units, as the units are abstract.`,
				{ asymmetry },
			),
		),
	}

	export const categorySpecificScores = {
		title: def('Category specific scores'),
		body: def(rt(`Each column is one capability, scored for both teams. A higher marker means that team is stronger in that category.`)),
	}

	export const layerScoresNonstandard = {
		title: def('Layer scores'),
		body: def(
			rt(`These are from your organization's custom layer scoring system. Consult your internal documentation for more information.`),
		),
	}
}

// The details window is a draggable window, so it stays open over the queue until the reader closes it, and the
// tour has no way to close it for them.
export const closeLayerDetails = {
	title: def('Close the details'),
	body: def('Close the details window to carry on with the queue:'),
}

export const layerContextMenu = {
	title: def('The layer context menu'),
	body: def('Right click a layer to see the actions available for it:'),
}

export const startEditing = {
	title: def('Start editing'),
	body: def(rt('Click <em>Start Editing</em> to tell other admins you are about to change the queue:')),
}

// The reader opens an edit session three times, because saving ends one. The first press is where it is
// explained; these two only have to say why they are being asked again, and their titles have to tell the
// contents apart.
export const startEditingAgain = {
	title: def('Start editing again'),
	body: def('Saving ended your editing session. Start another one:'),
}

export const startEditingToClear = {
	title: def('Start editing to clear the queue'),
	body: def('Saving ended your editing session again. Start one more:'),
}

export const queueUserPresence = {
	title: def('Checking for other editors'),
	body: def(
		'Everyone editing this server, and what they have open, is shown here. A grayed-out avatar is someone still in the session who has gone idle. Hover it to see for how long.',
	),
}

export namespace AddLayersSequence {
	export const addLayersButton = {
		title: def('Add layers'),
		body: def(rt('Click <em>Add Layers</em> to open the <strong>layer selection dialog</strong>.')),
	}

	export const addLayersDialogTour = {
		title: def('The layer selection dialog'),
		body: def('This is the layer selection dialog. It looks busy at first, so here it is piece by piece.'),
	}

	export const layerFilterMenu = {
		title: def('The layer filter menu'),
		body: def((map: string, gamemode: string, faction: string) =>
			rt(
				`<p>This is where you search for a layer configuration with a particular map, gamemode, faction and so on.</p>
<p>Try searching for layers with a <em>Map</em> of <strong>{map}</strong>, a <em>Gamemode</em> of <strong>{gamemode}</strong>, and <strong>{faction}</strong> on either team.</p>`,
				{ map, gamemode, faction },
			),
		),
	}

	export const resultsTable = {
		title: def('The results'),
		body: def('Layers matching your search show up here.'),
	}

	export const pagination = {
		title: def('Paging the results'),
		body: def('A search usually matches more layers than fit on one page. Page through them here.'),
	}

	export const sorting = {
		title: def('Sorting the results'),
		body: def('Click a column header to sort the results by that column.'),
	}

	export const randomization = {
		title: def('Randomized results'),
		body: def(rt('Results are randomized by default. Click <dice></dice> to reroll them.')),
	}

	export const appliedFiltersToolbar = {
		title: def('Applied filters toolbar'),
		body: def(
			rt(
				'By default your results are limited to <strong>in-pool</strong> layers: whichever layer filter defines the pool starts checked here. Uncheck to widen the search, or ctrl+click it to <strong>invert</strong> it, so the results are only the layers that filter excludes. Add more filters to the toolbar with <addFilter></addFilter>.',
			),
		),
	}

	export const repeats = {
		title: def('Repeats in the results'),
		body: def(rt('Results that repeat something played recently carry <repeat></repeat> indicators.')),
	}

	export const hideRepeats = {
		title: def('Hide repeats'),
		body: def(rt('Click <hideRepeats></hideRepeats> to filter out layers that repeat something played recently.')),
	}

	export const clickToSelect = {
		title: def('Pick a layer'),
		body: def('Click a layer in the results to select it. You can select more than one. Try selecting one now:'),
	}

	export const rightClick = {
		title: def('The context menu, again'),
		body: def(
			rt(
				'The right-click context menu is available for layer configurations in the results, too. With several selected, right click any one of them to act on all of them at once.',
			),
		),
	}

	export const addAnother = {
		title: def('Add a second layer'),
		body: def((map: string) =>
			rt('Add one more. Change the <em>Map</em> filter to <strong>{map}</strong> and pick a layer from the results:', {
				map,
			}),
		),
	}

	export const seeSelection = {
		title: def('See what you selected'),
		body: def(
			rt(
				'Changing the filters hid the layer you selected first, but it is still selected. Click <em>Show Selected</em> to see everything you have picked so far:',
			),
		),
	}

	export const submit = {
		title: def('Submit'),
		body: def(
			rt(
				"Choose <em>Play After</em> to add these layers to the end of the queue instead of the front. When you're happy with the selection, click <em>Submit</em>:",
			),
		),
	}
}

export const addedHighlight = {
	title: def('Your added layers'),
	body: def('Added layers carry a green border until the queue is saved.'),
}

export const layerAttribution = {
	title: def('Layer attribution'),
	body: def(rt('A layer you added is <strong>attributed</strong> to you here.')),
}

export const reorderLayer = {
	title: def('Reorder the queue'),
	body: def(rt('Queue items have a few more editing actions. Drag <grip></grip> to move an item through the queue:')),
}

export const removeLayer = {
	title: def('Remove an item'),
	body: def(rt('Remove an item from the queue with <remove></remove>:')),
}

export const swapTeams = {
	title: def('Swap the teams'),
	body: def(rt('Swap which team gets which faction with <swap></swap>:')),
}

export const editLayer = {
	title: def('Change an item'),
	body: def(rt("Change an item's layer with <pencil></pencil>:")),
}

export const editLayerSelection = {
	title: def('Editing an item'),
	body: def('This dialog is the same as the one for adding layers, except that you can only select a single layer.'),
}

export const layerItemEllipsis = {
	title: def('The rest of the item actions'),
	body: def(
		rt('Some additional actions are available by clicking the <ellipsis></ellipsis>, or by right clicking anywhere on the queue item.'),
	),
}

export const replayLayer = {
	title: def('Replay a layer'),
	body: def(rt('To replay a layer from the match history, drag it into the queue.')),
}

export const addTag = {
	title: def('Tag an item'),
	body: def(
		rt(
			`<p><strong>Tags</strong> are a simple way of communicating with your fellow admins about a queue item.</p>
<p>Try adding one now:</p>`,
		),
	),
}

export const notes = {
	title: def('Leave a note'),
	body: def('A note attaches freeform text to a layer item. Try adding one now:'),
}

export const save = {
	title: def('Save the queue'),
	body: def("Once you're happy with your edits, save them:"),
}

export const warningsOnSave = {
	title: def('Warnings on save'),
	body: def(
		rt(
			`SLM can be configured to warn you when a queue you are saving holds layers that match, or fail to match, a <strong>layer filter</strong>, or that violate a <strong>repeat rule</strong>. Fix what you can, or click <em>Save Anyway</em> to save regardless.`,
		),
	),
}

export const collaborativeEditing = {
	title: def('Editing together'),
	body: def(
		rt(
			`<p>Several people can edit the queue at once. While anyone else is still editing, the queue is not saved, and the save button reads <em>Finish Editing</em> instead of <em>Save</em>. It reads <em>Finish Editing</em> for you as well until you have actually changed something.</p>
<p>If everyone leaves the editing session by closing the page, the changes are discarded after a short delay.</p>
<p>If the map rolls while you are editing, your edits are discarded.</p>`,
		),
	),
}

export const forceSaveEdit = {
	title: def('Make a change'),
	body: def(
		rt(
			'Force Save overrides a queue someone else is holding, so there has to be something to save. Remove an item with <remove></remove>:',
		),
	),
}

export const forceSave = {
	title: def('Force save'),
	body: def(
		rt(
			"Sometimes someone forgets to save and leaves the queue stuck in an editing session. <em>Force Save</em> (<sword></sword>) saves it anyway and ends everyone else's session. Try it now:",
		),
	),
}

export namespace Autogen {
	export const intro = {
		title: def('Layer generation'),
		body: def(
			rt(
				'If the queue runs out of items you set yourself, SLM <strong>generates</strong> a layer to play from the rules configured for this server.',
			),
		),
	}
	export const tryItOut = {
		title: def('Try it out'),
		body: def(rt('Empty the queue with <trash></trash>, then click <em>Save</em>:')),
	}
	export const generatedItem = {
		title: def('A generated item'),
		body: def(rt('SLM chose this layer itself, which is what <dice></dice> means.')),
	}
}

export namespace PoolSettings {
	export const showPoolSettings = {
		title: def('Open the queue settings'),
		body: def(rt("Click <gear></gear> to open the queue's settings.")),
	}
	export const poolSettings = {
		title: def('Queue settings'),
		body: def(
			'Most of what shapes the queue is configured here, and on the settings page. Changing it takes permissions your account may not have. A quick tour:',
		),
	}

	export const poolFilter = {
		title: def('The pool filter'),
		body: def(
			rt(
				'The pool filter decides whether a layer is <strong>in pool</strong> or <strong>out of pool</strong>. It is always indicated on layers, applied by default when selecting them, and warned about on save. Depending on their permissions, some users cannot set an out-of-pool layer at all.',
			),
		),
	}

	export const indicateMatchesAndMisses = {
		title: def('Indicate matches and misses'),
		body: def('Filters listed here are indicated on queue items and in the layer selection dialog, the same way the pool filter is.'),
	}

	export const defaultSelect = {
		title: def('Default select'),
		body: def('Filters applied by default in the layer selection dialog.'),
	}

	export const viewRepeatRules = {
		title: def('Open the repeat rules'),
		body: def('Open the repeat rules configured for this server:'),
	}

	export const repeatRulesOverview = {
		title: def('Repeat rules'),
		body: def('Repeat rules are added, removed and edited here.'),
	}

	export const repeatRule = {
		title: def('A repeat rule'),
		body: def(
			rt(
				`<p>A repeat rule has a <em>Label</em>, a <em>Field</em> and a <em>Within</em> value. It matches an item in the queue or the match history when that item's <em>Field</em> -- map, gamemode, faction, and so on -- has already been played <em>Within</em> the configured range.</p>
<p>For per-team fields like <em>Faction</em>, only repeats by the same persistent team (<teamA>Team A</teamA> or <teamB>Team B</teamB>) count, unless the rule has <em>Cross-team</em> enabled.</p>`,
			),
		),
	}

	export const targetValues = {
		title: def('Target values'),
		body: def(
			rt(
				`A rule can also carry a set of <em>Target Values</em>, and then only matches when the field is one of them. That is how you space out niche maps, gamemodes and factions so they are not played too often.`,
			),
		),
	}

	export const ruleOptions = {
		title: def('Rule options'),
		body: def(
			rt(
				`<p><em>Options</em> is what the rule does when it matches. <em>Indicate</em> marks the item in the queue and the match history, <em>Warn</em> warns you when a save would introduce the repeat, and <em>Autogen</em> applies the rule when SLM generates a layer.</p>
<p><em>Cross-team</em> lives here too, and can only be set on a per-team field.</p>`,
			),
		),
	}
}
