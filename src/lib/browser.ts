import React from 'react'
import * as Rx from 'rxjs'

export function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof document !== 'undefined'
}

export const interaction$ = (function createPageActivityObservable(): Rx.Observable<true> {
	const userActions$ = Rx.merge(
		Rx.fromEvent(document, 'mousemove'),
		Rx.fromEvent(document, 'onclick'),
		Rx.fromEvent(document, 'oncontext'),
		Rx.fromEvent(document, 'focus'),
		Rx.fromEvent(document, 'keydown'),
		Rx.fromEvent(document, 'scroll'),
		Rx.fromEvent(document, 'touchstart'),
	)

	return userActions$.pipe(
		Rx.observeOn(Rx.asyncScheduler),
		Rx.map((): true => true),
		Rx.share(),
	)
})()

export function useNavigateAlert(interrupt: boolean): void {
	React.useEffect(() => {
		if (!interrupt) return

		const handleBeforeUnload = (event: BeforeUnloadEvent): boolean => {
			const shouldContinue = window.confirm('Are you sure you want to leave this page?')
			if (!shouldContinue) {
				event.preventDefault()
				return false
			}
			return true
		}

		const handleNavigate = (event: PopStateEvent): void => {
			const shouldContinue = window.confirm('Are you sure you want to leave this page?')
			if (!shouldContinue) {
				event.preventDefault()
				window.history.pushState(null, '', window.location.href)
			}
		}

		const originalPushState = window.history.pushState
		const originalReplaceState = window.history.replaceState

		window.history.pushState = function(...args: Parameters<typeof originalPushState>): void {
			const shouldContinue = window.confirm('Are you sure you want to leave this page?')
			if (shouldContinue) {
				originalPushState.apply(window.history, args)
			}
		}

		window.history.replaceState = function(...args: Parameters<typeof originalReplaceState>): void {
			const shouldContinue = window.confirm('Are you sure you want to leave this page?')
			if (shouldContinue) {
				originalReplaceState.apply(window.history, args)
			}
		}

		window.addEventListener('beforeunload', handleBeforeUnload)
		window.addEventListener('popstate', handleNavigate)
		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload)
			window.removeEventListener('popstate', handleNavigate)
			window.history.pushState = originalPushState
			window.history.replaceState = originalReplaceState
		}
	}, [interrupt])
}
