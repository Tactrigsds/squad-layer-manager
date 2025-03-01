import { useEffect, useRef } from 'react'
import { BehaviorSubject, Subscription } from 'rxjs'
import { debounceTime } from 'rxjs/operators'

import { useRefConstructor } from '@/lib/react'

export function useDebounced<T>(
	{ defaultValue, delay, onChange }: { defaultValue: () => T; delay: number; onChange: (value: T) => void },
) {
	const subRef = useRefConstructor(() => new BehaviorSubject<T>(defaultValue()))

	// trying to avoid stale closures without updating dep array. react was a mistake
	const onChangeRef = useRef(onChange)
	onChangeRef.current = onChange

	useEffect(() => {
		const subscription = new Subscription()
		const debounced$ = subRef.current.pipe(debounceTime(delay))
		subscription.add(debounced$.subscribe(onChangeRef.current))
		return () => subscription.unsubscribe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [delay])

	return {
		setValue: (value: T) => subRef.current.next(value),
	}
}
