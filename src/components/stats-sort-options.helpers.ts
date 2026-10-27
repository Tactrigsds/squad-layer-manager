import { assertNever } from '@/lib/type-guards'
import * as SM_Msgs from '@/messages/squad.messages'
import type * as CHAT from '@/models/chat.models'

export function statMetricLabel(metric: CHAT.StatMetric) {
	switch (metric) {
		case 'kills':
			return SM_Msgs.sortKills()
		case 'wounds':
			return SM_Msgs.sortWounds()
		case 'deaths':
			return SM_Msgs.sortDeaths()
		case 'kd':
			return SM_Msgs.sortKd()
		case 'wd':
			return SM_Msgs.sortWd()
		default:
			assertNever(metric)
	}
}
