import { Observable, asapScheduler, observeOn } from 'rxjs'

type Deferred<T> = Promise<T> & { resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: any) => void }

function defer<T>(): Deferred<T> {
	const properties = {},
		promise = new Promise<T>((resolve, reject) => {
			Object.assign(properties, { resolve, reject })
		})
	return Object.assign(promise, properties) as Deferred<T>
}

export async function* toAsyncGenerator<T>(observable: Observable<T>) {
	let nextData = defer<T>() as Deferred<T | null> | null
	const sub = observable.pipe(observeOn(asapScheduler)).subscribe({
		next(data) {
			const n = nextData
			nextData = defer()
			n?.resolve(data)
		},
		error(err) {
			nextData?.reject(err)
		},
		complete() {
			nextData?.resolve(null)
			nextData = null
		},
	})
	try {
		while (true) {
			const value = await nextData
			if (!nextData) break
			if (value) yield value
		}
	} finally {
		sub.unsubscribe()
	}
}
