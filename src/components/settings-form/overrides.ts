import React from 'react'

import { AdminListsField, ServerAdminListsField } from '@/components/settings-form/editors/admin-lists'
import {
	FlagMultiSelectField,
	InstalledModsField,
	LayerGenerationField,
	LayerTableField,
	LocaleField,
	MainPoolField,
	PasswordField,
	ServerAgentTokenField,
	ServerColorField,
} from '@/components/settings-form/editors/basic-fields'
import { AllowedPrefixesField, CommandCard } from '@/components/settings-form/editors/commands'
import { PlayerGroupingsField } from '@/components/settings-form/editors/player-groupings'
import {
	PluginChannelField,
	PluginChannelMultiField,
	PluginFilterField,
	PluginFilterMultiField,
	PluginMultilineField,
	PluginRotationTagField,
	PluginServerField,
	PluginServerMultiField,
} from '@/components/settings-form/editors/plugin-fields'
import { AdminMessageShorthandsField, LayerTagsField } from '@/components/settings-form/editors/preset-tables'
import { RbacSuperCallout } from '@/components/settings-form/editors/rbac'
import { CounterbalanceGroupsField, CounterbalancePickFirstField } from '@/components/settings-form/editors/teamswap-counterbalance'
import type { OverrideProps } from '@/components/settings-form/settings-form.helpers'
import type * as FormSchema from '@/models/settings-form-schema.models'

// extra read-only content injected at the top of specific sections (below the description, above the fields)
export function sectionExtraFor(path: FormSchema.Path): React.FC | undefined {
	if (path.length === 1 && path[0] === 'rbac') return RbacSuperCallout
	return undefined
}

export const OVERRIDE_COMPONENTS: Record<FormSchema.OverrideId, React.FC<OverrideProps>> = {
	'filter-id': PluginFilterField,
	'filter-ids': PluginFilterMultiField,
	'server-id': PluginServerField,
	'server-ids': PluginServerMultiField,
	'discord-channel-id': PluginChannelField,
	'discord-channel-ids': PluginChannelMultiField,
	'rotation-tag-id': PluginRotationTagField,
	multiline: PluginMultilineField,
	'admin-lists': AdminListsField,
	'server-admin-lists': ServerAdminListsField,
	'installed-mods': InstalledModsField,
	'allowed-prefixes': AllowedPrefixesField,
	locale: LocaleField,
	'server-color': ServerColorField,
	command: CommandCard,
	'admin-message-shorthands': AdminMessageShorthandsField,
	'layer-table': LayerTableField,
	'layer-generation': LayerGenerationField,
	'layer-tags': LayerTagsField,
	'flag-multi-select': FlagMultiSelectField,
	'player-groupings': PlayerGroupingsField,
	'main-pool': MainPoolField,
	'server-agent-token': ServerAgentTokenField,
	'counterbalance-groups': CounterbalanceGroupsField,
	'counterbalance-pick-first': CounterbalancePickFirstField,
	password: PasswordField,
}
