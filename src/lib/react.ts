import React from 'react'

export type SetStateCallback<T> = (prevState: T) => T
export type SetState<T> = (cb: SetStateCallback<T>) => void

export type GenericForwardedRef<RefType, Props extends object> = <P extends Props>(
	props: P & { ref?: React.MutableRefObject<RefType> }
) => React.ReactElement

export function useClosureRef<T extends object>(obj: T) {
	const objRef = React.useRef(obj)

	React.useLayoutEffect(() => {
		objRef.current = obj
	}, [obj])
	return objRef
}
