import type * as D from 'discord.js'

import * as Rx from '@/lib/rxjs'
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

// Quotes a linked history selection back into discord. A message in the home guild whose link to the history page
// carries a selection gets a reply holding those events as text, the same text copying them in the app gives.
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
	Discord.messages$.subscribe((message) => {
		if (enabled(Settings.GLOBAL_SETTINGS)) void quoteLinks(message)
	})
}

async function quoteLinks(message: D.Message) {
	const links = HQ.selectionLinksIn(message.content, ENV.ORIGIN).slice(0, MAX_LINKS_PER_MESSAGE)
	if (links.length === 0) return
	const ctx = DB.addPooledDb({ ...CS.init(), user: { discordId: BigInt(message.author.id) }, signal: CleanupSys.shutdownSignal })
	try {
		// someone who could not open the link gets nothing from it here either, and is not told why
		if (await History.denyUnlessHistoryQuery(ctx)) return
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
			await message.reply(replyFor(res.text, res.count))
			log.info('quoted %d events from a selection %s linked in channel %s', res.count, message.author.username, message.channelId)
		}
	} catch (err) {
		log.error({ err }, 'failed to quote a linked selection')
	}
}

// the text in a code block under a line saying how much there is; what does not fit rides along as a file
function replyFor(text: string, count: number): D.MessageReplyOptions {
	const { content, truncated } = DM.codeBlockMessage(I18n.ambient.text(HistoryMsgs.quotedSelection(count)), text, (n) =>
		I18n.ambient.text(HistoryMsgs.quotedSelectionTruncated(n)),
	)
	return {
		content,
		allowedMentions: { parse: [], repliedUser: false },
		files: truncated ? [{ attachment: Buffer.from(text, 'utf8'), name: 'selection.txt' }] : undefined,
	}
}
