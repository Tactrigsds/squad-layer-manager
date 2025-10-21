export type Mutations<T extends string = string> = {
	added: Set<T>
	removed: Set<T>
	moved: Set<T>
	edited: Set<T>
}

export type MutType = keyof Mutations

export type ItemMutationState = { [key in keyof Mutations]: boolean }

export function getDisplayedMutation(mutation: ItemMutationState) {
	if (mutation.added) return 'added'
	if (mutation.removed) return 'removed'
	if (mutation.moved) return 'moved'
	if (mutation.edited) return 'edited'
}
export function tryApplyMutation<T extends string>(type: keyof Mutations, ids: T | T[], mutations?: Mutations<T>) {
	if (!mutations) return
	for (const id of Array.isArray(ids) ? ids : [ids]) {
		if (type === 'added') {
			mutations.added.add(id)
		}
		if (type === 'removed') {
			mutations.added.delete(id)
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

export function getAllMutationIds<T extends string>(mutations: Mutations<T>) {
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
export function initMutations<T extends string = string>(): Mutations<T> {
	return {
		added: new Set(),
		removed: new Set(),
		moved: new Set(),
		edited: new Set(),
	}
}

export function hasMutations(mutations: Mutations) {
	return Math.max(...Object.values(mutations).map((set) => set.size)) > 0
}

export function idMutated(mutations: Mutations, id: string) {
	return mutations.added.has(id) || mutations.removed.has(id) || mutations.moved.has(id) || mutations.edited.has(id)
}

export function toItemMutationState<T extends string>(mutations: Mutations<T>, id: T, parentItemId?: T): ItemMutationState {
	return {
		added: mutations.added.has(id) || parentItemId != undefined && mutations.moved.has(parentItemId),
		removed: mutations.removed.has(id) || parentItemId != undefined && mutations.moved.has(parentItemId),
		moved: mutations.moved.has(id) || parentItemId != undefined && mutations.moved.has(parentItemId),
		edited: mutations.edited.has(id) || parentItemId != undefined && mutations.moved.has(parentItemId),
	}
}
