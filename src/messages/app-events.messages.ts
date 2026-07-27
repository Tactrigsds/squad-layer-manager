import * as Msgs from '@/messages/shared'
import type * as AppEvents from '@/models/app-events.models'

// The audit log, rendered on the settings page. `describeAppEvent` in the models still builds each row's summary
// line itself.

export const auditLog = Msgs.def(() => ({ text: () => 'Audit Log' }))

export const auditLogBlurb = Msgs.def(() => ({ text: () => 'Recent actions taken across SLM.' }))

export const noEvents = Msgs.def(() => ({ text: () => 'No events yet.' }))

// what a row calls the actor when it cannot name them: an SLM user whose account no longer resolves, an in-game
// admin missing from the players table, or the system, which has no name to resolve in the first place
export const unnamedActors: Record<AppEvents.Actor['type'], string> = {
	'slm-user': 'Admin',
	'ingame-user': 'An in-game admin',
	system: 'System',
}
