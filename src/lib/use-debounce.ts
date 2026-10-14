import React from 'react'

import * as Rx from '@/lib/rxjs'

export function useDebounced<T>(ops: { mode?: 'debounce' | 'throttle'; delay: number; onChange: (value: T) => void }) {
	// a plain Subject on purpose: a BehaviorSubject would replay the last value into the new subscription
	// when onChange changes identity, delivering a stale value to a consumer that never saw it produced
	const [sub] = React.useState(() => new Rx.Subject<T>())

	React.useEffect(() => {
		const subscription = new Rx.Subscription()
		const debounced$ = sub.pipe(
			Rx.observeOn(Rx.asyncScheduler),
			ops.mode === 'throttle' ? Rx.throttleTime(ops.delay) : Rx.debounceTime(ops.delay),
		)
		subscription.add(debounced$.subscribe(ops.onChange))
		return () => subscription.unsubscribe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ops.delay, ops.onChange])

	return React.useCallback((value: T) => sub.next(value), [sub])
}

// for when you still want to rerender immediately when state is set but you have some expensive side-effect you would like to compute asynchronously. defaultValue is expected to be referentially stable
export function useDebouncedState<T>(
	defaultValue: T,
	opts: {
		delay: number
		mode?: 'debounce' | 'throttle'
		onChange: (value: T) => void
	},
) {
	const prevDefaultValue = React.useRef(defaultValue)
	const [_state, setState] = React.useState(defaultValue)
	let state: T
	if (prevDefaultValue.current !== defaultValue) {
		state = defaultValue
	} else {
		state = _state
	}

	const setDebounced = useDebounced<T>({ ...opts })

	const setCombinedState = React.useCallback(
		(value: T) => {
			prevDefaultValue.current = defaultValue
			setState(value)
			setDebounced(value)
		},
		[defaultValue, setDebounced],
	)
	return [state, setCombinedState] as const
}
