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
} from '@/components/settings-form/editors/basic-fields'
import { AllowedPrefixesField, CommandCard } from '@/components/settings-form/editors/commands'
import { PlayerGroupingsField } from '@/components/settings-form/editors/player-groupings'
import {
	PluginChannelField,
	PluginChannelMultiField,
	PluginFilterField,
	PluginFilterMultiField,
	PluginMultilineField,
	PluginServerField,
	PluginServerMultiField,
} from '@/components/settings-form/editors/plugin-fields'
import { AdminActionReasonsField, LayerTagsField } from '@/components/settings-form/editors/preset-tables'
import { RbacSuperCallout } from '@/components/settings-form/editors/rbac'
import type { OverrideProps, Path, SchemaNode } from '@/components/settings-form/settings-form.helpers'
import * as PLG from '@/models/plugins.models'
import * as SDoc from '@/models/schema-docs.models'

// extra read-only content injected at the top of specific sections (below the description, above the fields)
export function sectionExtraFor(path: Path): React.FC | undefined {
	if (path.length === 1 && path[0] === 'rbac') return RbacSuperCallout
	return undefined
}

const DECLARED_CONTROLS: Record<PLG.FieldControl, React.FC<OverrideProps>> = {
	'filter-id': PluginFilterField,
	'filter-ids': PluginFilterMultiField,
	'server-id': PluginServerField,
	'server-ids': PluginServerMultiField,
	'discord-channel-id': PluginChannelField,
	'discord-channel-ids': PluginChannelMultiField,
	multiline: PluginMultilineField,
}

export function overrideFor(path: Path, _node: SchemaNode): React.FC<OverrideProps> | undefined {
	const declared = PLG.fieldControl(_node)
	if (declared) return DECLARED_CONTROLS[declared]
	const last = path[path.length - 1]
	// global settings define the lists (a record); a server picks from them (an array of names)
	if (path.length === 1 && last === 'adminLists') return _node.type === 'array' ? ServerAdminListsField : AdminListsField
	if (path.length === 1 && last === 'installedMods') return InstalledModsField
	if (path.length === 1 && last === 'allowedPrefixes') return AllowedPrefixesField
	if (path.length === 1 && last === 'locale') return LocaleField
	// each command renders as one compact card (which itself renders the strings sub-editor), so there's no separate strings override
	if (path.length === 2 && path[0] === 'commands') return CommandCard
	if (path.length === 1 && last === 'adminActionReasons') return AdminActionReasonsField
	if (path.length === 1 && last === 'layerTable') return LayerTableField
	if (path.length === 1 && last === 'layerGeneration') return LayerGenerationField
	if (path.length === 1 && last === 'layerTags') return LayerTagsField
	if (path.length === 1 && last === 'playerFlagsRequiringNote') return FlagMultiSelectField
	if (path.length === 1 && last === 'playerGroupings') return PlayerGroupingsField
	// the entire `rbac` subtree is rendered by RbacBody (see FieldControl), so no per-field rbac overrides are needed here
	// server settings: the pool configuration reuses the dashboard popover's panels; connection passwords are masked
	if (path.length === 2 && path[0] === 'queue' && last === 'mainPool') return MainPoolField
	if (path.length === 2 && path[0] === 'connections' && last === 'token') return ServerAgentTokenField
	if (SDoc.read(_node)?.secret) return PasswordField
	return undefined
}
