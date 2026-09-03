import * as childProcess from 'node:child_process'
import * as path from 'node:path'

export function extractMessages() {
	const command = path.join(process.cwd(), 'node_modules/.bin/tsx')
	childProcess.execFileSync(command, ['--tsconfig', 'tsconfig.node.json', 'src/scripts/extract-messages.ts', '--quiet'], {
		stdio: 'inherit',
	})
}
