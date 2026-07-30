import * as CMD from '@/models/command.models'
import type * as SM from '@/models/squad.models'

// The unanswered choices a caller has been asked for, and what to run once they have picked. Held in memory and
// keyed by server, like the console channels: a session outlives the chat message that raised it and nothing else.
//
// Kept clear of commands.server so the dispatcher can own both ends (raising a session, replaying it) without this
// module importing back into it.

// Long enough to read three options and type a digit, short enough that a stale session cannot surprise anyone with
// a moderation action they have forgotten about.
export const TTL_MS = 45_000

export type PromptStep = {
	argName: string
	typed: string
	// where the argument sits in `tokens`, so a pick replaces exactly the words that failed
	range: CMD.ArgTokenRange
	msg: string
	choices: CMD.ArgChoice[]
}

export type PromptSession = {
	cmd: CMD.CommandId
	trigger: CMD.CommandTrigger
	// the caller's words after any trigger template expanded them, which is what picks are spliced over
	tokens: string[]
	// the command as it was actually typed, for naming it back to them. Not `tokens`, which a trigger that pins
	// arguments has already expanded into words they never wrote.
	typed: string
	// the chat the command was typed in. A prompt only captures answers there, so a number typed in another chat
	// still reaches whatever normally reads it (a vote).
	channel: SM.ChatChannelType
	steps: PromptStep[]
	picks: (CMD.ArgChoice | undefined)[]
	expiresAt: number
}

const sessions = new Map<string, Map<string, PromptSession>>()

function forServer(serverId: string): Map<string, PromptSession> {
	let byPlayer = sessions.get(serverId)
	if (!byPlayer) {
		byPlayer = new Map()
		sessions.set(serverId, byPlayer)
	}
	return byPlayer
}

export function get(serverId: string, playerId: SM.PlayerId): PromptSession | undefined {
	return sessions.get(serverId)?.get(playerId)
}

export function set(serverId: string, playerId: SM.PlayerId, session: PromptSession): void {
	forServer(serverId).set(playerId, session)
}

// reads and removes in one step, since every answer either completes a session or ends it
export function take(serverId: string, playerId: SM.PlayerId): PromptSession | undefined {
	const session = get(serverId, playerId)
	if (session) forServer(serverId).delete(playerId)
	return session
}

export function disposeFor(serverId: string): void {
	sessions.delete(serverId)
}

// whether a live session should read this message rather than whatever normally would. An expired session still
// captures, so the caller learns their choice lapsed instead of watching a number do nothing.
export function capturesAnswer(serverId: string, playerId: SM.PlayerId, msg: SM.RconEvents.ChatMessage): boolean {
	const session = get(serverId, playerId)
	return !!session && session.channel === msg.channelType && isAnswer(msg.message)
}

// One number per outstanding question, so a caller who already knows can answer them all at once. 0 cancels.
const ANSWER = /^\d+(\s+\d+)*$/

export function isAnswer(message: string): boolean {
	return ANSWER.test(message.trim())
}

export function parseAnswer(message: string): number[] {
	return message.trim().split(/\s+/).map(Number)
}

export function expired(session: PromptSession, now: number): boolean {
	return now >= session.expiresAt
}

// the first question still waiting on an answer, or undefined once every step has one
export function nextStep(session: PromptSession): number | undefined {
	const index = session.picks.findIndex((pick) => pick === undefined)
	return index === -1 ? undefined : index
}

// the caller's words with every pick spliced back over the argument it answers for
export function resolvedTokens(session: PromptSession): string[] {
	const picks = session.picks.flatMap((pick, i) => (pick ? [{ range: session.steps[i].range, tokens: pick.tokens }] : []))
	return CMD.spliceArgTokens(session.tokens, picks)
}
