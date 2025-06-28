import { Command } from 'commander'
import fs from 'node:fs/promises'

export let options!: { envFile?: string; config: string; extraColumnsConfig: string }
export async function ensureCliParsed() {
	if (options) return

	const defaultExtraColumnsConfig = 'extra-columns.json'
	const program = new Command()
	program
		.option('--env-file <path>', 'Path to the environment file (optional)')
		.option('--config <path>', 'Path to the configuration file', 'slm-config.json')
		.option('--extra-columns-config <path>', 'Path to the extra columns configuration file', defaultExtraColumnsConfig)
		.helpOption('--help', 'Display help information')
		.parse(process.argv)

	options = program.opts() as { envFile?: string; config: string; extraColumnsConfig: string }

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

	// Use provided config file path if available
	try {
		await fs.access(options.config)
	} catch {
		console.error(`Configuration file not found at ${options.config}`)
		process.exit(1)
	}

	if (options.extraColumnsConfig !== defaultExtraColumnsConfig) {
		try {
			await fs.access(options.extraColumnsConfig)
		} catch {
			console.error(`Extra columns configuration file not found at ${options.extraColumnsConfig}`)
			process.exit(1)
		}
	}
}
