import * as dateFns from 'date-fns'

/** The timezone-qualified timestamp the row tooltips show, formatted only when one opens. */
export function formatFullTime(time: number) {
	return dateFns.format(time, 'yyyy-MM-dd HH:mm:ss zzz')
}
