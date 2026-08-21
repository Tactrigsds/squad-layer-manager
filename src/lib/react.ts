import React from 'react'

import * as Obj from '@/lib/object-utils'

export type UseStateReturn<T> = [T, React.Dispatch<React.SetStateAction<T>>]

export type GenericForwardedRef<RefType, Props extends object> = <P extends Props>(
	props: P & { ref?: React.RefObject<RefType> },
) => React.ReactElement

export function useClosureRef<T extends object>(obj: T) {
	const objRef = React.useRef(obj)

	React.useLayoutEffect(() => {
		objRef.current = obj
	}, [obj])
	return objRef
}

/**
 * A ref built once per mount, for when reevaluating the starting value on every render is too much psychic damage.
 *
 * Only reach for this when the box itself is written to. To construct a value once and read it,
 * `React.useState(() => value)[0]` is the same guarantee without a ref, and reading `.current` during render costs
 * the whole component its React Compiler optimization.
 *
 * Name the result `<something>Ref`. React Compiler recognizes refs by identifier, not by type, so a differently
 * named binding is treated as an ordinary hook return and writing through its `.current` trips `react/immutability`.
 */
export function useRefConstructor<T>(constructor: () => T) {
	// `=== null` rather than a falsy check, so a constructor returning 0, '' or undefined still runs exactly once
	const ref = React.useRef<T | null>(null)
	if (ref.current === null) {
		ref.current = constructor()
	}
	return ref as React.RefObject<T>
}

export type Focusable = {
	focus: () => void
	isFocused: boolean
}
export type Clearable = {
	// if ephemeralOnly then just the element state should be cleared(input values, etc)
	clear: (ephemeralOnly?: boolean) => void
}

export function eltToFocusable(elt: HTMLElement): Focusable {
	return {
		focus: () => elt.focus(),
		get isFocused() {
			return document.activeElement === elt
		},
	}
}

export function useStableReferenceDeepEquals<T>(value: T) {
	const ref = React.useRef<T>(value)
	if (value !== ref.current) {
		if (!Obj.deepEqual(value, ref.current)) {
			ref.current = value
		}
	}
	return ref.current
}
export function useStable<T>(value: T, compare: (a: T, b: T) => boolean = Obj.deepEqual) {
	const ref = React.useRef<T>(value)
	if (!compare(value, ref.current)) {
		ref.current = value
	}
	return ref.current
}

export function useStableValue<Deps extends [] | [unknown, ...unknown[]], O>(
	cb: (...args: Deps) => O,
	deps: Deps,
	opts?: {
		// do equality fheck for deps or the output value
		compare?: 'deps' | 'value'
		equals?: (a: any, b: any) => boolean
	},
) {
	const ref = React.useRef<any>(null)
	const outValueRef = React.useRef<O | undefined>(undefined)
	const compare = opts?.compare ?? 'deps'
	const compareValue = compare === 'deps' ? deps : cb(...deps)
	const equals = opts?.equals ?? Obj.deepEqual
	if (!equals(ref.current!, compareValue)) {
		ref.current = compareValue
		if (compare === 'deps') {
			outValueRef.current = cb(...(compareValue as Deps))
		} else {
			outValueRef.current = compareValue as any
		}
	}

	return outValueRef.current as O
}

// iife syntax sugar
export function inline<O>(cb: () => O) {
	return cb()
}

/**
 * A timestamp that advances on an interval, for UI that goes stale on its own: an expiring timeout, a presence
 * window. Reading `Date.now()` during render instead leaves the value frozen until something unrelated re-renders,
 * and React Compiler refuses to memoize around it.
 *
 * The snapshot is quantized to `intervalMs` so it holds still between ticks, which is what useSyncExternalStore
 * needs to avoid re-rendering on every read.
 */
export function useNow(intervalMs: number) {
	const subscribe = React.useCallback(
		(onTick: () => void) => {
			const id = setInterval(onTick, intervalMs)
			return () => clearInterval(id)
		},
		[intervalMs],
	)
	const getSnapshot = React.useCallback(() => Math.floor(Date.now() / intervalMs) * intervalMs, [intervalMs])
	return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
