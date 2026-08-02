import { describe, expect, it } from 'vitest'

import * as CMD_Msgs from '@/messages/command.messages'
import * as I18n from '@/messages/i18n'
import * as CMD from '@/models/command.models'

const configs = CMD.seedCommandConfigs({}, CMD.DEFAULT_PREFIX) as unknown as CMD.CommandConfigs

// the listing arrives as a few warns of several lines each, which is chat's limit rather than anything a reader of
// these tests cares about
function helpLines(commands: CMD.CommandConfigs, section?: string): string[] {
	const warn = I18n.ambient.warn(CMD_Msgs.help(commands, section))
	const msgs = Array.isArray(warn) ? warn : [warn as string]
	return msgs.flatMap((msg) => msg.split('\n'))
}

function withTimeout(triggers: CMD.CommandTrigger[]): CMD.CommandConfigs {
	return { ...configs, timeout: { ...configs.timeout, triggers } }
}

describe('help', () => {
	it('lists a command by its triggers and the arguments they take', () => {
		expect(helpLines(withTimeout(['/to', '/timeout']), 'moderation')).toContain(
			'[/to, /timeout] <player> <duration> [reason|message]: Kick a player with a timeout (e.g. 2h); they are re-kicked on any SLM ' +
				'server until it expires',
		)
	})

	it('gives a shortcut its own line, naming what it stands for', () => {
		const lines = helpLines(withTimeout(['/timeout', { string: '/to2h', args: '{{arg1}} 2h {{rest2}}' }]), 'moderation')
		expect(lines).toContain('[/to2h] <player> [reason|message]: Shortcut for "/timeout {{arg1}} 2h {{rest2}}"')
	})

	// the command is only reachable through triggers that pin arguments, so there is no plain form to head the listing
	// with -- and heading it with an empty [] was what the listing used to do
	it('describes a command with no plain trigger by the triggers it does have', () => {
		const lines = helpLines(
			withTimeout([
				{ string: '/to', args: '{{arg1}} 45m' },
				{ string: '/timeout', args: '{{arg1}} 45m' },
				{
					string: '/to2h',
					args: '{{arg1}} 2h',
				},
			]),
			'moderation',
		)
		expect(lines.some((line) => line.startsWith('[]'))).toBe(false)
		expect(lines).toContain(
			'[/to, /timeout] <player>: Kick a player with a timeout (e.g. 2h); they are re-kicked on any SLM server until it expires',
		)
		expect(lines).toContain('[/to2h] <player>: always duration 2h')
	})
})
