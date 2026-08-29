/**
 * The server event union carried by slm/systems/squad-server's `events$`, and its members.
 *
 * Types only: an event is discriminated on a string literal `type`, so nothing here needs a runtime value.
 * The persisted schemas, the pending-events machinery and the per-type META descriptors stay with the host.
 */
export type {
	AdminBroadcast,
	ChatMessage,
	Event,
	IngameVoteStarted,
	MapSet,
	NewGame,
	PlayerBanned,
	PlayerChangedTeam,
	PlayerConnected,
	PlayerDetailsChanged,
	PlayerDied,
	PlayerDisconnected,
	PlayerJoinedSquad,
	PlayerKicked,
	PlayerLeftSquad,
	PlayerPromotedToLeader,
	PlayerReconciled,
	PlayerWarned,
	PlayerWounded,
	PossessedAdminCamera,
	RconConnected,
	RconDisconnected,
	Reset,
	RoundEnded,
	SquadCreated,
	SquadDetailsChanged,
	SquadDisbanded,
	SquadRenamed,
	TeamsPolledUpdate,
	UnpossessedAdminCamera,
} from '@/models/server-events.models'
