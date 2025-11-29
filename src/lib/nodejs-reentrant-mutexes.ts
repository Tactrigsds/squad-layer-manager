import { E_CANCELED, type Mutex } from 'async-mutex'
import { AsyncLocalStorage } from 'node:async_hooks'

type MutexContext = { locked: Set<Mutex>; releaseTasks: Array<() => void | Promise<void>> }

const mtxStorage = new AsyncLocalStorage<MutexContext>()

export function pushReleaseTask(task: () => void | Promise<void>) {
	mtxStorage.getStore()?.releaseTasks.push(task)
}

/**
 * Runs a callback while all supplied mutexes are acquired.
 *
 * Mutexes that were previously acquired by the callstack are included in the lock context.
 * Any tasks registered with pushReleaseTask during execution will be run once the supplied mutexes are fully released.
 *
 * @param getMutexes - Function that derives mutexes from callback arguments
 * @param cb - The callback to execute while holding the mutexes
 * @returns A function that acquires mutexes and executes the callback
 */
export const withAcquired = <Cb extends (...args: any[]) => any>(
	getMutexes: ((...args: Parameters<Cb>) => Mutex[] | Mutex) | Mutex | Mutex[],
	cb: Cb,
) => (
	(...args: Parameters<Cb>) => {
		if (typeof getMutexes === 'function') {
			getMutexes = getMutexes(...args)
		}
		const mutexes = Array.isArray(getMutexes) ? getMutexes : [getMutexes]
		return _withReentrantMutexes(mutexes, () => cb(...args))
	}
)

function _withReentrantMutexes<Cb extends (...args: any[]) => any>(mutexes: Mutex[], cb: Cb) {
	return mtxStorage.run(
		{ locked: new Set(mtxStorage.getStore()?.locked), releaseTasks: [] },
		async (...args: Parameters<Cb>) => {
			const { locked, releaseTasks } = mtxStorage.getStore()!
			// being in 'locked', means that we've already acquired this mutex
			const mutexesToAcquire = mutexes.filter(mutex => !locked.has(mutex))

			// Acquire all locks that we don't have yet
			const newlyAcquired = await Promise.all(
				mutexesToAcquire.map(mutex => mutex.acquire().catch(e => e === E_CANCELED ? () => undefined : Promise.reject(e))),
			)

			for (const mutex of mutexesToAcquire) {
				locked.add(mutex)
			}

			let logError: (...args: any[]) => void = console.error
			if (typeof (args[0] as any)?.log === 'function') {
				logError = (...args: any[]) => args[0].log.error?.(...args)
			}

			try {
				return await cb(...args)
			} finally {
				void (async () => {
					// wait for all mutexes to be released before processing release tasks
					try {
						await Promise.all(mutexes.map(mutex => mutex.waitForUnlock()))
					} catch (err) {
						logError(err, 'error during mutex acquisition')
						throw err
					}
					for (const task of releaseTasks) {
						try {
							void task()
						} catch (err) {
							logError(err, 'error during release task execution')
						}
					}
				})()

				for (const release of newlyAcquired) {
					release()
				}
			}
		},
	)
}
