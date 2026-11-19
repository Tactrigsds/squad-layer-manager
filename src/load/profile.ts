// What a full (80+ players) production server logs per minute, as means over 992 such minutes of two SquadGame.log
// files from 2026-09-28 and 2026-09-29, measured with src/scripts/measure-log-rates.ts. The p95 minute is about
// twice the mean for combat and three to four times for vehicle and deployable damage.
export const RATES_PER_MINUTE = {
	PLAYER_WOUNDED: 10.79,
	PLAYER_DIED: 8.12,
	PLAYER_REVIVED: 2.77,
	PLAYER_RESTARTED: 10.7,
	VEHICLE_ENTERED: 6.87,
	VEHICLE_EXITED: 7.08,
	VEHICLE_HEALTH_CHANGED: 28.13,
	DEPLOYABLE_HEALTH_CHANGED: 4.69,
	PLAYER_DISCONNECTED: 1.55,
}

// 767 lines a minute in all, of which about 118 belong to the events above
export const UNPARSED_LINES_PER_MINUTE = 650

// Chat arrives over RCON rather than in the log, so the logs above cannot measure it. An assumption until
// production numbers replace it.
export const DEFAULT_CHAT_PER_MINUTE = 6
