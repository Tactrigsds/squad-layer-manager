import { Dispatch, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BehaviorSubject, Subject, Subscription } from 'rxjs'
import { debounceTime } from 'rxjs/operators'

export function useDebounced<T>({ value, delay, onChange }: { value: T; delay: number; onChange: (value: T) => void }) {
	const subRef = useRef(new BehaviorSubject<T>(value))
	useEffect(() => {
		const subscription = new Subscription()
		const debounced$ = subRef.current.pipe(debounceTime(delay))
		subscription.add(debounced$.subscribe(onChange))
		return () => subscription.unsubscribe()
	}, [onChange, delay])

	useEffect(() => {
		if (subRef.current.value !== value) return
		subRef.current.next(value)
	}, [value])
}
