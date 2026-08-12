import { def, t } from '@/models/messages.models'

// -------- in-game warns for the /switch queue --------

export const queued = def(
	"You're #{position} in line to switch teams. You'll be switched when the balance allows. Type {cancelCommand} to cancel.",
	(position: number, cancelCommand: string) => ({ position, cancelCommand }),
)

export const alreadyQueued = def(
	"You're already #{position} in line to switch teams. Type {cancelCommand} to cancel.",
	(position: number, cancelCommand: string) => ({ position, cancelCommand }),
)

export const notifySwitched = def('Switching you to the other team now.')

export const notifyConnectorMoved = def('You were placed on the other team to make room for a queued switch request.')

export const notifySwitchFailed = def(
	'We could not switch you to the other team. Your switch request has been cancelled; feel free to try again.',
)

export const notifyPositionChanged = def('You moved up: now #{position} in line to switch teams.', (position: number) => ({ position }))

export const cancelled = def('Your switch request has been cancelled.')

export const notQueued = def('You have no pending switch request.')

export const noTeam = def('You are not on a team yet.')

export const swapPending = def('A team swap for you is already in progress.')

// -------- the teams panel --------

export const iconHint = def(
	'Requested a team switch. Shift+click: select all switch requesters on this team. Shift+Ctrl+click: both teams.',
)

// -------- the switch-requests window --------

export const windowTitle = def('Switch Requests')

export const windowBlurb = def('Players who asked to switch teams. They are switched automatically as space frees up.')

export const noRequests = def('No switch requests.')

export const switchNowHint = def('Switch this player now')

export const mutualPairHint = def('Next mutual swap: these two trade places automatically.')

export const switchRequestsTab = def('Switch requests')

export const switchRequestsTabHint = def('Players asking to switch teams')

export const switchNowFailed = def((code: string) => ({
	toast: [t('Switch failed'), { description: t('The request could not be fulfilled ({code}).', { code }) }],
}))
