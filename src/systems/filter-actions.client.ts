// Actions on filter entities that need the users and rbac systems, which import the filter entity system themselves
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as F_Msgs from '@/messages/filter.messages'
import type * as F from '@/models/filter.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import { invalidateLoggedInUser } from '@/systems/users.client'

export namespace Actions {
	// Creates a copy of `source` under a new id and name, owned by the user, then runs `afterCreate` (such as opening
	// the copy). The user's permissions are refreshed only after it: a refresh racing a route load cancels the query the
	// loader is waiting on. Resolves to whether the copy was created.
	export async function clone(
		source: F.FilterEntity,
		input: { id: F.FilterEntityId; name: string },
		afterCreate?: () => Promise<void>,
	): Promise<boolean> {
		const res = await RPC.orpc.filters.createFilter.call({
			id: input.id,
			name: input.name,
			description: source.description,
			filter: source.filter,
			emoji: source.emoji,
			alertMessage: source.alertMessage,
			invertedEmoji: source.invertedEmoji,
			invertedAlertMessage: source.invertedAlertMessage,
			missExemption: source.missExemption,
		})
		switch (res.code) {
			case 'ok':
				toast(...tr.toast(F_Msgs.created()))
				await afterCreate?.()
				invalidateLoggedInUser()
				return true
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				return false
			case 'err:cyclical-reference':
				toast.error(...tr.toast(F_Msgs.cyclicalReference(res.cycle)))
				return false
			case 'err:already-exists':
				toast.error(...tr.toast(F_Msgs.idTaken(input.id)))
				return false
			default:
				assertNever(res)
		}
	}
}
