import type * as Cleanup from '@/lib/cleanup'
import type * as CS from '@/models/context-shared'
import type * as C from '@/server/context'

// Reminders warned to admins after each roll. A provider is asked, when the announcements run, for
// everything it wants said now, and the caller does the warning: nothing registered here reaches the
// game server itself.
//
// Asking rather than queueing is what makes withdrawal free. A reminder is only worth sending while
// the condition behind it holds, and the provider is the only thing that knows whether it still does,
// so it returns the messages that apply right now and nothing else. Returning several is normal, and
// removes any need for one to outrank another.

export type ProviderCtx = C.Db & CS.AbortSignal & C.ManagedServer
export type Provider = (ctx: ProviderCtx) => Promise<string[]>

const providers = new Set<Provider>()

/** Registers a provider asked for messages after each roll. Unregistered through `cleanup`. */
export function register(cleanup: Cleanup.Tasks, provide: Provider) {
	providers.add(provide)
	cleanup.push(() => providers.delete(provide))
}

/** Every provider's messages, in registration order. One that throws contributes nothing and does not stop the rest. */
export async function collect(ctx: ProviderCtx, log: CS.Logger): Promise<string[]> {
	const messages: string[] = []
	for (const provide of providers) {
		try {
			messages.push(...(await provide(ctx)))
		} catch (err) {
			log.error(err, 'post-roll reminder provider failed')
		}
	}
	return messages
}
