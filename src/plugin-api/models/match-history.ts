// Match shapes and the team1/team2 <-> A/B normalization. Row conversion and entry creation belong
// to the host, as does MH.Ctx: a plugin receives its ctx already built.
export {
	getDenormedTeamId,
	getDisplayedTeamOrder,
	getNormedTeamFaction,
	getNormedTeamId,
	getTeamDenormalizedOutcome,
	getTeamFaction,
	getTeamNormalizedAllianceProp,
	getTeamNormalizedFactionProp,
	getTeamNormalizedOutcome,
	getTeamNormalizedUnitProp,
	getTeamParityForOffset,
	MAX_RECENT_MATCHES,
	MatchOutcomeSchema,
	NormedTeamIdOrPropSchema,
	NormedTeamIdSchema,
	NormedTeamPropSchema,
	toNormedTeamId,
	toNormedTeamProp,
} from '@/models/match-history.models'
export type {
	MatchDetails,
	MatchOutcome,
	NormalizedMatchOutcome,
	NormedTeamId,
	NormedTeamIdOrProp,
	NormedTeamProp,
	PostGameMatchDetails,
	PublicMatchHistoryState,
} from '@/models/match-history.models'
