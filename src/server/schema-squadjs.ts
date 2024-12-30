import { datetime, index, int, mysqlSchema, primaryKey, tinyint, varchar } from 'drizzle-orm/mysql-core'

const schema = mysqlSchema('dblog')
export const dbLogMatches = schema.table(
	'DBLog_Matches',
	{
		id: int('id').autoincrement().notNull(),
		dlc: varchar('dlc', { length: 255 }),
		mapClassname: varchar('mapClassname', { length: 255 }),
		layerClassname: varchar('layerClassname', { length: 255 }),
		map: varchar('map', { length: 255 }),
		layer: varchar('layer', { length: 255 }),
		startTime: datetime('startTime', { mode: 'date' }),
		endTime: datetime('endTime', { mode: 'date' }),
		tickets: int('tickets'),
		winner: varchar('winner', { length: 255 }),
		team1: varchar('team1', { length: 255 }),
		team2: varchar('team2', { length: 255 }),
		team1Short: varchar('team1Short', { length: 255 }),
		team2Short: varchar('team2Short', { length: 255 }),
		subFactionTeam1: varchar('subFactionTeam1', { length: 255 }),
		subFactionTeam2: varchar('subFactionTeam2', { length: 255 }),
		subFactionShortTeam1: varchar('subFactionShortTeam1', { length: 255 }),
		subFactionShortTeam2: varchar('subFactionShortTeam2', { length: 255 }),
		winnerTeam: varchar('winnerTeam', { length: 255 }),
		winnerTeamId: int('winnerTeamID'),
		isDraw: tinyint('isDraw'),
		server: int('server').notNull(),
	},
	(table) => {
		return {
			server: index('server').on(table.server),
			dbLogMatchesId: primaryKey({
				columns: [table.id],
				name: 'DBLog_Matches_id',
			}),
		}
	}
)
