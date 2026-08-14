import { def } from '@/models/messages.models'

// Copy for the in-app tutorial tour. Each step's card shows a title and a body; a step references one bundled
// entry here. Branching steps (sync, roll) export the alternative under its own name; the step's msg selector
// picks between them by live state. No static string quotes a layer name or a timestamp: those arrive as ICU args
// when the state supplying them is on screen (see rollLanded).
//
// StepMsg = { title, body }, each a message factory. The tour renders them through the `tr` singleton.

export const welcome = {
	title: def('Welcome'),
	body: def('This server is emulated and yours alone. Nothing you do here reaches a real server or a real player.'),
}

export const nowPlaying = {
	title: def("What's playing now"),
	body: def('This is the match running on the server right now: its map, its factions, and who is in it.'),
}

export const queuePanel = {
	title: def('The queue'),
	body: def("This is what plays next, in order. The layer at the top is the one SLM keeps set as the game server's next map."),
}

export const openEditor = {
	title: def('Edit the queue'),
	body: def('Open the editor to change the queue. Your edits stay local to you until you save them.'),
}

export const pickLayer = {
	title: def('Add a layer'),
	body: def('Open Add Layers, browse the pool, and add one. It joins the queue the moment you pick it.'),
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
	body: def('Save to commit the queue. Until you do, your edits are yours alone and the server does not see them.'),
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
