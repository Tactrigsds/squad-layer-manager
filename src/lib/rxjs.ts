import { Observable } from 'rxjs'

function defer<T>() {
	const properties = {},
		promise = new Promise<T>((resolve, reject) => {
			Object.assign(properties, { resolve, reject })
		})
	return Object.assign(promise, properties)
}

export async function* toAsyncGenerator<T>(observable: Observable<T>) {
	let nextData = defer<T>() as Promise<T> | null
	const sub = observable.subscribe({
		next(data) {
			const n = nextData
			nextData = defer()
			//@ts-expect-error added stuff
			n?.resolve(data)
		},
		error(err) {
			//@ts-expect-error added stuff
			nextData?.reject(err)
		},
		complete() {
			const n = nextData
			nextData = null
			//@ts-expect-error added stuff
			n.resolve()
		},
	})
	try {
		for (;;) {
			const value = await nextData
			if (!nextData) break
			yield value
		}
	} finally {
		sub.unsubscribe()
	}
}
