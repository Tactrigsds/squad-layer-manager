import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as ROT_Msgs from '@/messages/rotations.messages'
import * as LTag from '@/models/layer-tags.models'
import type * as ROT from '@/models/rotations.models'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as PartsSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'
import type { RotationChange } from '@/systems/rotation.server'
import * as SettingsClient from '@/systems/settings.client'

// every rotation, kept current from rotations.watchRotations
export type State = {
	rotations: ReadonlyMap<ROT.RotationId, ROT.Rotation>
	initialized: boolean
}

export const Store = Zus.createStore<State>(() => ({ rotations: new Map(), initialized: false }))

export namespace Sel {
	export function rotations(state: State) {
		return state.rotations
	}
	export const rotation = (id: ROT.RotationId | undefined) => (state: State) => (id ? state.rotations.get(id) : undefined)
}

export function getContributorsQuery(rotationId: ROT.RotationId) {
	return RPC.orpc.rotations.getContributors.queryOptions({ input: rotationId })
}

type MutationResult = { code: string; message?: string; msg?: string }

// reports a failed call; true when the call succeeded
function handleResult(res: MutationResult): boolean {
	if (res.code === 'ok') return true
	if (res.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res as never)
	else if (res.code === 'err:already-exists') toast.error(...tr.toast(ROT_Msgs.idTaken()))
	else toast.error(...tr.toast(ROT_Msgs.actionFailed(res.message ?? res.msg ?? res.code)))
	return false
}

export namespace Actions {
	export async function create(input: ROT.NewRotation): Promise<boolean> {
		return handleResult(await RPC.orpc.rotations.create.call(input))
	}

	export async function clone(input: ROT.CloneInput) {
		return handleResult(await RPC.orpc.rotations.clone.call(input))
	}

	export async function updateMeta(rotationId: ROT.RotationId, patch: ROT.MetaPatch): Promise<boolean> {
		return handleResult(await RPC.orpc.rotations.updateMeta.call({ rotationId, patch }))
	}

	export async function setTag(rotationId: ROT.RotationId, tagId: LTag.TagId, applied: boolean): Promise<boolean> {
		const current = Store.getState().rotations.get(rotationId)?.tags ?? []
		const tags = applied ? [...new Set([...current, tagId])] : current.filter((id) => id !== tagId)
		return await updateMeta(rotationId, { tags })
	}

	export async function addContributor(rotationId: ROT.RotationId, who: { userId: USR.UserId } | { roleId: string }) {
		const res = await RPC.orpc.rotations.addContributor.call({ rotationId, ...who })
		if (res.code === 'err:already-exists') toast(...tr.toast(F_Msgs.contributorAlreadyAdded()))
		else handleResult(res)
		void RPC.queryClient.invalidateQueries({ queryKey: getContributorsQuery(rotationId).queryKey })
	}

	export async function removeContributor(rotationId: ROT.RotationId, who: { userId: USR.UserId } | { roleId: string }) {
		const res = await RPC.orpc.rotations.removeContributor.call({ rotationId, ...who })
		if (res.code === 'err:not-found') toast(...tr.toast(F_Msgs.contributorNotFound()))
		else handleResult(res)
		void RPC.queryClient.invalidateQueries({ queryKey: getContributorsQuery(rotationId).queryKey })
	}

	// creates a layer tag for each label, resolving to each label's new id, lowercased, or null when one failed
	export async function createLayerTags(labels: string[]): Promise<Map<string, LTag.TagId> | null> {
		const created = new Map<string, LTag.TagId>()
		const taken = [...(SettingsClient.PublicSettingsStore.getState()?.layerTags ?? [])]
		for (const label of labels) {
			const tag: LTag.Tag = { id: LTag.createTagId(label), label, description: '', color: LTag.suggestColor(taken) }
			const res = await RPC.orpc.settings.global.upsertLayerTag.call(tag)
			if (res.code !== 'ok') {
				if (res.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
				else toast.error(...tr.toast(ROT_Msgs.actionFailed(res.message)))
				return null
			}
			taken.push(res.tag)
			created.set(label.toLowerCase(), res.tag.id)
		}
		return created
	}

	export async function remove(rotation: ROT.Rotation): Promise<boolean> {
		const ok = handleResult(await RPC.orpc.rotations.delete.call(rotation.id))
		if (ok) toast(...tr.toast(ROT_Msgs.deleted(rotation.name)))
		return ok
	}
}

export function setup() {
	RPC.observe('rotations.watchRotations', () => RPC.orpc.rotations.watchRotations.call()).subscribe((_output) => {
		const output = PartsSys.stripParts(_output) as RotationChange
		switch (output.code) {
			case 'initial-value':
				Store.setState({ rotations: new Map(output.rotations.map((r) => [r.id, r])), initialized: true })
				break
			case 'mutation': {
				const { mutation } = output
				const rotations = new Map(Store.getState().rotations)
				switch (mutation.type) {
					case 'add':
					case 'update':
						rotations.set(mutation.key, mutation.value)
						break
					case 'delete':
						rotations.delete(mutation.key)
						break
					default:
						assertNever(mutation.type)
				}
				Store.setState({ rotations })
				break
			}
			default:
				assertNever(output)
		}
	})
}
