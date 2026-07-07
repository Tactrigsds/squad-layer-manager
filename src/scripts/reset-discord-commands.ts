import * as Cli from '@/systems/cli.server'
import * as D from 'discord.js'
import dotenv from 'dotenv'
import { parse as parseJsonc } from 'jsonc-parser'
import fs from 'node:fs/promises'
import { z } from 'zod'

// Clears every application command registered for the SLM Discord app, both the home-guild-scoped
// commands and any global ones. The app re-registers its guild commands on the next boot (see
// discord.server.ts setup()), so this is the way to fix a stale/duplicated command list.
//
// Run with `pnpm run discord:reset-commands` (respects --env-file / --config). Deliberately reads
// env + config directly instead of importing @/server/config, to stay off the logger/OTel chain
// that isn't loadable outside the instrumented server entrypoint.

await Cli.ensureCliParsed()
dotenv.config({ path: Cli.options!.envFile })

const token = process.env.DISCORD_BOT_TOKEN
const appId = process.env.DISCORD_CLIENT_ID
if (!token || !appId) {
	console.error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID must both be set')
	process.exit(1)
}

const raw = await fs.readFile(Cli.options!.config, 'utf-8')
const { homeDiscordGuildId: guildId } = z
	.object({ homeDiscordGuildId: z.string().min(1) })
	.parse(parseJsonc(raw))

const rest = new D.REST().setToken(token)

// the app not being installed in the guild (Missing Access / Unknown Guild) means there are no
// guild-scoped commands to clear in the first place, so treat it as a warning rather than a failure.
const NOT_INSTALLED_CODES: (string | number)[] = [D.RESTJSONErrorCodes.MissingAccess, D.RESTJSONErrorCodes.UnknownGuild]

console.log(`Clearing guild-scoped commands for app ${appId} in guild ${guildId}...`)
try {
	await rest.put(D.Routes.applicationGuildCommands(appId, guildId), { body: [] })
} catch (err) {
	if (err instanceof D.DiscordAPIError && NOT_INSTALLED_CODES.includes(err.code)) {
		console.warn(
			`  skipped: the app is not installed in guild ${guildId} (${err.message}), so it has no guild-scoped commands.`,
		)
	} else {
		throw err
	}
}

console.log(`Clearing global commands for app ${appId}...`)
await rest.put(D.Routes.applicationCommands(appId), { body: [] })

console.log('done — application commands reset. Restart SLM to re-register its commands.')
process.exit(0)
