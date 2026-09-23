import type * as D from 'discord.js'
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js'

import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import * as CS from '@/models/context-shared'
import * as DM from '@/models/discord.models'
import * as HQ from '@/models/history.models'
import type * as SETTINGS from '@/models/settings.models'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Discord from '@/systems/discord.server'
import * as History from '@/systems/history.server'
import * as Settings from '@/systems/settings.server'

// Quotes a linked history selection back into discord. A message in the home guild whose links to the history page
// carry selections gets one reply, a code block per selection holding its events as text (the same text copying them
// in the app gives), which follows the message as it is edited or deleted.
//
// Answered only for a poster who may query history (`history:query`), and scoped to the servers they can see, the way
// their own query of the link would be. The reply itself is public to the channel, as the link was.

const module = initModule('history-links')
let log!: CS.Logger

const envBuilder = Env.getEnvBuilder({ ...Env.groups.httpServer })
let ENV!: ReturnType<typeof envBuilder>

const MAX_LINKS_PER_MESSAGE = 3
const TIME_ZONE = 'UTC'

export function setup() {
	log = module.getLogger()
	ENV = envBuilder()
	if (!Discord.isEnabled()) return
	// said once per switch-on rather than per message, since without the intent no message ever arrives to say it on
	const enabled = (settings: SETTINGS.GlobalSettings) => settings.discord.expandHistoryLinks
	Settings.settings$
		.pipe(
			Rx.filter((event): event is Extract<Settings.SettingsEvent, { scope: 'global' }> => event.scope === 'global'),
			Rx.map((event) => enabled(event.settings)),
			Rx.startWith(enabled(Settings.GLOBAL_SETTINGS)),
			Rx.distinctUntilChanged(),
		)
		.subscribe((on) => {
			if (on && Discord.readsMessageContent() === false) {
				log.warn(
					'discord.expandHistoryLinks is on, but Message Content Intent is off for the bot in the discord developer portal. Switch it on and restart SLM for history links to be quoted.',
				)
			}
		})
	Discord.messageEvents$.subscribe((event) => {
		switch (event.type) {
			case 'posted':
				if (enabled(Settings.GLOBAL_SETTINGS)) inTurn(event.message.id, () => sync(event.message))
				break
			case 'deleted':
				inTurn(event.messageId, () => unquote(event.messageId))
				break
			default:
				assertNever(event)
		}
	})
}

// -------- the reply that goes with a message --------
//
// A message's reply is kept in step with it: edited when the message's links change, deleted when it no longer
// links a selection anyone may see, or when the message itself is deleted. Held in memory only, so after a restart
// the replies already posted stay as they are.

type Tracked = { content: string; reply: D.Message | null }
// every message that has linked a selection, by id, oldest first; content is what was last quoted from
const tracked = new Map<string, Tracked>()
// past this many, the oldest message stops being followed
const MAX_TRACKED = 500

// A message's events are handled one at a time: an edit can arrive while the reply to the post is still being
// written, and the two must not both post one.
const turns = new Map<string, Promise<void>>()
function inTurn(messageId: string, fn: () => Promise<void>) {
	const turn = (turns.get(messageId) ?? Promise.resolve()).then(fn).catch((err: unknown) => {
		log.error({ err }, 'failed to quote the selections linked in message %s', messageId)
	})
	turns.set(messageId, turn)
	void turn.finally(() => {
		if (turns.get(messageId) === turn) turns.delete(messageId)
	})
}

async function sync(message: D.Message) {
	const previous = tracked.get(message.id)
	// discord adding a link preview is an edit too, one that leaves the content as it was
	if (previous?.content === message.content) return
	const links = HQ.selectionLinksIn(message.content, ENV.ORIGIN).slice(0, MAX_LINKS_PER_MESSAGE)
	if (links.length === 0 && !previous) return

	const quotes = links.length > 0 ? await quotesFor(message, links) : []
	const reply = previous?.reply ?? null
	if (quotes.length === 0) {
		if (reply) await reply.delete().catch(ignoreGone)
		remember(message.id, { content: message.content, reply: null })
		return
	}
	const payload = replyPayload(quotes)
	let posted: D.Message | null = null
	if (reply) {
		posted = await reply.edit({ ...payload, attachments: [] }).catch((err: unknown) => (ignoreGone(err), null))
	}
	posted ??= await message.reply(payload)
	remember(message.id, { content: message.content, reply: posted })
	log.info('quoted %d selections linked by %s in channel %s', quotes.length, message.author.username, message.channelId)
}

async function unquote(messageId: string) {
	const entry = tracked.get(messageId)
	if (!entry) return
	tracked.delete(messageId)
	if (entry.reply) await entry.reply.delete().catch(ignoreGone)
}

function remember(messageId: string, entry: Tracked) {
	tracked.delete(messageId)
	tracked.set(messageId, entry)
	if (tracked.size > MAX_TRACKED) tracked.delete(tracked.keys().next().value!)
}

// a reply someone else already deleted is the outcome that was wanted anyway
function ignoreGone(err: unknown) {
	if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage) return
	throw err
}

// The text of each selection the message's author may see. Someone who could not open the links gets nothing from
// them here either, and is not told why.
async function quotesFor(message: D.Message, links: ReturnType<typeof HQ.selectionLinksIn>): Promise<string[]> {
	const ctx = DB.addPooledDb({ ...CS.init(), user: { discordId: BigInt(message.author.id) }, signal: CleanupSys.shutdownSignal })
	if (await History.denyUnlessHistoryQuery(ctx)) return []
	const quotes: string[] = []
	for (const link of links) {
		const res = await History.selectionText(
			ctx,
			link.query,
			{ anchor: link.sel[0], head: link.sel[1] },
			{ render: History.DEFAULT_RENDER, timeZone: TIME_ZONE },
		)
		if (res.code !== 'ok') {
			log.info({ code: res.code }, 'not quoting a linked selection from %s', message.author.username)
			continue
		}
		quotes.push(res.text)
	}
	return quotes
}

function replyPayload(quotes: string[]) {
	const { content, files } = DM.quoteContent(quotes, (n) => I18n.ambient.text(HistoryMsgs.quotedSelectionTruncated(n)))
	return {
		content,
		files: files.map((file) => ({ attachment: Buffer.from(file.text, 'utf8'), name: file.name })),
		allowedMentions: { parse: [], repliedUser: false },
	}
}
