import * as fs from 'node:fs'

// Rewrites IPv4 addresses to the reserved documentation ranges (RFC 5737) so corpus files and
// test fixtures never carry real player/server addresses. The mapping is deterministic within a
// process (same input ip -> same fake ip), preserving cross-references between correlated files
// anonymized in one run. Loopback/unspecified addresses are kept: they're structurally meaningful.
//
// CLI usage: pnpm run script src/scripts/anonymize-ips.ts <file> [...files]

const DOC_RANGES = ['203.0.113.', '198.51.100.', '192.0.2.']
const KEEP = new Set(['127.0.0.1', '0.0.0.0'])

const mapping = new Map<string, string>()
let counter = 0

function fakeIp(): string {
	// 254 usable addresses per /24; chain through the three documentation ranges
	const range = DOC_RANGES[Math.floor(counter / 254) % DOC_RANGES.length]
	const octet = (counter % 254) + 1
	counter++
	return `${range}${octet}`
}

export function anonymizeIps(text: string): string {
	return text.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, (ip) => {
		if (KEEP.has(ip)) return ip
		if (DOC_RANGES.some((r) => ip.startsWith(r))) return ip
		// version-ish tokens (e.g. 10.5.1.627303 in GameVersion_s) aren't IPs; octet range check filters them
		if (ip.split('.').some((o) => Number(o) > 255)) return ip
		let mapped = mapping.get(ip)
		if (!mapped) {
			mapped = fakeIp()
			mapping.set(ip, mapped)
		}
		return mapped
	})
}

const isCliEntry = process.argv[1]?.endsWith('anonymize-ips.ts')
if (isCliEntry) {
	const files = process.argv.slice(2)
	if (files.length === 0) {
		console.error('usage: pnpm run script src/scripts/anonymize-ips.ts <file> [...files]')
		process.exit(1)
	}
	for (const f of files) {
		const before = fs.readFileSync(f, 'utf8')
		const after = anonymizeIps(before)
		if (before !== after) {
			fs.writeFileSync(f, after)
			console.log(`anonymized ${f}`)
		} else {
			console.log(`no change ${f}`)
		}
	}
	console.log(`distinct ips mapped: ${mapping.size}`)
}
