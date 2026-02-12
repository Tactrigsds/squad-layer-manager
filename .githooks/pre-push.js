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
	// Parse push information to detect if pushing to main
	const lines = input.trim().split('\n')

	let isPushingToMain = false

	for (const line of lines) {
		const parts = line.split(' ')
		if (parts.length >= 4) {
			const refName = parts[2]
			if (refName === 'refs/heads/main') {
				isPushingToMain = true
				break
			}
		}
	}

	if (!isPushingToMain) {
		process.exit(0)
	}

	console.log('🔍 Pushing to main - running checks...\n')

	try {
		console.log('📋 Checking format...')
		execSync('pnpm run format:check', { stdio: 'inherit' })
		console.log('✅ Format check passed\n')

		console.log('🔎 Type checking...')
		execSync('pnpm run check', { stdio: 'inherit' })
		console.log('✅ Type check passed\n')

		console.log('🔎 Running linter...')
		execSync('pnpm run lint', { stdio: 'inherit' })
		console.log('✅ Linting passed\n')

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
