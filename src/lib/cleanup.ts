import type { MutexInterface } from 'async-mutex'

import type * as CS from '@/models/context-shared'

import * as Rx from './rxjs'
import { assertNever } from './type-guards'

type Value = Rx.Subscription | Rx.ObservableInput<unknown> | Rx.Subject<unknown> | MutexInterface | AbortController | null | undefined

export type Task = (() => unknown) | Value | Tasks

export type Tasks = Task[]

type Classified =
	| { kind: 'noop' }
	| { kind: 'nested'; tasks: Tasks }
	| { kind: 'subject'; subject: Rx.Subject<unknown> }
	| { kind: 'mutex'; mutex: MutexInterface }
	| { kind: 'abortController'; controller: AbortController }
	| { kind: 'subscription'; subscription: Rx.Subscription }
	| { kind: 'awaitable'; source: Rx.ObservableInput<unknown> }

// The order of these checks is load-bearing, so they live in one function rather than as separate predicates whose
// correctness depends on the sequence a caller happens to apply them in. A Subject is a Subscription *and* an
// ObservableInput; a mutex and an AbortController both carry cancel-shaped methods; a Subscription carries
// `unsubscribe` and, unlike an Observable, no `subscribe`. Every branch is only right because the ones above it
// have already been ruled out. Anything left unrecognized is ignored rather than awaited: a thunk's return value is
// incidental, and zustand's unsubscribe -- `() => listeners.delete(listener)` -- hands back Set.delete's `true`.
function classify(value: unknown): Classified {
	if (value === null || value === undefined) return { kind: 'noop' }
	if (Array.isArray(value)) return { kind: 'nested', tasks: value }
	if (value instanceof Rx.Subject) return { kind: 'subject', subject: value }
	if (value instanceof AbortController) return { kind: 'abortController', controller: value }
	if (isMutex(value)) return { kind: 'mutex', mutex: value }
	if (isSubscription(value)) return { kind: 'subscription', subscription: value }
	if (isObservableInput(value)) return { kind: 'awaitable', source: value }
	return { kind: 'noop' }
}

// runs cleanup tasks in a FILO fashion, awaiting any that are async. A failing task is logged and the rest still run
export function runCleanup(ctx: CS.Log, tasks: Tasks): Promise<unknown> {
	// concat takes its sources variadically -- `concat(array)` emits the array's members as values and subscribes to
	// none of them. Each task is also deferred, so the chain runs in sequence: mapping to$ directly would fire every
	// task's side effect during the map, before the first async one had finished, which is not FILO at all.
	const chain = tasks.toReversed().map((task, index) => Rx.defer(() => to$(task, index)))
	return Rx.lastValueFrom(Rx.concat(...chain).pipe(Rx.endWith(0)))

	function to$(task: Task, index: number): Rx.Observable<unknown> {
		// the position the caller passed this task at, undoing the reverse above
		const taskIndex = tasks.length - index - 1
		try {
			const classified = classify(typeof task === 'function' ? task() : task)
			switch (classified.kind) {
				case 'noop':
					return Rx.EMPTY
				case 'nested':
					return Rx.from(runCleanup(ctx, classified.tasks))
				case 'subject':
					classified.subject.complete()
					return Rx.EMPTY
				case 'mutex':
					classified.mutex.cancel()
					return Rx.EMPTY
				case 'abortController':
					classified.controller.abort()
					return Rx.EMPTY
				case 'subscription':
					classified.subscription.unsubscribe()
					return Rx.EMPTY
				case 'awaitable':
					// an async task that rejects must not take the remaining tasks with it
					return Rx.from(classified.source).pipe(Rx.catchError((err) => onError(err, taskIndex)))
				default:
					assertNever(classified)
			}
		} catch (err) {
			return onError(err, taskIndex)
		}
	}

	function onError(err: unknown, taskIndex: number) {
		ctx.log.error(err, 'caught error during cleanup for task at index %d', taskIndex)
		return Rx.EMPTY
	}
}

function isSubscription(value: any): value is Rx.Subscription {
	return value instanceof Rx.Subscription || typeof value.unsubscribe === 'function'
}

function isObservableInput(value: any): value is Rx.ObservableInput<unknown> {
	return typeof value.subscribe === 'function' || typeof value.then === 'function' || typeof value[Symbol.asyncIterator] === 'function'
}

function isMutex(value: any): value is MutexInterface {
	const methods = ['acquire', 'runExclusive', 'waitForUnlock', 'isLocked', 'release', 'cancel']
	return typeof value === 'object' && methods.every((method) => method in value)
}
