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
