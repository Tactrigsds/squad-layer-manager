import * as Msgs from '@/messages/shared'

// a supplied reason is already the fully-rendered verbatim message; only the no-reason case gets a default
export const notifyKilled = Msgs.def((reason?: string) => ({
	warn: () => reason || 'You have been killed by an admin.',
}))

export const kill = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: `Kill ${Msgs.targetNoun(target)}`,
		description: `Kill ${Msgs.targetSubject(
			target,
		)}? They will be force-switched teams twice in quick succession to trigger a respawn, ending back on their current team.`,
		confirmLabel: 'Kill',
	}),
	toast: () => [`Killed ${Msgs.targetAffected(target)}`],
}))

export const killFailed = Msgs.def((reason: string) => ({
	toast: () => ['Kill failed', { description: reason }],
}))

export const kick = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: `Kick ${Msgs.targetNoun(target)}`,
		description: `Kick ${Msgs.targetSubject(target)} from the server? They may rejoin immediately.`,
		confirmLabel: 'Kick',
	}),
	toast: () => [`Kicked ${Msgs.targetAffected(target)}`],
}))

export const kickFailed = Msgs.def((reason: string) => ({
	toast: () => ['Kick failed', { description: reason }],
}))

export const timeout = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: `Timeout ${Msgs.targetNoun(target)}`,
		description: `Kick ${Msgs.targetSubject(
			target,
		)}? They will be re-kicked on join from any SLM-managed server until the timeout expires.`,
		confirmLabel: 'Timeout',
	}),
}))

export const timedOut = Msgs.def((target: Msgs.Target, duration: string) => ({
	toast: () => [`Timed out ${Msgs.targetAffected(target)} for ${duration}`],
}))

export const timeoutFailed = Msgs.def((reason: string) => ({
	toast: () => ['Timeout failed', { description: reason }],
}))

// a bulk timeout fans out one call per player, so some can fail while the rest succeed
export const someTimeoutsFailed = Msgs.def((count: number) => ({
	toast: () => [
		`${count} timeout${count === 1 ? '' : 's'} failed`,
		{ description: 'They may already have an active timeout or have left the server.' },
	],
}))

export const invalidTimeoutDuration = Msgs.def(() => ({
	toast: () => ['Invalid duration', { description: 'Use a duration like 30m, 2h or 1d' }],
}))

export const timeoutTooLong = Msgs.def((maxDuration: string) => ({
	toast: () => ['Duration too long', { description: `Your maximum timeout is ${maxDuration}` }],
}))

export const warnPreset = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: `Warn ${Msgs.targetNoun(target)}`,
		description: `Warn ${Msgs.targetSubject(target)} with a preset reason?`,
		confirmLabel: 'Warn',
	}),
}))

export const warned = Msgs.def((target: Msgs.Target, presetReasonLabel: string) => ({
	toast: () => [`Warned ${Msgs.targetAffected(target)} for ${presetReasonLabel}`],
}))

export const warnFailed = Msgs.def((reason: string) => ({
	toast: () => ['Warn failed', { description: reason }],
}))

// squadLabel is the quoted squad name, absent when the player's squad is not resolvable from live state
export const removeFromSquad = Msgs.def((target: Msgs.Target, squadLabel?: string) => ({
	confirm: () => ({
		title: 'Remove from Squad',
		description:
			target.kind === 'players'
				? `Remove ${target.count} players from their squads?`
				: `Remove this player from ${squadLabel ?? 'their squad'}?`,
		confirmLabel: 'Remove',
	}),
}))

// the three below are the loading/success/error legs of one toast.promise, which takes bare values rather than
// toast args, so they are `text` rather than `toast`
export const removingFromSquad = Msgs.def((count: number) => ({
	text: () => `Removing ${count} players from their squads...`,
}))

export const removedFromSquad = Msgs.def((count: number) => ({
	text: () => `Removed ${count} players from their squads`,
}))

export const removeFromSquadFailed = Msgs.def((count: number) => ({
	toast: () => ['Remove from squad failed', { description: `Failed to remove ${count} players` }],
}))

// teamId is named only from the player menu, where the squad is reached through one of its members and so is not
// otherwise identified on screen
export const disbandSquad = Msgs.def((squadLabel: string, teamId?: number) => ({
	confirm: () => ({
		title: 'Disband Squad',
		description: teamId === undefined ? `Disband squad ${squadLabel}?` : `Disband ${squadLabel} on team ${teamId}?`,
		confirmLabel: 'Disband',
	}),
}))

export const resetSquadName = Msgs.def((squadLabel: string) => ({
	confirm: () => ({
		title: 'Reset Squad Name',
		description: `Reset the name of ${squadLabel} to default?`,
		confirmLabel: 'Reset',
	}),
}))

export const demoteCommander = Msgs.def(() => ({
	confirm: () => ({
		title: 'Demote Commander',
		description: 'Demote this player from commander?',
		confirmLabel: 'Demote',
	}),
}))

export const copiedToClipboard = Msgs.def((what: string, count: number = 1) => ({
	toast: () => ['Copied', { description: count > 1 ? `${count} ${what}s copied to clipboard` : `${what} copied to clipboard` }],
}))
