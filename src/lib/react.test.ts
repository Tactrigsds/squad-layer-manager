// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDeadlineClock } from './react'

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(1_000_000)
})
afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe('useDeadlineClock', () => {
	it('re-renders once per deadline that passes, and compares like Date.now()', async () => {
		let renders = 0
		const deadlines = [1_000_000 + 30_000, 1_000_000 + 5_000, 1_000_000 - 1]
		const { result } = renderHook(() => {
			renders++
			return useDeadlineClock(deadlines)
		})
		const live = () => deadlines.filter((deadline) => deadline > result.current).length
		expect(live()).toBe(2)
		const rendersAtStart = renders

		await act(async () => vi.advanceTimersByTime(4_999))
		expect(renders).toBe(rendersAtStart)
		await act(async () => vi.advanceTimersByTime(1))
		expect(live()).toBe(1)
		await act(async () => vi.advanceTimersByTime(60_000))
		expect(live()).toBe(0)
		expect(renders).toBe(rendersAtStart + 2)
	})

	it('re-arms for new deadlines', async () => {
		const { result, rerender } = renderHook((deadlines: number[]) => useDeadlineClock(deadlines), { initialProps: [] as number[] })
		expect(result.current).toBe(-Infinity)
		rerender([1_000_000 + 1_000])
		await act(async () => vi.advanceTimersByTime(1_000))
		expect(result.current).toBe(1_000_000 + 1_000)
	})
})
