import * as Msgs from '@/messages/shared'

// What the transport says about itself. The toast ids, durations and dismissibility that go with these stay at
// the call site: one outage owns one toast, and keeping it keyed and unclearable is protocol, not wording.

export const transportError = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Transport Error'), { description: reason }],
}))

export const unknownError = Msgs.def('Unknown error')

// the whole state is in the title: updating a toast by id merges into the existing one, so a description here
// would survive into the success toast that replaces it
export const reconnecting = Msgs.def('Lost connection to the server, reconnecting...')

export const reconnected = Msgs.def('Reconnected to the server')

export const upgrading = Msgs.def(() => ({ toast: () => [Msgs.t('SLM is being upgraded, window will refresh shortly...')] }))

export const subscriptionError = Msgs.def((tag: string, reason: string) => ({
	toast: () => [Msgs.t('Remote Subscription Error'), { description: `${tag}: ${reason}` }],
}))
