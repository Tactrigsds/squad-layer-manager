import { Command } from 'commander'
import fs from 'node:fs/promises'

export let options: { envFile?: string } | undefined
export async function ensureCliParsed() {
	if (options) return

	const program = new Command()
	program
		.option('--env-file <path>', 'Path to the environment file (optional)')
		.helpOption('--help', 'Display help information')
		.parse(process.argv)

	options = program.opts() as { envFile?: string }

	// -------- validation --------
	const envFilePath = options.envFile
	if (envFilePath) {
		try {
			await fs.access(envFilePath)
		} catch {
			console.error(`Environment file not found at ${envFilePath}`)
			process.exit(1)
		}
	}
}
