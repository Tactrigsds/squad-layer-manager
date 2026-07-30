import { def, raw, t } from '@/models/messages.models'

// What the transport says about itself. The toast ids, durations and dismissibility that go with these stay at
// the call site: one outage owns one toast, and keeping it keyed and unclearable is protocol, not wording.

export const transportError = def((reason: string) => ({
	toast: [t('Transport Error'), { description: raw(reason) }],
}))

export const unknownError = def('Unknown error')

// the whole state is in the title: updating a toast by id merges into the existing one, so a description here
// would survive into the success toast that replaces it
export const reconnecting = def('Lost connection to the server, reconnecting...')

export const reconnected = def('Reconnected to the server')

export const upgrading = def(() => ({ toast: [t('SLM is being upgraded, window will refresh shortly...')] }))

export const subscriptionError = def((tag: string, reason: string) => ({
	toast: [t('Remote Subscription Error'), { description: t('{tag}: {reason}', { tag, reason }) }],
}))
