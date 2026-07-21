#!/usr/bin/env node

import { execSync } from 'child_process'
import process from 'process'

// Read the ref information from stdin
let input = ''
process.stdin.setEncoding('utf-8')

process.stdin.on('data', (chunk) => {
	input += chunk
})

process.stdin.on('end', () => {
	// <local ref> <local sha> <remote ref> <remote sha>, one per ref being pushed
	const refs = input.trim().split('\n')
		.map((line) => line.split(' '))
		.filter((parts) => parts.length >= 4)

	const hasCommitsToPush = refs.some(([, localSha]) => !/^0+$/.test(localSha))

	if (!hasCommitsToPush) {
		process.exit(0)
	}

	console.log('🔍 Running checks...\n')

	try {
		console.log('📋 Checking format...')
		execSync('pnpm run format:check', { stdio: 'inherit' })
		console.log('✅ Format check passed\n')

		console.log('🔎 Type checking...')
		execSync('pnpm run check --force', { stdio: 'inherit' })
		console.log('✅ Type check passed\n')

		console.log('🔎 Running linter...')
		execSync('pnpm run lint', { stdio: 'inherit' })
		console.log('✅ Linting passed\n')

		console.log('🧪 Running unit tests...')
		execSync('pnpm run test', { stdio: 'inherit' })
		console.log('✅ Unit tests passed\n')

		// the integration suite runs the server from source through tsx, but the layer engine is wasm and is
		// loaded at runtime either way, so it has to be built before anything boots the app.
		console.log('🦀 Building layer engine...')
		execSync('pnpm run build:engine', { stdio: 'inherit' })
		console.log('✅ Layer engine built\n')

		console.log('🧪 Running integration tests...')
		execSync('pnpm run test:integration', { stdio: 'inherit' })
		console.log('✅ Integration tests passed\n')

		// test:e2e also builds the client bundle the tests are served (and rebuilds the engine, a no-op here)
		console.log('🧪 Running e2e tests...')
		execSync('pnpm run test:e2e', { stdio: 'inherit' })
		console.log('✅ E2E tests passed\n')

		console.log('✨ All checks passed! Ready to push.')
		process.exit(0)
	} catch {
		console.error('\n❌ Checks failed. Please fix the issues above.\n')
		process.exit(1)
	}
})

// If no input is provided
setTimeout(() => {
	if (!input) {
		process.exit(0)
	}
}, 100)
