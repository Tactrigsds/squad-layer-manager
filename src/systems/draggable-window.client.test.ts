import { describe, expect, it } from 'vitest'

// @vitest-environment happy-dom
import { frameManager } from '@/frames/frame-manager'
import type * as FRM from '@/lib/frame'
import * as Prom from '@/lib/promise-utils'

import { DraggableWindowStore, frameDependency } from './draggable-window.client'

type Types = { name: 'test'; key: FRM.RawInstanceKey<{ id: string }>; input: { id: string }; state: { id: string } }
type Props = { id: string; key: FRM.InstanceKey<Types> }

const WINDOW_TYPE = 'test-window'
const isOpen = (id: string) => DraggableWindowStore.getState().windows.some((w) => w.id === id)

// one frame whose per-instance cleanup records whether the window bound to it was still open when it ran
const frame = frameManager.createFrame<Types>({
	name: 'test',
	createKey: (frameId, input) => ({ frameId, id: input.id }),
	setup: (args) => {
		args.set({ id: args.input.id })
		args.cleanup.push(() => void cleanupSawWindowOpen.push(isOpen(args.input.id)))
	},
})
const cleanupSawWindowOpen: boolean[] = []

DraggableWindowStore.getState().registerDefinition<Props, unknown>({
	type: WINDOW_TYPE,
	component: () => null,
	getId: (props) => props.id,
	dependsOn: (props) => [frameDependency(props.key)],
})

describe('window dependencies', () => {
	it('closes the window before the frame it depends on is torn down', async () => {
		const key = frameManager.ensureSetup(frame, { id: 'a' })
		DraggableWindowStore.getState().openWindow(WINDOW_TYPE, { id: 'a', key })
		expect(isOpen('a')).toBe(true)

		frameManager.teardown(key)
		expect(isOpen('a')).toBe(false)
		await Prom.sleep(0)
		expect(cleanupSawWindowOpen).toEqual([false])
	})

	it('lets go of the frame when the window closes first', () => {
		const key = frameManager.ensureSetup(frame, { id: 'b' })
		DraggableWindowStore.getState().openWindow(WINDOW_TYPE, { id: 'b', key })
		DraggableWindowStore.getState().closeWindow('b')

		const instance = frameManager.getInstance(key)!
		expect(instance.releaseListeners.size).toBe(0)
		frameManager.teardown(key)
	})

	it('closes the window when its key is dropped while another key keeps the frame alive', () => {
		const borrowed = frameManager.ensureSetup(frame, { id: 'd' })
		const other = frameManager.ensureSetup(frame, { id: 'd' })
		DraggableWindowStore.getState().openWindow(WINDOW_TYPE, { id: 'd', key: borrowed })

		frameManager.dropKey(borrowed)
		expect(isOpen('d')).toBe(false)
		expect(frameManager.getState(other)).toEqual({ id: 'd' })
		frameManager.dropKey(other)
	})

	it('does not open a window whose dependency is already gone', () => {
		const key = frameManager.ensureSetup(frame, { id: 'c' })
		frameManager.teardown(key)

		DraggableWindowStore.getState().openWindow(WINDOW_TYPE, { id: 'c', key })
		expect(isOpen('c')).toBe(false)
	})
})
