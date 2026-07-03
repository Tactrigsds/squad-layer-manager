import * as CS from '@/models/context-shared'
import type { MutexInterface } from 'async-mutex'
import * as Rx from 'rxjs'

type Value =
	| Rx.Subscription
	| Rx.ObservableInput<unknown>
	| Rx.Subject<unknown>
	| MutexInterface
	| AbortController
	| null
	| undefined

export type Task = (() => Value | void) | Value | Tasks

export type Tasks = Task[]

// runs cleanuptasks in a FILO fashion
export function runCleanup(ctx: CS.Log, tasks: Tasks) {
	return Rx.lastValueFrom(Rx.concat(tasks.toReversed().map(to$)).pipe(Rx.endWith(0)))

	function to$(_task: Task, index: number) {
		try {
			let task = typeof _task === 'function' ? _task() : _task
			if (task == null || task == undefined) {
				return Rx.EMPTY
			}
			if (task instanceof Rx.Subject) {
				task.complete()
				return Rx.EMPTY
			}
			if (isMutex(task)) {
				task.cancel()
				return Rx.EMPTY
			}
			if (task instanceof AbortController) {
				task.abort()
				return Rx.EMPTY
			}
			if (isSubscription(task)) {
				task.unsubscribe()
				return Rx.EMPTY
			}

			return task
		} catch (err) {
			const unreversedIndex = tasks.length - index - 1
			ctx.log.error(err, 'caught error during cleanup for task at index %d', unreversedIndex)
			return Rx.EMPTY
		}
	}
}

function isSubscription(value: any): value is Rx.Subscription {
	return typeof value === 'object' && 'subscribe' in value && 'unsubscribe' in value
}

function isMutex(value: any): value is MutexInterface {
	const methods = ['acquire', 'runExclusive', 'waitForUnlock', 'isLocked', 'release', 'cancel']
	return typeof value === 'object' && methods.every((method) => method in value)
}
