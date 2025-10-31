import React from 'react'
import * as Rx from 'rxjs'

import { useRefConstructor } from '@/lib/react'

export function useDebounced<T>(
	ops: { mode?: 'debounce' | 'throttle'; defaultValue?: () => T; delay: number; onChange: (value: T) => void },
) {
	const subRef = useRefConstructor(() => ops.defaultValue ? new Rx.BehaviorSubject<T>(ops.defaultValue()) : new Rx.Subject<T>())

	React.useEffect(() => {
		const subscription = new Rx.Subscription()
		const debounced$ = subRef.current.pipe(
			Rx.observeOn(Rx.asyncScheduler),
			ops.mode === 'throttle' ? Rx.throttleTime(ops.delay) : Rx.debounceTime(ops.delay),
		)
		subscription.add(debounced$.subscribe(ops.onChange))
		return () => subscription.unsubscribe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ops.delay, ops.onChange])

	// eslint-disable-next-line react-hooks/exhaustive-deps
	return React.useCallback((value: T) => subRef.current.next(value), [])
}

// for when you still want to rerender immediately when state is set but you have some expensive side-effect you would like to compute asynchronously
export function useDebouncedState<T>(defaultValue: T, opts: {
	delay: number
	mode?: 'debounce' | 'throttle'
	onChange: (value: T) => void
}) {
	const [state, setState] = React.useState(defaultValue)

	const setDebounced = useDebounced({ defaultValue: () => defaultValue, ...opts })

	const setCombinedState = (value: T) => {
		setState(value)
		setDebounced(value)
	}
	return [state, setCombinedState] as const
}
