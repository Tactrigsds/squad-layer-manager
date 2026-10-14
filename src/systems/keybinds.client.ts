// Routes each key to the binding that answers it, following the scopes around where the key was pressed. The table in
// models/keybinds.models.ts declares the bindings and scope types. This module holds the scopes that are open.
//
// A scope is opened by a component with `useScope(type, handlers)`, and attached to an element through the handle's
// `ref`. The scope it was opened inside, read from React context, is its parent, so a scope portalled out of its
// opener's DOM, as a dialog or popover is, still chains back to it. An overlay that opens no scope of its own (a menu,
// a select) marks its content with `inheritAttrs()`, so a key pressed in it reaches the scope it was opened from.
// A region rendered without React instead carries `typeAttrs(type)`, and its type's handlers are registered once with
// `handleType`.
//
// One listener, on the document in the bubble phase, sees each key after every focused control has had it. A control
// that answers a key itself claims it with preventDefault(), and the listener leaves a claimed key alone. Otherwise it
// builds the chain of scopes around the key's target, innermost first, and asks each in turn. A browser or library
// binding stops the walk and leaves the key to its owner. A button binding clicks the button the scope marks for it, so
// a disabled button blocks the key as it blocks the mouse. A handler binding runs its handler, which can return false to
// pass the key on. The walk ends at an isolated scope.
//
// A key pressed with nothing focused (on `body`) goes to the topmost open modal scope. Without one, it goes to the
// scope under the pointer if that scope's type takes hovered keys, then to the scope last pressed or focused in.
import * as React from 'react'

import { createId } from '@/lib/id'
import * as KB from '@/lib/keybinds'
import * as KEYS from '@/models/keybinds.models'

export const SCOPE_ATTR = 'data-kb-scope'
export const TYPE_ATTR = 'data-kb-type'
export const INHERIT_ATTR = 'data-kb-inherit'
export const BUTTON_ATTR = 'data-kb'

type Instance = {
	id: string
	type: KEYS.ScopeType
	element: Element | null
	parentId: string | null
	handlers: Partial<Record<KEYS.BindingId, KEYS.Handler>>
	openedAt: number
}

// one step of the chain a key walks: an open scope, a region marked by type, or the implicit scope of a text field
type Link = { type: KEYS.ScopeType; element: Element | null; handlers: Partial<Record<KEYS.BindingId, KEYS.Handler>> }

const instances = new Map<string, Instance>()
const typeHandlers = new Map<KEYS.ScopeType, Partial<Record<KEYS.BindingId, KEYS.Handler>>>()
let openCount = 0

// the id of the scope a component renders inside. Null is the app itself, which holds only browser bindings
export const Context = React.createContext<string | null>(null)

export type ScopeHandle<S extends KEYS.ScopeType> = {
	type: S
	id: string
	// attaches the scope to an element, and returns the detach
	ref: (element: Element | null) => (() => void) | undefined
}

export function useScope<S extends KEYS.ScopeType>(type: S, handlers: KEYS.Handlers<S>): ScopeHandle<S> {
	const parentId = React.useContext(Context)
	const [id] = React.useState(() => createId(8))
	React.useLayoutEffect(() => {
		const existing = instances.get(id)
		instances.set(id, {
			id,
			type,
			element: existing?.element ?? null,
			parentId,
			handlers: handlers as Instance['handlers'],
			openedAt: existing?.openedAt ?? 0,
		})
	})
	React.useLayoutEffect(() => () => void instances.delete(id), [id])
	const ref = React.useCallback((element: Element | null) => attach(id, type, element), [id, type])
	return React.useMemo(() => ({ type, id, ref }), [type, id, ref])
}

// React attaches an element's ref before its owner's layout effects run, so on first mount this creates the record
function attach(id: string, type: KEYS.ScopeType, element: Element | null): (() => void) | undefined {
	if (!element) return
	const claimed = element.getAttribute(SCOPE_ATTR)
	if (claimed && claimed !== id) throw new Error(`element already holds keybinding scope ${claimed}; one element opens one scope`)
	element.setAttribute(SCOPE_ATTR, id)
	const instance = instances.get(id) ?? { id, type, element: null, parentId: null, handlers: {}, openedAt: 0 }
	instance.element = element
	// a ref re-attached on a later render keeps its place: the topmost modal is the one opened last
	if (!instance.openedAt) instance.openedAt = ++openCount
	instances.set(id, instance)
	if (import.meta.env.DEV) queueMicrotask(() => checkParent(id))
	return () => {
		if (element.getAttribute(SCOPE_ATTR) === id) element.removeAttribute(SCOPE_ATTR)
		const current = instances.get(id)
		if (current?.element === element) current.element = null
	}
}

// the attributes an overlay's content carries to pass keys to the scope it was opened from
export function useInheritAttrs(): Record<string, string> {
	const parentId = React.useContext(Context)
	return parentId ? { [INHERIT_ATTR]: parentId } : {}
}

export function typeAttrs(type: KEYS.ScopeType) {
	return { [TYPE_ATTR]: type }
}

