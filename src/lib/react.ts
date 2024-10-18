import React from 'react'

export type SetStateCallback<T> = (prevState: T) => T
export type SetState<T> = (cb: SetStateCallback<T>) => void

export type GenericForwardedRef<RefType, Props extends object> = <P extends Props>(
	props: P & { ref?: React.RefObject<RefType> }
) => React.ReactElement

export function useClosureRef<T extends object>(obj: T) {
	const objRef = React.useRef(obj)

	React.useLayoutEffect(() => {
		objRef.current = obj
	}, [obj])
	return objRef
}

/**
 * For when the psychic damage of whatever you set as the starting value of the ref being reevaluated on every render is too great.
 */
export function useRefConstructor<T>(constructor: () => T) {
	const ref = React.useRef<T>()
	if (!ref.current) {
		ref.current = constructor()
	}
	return ref as React.MutableRefObject<T>
}
