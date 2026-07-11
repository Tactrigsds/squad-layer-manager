import * as RBAC from '@/rbac.models'
import { describe, expect, it } from 'vitest'

function timeoutPerm(maxDurationMs: number | null): RBAC.Permission {
	return RBAC.perm('squad-server:timeout-players', { maxDurationMs })
}

describe('maxTimeoutDurationMs', () => {
	it('returns undefined with no timeout grant', () => {
		expect(RBAC.maxTimeoutDurationMs([])).toBeUndefined()
		expect(RBAC.maxTimeoutDurationMs([RBAC.perm('squad-server:warn-players')])).toBeUndefined()
	})

	it('returns the max across grants', () => {
		expect(RBAC.maxTimeoutDurationMs([timeoutPerm(60_000), timeoutPerm(3_600_000), timeoutPerm(600_000)])).toBe(3_600_000)
	})

	it('null (unlimited) short-circuits', () => {
		expect(RBAC.maxTimeoutDurationMs([timeoutPerm(60_000), timeoutPerm(null)])).toBeNull()
	})
})
