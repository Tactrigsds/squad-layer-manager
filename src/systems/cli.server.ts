import { Command } from 'commander'
import fs from 'node:fs/promises'

export let options: { envFile?: string; secretsFile?: string } | undefined
export async function ensureCliParsed() {
	if (options) return

	const program = new Command()
	program
		.option('--env-file <path>', 'Path to the environment file (optional)')
		.option('--secrets-file <path>', 'Path to the secrets file, defaulting to ./.env.secrets (optional)')
		.helpOption('--help', 'Display help information')
		.parse(process.argv)

	options = program.opts() as { envFile?: string; secretsFile?: string }

	// -------- validation --------
	for (const [label, filePath] of [['Environment', options.envFile], ['Secrets', options.secretsFile]] as const) {
		if (!filePath) continue
		try {
			await fs.access(filePath)
		} catch {
			console.error(`${label} file not found at ${filePath}`)
			process.exit(1)
		}
	}
}
