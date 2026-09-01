import type { ComboBoxOption } from '@/components/combo-box/combo-box.tsx'
import type { ComboBoxGroupingDef } from '@/components/combo-box/options.ts'
import * as HistoryMsgs from '@/messages/history.messages'
import * as HQ from '@/models/history.models'
import { tr } from '@/systems/messages.client'

// Event types as a picker shows them, grouped by the family that raises them. Sixty names in one flat list
// otherwise, where PLAYER_KICKED the admin action SLM logged and PLAYER_KICKED the server reported are
// indistinguishable.

export const EVENT_FAMILY_GROUPING = 'eventFamily'

const BOTH = 'both'

let groupings: ComboBoxGroupingDef[] | undefined

// cached for a stable identity: a fresh array per render rebuilds every option list downstream
export function eventTypeGroupings(): ComboBoxGroupingDef[] {
	groupings ??= [
		{
			key: EVENT_FAMILY_GROUPING,
			label: tr.text(HistoryMsgs.eventFamilyGrouping()),
			groups: [
				{ key: 'server', label: tr.text(HistoryMsgs.eventFamilyServer()) },
				{ key: 'app', label: tr.text(HistoryMsgs.eventFamilyApp()) },
				{ key: BOTH, label: tr.text(HistoryMsgs.eventFamilyBoth()) },
			],
		},
	]
	return groupings
}

// A shared name leads with `both`, so it heads and prefixes as such, while still belonging to each family:
// narrowing to either still shows it, because selecting it does match either family's events.
export const EVENT_TYPE_OPTIONS: ComboBoxOption<string>[] = HQ.EVENT_TYPES.map((type) => {
	const families = HQ.eventTypeFamilies(type)
	return { value: type, groups: { [EVENT_FAMILY_GROUPING]: families.length > 1 ? [BOTH, ...families] : families } }
})
