import { describe, expect, it } from 'vitest'

// @vitest-environment happy-dom
import * as CS from '@/models/context-shared'

import * as FRM from './frame'
import * as Prom from './promise-utils'
import * as Rx from './rxjs'

function manager() {
	const errors: unknown[] = []
	const log = { error: (err: unknown) => errors.push(err) } as unknown as CS.Logger
	return { frameManager: new FRM.FrameManager({ ...CS.init(), log }), errors }
}

type Types = { name: 'test'; key: FRM.RawInstanceKey<{ id: string }>; input: { id: string }; state: { id: string } }

// builds a frame whose setup body is supplied by the test, so each case can register whatever it needs
function testFrame(frameManager: FRM.FrameManager, setup: (args: FRM.SetupArgs<Types['input'], Types['state']>) => void) {
	return frameManager.createFrame<Types>({
		name: 'test',
		createKey: (frameId, input) => ({ frameId, id: input.id }),
		setup: (args) => {
			args.set({ id: args.input.id })
			setup(args)
		},
	})
}

describe('FrameManager teardown', () => {
	it('runs a frame’s cleanup tasks FILO', async () => {
		const { frameManager } = manager()
		const order: string[] = []
		const frame = testFrame(frameManager, (args) => {
			args.cleanup.push(() => void order.push('first'))
			args.cleanup.push(() => void order.push('second'))
		})
		const key = frameManager.ensureSetup(frame, { id: 'a' })

		frameManager.teardown(key)
		await Prom.sleep(0)
		// the store -> update$ feed the manager registers before setup runs is torn down last, so it is not
		// asserted here beyond the relative order of the two the frame itself added
		expect(order).toEqual(['second', 'first'])
	})

	// this is why SetupArgs carries a signal as well as a cleanup list: a task pushed into the list aborts at its
	// own position in the FILO run, whereas the signal has to be observable before any task has run
	it('aborts the signal before running any cleanup task', async () => {
		const { frameManager } = manager()
		const abortedAtFirstTask: boolean[] = []
		const frame = testFrame(frameManager, (args) => {
			args.cleanup.push(() => void abortedAtFirstTask.push(args.signal.aborted))
		})
		const key = frameManager.ensureSetup(frame, { id: 'a' })

		frameManager.teardown(key)
		await Prom.sleep(0)
		expect(abortedAtFirstTask).toEqual([true])
	})

	// without the signal this await never settles, so the closure and the frame state it captured are retained
	// for the life of the page whenever the source it waits on never emits
	it('settles a pending signal-aware await on teardown', async () => {
		const { frameManager } = manager()
		let outcome: string | null = null
		const frame = testFrame(frameManager, (args) => {
			void (async () => {
				await Rx.Ext.firstValueFrom(Rx.NEVER, args.signal)
				outcome = 'resumed'
			})().catch((err) => {
				outcome = Prom.isAbortError(err) ? 'aborted' : 'other'
			})
		})
		const key = frameManager.ensureSetup(frame, { id: 'a' })
		await Prom.sleep(0)
		expect(outcome).toBeNull()

		frameManager.teardown(key)
		await Prom.sleep(0)
		expect(outcome).toBe('aborted')
	})

	it('reports a failing cleanup task and still runs the rest', async () => {
		const { frameManager, errors } = manager()
		const order: string[] = []
		const frame = testFrame(frameManager, (args) => {
			args.cleanup.push(() => void order.push('ran'))
			args.cleanup.push(() => {
				throw new Error('teardown boom')
			})
		})
		const key = frameManager.ensureSetup(frame, { id: 'a' })

		frameManager.teardown(key)
		await Prom.sleep(0)
		expect(order).toEqual(['ran'])
		expect(errors).toHaveLength(1)
	})
})
