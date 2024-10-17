import React from 'react'

export type SetStateCallback<T> = (prevState: T) => T
export type SetState<T> = (cb: SetStateCallback<T>) => void

export type GenericForwardedRef<RefType, Props extends object> = <P extends Props>(
	props: P & { ref: React.Ref<RefType> }
) => React.ReactElement
