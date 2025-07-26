/**
 * Priority Queue Usage Examples
 *
 * This file demonstrates how to use the priority queue system in the LayerQueryWorkerPool.
 * Run this in a browser environment where the layer queries client is available.
 */

import * as LQY from '../src/models/layer-queries.models'
import * as LayerQueries from '../src/systems.client/layer-queries.client'

/**
 * Example 1: Basic Priority Usage
 *
 * This example shows how to queue queries with different priorities.
 * Lower priority numbers are processed first.
 */
export async function basicPriorityExample() {
	console.log('=== Basic Priority Example ===')

	// Sample query input
	const queryInput: LQY.LayersQueryInput = {
		constraints: [],
		pageSize: 10,
		pageIndex: 0,
		sort: LQY.DEFAULT_SORT,
	}

	// Queue multiple queries with different priorities
	const promises = [
		LayerQueries.queueLowPriorityQuery('queryLayers', queryInput), // Priority 10
		LayerQueries.queueHighPriorityQuery('queryLayers', queryInput), // Priority 0
		LayerQueries.queueMediumPriorityQuery('queryLayers', queryInput), // Priority 5
		LayerQueries.queueLowPriorityQuery('queryLayers', queryInput), // Priority 10
	]

	console.log('Queued 4 queries: high(0), medium(5), low(10), low(10)')
	console.log('Expected processing order: high -> medium -> low -> low')

	const results = await Promise.all(promises)
	console.log('All queries completed:', results.length)
}

/**
 * Example 2: React Hook with Priority
 *
 * This shows how to use the priority system in React components.
 */
export function ReactComponentExample() {
	const queryInput: LQY.LayersQueryInput = {
		constraints: [],
		pageSize: 20,
		pageIndex: 0,
		sort: LQY.DEFAULT_SORT,
	}

	// Critical user-facing query - highest priority
	const criticalLayers = LayerQueries.useLayersQuery(queryInput, {
		priority: 0,
		enabled: true,
	})

	// Background prefetch - lower priority
	const backgroundLayers = LayerQueries.useLayersQuery(
		{ ...queryInput, pageIndex: 1 },
		{ priority: 7 },
	)

	// Analytics query - lowest priority
	const analyticsData = LayerQueries.useLayerComponents(
		{ column: 'Gamemode', constraints: [] },
		{ priority: 10 },
	)

	return {
		criticalLayers,
		backgroundLayers,
		analyticsData,
	}
}

/**
 * Example 3: Monitoring Worker Pool Performance
 *
 * This example shows how to monitor the worker pool and queue performance.
 */
export async function monitoringExample() {
	console.log('=== Worker Pool Monitoring Example ===')

	// Get initial stats
	const initialStats = LayerQueries.getWorkerPoolStats()
	console.log('Initial worker pool stats:', initialStats)

	// Queue several queries to see the queue in action
	const queryInput: LQY.LayersQueryInput = {
		constraints: [],
		pageSize: 5,
		pageIndex: 0,
		sort: LQY.DEFAULT_SORT,
	}

	// Queue more queries than we have workers to see queuing behavior
	const promises = Array.from({ length: 10 }, (_, i) =>
		LayerQueries.queueMediumPriorityQuery('queryLayers', {
			...queryInput,
			pageIndex: i,
		}))

	// Check stats while queries are processing
	setTimeout(() => {
		const midStats = LayerQueries.getWorkerPoolStats()
		console.log('Stats during processing:', midStats)
	}, 100)

	await Promise.all(promises)

	// Final stats
	const finalStats = LayerQueries.getWorkerPoolStats()
	console.log('Final worker pool stats:', finalStats)
}

/**
 * Example 4: Priority-Based Prefetching Strategy
 *
 * This demonstrates a smart prefetching strategy using priorities.
 */
