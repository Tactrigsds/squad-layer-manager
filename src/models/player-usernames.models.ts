// A stretch of time a player went by one name. `to` is when the next name replaced it, null for the current name.
export type UsernamePeriod = { username: string; from: number; to: number | null }

export const MAX_PERIODS = 50

/**
 * Turns a player's playerUsernames rows, newest first, into periods, newest first. Neighbouring rows with the same
 * name, which an event recorded out of order leaves behind, are one period.
 */
export function toPeriods(rows: { username: string; time: Date }[]): UsernamePeriod[] {
	const periods: UsernamePeriod[] = []
	for (const row of rows) {
		const newer = periods.at(-1)
		if (newer?.username === row.username) {
			newer.from = row.time.getTime()
			continue
		}
		periods.push({ username: row.username, from: row.time.getTime(), to: newer ? newer.from : null })
	}
	return periods
}
