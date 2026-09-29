import { describe, expect, test } from 'vitest'

import * as CL from '@/models/changelog.models'
import { parseFragment } from '@/systems/changelog-files.server'

describe('parseFragment', () => {
	test('splits the title from the body at the first blank line', () => {
		const res = parseFragment(
			'short-links',
			'---\naudience: users\nkind: changed\n---\n\nHistory links are shorter.\nOld links still open.\n\nA body.\n\nIn two paragraphs.\n',
		)
		expect(res).toEqual({
			code: 'ok',
			entry: {
				id: 'short-links',
				audience: 'users',
				kind: 'changed',
				minor: false,
				title: 'History links are shorter. Old links still open.',
				body: 'A body.\n\nIn two paragraphs.',
			},
		})
	})

	test('rejects what the page could not show honestly', () => {
		const fm = (yaml: string) => `---\n${yaml}\n---\nTitle`
		expect(parseFragment('Bad_Id', fm('audience: users\nkind: added')).code).toBe('err:invalid-fragment')
		expect(parseFragment('x', 'no frontmatter').code).toBe('err:invalid-fragment')
		expect(parseFragment('x', fm('audience: users\nkind: breaking')).code).toBe('err:invalid-fragment')
		expect(parseFragment('x', fm('audience: users\nkind: added\ntutorial: nope')).code).toBe('err:invalid-fragment')
		expect(parseFragment('x', fm('audience: users\nkind: added\ntypo: 1')).code).toBe('err:invalid-fragment')
		expect(parseFragment('x', '---\naudience: users\nkind: added\n---\n\n').code).toBe('err:invalid-fragment')
	})
})

describe('nextVersion', () => {
	test('counts releases within the month, and restarts in a new one', () => {
		const sep = new Date('2026-09-29T12:00:00Z')
		expect(CL.nextVersion([], sep)).toBe('2026.9.1')
		expect(CL.nextVersion(['2026.9.1', '2026.9.3', '2026.8.7'], sep)).toBe('2026.9.4')
		expect(CL.nextVersion(['2026.9.4'], new Date('2026-10-01T00:00:00Z'))).toBe('2026.10.1')
		// 2026.1.x must not be read as the start of 2026.10.x or 2026.11.x
		expect(CL.nextVersion(['2026.1.5'], new Date('2026-11-02T00:00:00Z'))).toBe('2026.11.1')
	})

	test('sorts numerically, not as text', () => {
		expect(['2026.9.2', '2026.10.1', '2026.9.10'].toSorted(CL.compareVersions)).toEqual(['2026.9.2', '2026.9.10', '2026.10.1'])
	})
})