export async function smartPrefetchingExample() {
	console.log('=== Smart Prefetching Example ===')

	const baseQuery: LQY.LayersQueryInput = {
		constraints: [],
		pageSize: 10,
		pageIndex: 0,
		sort: LQY.DEFAULT_SORT,
	}

	// Immediate user request - highest priority
	console.log('1. Processing immediate user request (priority 0)')
	const currentPage = await LayerQueries.queueHighPriorityQuery('queryLayers', baseQuery)

	// Prefetch next page - medium priority
	console.log('2. Prefetching next page (priority 5)')
	LayerQueries.prefetchLayersQuery({ ...baseQuery, pageIndex: 1 }, 5)

	// Prefetch previous page - lower priority
	console.log('3. Prefetching previous page (priority 6)')
	LayerQueries.prefetchLayersQuery({ ...baseQuery, pageIndex: -1 }, 6)

	// Background analytics - lowest priority
	console.log('4. Background analytics (priority 10)')
	LayerQueries.queueLowPriorityQuery('queryLayerComponent', {
		column: 'Map',
		constraints: [],
	})

	console.log('Current page loaded, prefetching in background')
	return currentPage
}

/**
 * Example 5: Error Handling with Priorities
 *
 * Shows how errors are handled in the priority queue system.
 */
export async function errorHandlingExample() {
	console.log('=== Error Handling Example ===')

	try {
		// This might fail if the input is invalid
		const result = await LayerQueries.queueHighPriorityQuery('layerExists', {
			id: 'invalid-layer-id',
		})
		console.log('Query succeeded:', result)
	} catch (error) {
		console.log('Query failed with error:', error.message)
		// Error is automatically displayed via globalToast$
	}

	// Queue continues to work after errors
	const validQuery = await LayerQueries.queueHighPriorityQuery('queryLayers', {
		constraints: [],
		pageSize: 1,
		pageIndex: 0,
		sort: LQY.DEFAULT_SORT,
	})

	console.log('Subsequent query succeeded:', validQuery)
}

/**
 * Example 6: Real-world Usage Pattern
 *
 * A realistic example of how you might use priorities in a real application.
 */
export class LayerExplorer {
	private currentFilters: any[] = []

	async searchLayers(searchTerm: string) {
		console.log('=== Layer Explorer Search ===')

		// Cancel any low-priority background queries by issuing high-priority ones
		const searchQuery: LQY.SearchIdsInput = {
			queryString: searchTerm,
			constraints: this.currentFilters,
		}

		// High priority: Get search results immediately
		const searchResults = await LayerQueries.queueHighPriorityQuery('searchIds', searchQuery)

		// Medium priority: Get full layer data for search results
		if (searchResults && searchResults.length > 0) {
			const layersQuery: LQY.LayersQueryInput = {
				constraints: [
					{
						type: 'filter-anon',
						id: 'search-results',
						filter: { type: 'comp', neg: false, comp: { code: 'in', column: 'id', values: searchResults } },
						applyAs: 'where-condition',
					},
				],
				pageSize: 20,
				pageIndex: 0,
				sort: LQY.DEFAULT_SORT,
			}

			const layerDetails = await LayerQueries.queueMediumPriorityQuery('queryLayers', layersQuery)

			// Low priority: Prefetch next page of results
			LayerQueries.prefetchLayersQuery({ ...layersQuery, pageIndex: 1 }, 8)

			return layerDetails
		}

		return []
	}

	async applyFilters(filters: any[]) {
		this.currentFilters = filters

		// High priority: Apply filters immediately
		const filteredQuery: LQY.LayersQueryInput = {
			constraints: filters,
			pageSize: 20,
			pageIndex: 0,
			sort: LQY.DEFAULT_SORT,
		}

		const results = await LayerQueries.queueHighPriorityQuery('queryLayers', filteredQuery)

		// Medium priority: Update available filter options
		LayerQueries.queueMediumPriorityQuery('queryLayerComponent', {
			column: 'Gamemode',
			constraints: filters,
		})

		// Low priority: Prefetch additional pages
		for (let page = 1; page <= 3; page++) {
			LayerQueries.prefetchLayersQuery(
				{ ...filteredQuery, pageIndex: page },
				8 + page, // Increasing priority for later pages
			)
		}

		return results
	}
}

/**
 * Run all examples
 */
export async function runAllExamples() {
	console.log('Running all priority queue examples...')

	try {
		await basicPriorityExample()
		await monitoringExample()
		await smartPrefetchingExample()
		await errorHandlingExample()

		const explorer = new LayerExplorer()
		await explorer.searchLayers('dust')
		await explorer.applyFilters([])

		console.log('All examples completed successfully!')
	} catch (error) {
		console.error('Example failed:', error)
	}
}
