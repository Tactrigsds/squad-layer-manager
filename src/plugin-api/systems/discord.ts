/**
 * Posting to Discord as SLM, over the host's bot.
 *
 * An install can run with the integration off, and many do, so `isEnabled` is the check to make before
 * treating a failed post as a fault: `postMessage` answers `err:disabled` rather than throwing, and a
 * plugin that needs Discord should say so in its own status rather than erroring on every attempt.
 *
 * Reading the guild -- members, roles, channels -- stays with the host. A plugin names a channel by id,
 * which the channel pickers in slm/components/pickers are for.
 */
export { isEnabled, postMessage } from '@/systems/discord.server'
