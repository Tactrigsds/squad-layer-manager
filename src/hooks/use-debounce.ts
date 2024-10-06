import { useEffect, useRef } from 'react'
import { BehaviorSubject, Subscription } from 'rxjs'
import { debounceTime } from 'rxjs/operators'

export function useDebounced<T>({ defaultValue, delay, onChange }: { defaultValue: T; delay: number; onChange: (value: T) => void }) {
	const subRef = useRef(new BehaviorSubject<T>(defaultValue))
	useEffect(() => {
		const subscription = new Subscription()
		const debounced$ = subRef.current.pipe(debounceTime(delay))
		subscription.add(debounced$.subscribe(onChange))
		return () => subscription.unsubscribe()
	}, [onChange, delay])

	return {
		setValue: (value: T) => subRef.current.next(value),
	}
}
