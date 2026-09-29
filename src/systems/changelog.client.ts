import { toast } from '@/lib/toast'
import * as CL_Msgs from '@/messages/changelog.messages'
import * as RPC from '@/orpc.client'
import { rootRouter } from '@/root-router'
import { tr } from '@/systems/messages.client'

// Client side of the in-app changelog: the queries behind the What's new page and the unseen dot, and the notice
// shown once after the page reloads onto a new version.

// the releases, plus the caller's place in them as of this fetch
export const changelogQueryOptions = RPC.orpc.changelog.get.queryOptions()

// what the nav needs: how many headline changes the caller hasn't seen, and whether they want to be told
export const statusQueryOptions = RPC.orpc.changelog.getStatus.queryOptions()

export function setup() {
	let upgraded = false
	try {
		upgraded = sessionStorage.getItem(RPC.UPGRADED_KEY) !== null
		sessionStorage.removeItem(RPC.UPGRADED_KEY)
	} catch {
		// storage blocked: the notice is a nicety, so skipping it is fine
	}
	if (upgraded) void showUpgradeNotice()
}

async function showUpgradeNotice() {
	const status = await RPC.queryClient.fetchQuery(statusQueryOptions)
	if (!status.notify || status.unseen === 0) return
	toast(tr.text(CL_Msgs.upgraded(status.version)), {
		description: tr.text(CL_Msgs.upgradedUnseen(status.unseen)),
		duration: 15_000,
		action: { label: tr.text(CL_Msgs.seeWhatsNew()), onClick: () => void rootRouter.navigate({ to: '/changelog' }) },
	})
}

export namespace Actions {
	export async function markSeen(upTo: number) {
		await RPC.orpc.changelog.markSeen.call({ upTo })
		await RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.changelog.getStatus.key() })
	}

	export async function setNotify(notify: boolean) {
		RPC.queryClient.setQueryData(statusQueryOptions.queryKey, (prev) => (prev ? { ...prev, notify } : prev))
		await RPC.orpc.changelog.setNotify.call({ notify })
		await RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.changelog.key() })
	}
}
