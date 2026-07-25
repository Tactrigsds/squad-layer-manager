import { z } from 'zod'

// What a squad server is doing, as the server itself sees it. Three channels rather than one stream because they
// answer different questions: what SLM asked of it (rcon), what the game reported (log), and what a player typed
// (command).
//
// `reqId` pairs a response with the command that asked for it. Commands are in flight concurrently and their
// responses do not come back in send order, so adjacency in the stream is not correlation.
//
// `dir` is always from the SERVER's point of view rather than ours: 'recv' is a command arriving at the game
// server and 'send' is the game server talking back. SLM reads this off its own rcon client, at the opposite end,
// and flips it -- so an emulated server and a real one read the same way.
export type ConsoleEventInput =
	| { type: 'rcon'; dir: 'recv' | 'send'; body: string; time: number; reqId?: number }
	| { type: 'log'; line: string; time: number }
	| { type: 'command'; player: string; channel: string; message: string; time: number }

// seq is stamped by the console system on the way into the buffer. It gives the client a stable key per event and
// lets a late subscriber tell backlog from live.
export type ConsoleEvent = ConsoleEventInput & { seq: number }

export const CONSOLE_CHANNEL = z.enum(['rcon', 'log', 'command'])
export type ConsoleChannel = z.infer<typeof CONSOLE_CHANNEL>

// A console is a tail, not a transcript: a busy server produces log lines indefinitely and none of this is
// persisted, so old entries are dropped rather than growing the buffer forever. This is also the backlog a window
// opened mid-match starts from.
//
// Bounded by bytes as well as by count because the two limits catch different things: a ListPlayers response on a
// full server is tens of kilobytes, so 500 of those would be megabytes held per server whether or not anyone ever
// opens a console.
export const BUFFER_SIZE = 500
export const BUFFER_BYTES = 512 * 1024

export function eventSize(event: ConsoleEventInput): number {
	switch (event.type) {
		case 'rcon':
			return event.body.length
		case 'log':
			return event.line.length
		case 'command':
			return event.message.length + event.player.length
	}
}

// The tick rate heartbeat, which every server emits on a timer and which never says anything. Named here rather
// than in the client because it describes the log format, not the presentation.
export const TICK_RATE_LINE = /Server Tick Rate:/

// A log chunk is not line-aligned: an sftp poll or a socket read can split a line anywhere. Whatever follows the
// last newline is the start of a line that has not finished arriving, so it is carried into the next chunk rather
// than printed as if it were whole.
export function splitChunk(partial: string, chunk: string): { lines: string[]; partial: string } {
	const parts = (partial + chunk).split('\n')
	const rest = parts.pop() ?? ''
	const lines: string[] = []
	for (const part of parts) {
		const line = part.replace(/\r$/, '')
		if (line.trim()) lines.push(line)
	}
	return { lines, partial: rest }
}
