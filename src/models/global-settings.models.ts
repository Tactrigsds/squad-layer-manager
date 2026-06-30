import * as DH from '@/lib/display-helpers.ts'
import { BasicStrNoWhitespace, HumanTime } from '@/lib/zod'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as BM from '@/models/battlemetrics.models.ts'
import * as CHAT from '@/models/chat.models.ts'
import * as CMD from '@/models/command.models.ts'
import * as SS from '@/models/server-state.models.ts'
import * as SM from '@/models/squad.models.ts'
import { z } from 'zod'

export const NavLinkSchema = z.array(z.object({
	label: z.string(),
	url: z.url(),
}))

export const GlobalSettingsSchema = z.object({
	topBarColor: z.string().prefault('green').nullable().describe('set to null for production'),
	warnPrefix: z.string().nullable().prefault('SLM: ').describe('Prefix to use for warnings'),
	postRollAnnouncementsTimeout: HumanTime.prefault('5m').describe('How long to wait before sending post-roll reminders'),
	fogOffDelay: HumanTime.prefault('25s').describe('Delay before fog is automatically turned off'),
	chat: CHAT.ChatConfigSchema.prefault({}),
	layerQueue: z.object({
		lowQueueWarningThreshold: z
			.number()
			.positive()
			.prefault(1)
			.describe('Number of layers in the queue to trigger a low queue size warning'),
		adminQueueReminderInterval: HumanTime.prefault('10m').describe(
			'How often to remind admins to maintain the queue. Low queue warnings happen half as often.',
		),
		maxQueueSize: z.int().min(1).max(100).prefault(20).describe('Maximum number of layers that can be in the queue'),
	}).prefault({}),
	vote: z.object({
		voteDuration: HumanTime.prefault('180s').describe('Duration of a vote'),
		startVoteReminderThreshold: HumanTime.prefault('20m').describe('How far into a match to start reminding admins to start a vote'),
		voteReminderInterval: HumanTime.prefault('30s').describe('How often to remind users to vote'),
		internalVoteReminderInterval: HumanTime.prefault('15s').describe('How often to remind admins to vote in an internal vote'),
		autoStartVoteDelay: HumanTime.prefault('20m').nullable().describe(
			'Delay before autostarting a vote from the start of the current match. Set to null to disable',
		),
		autoStartVoteCutoff: HumanTime.prefault('30m').describe(
			'How far into a match to stop auto-starting votes',
		),
		voteDisplayProps: z.array(DH.LAYER_DISPLAY_PROP).prefault(['map', 'gamemode']).describe(
			'What parts of a layer setup should be displayed',
		),
		finalVoteReminder: HumanTime.prefault('10s').describe('How far in advance the final vote reminder should be sent'),
		maxNumVoteChoices: z.int().min(1).max(50).prefault(5).describe('Maximum number of choices allowed in a vote'),
	}).prefault({}),
	squadServer: z.object({
		sftpPollInterval: HumanTime.prefault('1s'),
		sftpReconnectInterval: HumanTime.prefault('5s'),
	}).prefault({}),
	steamLinkCodeExpiry: HumanTime.prefault('15m').describe('Duration of a steam account link code'),
	balanceTriggerLevels: z.partialRecord(BAL.TRIGGER_IDS, BAL.TRIGGER_LEVEL)
		.prefault({ '150x2': 'warn' })
		.describe('Configures the trigger warning levels for balance calculations'),
	playerFlagColorHierarchy: z.array(z.uuid()).optional(),
	playerFlagGroupings: BM.PlayerFlagGroupingsSchema.optional(),
	navLinks: NavLinkSchema.optional().describe('Global links to display in the navbar dropdown menu'),
	warnOnSlmStart: z.boolean().prefault(false),
	adminListSources: z.record(z.string(), SM.AdminListSourceSchema).prefault({}).describe('Named admin list sources'),
	commandPrefix: BasicStrNoWhitespace.prefault('!').describe('Prefix character for in-game commands'),
	commands: CMD.AllCommandConfigSchema,
	servers: z.array(
		z.object({
			id: SS.ServerIdSchema.describe('ID of the server'),
			displayName: z.string().describe('Display name of the server'),
			adminListSources: z.array(z.string()).optional().describe(
				'Specify which sources to include from adminListSources. By default includes all sources.',
			),
			adminIdentifyingPermissions: z.array(SM.PLAYER_PERM).prefault(['canseeadminchat']).describe(
				"What in-game permissions identify an admin for SLM's purposes",
			),
			enabled: z.boolean().prefault(true).describe('Initial enabled state. Runtime enable/disable is controlled via the settings page'),
			connections: SS.ServerConnectionSchema,
			defaultServer: z.boolean().default(false),
			navLinks: NavLinkSchema.optional().describe('Server-specific links to display in the navbar dropdown menu'),
		}),
	).prefault([]).refine((servers) => {
		const defaultServerCount = servers.filter((server) => server.defaultServer).length
		return defaultServerCount <= 1
	}, 'There must be at most one default server'),
})

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>
