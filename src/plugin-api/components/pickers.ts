/**
 * SLM's pickers over its own entities, for a plugin's own components. Each takes a value and hands one
 * back; where the options come from is the host's problem, so none of them needs wiring.
 *
 * The same six are reachable declaratively from a config schema through slm/plugin/fields, which is the
 * better choice when the value is a setting rather than something chosen in a slot.
 */
export { FilterMultiSelect, FilterSelect } from '@/components/filter-entity-select'
export { ServerMultiSelect, ServerSelect } from '@/components/server-select'
export { DiscordChannelMultiSelect, DiscordChannelSelect } from '@/components/discord-picker'
