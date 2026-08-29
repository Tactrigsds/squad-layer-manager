/**
 * The roster shapes `getTeams` and `getServerInfo` return.
 *
 * Types only. Parsing raw rcon output, the id-query builders and the squad helpers stay with the host; a
 * plugin reads what it was handed and passes `player.ids` back to the functions that take one.
 */
export type { Player, PlayerId, ServerInfo, ServerInfoRes, Squad, SquadId, TeamId, Teams, TeamsRes } from '@/models/squad.models'
