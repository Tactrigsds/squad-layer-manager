import { E_CANCELED, type MutexInterface } from 'async-mutex'
import { AsyncLocalStorage } from 'node:async_hooks'

type MutexContext = { locked: Set<MutexInterface>; releaseTasks: Set<() => void | Promise<void>> }

const mtxStorage = new AsyncLocalStorage<MutexContext>()

/**
 * Add a task to be executed when  all mutexes are released.
 * @param tasks are deduped via referential equality
 */
export function addReleaseTask(task: () => void | Promise<void>) {
	mtxStorage.getStore()?.releaseTasks.add(task)
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
export const withAcquired = <Cb extends (...args: any[]) => Promise<any>>(
	getMutexes: ((...args: Parameters<Cb>) => MutexInterface[] | MutexInterface) | MutexInterface | MutexInterface[],
	cb: Cb,
): Cb =>
	(
		(...args: Parameters<Cb>) => {
			if (typeof getMutexes === 'function') {
				getMutexes = getMutexes(...args)
			}
			const mutexes = Array.isArray(getMutexes) ? getMutexes : [getMutexes]
			return mtxStorage.run(
				{ locked: new Set(mtxStorage.getStore()?.locked), releaseTasks: new Set() },
				async () => {
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
								logError(err, 'error while waiting for mutexes to unlock')
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
	) as unknown as Cb
