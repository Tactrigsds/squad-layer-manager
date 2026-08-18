import { def, rt } from '@/models/messages.models'

// Copy for the in-app tutorial tour. Each step's card shows a title and a body; a step references one bundled
// entry here. Branching steps (sync, roll) export the alternative under its own name; the step's msg selector
// picks between them by live state. No static string quotes a layer name or a timestamp: those arrive as ICU args
// when the state supplying them is on screen (see rollLanded).
//
// StepMsg = { title, body }, each a message factory. The tour renders them through the `tr` singleton.

export const welcome = {
	title: def('Welcome'),
	body: def("Welcome to the layer queue tutorial. Here, we'll learn the basics of editing SLM's layer queue"),
}

export const nowPlaying = {
	title: def("What's playing now"),
	body: def('This is the match running on the server right now: its map, its factions, and who is in it.'),
}

export const queuePanel = {
	title: def('The queue'),
	body: def("This is what plays next, in order. The layer at the top is the one SLM keeps set as the game server's next map."),
}

// Grounds the queue in what an item actually is: the AdminSetNextLayer command SLM runs for it. The args carry the
// real command for the spotlighted head item, split so the pattern can color the faction arguments; the tags color
// their chunks with the real team colors (renderers in tour.client.ts), so each sentence stays one translatable
// pattern.
export const layerCommand = {
	title: def('A queue item is a command'),
	body: def((prefix: string, team1: string, team2: string) => ({
		richText: rt(
			'Each item in the queue defines a command. When the item reaches the top, SLM runs it on the game server to set the next layer:<br></br><code>{prefix} <t1>{team1}</t1> <t2>{team2}</t2></code><br></br>The faction listed first plays as <t1>Team 1</t1> <m1>(1)</m1>, the second as <t2>Team 2</t2> <m2>(2)</m2>. Everyone switches sides after every match, so SLM also tracks two persistent teams, <ta>Team A</ta> and <tb>Team B</tb>, that stay with their players.',
			{ prefix, team1, team2 },
		),
	})),
}

export const teamNormalize = {
	title: def('Normalized for display'),
	body: def(() => ({
		richText: rt(
			'Each layer here is shown with <ta>Team A</ta> on the left and <tb>Team B</tb> on the right, whatever order its command says. Watch the <m1>(1)</m1> and <m2>(2)</m2> marks alternate down the queue: the teams switch slots every match, and SLM flips the printed order so each side keeps its column. Turn off Normalize Teams in the top menu to see raw command order instead.',
		),
	})),
}

export const nextBadge = {
	title: def('The Next Layer badge'),
	body: def("This badge means SLM has posted this layer as the server's next map. The layer at the top of the queue is what plays next."),
}

export const addedHighlight = {
	title: def('Your added layers'),
	body: def('Layers you add show a green border until you save. It marks an unsaved change to the queue.'),
}

export const notNextBadge = {
	title: def('Not the next layer yet'),
	body: def('Your new layer is not posted on the server yet. Save the queue to set it as the next map.'),
}

export const openEditor = {
	title: def('Edit the queue'),
	body: def('Open the editor to signal to others that you are editing the queue.'),
}

export const openAdd = {
	title: def('Add a layer'),
	body: def('When you want to add a layer to the queue, click'),
}

export const appliedFilter = {
	title: def('The applied filter'),
	body: def('Add Layers is already filtered to the layers your pool allows. This shows which filter is applied.'),
}

export const addFilters = {
	title: def('Narrow the pool'),
	body: def('Filter by map, gamemode, faction and more to find the layer you want.'),
}

export const addPick = {
	title: def('Pick your layers'),
	body: def('Check any rows you want to queue. Flip Show Selected to review your picks.'),
}

export const addSubmit = {
	title: def('Add them to the queue'),
	body: def('Submit adds your picks to the queue and closes the pool.'),
}

export const removeLayer = {
	title: def('Remove a layer'),
	body: def('Drop a layer from the queue with the X on its row.'),
}

export const swapFactions = {
	title: def('Swap the factions'),
	body: def('Flip which faction plays each side of this layer. The teams switch, the map stays.'),
}

export const reorderLayer = {
	title: def('Reorder the queue'),
	body: def('Drag a layer by its handle to move it. The layer at the top is what plays next.'),
}

export const saveQueue = {
	title: def('Save your changes'),
	body: def('Save to commit your changes. Until then they live in a shared draft that other editors see, not on the game server.'),
}

export const watchSync = {
	title: def('SLM keeps the game server in sync'),
	body: def('Whenever the queue head changes, SLM sets it as the next layer on the game server. Watch the indicator.'),
}

export const alreadySynced = {
	title: def('SLM keeps the game server in sync'),
	body: def('SLM already set your layer as next on the game server. It usually wins this race.'),
}

export const generate = {
	title: def('Let SLM pick one'),
	body: def('Generate draws a layer that fits your pool and rules and appends it to the queue.'),
}

export const rollEnding = {
	title: def('The match is ending'),
	body: def('Watch it finish. The layer at the head of the queue becomes the next match, and the queue shifts up.'),
}

export const rollLanded = {
	title: def('The queue moved up'),
	body: def('{layer} is now playing. The head that was next became the match, and the queue shifted.', (layer: string) => ({ layer })),
}

export const history = {
	title: def('Match history'),
	body: def('Every match that finishes lands here, newest first, with how it ended.'),
}

export const createVote = {
	title: def('Put it to a vote'),
	body: def('Instead of a fixed layer, add a vote with a few choices. The players in the match pick the winner.'),
}

export const startVote = {
	title: def('Start the vote'),
	body: def('Start it to open the vote on the server. Players vote in chat and the tally fills in live.'),
}

export const tally = {
	title: def('The votes come in'),
	body: def('Watch the choices tally as votes arrive. When it resolves, the winner takes the head of the queue.'),
}

export const wrapUp = {
	title: def("That's the tour"),
	body: def(
		'You added a layer, removed one, swapped its factions and reordered the queue, then saved. Keep this server to play with, or pick another tutorial.',
	),
}
