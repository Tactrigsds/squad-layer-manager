import { Dispatch, useEffect, useRef, useState } from 'react'
import { BehaviorSubject, Subject, Subscription } from 'rxjs'
import { debounceTime } from 'rxjs/operators'

export function useDebounced<T>({
	setValue,
	defaultValue,
	waitTime,
	onChange,
}: {
	setValue: (v: T) => void
	defaultValue: T
	waitTime: number
	onChange: (value: T) => void
}) {
	const subRef = useRef(new BehaviorSubject<T>(defaultValue))
	useEffect(() => {
		const subscription = new Subscription()
		subscription.add(subRef.current.subscribe(setValue))
		const debounced$ = subRef.current.pipe(debounceTime(waitTime))
		subscription.add(debounced$.subscribe(onChange))
	}, [setValue, onChange, waitTime])
}
