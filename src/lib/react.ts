import React from 'react'

export type SetStateCallback<T> = (prevState: T) => T

export type GenericForwardedRef<RefType, Props extends object> = <P extends Props>(
	props: P & { ref?: React.MutableRefObject<RefType> },
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
	const ref = React.useRef<T>()
	if (!ref.current) {
		ref.current = constructor()
	}
	return ref as React.MutableRefObject<T>
}

export type Focusable = {
	focus: () => void
	isFocused: boolean
}

export function eltToFocusable(elt: HTMLElement): Focusable {
	return {
		focus: () => elt.focus(),
		get isFocused() {
			return document.activeElement === elt
		},
	}
}
