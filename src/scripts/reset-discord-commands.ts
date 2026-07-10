import * as Cli from '@/systems/cli.server'
import * as D from 'discord.js'
import dotenv from 'dotenv'

// Clears every application command registered for the SLM Discord app, both the home-guild-scoped
// commands and any global ones. The app re-registers its guild commands on the next boot (see
// discord.server.ts setup()), so this is the way to fix a stale/duplicated command list.
//
// Run with `pnpm run discord:reset-commands` (respects --env-file). Deliberately reads env directly
// instead of importing @/server/config.server, to stay off the logger/OTel chain that isn't loadable
// outside the instrumented server entrypoint.

await Cli.ensureCliParsed()
dotenv.config({ path: Cli.options!.envFile })

const token = process.env.DISCORD_BOT_TOKEN
const appId = process.env.DISCORD_CLIENT_ID
const guildId = process.env.HOME_DISCORD_GUILD_ID
if (!token || !appId || !guildId) {
	console.error('DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID and HOME_DISCORD_GUILD_ID must all be set')
	process.exit(1)
}

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
