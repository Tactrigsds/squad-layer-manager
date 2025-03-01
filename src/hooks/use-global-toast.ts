import React from 'react'
import { Subject } from 'rxjs'
import { Toast, useToast } from './use-toast.ts'

// send events to the global toast
export const globalToast$ = new Subject<Toast>()

export function useGlobalToast() {
	const toaster = useToast()

	React.useEffect(() => {
		const sub = globalToast$.subscribe((args) => {
			toaster.toast(args)
		})
		return () => sub.unsubscribe()
	}, [toaster])
}
