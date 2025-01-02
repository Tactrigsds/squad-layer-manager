import { Subject } from 'rxjs'
import { useToast, Toast } from './use-toast.ts'
import React from 'react'

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
