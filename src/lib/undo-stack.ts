// A client's own undo history over an op-based editor. The stack applies nothing itself: `data` is whatever the
// editor needs to reverse an entry, and the editor replaces it each time it undoes or redoes one. Undoing moves an
// entry to the redo side, a fresh edit empties the redo side, and an entry whose ops the server refused is removed by
// the id of the op it sent.

export type Entry<T> = {
	id: string
	// what the entry did, for the button's tooltip
	kind: string
	// the ids of the ops this entry last dispatched, so a refusal can find it
	opIds: string[]
	// when the entry was last written. Consecutive entries sharing a key within COALESCE_WINDOW_MS merge into one, so a
	// value typed in one go is undone in one go
	at: number
	key: string | undefined
	// one action made of several edits, merged into a single entry however long apart they land
	group?: string
	data: T
}

export type Stack<T> = { past: Entry<T>[]; future: Entry<T>[] }

export const MAX_ENTRIES = 100
export const COALESCE_WINDOW_MS = 1000

const EMPTY: Stack<never> = { past: [], future: [] }

export function empty<T>(): Stack<T> {
	return EMPTY
}

// `merge` folds a new entry's data into the one it coalesces with, older first
export function push<T>(stack: Stack<T>, entry: Entry<T>, merge: (older: T, newer: T) => T): Stack<T> {
	const top = stack.past.at(-1)
	const sameGroup = entry.group !== undefined && top?.group === entry.group
	const sameKey = entry.key !== undefined && top?.key === entry.key && entry.at - top.at < COALESCE_WINDOW_MS
	if (top && (sameGroup || sameKey)) {
		const merged: Entry<T> = { ...entry, id: top.id, opIds: [...top.opIds, ...entry.opIds], data: merge(top.data, entry.data) }
		return { past: [...stack.past.slice(0, -1), merged], future: [] }
	}
	const past = stack.past.length >= MAX_ENTRIES ? stack.past.slice(1) : stack.past
	return { past: [...past, entry], future: [] }
}

export function peekUndo<T>(stack: Stack<T>): Entry<T> | undefined {
	return stack.past.at(-1)
}

export function peekRedo<T>(stack: Stack<T>): Entry<T> | undefined {
	return stack.future.at(-1)
}

export function find<T>(stack: Stack<T>, entryId: string): Entry<T> | undefined {
	return stack.past.find((entry) => entry.id === entryId) ?? stack.future.find((entry) => entry.id === entryId)
}

// moves an entry to the redo side once its undo has been dispatched. It loses its key and group: it is complete, and a
// later edit must not merge into it
export function undone<T>(stack: Stack<T>, entry: Entry<T>): Stack<T> {
	const past = stack.past.filter((e) => e.id !== entry.id)
	return { past, future: [...stack.future, { ...entry, key: undefined, group: undefined }] }
}

export function redone<T>(stack: Stack<T>, entry: Entry<T>): Stack<T> {
	const future = stack.future.filter((e) => e.id !== entry.id)
	return { past: [...stack.past, { ...entry, key: undefined, group: undefined }], future }
}

export function removeEntry<T>(stack: Stack<T>, entryId: string): Stack<T> {
	if (!find(stack, entryId)) return stack
	return { past: stack.past.filter((e) => e.id !== entryId), future: stack.future.filter((e) => e.id !== entryId) }
}

export function removeByOpId<T>(stack: Stack<T>, opId: string): Stack<T> {
	const keep = (entry: Entry<T>) => !entry.opIds.includes(opId)
	if (stack.past.every(keep) && stack.future.every(keep)) return stack
	return { past: stack.past.filter(keep), future: stack.future.filter(keep) }
}
