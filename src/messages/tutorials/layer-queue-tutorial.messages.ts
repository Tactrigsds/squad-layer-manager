import type React from 'react'

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
	body: def(rt('This tutorial is run in a <em>sandbox</em> environment, so we can experiment without affecting the server.')),
}

export const matchHistory = {
	title: def('Match history'),
	body: def('This is the match history panel. Right now, it only contains one entry — the current match.'),
}

export const queuePanel = {
	title: def('The queue'),
	body: def('This is the layer queue. It manages the upcoming layers for the server.'),
}

export const queueItems = {
	title: def('Queue items'),
	body: def(
		rt(
			'A <strong>queue item</strong> occupies one slot in the queue. Once an item is the <strong>next layer</strong>, SLM runs <code>AdminSetNextLayer</code> over RCON with the <strong>layer configuration</strong> that item holds.',
		),
	),
}

export const nextBadge = {
	title: def('The Next Layer badge'),
	body: def("This badge means SLM has already set this layer configuration as the server's next layer."),
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
    <li>the map, gamemode and layer version, written as one name: <code>{layerName}</code></li>
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
			`<p>A Squad server swaps every player between <team1>Team 1</team1> and <team2>Team 2</team2> on each map roll, so neither slot belongs to one group of players.</p>
<p>To keep the queue and the match history readable, SLM <strong>normalizes</strong> the display: the two persistent teams are named <teamA>Team A</teamA> and <teamB>Team B</teamB>, and <teamA>Team A</teamA> is always shown on the left. These colours mean the same thing everywhere in the app.</p>
<p>The <mark1>(1)</mark1> and <mark2>(2)</mark2> beside each team indicate which team is <team1>Team 1</team1> and which is <team2>Team 2</team2></p>
<p>Turn normalization off with <em>Normalize Teams</em> in the avatar menu, top right. The same layer then reads: {denormalized}</p>`,
			{ denormalized },
		),
	),
}

export const filterIndicators = {
	title: def('Filter indicators'),
	body: def(
		rt(
			'Your SLM install can define rules that categorize layers, called <strong>layer filters</strong>. A filter can show an emoji <strong>indicator</strong> on the layers it matches. Hover an indicator to see which filter put it there. Filters live on the <filtersPage>filters page</filtersPage>.',
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
		// TODO needs a variant for an install whose layers carry no scores at all
		body: def(rt('Depending on your install, a layer configuration may also carry <strong>scores</strong>. Open them here:')),
	}
	export const layerScores = {
		title: def('Layer scores'),
		body: def(rt('Which scores exist depends on your install. The defaults are documented <scoresDocs>here</scoresDocs>.')),
	}
}

// AUTHORED, not proofread: the details window is a draggable window, so it stays open over the queue until the
// reader closes it, and the tour has no way to close it for them
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
	body: def(rt("Let's edit the queue. Click <em>Start Editing</em> to signal to everyone else that you are editing it:")),
}

export const queueUserPresence = {
	title: def('Who else is editing'),
	body: def('While you are editing, everyone else sees it here:'),
}

export namespace AddLayersSequence {
	export const addLayersButton = {
		title: def('Add layers'),
		body: def(rt('Click <em>Add Layers</em> to open the <strong>layer selection dialog</strong>.')),
	}

	export const addLayersDialogTour = {
		title: def('The layer selection dialog'),
		body: def("This is the layer selection dialog. It looks busy at first, so let's break it down."),
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
				'By default your results are limited to <strong>in-pool</strong> layers: whichever layer filter defines the pool starts checked here. Uncheck it to search wider, or ctrl+click it to <strong>invert</strong> it, so the results are only the layers that filter excludes. Add more filters to the toolbar with <addFilter></addFilter>.',
			),
		),
	}

	export const repeats = {
		title: def('Repeats in the results'),
		body: def(
			rt('Results that repeat something played recently carry <repeat></repeat> here too, so you can see them before you add them.'),
		),
	}

	export const clickToSelect = {
		title: def('Pick a layer'),
		body: def('Click a layer in the results to select it. You can select more than one. Try selecting one now:'),
	}

	export const rightClick = {
		title: def('The context menu, again'),
		body: def(
			rt(
				'The layer context menu is available in the results too, as long as only one layer is selected. Click <em>Show Details</em> to see that layer in full.',
			),
		),
	}

	export const addAnother = {
		title: def('Add a second layer'),
		body: def((map: string) =>
			rt("Let's add one more. Change the <em>Map</em> filter to <strong>{map}</strong> and pick a layer from the results:", {
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

	export const layerSelectionContextMenu = {
		title: def('Acting on a selection'),
		body: def(
			'With more than one layer selected the context menu offers different actions, like copying every selected layer to the clipboard.',
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
	body: def(rt('Layer items have a few more editing actions. Drag <grip></grip> to move an item through the queue:')),
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
	body: def(rt('The remaining actions are on the layer item itself: right click it, or click <ellipsis></ellipsis>.')),
}

export const replayLayer = {
	title: def('Replay a layer'),
	body: def(
		rt(
			'To replay a layer from the match history, drag it into the queue. This only works while you are editing, so click <em>Start Editing</em> first.',
		),
	),
}

export const addTag = {
	title: def('Tag an item'),
	body: def(
		rt(
			`<p><strong>Tags</strong> are short labels your install defines, attached to a layer item so your fellow admins can read them: that a layer was already agreed on, or that it is a risky pick.</p>
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
		body: def(
			'Further filters to indicate on layer items and in the layer selection dialog, either when a layer matches or when it misses.',
		),
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

	export const warnsAndAutogen = {
		title: def('Warns and generation'),
		body: def(
			rt(
				'Like a filter, a repeat rule can be indicated on queue and history items, warn you on save, or be applied when SLM generates a layer.',
			),
		),
	}
}
