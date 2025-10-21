import React from 'react'
import * as Rx from 'rxjs'

import { useRefConstructor } from '@/lib/react'

type Opts<T> = {
	delay: number
	onChange: (value: T) => void
	immediate?: boolean
}
export function useDebounced<T>(
	{ defaultValue, delay, onChange, immediate }: { defaultValue: () => T } & Opts<T>,
) {
	const subRef = useRefConstructor(() => immediate === true ? new Rx.BehaviorSubject<T>(defaultValue()) : new Rx.Subject<T>())

	React.useEffect(() => {
		const subscription = new Rx.Subscription()
		const debounced$ = subRef.current.pipe(
			Rx.observeOn(Rx.asyncScheduler),
			Rx.debounceTime(delay),
		)
		subscription.add(debounced$.subscribe(onChange))
		return () => subscription.unsubscribe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [delay, onChange])

	// eslint-disable-next-line react-hooks/exhaustive-deps
	return React.useCallback((value: T) => subRef.current.next(value), [])
}

// for when you still want to rerender immediately when state is set but you have some expensive side-effect you would like to compute asynchronously
export function useDebouncedState<T>(defaultValue: T, opts: Opts<T>) {
	const [state, setState] = React.useState(defaultValue)

	const setDebounced = useDebounced({ defaultValue: () => defaultValue, ...opts })

	const setCombinedState = (value: T) => {
		setState(value)
		setDebounced(value)
	}
	return [state, setCombinedState] as const
}
