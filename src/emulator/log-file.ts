import * as fs from 'node:fs'

// Writes the emulated server's log lines to a file, the way the real game does. The app reads it
// with a `local-file` log source, so the whole log path (tail, chunking, parse) is the production
// one -- no test-only transport in between.

export class LogFileSink {
	readonly path: string
	#fd: number

	constructor(path: string, opts?: { preamble?: string[] }) {
		this.path = path
		this.#fd = fs.openSync(path, 'a')
		// the real log opens with headerless preamble lines, which the parser has to skip before it
		// sees its first timestamped entry
		const preamble = opts?.preamble ?? [`Log file open, ${new Date().toISOString()}`]
		if (preamble.length > 0) this.writeLine(preamble.join('\n'))
	}

	writeLine(line: string) {
		fs.writeSync(this.#fd, line.endsWith('\n') ? line : line + '\n')
	}

	// truncates the file the way a log rotation would, so the tail's recovery path can be exercised
	rotate() {
		fs.closeSync(this.#fd)
		fs.truncateSync(this.path, 0)
		this.#fd = fs.openSync(this.path, 'a')
	}

	close() {
		fs.closeSync(this.#fd)
	}
}