export function handleType<S extends KEYS.ScopeType>(type: S, handlers: KEYS.Handlers<S>) {
	if (typeHandlers.has(type)) throw new Error(`keybinding handlers for ${type} are registered already`)
	typeHandlers.set(type, handlers as Partial<Record<KEYS.BindingId, KEYS.Handler>>)
}

export function buttonAttrs(id: KEYS.BindingId) {
	return { [BUTTON_ATTR]: id, 'aria-keyshortcuts': KEYS.ariaKeyshortcuts(id) }
}

// -------- the chain --------

const TABLE = KEYS.TABLE

function isTextField(element: Element) {
	return !!element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
}

// Radix keeps a closing overlay mounted, as data-state="closed", while it animates out
function isShowing(element: Element) {
	if (!element.isConnected || element.getAttribute('data-state') === 'closed') return false
	if (element.checkVisibility()) return true
	// a `display: contents` wrapper has no box of its own to be visible
	return getComputedStyle(element).display === 'contents' && [...element.children].some((child) => child.checkVisibility())
}

function instanceLinks(start: Instance, chain: Link[]): Link[] | null {
	for (let instance: Instance | undefined = start; instance; instance = instance.parentId ? instances.get(instance.parentId) : undefined) {
		// a scope with no element yet passes its keys straight to its parent
		if (!instance.element) continue
		if (!isShowing(instance.element)) return null
		chain.push({ type: instance.type, element: instance.element, handlers: instance.handlers })
		if (KB.isIsolated(TABLE, instance.type)) break
	}
	return chain
}

// the scopes around an element, innermost first. Null when one of them is hidden or closing
export function chainFrom(element: Element): Link[] | null {
	const chain: Link[] = []
	if (element.closest('.cm-editor')) chain.push({ type: 'code-editor', element: null, handlers: {} })
	else if (isTextField(element)) chain.push({ type: 'text-field', element: null, handlers: {} })
	for (let node: Element | null = element; node;) {
		const scopeElement: Element | null = node.closest(`[${SCOPE_ATTR}], [${TYPE_ATTR}], [${INHERIT_ATTR}]`)
		if (!scopeElement) return chain
		const scopeId = scopeElement.getAttribute(SCOPE_ATTR) ?? scopeElement.getAttribute(INHERIT_ATTR)
		if (scopeId) {
			const instance = instances.get(scopeId)
			if (instance) return instanceLinks(instance, chain)
			node = scopeElement.parentElement
			continue
		}
		const type = scopeElement.getAttribute(TYPE_ATTR) as KEYS.ScopeType
		if (!isShowing(scopeElement)) return null
		chain.push({ type, element: scopeElement, handlers: typeHandlers.get(type) ?? {} })
		if (KB.isIsolated(TABLE, type)) return chain
		node = scopeElement.parentElement
	}
	return chain
}

// the element last pressed or focused, and the scope around it, which outlasts the element: a button often removes
// itself, leaving focus on the body, and the next key belongs to the scope it was in
let lastEngaged: { element: Element; scope: Element | null } | null = null

function onEngage(e: Event) {
	if (!(e.target instanceof Element)) return
	const scope = e.target.closest(`[${SCOPE_ATTR}], [${TYPE_ATTR}], [${INHERIT_ATTR}]`)
	const inherited = scope?.getAttribute(INHERIT_ATTR)
	lastEngaged = { element: e.target, scope: inherited ? (instances.get(inherited)?.element ?? null) : scope }
}

function engagedElement(): Element | null {
	if (!lastEngaged) return null
	if (lastEngaged.element.isConnected) return lastEngaged.element
	return lastEngaged.scope?.isConnected ? lastEngaged.scope : null
}

// the chains a key pressed with nothing focused tries, in order
function focuslessChains(): Link[][] {
	let modal: Instance | null = null
	for (const instance of instances.values()) {
		if (!instance.element || !KB.isModal(TABLE, instance.type) || !isShowing(instance.element)) continue
		if (!modal || instance.openedAt > modal.openedAt) modal = instance
	}
	const engagedEl = engagedElement()
	if (modal) {
		const engaged = engagedEl && modal.element!.contains(engagedEl) ? chainFrom(engagedEl) : null
		return [engaged ?? instanceLinks(modal, []) ?? []]
	}
	const chains: Link[][] = []
	const hovered = [...document.querySelectorAll(':hover')].at(-1)
	const hoverChain = hovered ? chainFrom(hovered) : null
	if (hoverChain?.some((link) => KB.isHover(TABLE, link.type))) chains.push(hoverChain)
	const engaged = engagedEl ? chainFrom(engagedEl) : null
	if (engaged) chains.push(engaged)
	return chains
}

// -------- dispatch --------

const bindingsByKeys = new Map<string, KEYS.BindingId[]>()
for (const id of Object.keys(TABLE.bindings) as KEYS.BindingId[]) {
	for (const chord of KB.chordsFor(TABLE.bindings[id], KEYS.PLATFORM)) {
		const keys = KB.canonical(chord, KEYS.PLATFORM)
		bindingsByKeys.set(keys, [...(bindingsByKeys.get(keys) ?? []), id])
	}
}

