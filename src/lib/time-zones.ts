// IANA time zones by name: checking one, and reading or writing wall-clock times in one regardless of the zone the
// process runs in.

const zonedFormats = new Map<string, Intl.DateTimeFormat>()

function zonedFormat(timeZone: string) {
	let format = zonedFormats.get(timeZone)
	if (!format) {
		format = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
			timeZoneName: 'short',
		})
		zonedFormats.set(timeZone, format)
	}
	return format
}

type WallParts = { year: string; month: string; day: string; hour: string; minute: string; second: string; zone: string }

function wallParts(time: number, timeZone: string): WallParts {
	const out: WallParts = { year: '', month: '', day: '', hour: '', minute: '', second: '', zone: '' }
	for (const part of zonedFormat(timeZone).formatToParts(time)) {
		switch (part.type) {
			case 'year':
			case 'month':
			case 'day':
			case 'hour':
			case 'minute':
			case 'second':
				out[part.type] = part.value
				break
			case 'timeZoneName':
				out.zone = part.value
				break
		}
	}
	return out
}

/** The zone name as Intl spells it canonically, or undefined for a name that is not an IANA zone. */
export function canonical(timeZone: string): string | undefined {
	try {
		return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone
	} catch {
		return undefined
	}
}

export function isValid(timeZone: string): boolean {
	return canonical(timeZone) !== undefined
}

export function local(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone
}

let allZones: readonly string[] | undefined
/** Every IANA zone this runtime knows, UTC first. */
export function all(): readonly string[] {
	allZones ??= ['UTC', ...Intl.supportedValuesOf('timeZone').filter((zone) => zone !== 'UTC')]
	return allZones
}

/** `yyyy-MM-dd HH:mm:ss` in `timeZone`. */
export function formatDateTime(time: number, timeZone: string): string {
	const p = wallParts(time, timeZone)
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

/** The zone's short name at `time`, such as `EDT` or `GMT+2`. */
export function shortName(timeZone: string, time = Date.now()): string {
	return wallParts(time, timeZone).zone
}

/** formatDateTime followed by the zone's short name and, where that differs and `withIana` is set, its IANA name. */
export function formatFull(time: number, timeZone: string, withIana = true): string {
	const p = wallParts(time, timeZone)
	const named = !withIana || p.zone === timeZone ? p.zone : `${p.zone} (${timeZone})`
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${named}`
}

function offsetAt(time: number, timeZone: string): number {
	const p = wallParts(time, timeZone)
	const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
	return wall - (time - (((time % 1000) + 1000) % 1000))
}

/** `time` as a datetime-local input's value (`yyyy-MM-ddTHH:mm`) in `timeZone`. */
export function toWallInput(time: number, timeZone: string): string {
	const p = wallParts(time, timeZone)
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/**
 * A datetime-local input's value read as a wall-clock time in `timeZone`. A time skipped by a DST change resolves past
 * the gap. Undefined for a value that is not `yyyy-MM-ddTHH:mm[:ss]`.
 */
export function fromWallInput(value: string, timeZone: string): number | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
	if (!m) return undefined
	const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0)
	// The offset at the guess can differ from the offset at the answer across a DST change, so it is taken twice. A
	// skipped wall time has no answer whose own offset agrees with it, and of the two guesses the first is past the gap.
	const guess = wall - offsetAt(wall, timeZone)
	const time = wall - offsetAt(guess, timeZone)
	return wall - offsetAt(time, timeZone) === time ? time : guess
}
