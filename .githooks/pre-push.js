#!/usr/bin/env node

import { execFileSync, execSync } from 'child_process'
import process from 'process'

// Read the ref information from stdin
let input = ''
process.stdin.setEncoding('utf-8')

process.stdin.on('data', (chunk) => {
	input += chunk
})

// Arguments for `changelog:check`. A pushed branch is checked against the remote's default branch, as CI checks the
// pull request. A push with no branch in it only validates the fragments.
function changelogCheckArgs(remote, refs) {
	const pushesBranch = refs.some(([, localSha, remoteRef]) => !/^0+$/.test(localSha) && remoteRef.startsWith('refs/heads/'))
	if (!pushesBranch || !remote) return []
	const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
	for (const resolve of [() => git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]), () => `${remote}/main`]) {
		try {
			const base = resolve()
			git(['rev-parse', '--verify', `${base}^{commit}`])
			return ['--base', base]
		} catch {}
	}
	return []
}

process.stdin.on('end', () => {
	// <local ref> <local sha> <remote ref> <remote sha>, one per ref being pushed
	const refs = input
		.trim()
		.split('\n')
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

		console.log('🔗 Checking doc links...')
		execSync('pnpm run docs:lint', { stdio: 'inherit' })
		console.log('✅ Doc links passed\n')

		// nothing else notices a message edited without re-extracting: every other check passes while the
		// catalogue names a string the source no longer has
		console.log('🌐 Checking message catalogue...')
		execSync('pnpm run i18n:lint', { stdio: 'inherit' })
		console.log('✅ Message catalogue up to date\n')

		// same failure mode as the catalogue: a core change can reshape the slm/* plugin surface with
		// every other gate green, and API_VERSION only moves if something forces the question
		console.log('🔌 Checking plugin API report...')
		execSync('pnpm run api:report:check', { stdio: 'inherit' })
		console.log('✅ Plugin API report up to date\n')

		// the hook cannot see the PR description, so a "Changelog: none" there does not count here
		console.log('📰 Checking changelog...')
		execFileSync('pnpm', ['run', 'changelog:check', ...changelogCheckArgs(process.argv[2], refs)], { stdio: 'inherit' })
		console.log('✅ Changelog passed\n')

		console.log('🧪 Running unit tests...')
		execSync('pnpm run test', { stdio: 'inherit' })
		console.log('✅ Unit tests passed\n')

		// the integration suite runs the server from source through tsx, but the layer engine is wasm and is
		// loaded at runtime either way, so it has to be built before anything boots the app.
		console.log('🦀 Building layer engine...')
		execSync('pnpm run build:engine', { stdio: 'inherit' })
		console.log('✅ Layer engine built\n')

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
