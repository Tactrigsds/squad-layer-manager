export type ItemMutations = {
	added: Set<string>
	removed: Set<string>
	moved: Set<string>
	edited: Set<string>
}

export type ItemMutationState = { [key in keyof ItemMutations]: boolean }
export type WithMutationId = { id: string }

export function getDisplayedMutation(mutation: ItemMutationState) {
	if (mutation.added) return 'added'
	if (mutation.removed) return 'removed'
	if (mutation.moved) return 'moved'
	if (mutation.edited) return 'edited'
}
export function tryApplyMutation(type: keyof ItemMutations, ids: string | string[], mutations: ItemMutations) {
	for (const id of Array.isArray(ids) ? ids : [ids]) {
		if (type === 'added') {
			mutations.added.add(id)
		}
		if (type === 'removed') {
			if (mutations.added.has(id)) {
				mutations.added.delete(id)
				return
			}
			mutations.removed.add(id)
			mutations.edited.delete(id)
			mutations.moved.delete(id)
		}
		if (type === 'moved' && !mutations.added.has(id)) {
			mutations.moved.add(id)
		}
		if (type === 'edited' && !mutations.added.has(id)) {
			mutations.edited.add(id)
		}
	}
}

export function getAllMutationIds(mutations: ItemMutations) {
	return new Set([...mutations.added, ...mutations.removed, ...mutations.moved, ...mutations.edited])
}

export function initMutationState(): ItemMutationState {
	return {
		added: false,
		removed: false,
		moved: false,
		edited: false,
	}
}
export function initMutations(): ItemMutations {
	return {
		added: new Set(),
		removed: new Set(),
		moved: new Set(),
		edited: new Set(),
	}
}

export function hasMutations(mutations: ItemMutations) {
	return Math.max(...Object.values(mutations).map((set) => set.size)) > 0
}

export function toItemMutationState(mutations: ItemMutations, id: string): ItemMutationState {
	return {
		added: mutations.added.has(id),
		removed: mutations.removed.has(id),
		moved: mutations.moved.has(id),
		edited: mutations.edited.has(id),
	}
}
