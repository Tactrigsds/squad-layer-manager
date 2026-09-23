import * as dateFns from 'date-fns'

/** The timezone-qualified timestamp the row tooltips show, formatted only when one opens. */
export function formatFullTime(time: number) {
	return dateFns.format(time, 'yyyy-MM-dd HH:mm:ss zzz')
}

// the same instant, minus the zone: a row that carries its date inline repeats the zone on every line, and
// the tooltip already has it for whoever needs to be sure
export function formatDateTime(time: number) {
	return dateFns.format(time, 'yyyy-MM-dd HH:mm:ss')
}

export function localTimeZone() {
	return Intl.DateTimeFormat().resolvedOptions().timeZone
}

const zonedFormats = new Map<string, Intl.DateTimeFormat>()

/** formatDateTime's shape in a named time zone rather than the process's own. */
export function formatDateTimeIn(time: number, timeZone: string) {
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
		})
		zonedFormats.set(timeZone, format)
	}
	const parts: Record<string, string> = {}
	for (const part of format.formatToParts(time)) parts[part.type] = part.value
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}