function defOf(id: KEYS.BindingId): KB.BindingDef<KEYS.ScopeType, KEYS.BindingId> {
	return TABLE.bindings[id]
}

function appliesIn(id: KEYS.BindingId, type: KEYS.ScopeType) {
	return defOf(id).scopes.some((scope) => KB.isA(TABLE, type, scope))
}

// the scope a button belongs to for a binding: the nearest one around it that the binding applies in
function ownerOf(button: Element, id: KEYS.BindingId): Element | null {
	for (let node = button.parentElement; node; node = node.parentElement) {
		const scopeId = node.getAttribute(SCOPE_ATTR)
		const type = scopeId ? instances.get(scopeId)?.type : (node.getAttribute(TYPE_ATTR) as KEYS.ScopeType | null)
		if (type && appliesIn(id, type)) return node
	}
	return null
}

export function ownedButton(scopeElement: Element, id: KEYS.BindingId): HTMLElement | null {
	for (const button of scopeElement.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}="${id}"]`)) {
		if (ownerOf(button, id) === scopeElement) return button
	}
	return null
}

// the element of the nearest scope around `element` that a binding applies in
export function nearestScopeFor(element: Element, id: KEYS.BindingId): Element | null {
	for (const link of chainFrom(element) ?? []) {
		if (link.element && appliesIn(id, link.type)) return link.element
	}
	return null
}

type Outcome = 'handled' | 'stopped' | 'unhandled'

function walk(e: KeyboardEvent, chain: Link[], candidates: KEYS.BindingId[]): Outcome {
	for (const link of chain) {
		const here = candidates
			.filter((id) => appliesIn(id, link.type))
			// a binding that shadows another goes first
			.sort((a, b) => (defOf(a).shadows?.includes(b) ? -1 : defOf(b).shadows?.includes(a) ? 1 : 0))
		for (const id of here) {
			const def = defOf(id)
			if (def.native || def.local) return 'stopped'
			if (def.button) {
				const button = link.element && ownedButton(link.element, id)
				if (!button) continue
				e.preventDefault()
				button.click()
				return 'handled'
			}
			const handler = link.handlers[id]
			if (handler && handler(e, link.element!) !== false) {
				e.preventDefault()
				return 'handled'
			}
		}
		if (KB.isIsolated(TABLE, link.type)) return 'stopped'
	}
	return 'unhandled'
}

const reached = new WeakSet<KeyboardEvent>()

function onKeyDown(e: KeyboardEvent) {
	reached.add(e)
	if (e.isComposing) return
	const candidates = (bindingsByKeys.get(KB.eventKeys(e)) ?? []).filter((id) => !e.repeat || defOf(id).repeat)
	if (candidates.length === 0) return
	const target = e.target instanceof Element ? e.target : null
	if (e.defaultPrevented) {
		if (import.meta.env.DEV) warnIfUnexplained(e, target, candidates)
		return
	}
	const chains = !target || target === document.body || target === document.documentElement ? focuslessChains() : [chainFrom(target) ?? []]
	for (const chain of chains) {
		if (walk(e, chain, candidates) !== 'unhandled') return
	}
}

// -------- development checks --------

function checkParent(id: string) {
	const instance = instances.get(id)
	if (!instance?.element) return
	const parentType = instance.parentId ? instances.get(instance.parentId)?.type : 'app'
	if (!parentType || KB.canSitWithin(TABLE, instance.type, parentType)) return
	throw new Error(
		`keybinding scope ${instance.type} opened inside ${parentType}, which the table does not allow. Add ${parentType} to its parents in models/keybinds.models.ts`,
	)
}

// a key a binding declares, claimed before the dispatcher by something that declares nothing for it
function warnIfUnexplained(e: KeyboardEvent, target: Element | null, candidates: KEYS.BindingId[]) {
	const chain = target && target !== document.body ? (chainFrom(target) ?? []) : []
	const explained = chain.some((link) => candidates.some((id) => appliesIn(id, link.type) && (defOf(id).native || defOf(id).local)))
	if (!explained) console.warn(`[keybinds] ${KB.eventKeys(e)} (${candidates.join(', ')}) was claimed before the dispatcher saw it`, target)
}

// sees every key first, and warns about one a binding declares that never reached the dispatcher: something stopped it
function onKeyDownObserved(e: KeyboardEvent) {
	if (e.isComposing) return
	const candidates = bindingsByKeys.get(KB.eventKeys(e))
	if (!candidates?.some((id) => !defOf(id).native)) return
	setTimeout(() => {
		if (!reached.has(e))
			console.warn(`[keybinds] ${KB.eventKeys(e)} (${candidates.join(', ')}) was stopped before the dispatcher saw it`, e.target)
	})
}

export function setup() {
	if (import.meta.env.DEV) {
		KB.assertValid(TABLE)
		window.addEventListener('keydown', onKeyDownObserved, { capture: true })
	}
	document.addEventListener('pointerdown', onEngage, { capture: true })
	document.addEventListener('focusin', onEngage, { capture: true })
	document.addEventListener('keydown', onKeyDown)
}
