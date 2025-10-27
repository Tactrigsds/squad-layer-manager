import { describe, expect, test } from 'vitest'
import { getRouteRegex as _getRouteRegex } from './app-routes'

const getRouteRegex = _getRouteRegex as (id: string) => RegExp
/**
 * Comprehensive test suite for the getRouteRegex function
 *
 * This test suite covers:
 * - Basic route matching (static routes, root path)
 * - Route parameters (single and multiple parameters)
 * - Query parameter handling
 * - Trailing slash handling
 * - Special regex character escaping
 * - Edge cases and boundary conditions
 * - Real-world application routes
 * - Performance and optimization concerns
 * - Unicode and encoded character support
 *
 * The function should:
 * 1. Convert route patterns like '/servers/:id' to RegExp objects
 * 2. Handle special regex characters by escaping them
 * 3. Support route parameters that capture values
 * 4. Allow optional trailing slashes
 * 5. Support query parameters
 * 6. Provide proper boundary matching (start ^ and end $)
 */

describe('getRouteRegex', () => {
	describe('basic route matching', () => {
		test('matches root path', () => {
			const regex = getRouteRegex('/')

			expect(regex.test('/')).toBe(true)
			expect(regex.test('')).toBe(true) // should handle empty string as root
			expect(regex.test('//')).toBe(false) // double slash should not match root
		})

		test('matches simple static routes', () => {
			const regex = getRouteRegex('/login')

			expect(regex.test('/login')).toBe(true)
			expect(regex.test('/login/')).toBe(true) // with trailing slash
			expect(regex.test('/login?foo=bar')).toBe(true) // with query params
		})

		test('matches nested static routes', () => {
			const regex = getRouteRegex('/filters/new')

			expect(regex.test('/filters/new')).toBe(true)
			expect(regex.test('/filters/new/')).toBe(true)
			expect(regex.test('/filters/new?redirect=true')).toBe(true)
		})
	})

	describe('route parameters', () => {
		test('matches single parameter routes', () => {
			const regex = getRouteRegex('/servers/:id')

			expect(regex.test('/servers/123')).toBe(true)
			expect(regex.test('/servers/abc')).toBe(true)
			expect(regex.test('/servers/server-name')).toBe(true)
			expect(regex.test('/servers/123/')).toBe(true)
			expect(regex.test('/servers/123?tab=settings')).toBe(true)
		})

		test('matches multiple parameter routes', () => {
			const regex = getRouteRegex('/servers/:serverId/layers/:layerId')

			expect(regex.test('/servers/123/layers/456')).toBe(true)
			expect(regex.test('/servers/abc/layers/def')).toBe(true)
			expect(regex.test('/servers/server-1/layers/layer-2')).toBe(true)
		})

		test('parameters do not match across slashes', () => {
			const regex = getRouteRegex('/servers/:id')

			expect(regex.test('/servers/123/extra')).toBe(false)
			expect(regex.test('/servers/')).toBe(false) // empty parameter
			expect(regex.test('/servers')).toBe(false) // missing parameter
		})

		test('parameters match special characters except slash', () => {
			const regex = getRouteRegex('/servers/:id')

			expect(regex.test('/servers/test-123')).toBe(true)
			expect(regex.test('/servers/test_456')).toBe(true)
			expect(regex.test('/servers/test.789')).toBe(true)
			expect(regex.test('/servers/test@example')).toBe(true)
			expect(regex.test('/servers/test%20with%20spaces')).toBe(true)
		})
	})

	describe('query parameters', () => {
		test('matches routes with query parameters', () => {
			const regex = getRouteRegex('/filters')

			expect(regex.test('/filters?search=tank')).toBe(true)
			expect(regex.test('/filters?search=tank&type=infantry')).toBe(true)
			expect(regex.test('/filters?')).toBe(true) // empty query string
		})

		test('matches parameterized routes with query parameters', () => {
			const regex = getRouteRegex('/servers/:id')

			expect(regex.test('/servers/123?tab=players')).toBe(true)
			expect(regex.test('/servers/abc?tab=settings&refresh=true')).toBe(true)
		})
	})

	describe('trailing slash handling', () => {
		test('routes with trailing slashes in definition', () => {
			const regex = getRouteRegex('/login/')

			expect(regex.test('/login')).toBe(true)
			expect(regex.test('/login/')).toBe(true)
		})

		test('optional trailing slash in matches', () => {
			const regex = getRouteRegex('/filters')

			expect(regex.test('/filters')).toBe(true)
			expect(regex.test('/filters/')).toBe(true)
		})
	})

	describe('special regex characters in routes', () => {
		test('handles routes with dots', () => {
			const regex = getRouteRegex('/layers.sqlite3')

			expect(regex.test('/layers.sqlite3')).toBe(true)
			expect(regex.test('/layersXsqlite3')).toBe(false) // should not match due to literal dot
		})

		test('handles routes with other special characters', () => {
			// Note: These are hypothetical routes to test regex escaping
			const regexPlus = getRouteRegex('/api+test')
			const regexStar = getRouteRegex('/api*test')
			const regexQuestion = getRouteRegex('/api?test')
			const regexBrackets = getRouteRegex('/api[test]')

			expect(regexPlus.test('/api+test')).toBe(true)
			expect(regexPlus.test('/apiXtest')).toBe(false)

			expect(regexStar.test('/api*test')).toBe(true)
			expect(regexStar.test('/apiXtest')).toBe(false)

			expect(regexQuestion.test('/api?test')).toBe(true)
			expect(regexQuestion.test('/apiXtest')).toBe(false)

			expect(regexBrackets.test('/api[test]')).toBe(true)
			expect(regexBrackets.test('/apiXtest')).toBe(false)
		})
	})

	describe('negative cases', () => {
		test('does not match wrong paths', () => {
			const regex = getRouteRegex('/login')

			expect(regex.test('/logout')).toBe(false)
			expect(regex.test('/login/callback')).toBe(false)
			expect(regex.test('/admin/login')).toBe(false)
			expect(regex.test('login')).toBe(false) // missing leading slash
		})

		test('does not match partial paths', () => {
			const regex = getRouteRegex('/filters/new')

			expect(regex.test('/filters')).toBe(false)
			expect(regex.test('/filters/')).toBe(false)
			expect(regex.test('/filters/new/edit')).toBe(false)
		})

		test('does not match empty parameter segments', () => {
			const regex = getRouteRegex('/servers/:id')

			expect(regex.test('/servers/')).toBe(false)
			expect(regex.test('/servers//')).toBe(false)
		})

		test('does not match when parameters contain slashes', () => {
			const regex = getRouteRegex('/servers/:id')

			expect(regex.test('/servers/123/456')).toBe(false)
		})
	})

	describe('edge cases', () => {
		test('handles routes with multiple consecutive slashes in definition', () => {
			// This tests the current behavior, though ideally this should be normalized
			const regex = getRouteRegex('/api//test')

			// Current implementation will create empty segments
			// The exact behavior may depend on implementation details
			expect(regex.test('/api//test')).toBe(true)
		})

		test('handles complex query strings', () => {
			const regex = getRouteRegex('/search')

			expect(regex.test('/search?q=squad&filters[]=tank&filters[]=infantry&sort=name')).toBe(true)
			expect(regex.test('/search?q=test%20query&redirect_uri=https://example.com/callback')).toBe(true)
		})

		test('handles routes that look like parameters but are not', () => {
			const regex = getRouteRegex('/user:profile')

			expect(regex.test('/user:profile')).toBe(true)
			expect(regex.test('/userXprofile')).toBe(false)
		})
	})

	describe('anchor and boundary matching', () => {
		test('matches only complete paths from start to end', () => {
			const regex = getRouteRegex('/api')

			expect(regex.test('/api')).toBe(true)
			expect(regex.test('/api/')).toBe(true)
			expect(regex.test('/api?test=1')).toBe(true)

			// Should not match partial matches
			expect(regex.test('/api/v1')).toBe(false)
			expect(regex.test('/test/api')).toBe(false)
			expect(regex.test('prefix/api')).toBe(false)
			expect(regex.test('/api/suffix')).toBe(false)
		})
	})

	describe('regex extraction and groups', () => {
		test('extracts parameter values correctly', () => {
			const regex = getRouteRegex('/servers/:id')
			const match = '/servers/test-123'.match(regex)

			expect(match).toBeTruthy()
			expect(match![1]).toBe('test-123') // First capture group should be the parameter value
		})

		test('extracts multiple parameter values correctly', () => {
			const regex = getRouteRegex('/servers/:serverId/layers/:layerId')
			const match = '/servers/server-1/layers/layer-2'.match(regex)

			expect(match).toBeTruthy()
			expect(match![1]).toBe('server-1')
			expect(match![2]).toBe('layer-2')
		})

		test('handles query parameters in capture groups', () => {
			const regex = getRouteRegex('/servers/:id')
			const match = '/servers/123?tab=settings'.match(regex)

			expect(match).toBeTruthy()
			expect(match![1]).toBe('123') // Parameter should be captured correctly
			// Query string behavior depends on implementation - it might be in a separate group
		})
	})

	describe('performance and regex optimization', () => {
		test('regex compilation works without throwing', () => {
			// Test that all common route patterns compile successfully
			const testRoutes = [
				'/',
				'/login',
				'/servers/:id',
				'/servers/:serverId/layers/:layerId',
				'/api/v1.0/users',
				'/files.json',
				'/path+with+plus',
				'/path*with*star',
				'/path?with?question',
				'/path[with]brackets',
			]

			testRoutes.forEach(route => {
				expect(() => getRouteRegex(route)).not.toThrow()
			})
		})

		test('regex patterns are deterministic', () => {
			const route = '/servers/:id/config'
			const regex1 = getRouteRegex(route)
			const regex2 = getRouteRegex(route)

			expect(regex1.toString()).toBe(regex2.toString())
		})
	})

	describe('real-world route examples', () => {
		test('handles actual routes from the application', () => {
			// Based on the routes defined in the main file
			const appRoutes = [
				'/',
				'/servers/:id',
				'/filters',
				'/filters/new',
				'/filters/:id',
				'/layers/:id',
				'/login',
				'/login/callback',
				'/logout',
				'/layers.sqlite3',
				'/trpc',
			]

			appRoutes.forEach(route => {
				const regex = getRouteRegex(route)
				expect(regex).toBeInstanceOf(RegExp)

				// Test that the route matches itself (without parameters)
				if (!route.includes(':')) {
					expect(regex.test(route)).toBe(true)
					// Special case: root path '/' doesn't match '//'
					if (route !== '/') {
						expect(regex.test(route + '/')).toBe(true)
					}
					expect(regex.test(route + '?param=value')).toBe(true)
				}
			})
		})

		test('parameterized routes work with realistic values', () => {
			const serverRegex = getRouteRegex('/servers/:id')
			expect(serverRegex.test('/servers/server-001')).toBe(true)
			expect(serverRegex.test('/servers/us-east-1')).toBe(true)
			expect(serverRegex.test('/servers/123456789')).toBe(true)

			const layerRegex = getRouteRegex('/layers/:id')
			expect(layerRegex.test('/layers/layer_name_123')).toBe(true)
			expect(layerRegex.test('/layers/Al-Basrah_Invasion_v1')).toBe(true)

			const filterRegex = getRouteRegex('/filters/:id')
			expect(filterRegex.test('/filters/my-filter')).toBe(true)
			expect(filterRegex.test('/filters/tank_only_filter')).toBe(true)
		})
	})

	describe('boundary conditions', () => {
		test('handles very long parameter values', () => {
			const regex = getRouteRegex('/servers/:id')
			const longId = 'a'.repeat(1000)

			expect(regex.test(`/servers/${longId}`)).toBe(true)
		})

		test('handles unicode characters in parameters', () => {
			const regex = getRouteRegex('/servers/:id')

			expect(regex.test('/servers/测试服务器')).toBe(true)
			expect(regex.test('/servers/сервер-123')).toBe(true)
			expect(regex.test('/servers/🚀-server')).toBe(true)
		})

		test('handles encoded characters in parameters', () => {
			const regex = getRouteRegex('/servers/:id')

			expect(regex.test('/servers/server%20name')).toBe(true)
			expect(regex.test('/servers/test%2Bserver')).toBe(true)
			expect(regex.test('/servers/server%40domain')).toBe(true)
		})
	})
})
