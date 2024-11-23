import { FastifyReply, FastifyRequest } from 'fastify'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as Context from '@/server/context'
import * as DB from '@/server/db'
import { baseLogger, setupLogger } from '@/server/logger'

import { setupEnv } from './env'

describe('pushOperation', () => {
	let mockContext: Context.Log & Partial<Context.Db>
	let debugSpy: any
	let errorSpy: any
	beforeAll(() => {
		setupEnv()
		setupLogger()
	})

	beforeEach(() => {
		debugSpy = vi.spyOn(baseLogger, 'debug')
		errorSpy = vi.spyOn(baseLogger, 'error')
		mockContext = {
			log: baseLogger,
		}
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it('should create operation with default options', async () => {
		await using opContext = Context.pushOperation(mockContext, 'test-op')

		expect(opContext.tasks).toEqual([])
		expect(typeof opContext[Symbol.dispose]).toBe('function')
		expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Operation test-op::'), expect.stringMatching(/started$/))
	})

	it('should create operation with custom level', () => {
		const traceSpy = vi.spyOn(baseLogger, 'trace')

		Context.pushOperation(mockContext, 'test-op', { level: 'trace' })

		expect(traceSpy).toHaveBeenCalledWith(expect.stringContaining('Operation test-op::'), expect.stringMatching(/started$/))
	})

	it('should handle successful disposal', async () => {
		await using opContext = Context.pushOperation(mockContext, 'test-op')
		opContext.tasks.push(Promise.resolve())

		opContext[Symbol.dispose]()
		await Promise.all(opContext.tasks)

		expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Operation test-op::'), expect.stringMatching(/completed$/))
	})

	it('should handle error on disposal', async () => {
		await using opContext = Context.pushOperation(mockContext, 'test-op')
		const error = new Error('Test error')

		opContext[Symbol.dispose](error)

		expect(errorSpy).toHaveBeenCalledWith(
			{ err: error, result: 'error' },
			expect.stringContaining('Operation test-op::'),
			expect.stringMatching(/failed$/)
		)
	})

	it.only('should append operations in logs', () => {
		const opContext = Context.pushOperation(mockContext, 'parent-op')
		const childContext = Context.pushOperation(opContext, 'child-op')

		expect(opContext.log.bindings().ops).toEqual([{ id: expect.any(String), type: 'parent-op' }])

		expect(childContext.log.bindings().ops).toEqual([
			{ id: expect.any(String), type: 'parent-op' },
			{ id: expect.any(String), type: 'child-op' },
		])
	})
})
