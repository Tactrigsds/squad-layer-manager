import * as Obj from '@/lib/object'
import React from 'react'

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
 * For when the psychic damage of whatever you set as the starting value of the ref being reevaluated on every render is too great. Also useful if you only want to run something exactly once
 */
export function useRefConstructor<T>(constructor: () => T) {
	const ref = React.useRef<T>(null)
	if (!ref.current) {
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

export function useDeepEqualsMemo<T>(cb: () => T, deps: unknown[]) {
	const ref = React.useRef<T>(null)
	return React.useMemo(() => {
		const newValue = cb()
		if (!Obj.deepEqual(ref.current, newValue)) {
			ref.current = newValue
		}
		return ref.current
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps) as T
}
