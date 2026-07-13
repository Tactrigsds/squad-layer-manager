import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'

/**
 * react-rxjs suspends a component until its StateObservable produces a first value, and React cannot notice when
 * that value never arrives: Suspense has no timeout, and a suspended component never commits, so it can't run a
 * timer of its own either. The stream is the only place that can tell "nothing is coming", hence the first-emit
 * guard below.
 *
 * Rule of thumb: any bind that can suspend (i.e. has no default value) should go through `bind` here so the hang
 * turns into an attributable error instead of a permanent fallback. Binds with a default value can't suspend and
 * are fine on plain `ReactRx.bind`.
 */

export class StateTimeoutError extends Error {
	constructor(readonly tag: string, readonly ms: number) {
		super(`"${tag}" produced no value within ${ms}ms of the transport being live`)
		this.name = 'StateTimeoutError'
	}
}

export const DEFAULT_FIRST_EMIT_TIMEOUT = 15_000

// the guard's clock only runs while the transport can actually deliver a value, otherwise a dropped websocket
// would produce an error screen instead of a fallback that resolves on its own once we reconnect. Injected
// (rather than imported from orpc.client) to keep this module free of app dependencies.
let transportLive$: Rx.Observable<boolean> = Rx.of(true)
export function setTransportLive(live$: Rx.Observable<boolean>) {
	transportLive$ = live$
}

export function guardFirstEmit<T>(tag: string, ms: number): Rx.MonoTypeOperatorFunction<T> {
	return (source$) =>
		Rx.defer(() => {
			const settled$ = new Rx.Subject<void>()
			const settle = () => settled$.next()
			const timeout$: Rx.Observable<never> = Rx.defer(() => transportLive$).pipe(
				// the clock restarts on each reconnect, so a flapping connection can't accumulate its way to a timeout
				Rx.switchMap((live) => live ? Rx.timer(ms) : Rx.NEVER),
				Rx.take(1),
				Rx.takeUntil(settled$),
				Rx.mergeMap(() => Rx.throwError(() => new StateTimeoutError(tag, ms))),
			)
			// timeout$ is merged first so that a source which emits (or completes) synchronously on subscribe still
			// cancels the timer -- settled$ has no replay, so nothing may be pushed through it before this subscribes
			return Rx.merge(timeout$, source$.pipe(Rx.tap({ next: settle, complete: settle })))
		})
}

/**
 * Resubscribe after an error, for the long-lived subscriptions that keep a state observable hot (frame setup,
 * `watchServer`). A StateObservable resets itself on error, so resubscribing re-runs the source; without this the
 * first timeout would leave the stream dead for the rest of the session even once the server recovered.
 */
export function retryHot<T>(delayMs = 5_000): Rx.MonoTypeOperatorFunction<T> {
	return Rx.retry({
		delay: (err) => {
			console.error(err)
			return Rx.timer(delayMs)
		},
	})
}

export type BindOpts = {
	// false disables the guard, for streams which are events rather than state and legitimately stay silent
	// (e.g. an invalidation feed that only fires when something changes)
	firstEmitTimeoutMs?: number | false
}

export function bind<T>(tag: string, source$: Rx.Observable<T>, opts?: BindOpts): [() => T, ReactRx.StateObservable<T>]
export function bind<Args extends unknown[], T>(
	tag: string,
	getSource: (...args: Args) => Rx.Observable<T>,
	opts?: BindOpts,
): [(...args: Args) => T, (...args: Args) => ReactRx.StateObservable<T>]
export function bind(tag: string, source: Rx.Observable<unknown> | ((...args: unknown[]) => Rx.Observable<unknown>), opts?: BindOpts) {
	const ms = opts?.firstEmitTimeoutMs ?? DEFAULT_FIRST_EMIT_TIMEOUT
	if (typeof source === 'function') {
		return ReactRx.bind((...args: unknown[]) => {
			const guarded = ms === false ? Rx.identity : guardFirstEmit(`${tag}(${args.join(', ')})`, ms)
			return source(...args).pipe(guarded)
		})
	}
	return ReactRx.bind(source.pipe(ms === false ? Rx.identity : guardFirstEmit(tag, ms)))
}
