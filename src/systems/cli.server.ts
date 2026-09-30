import { Command } from 'commander'
import fs from 'node:fs/promises'

type Options = { envFile?: string; secretsFile?: string; secretsDir?: string }
export let options: Options | undefined
export async function ensureCliParsed() {
	if (options) return

	const program = new Command()
	program
		.option('--env-file <path>', 'Path to the environment file (optional)')
		.option('--secrets-file <path>', 'Path to the secrets file, defaulting to ./.env.secrets (optional)')
		.option('--secrets-dir <path>', 'Path to a directory holding one file per secret, named after the variable (optional)')
		.helpOption('--help', 'Display help information')
		.parse(process.argv)

	options = program.opts() as Options

	// -------- validation --------
	for (const [label, filePath] of [
		['Environment', options.envFile],
		['Secrets', options.secretsFile],
		['Secrets directory', options.secretsDir],
	] as const) {
		if (!filePath) continue
		try {
			await fs.access(filePath)
		} catch {
			console.error(`${label} file not found at ${filePath}`)
			process.exit(1)
		}
	}
}
