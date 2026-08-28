/**
 * The combo box the pickers in slm/components/pickers are built from, for a plugin that needs one over its
 * own options. `LOADING` stands in for the option list while it is still being fetched.
 *
 * Options may carry `groups`, which `groupings` then narrows the list by; see ComboBoxGroupingDef.
 */
export { default as ComboBox } from '@/components/combo-box/combo-box'
export type { ComboBoxHandle, ComboBoxOption, ComboBoxProps } from '@/components/combo-box/combo-box'
export { default as ComboBoxMulti } from '@/components/combo-box/combo-box-multi'
export type { ComboBoxMultiProps } from '@/components/combo-box/combo-box-multi'
export { LOADING } from '@/components/combo-box/constants'
export type { ComboBoxGroupDef, ComboBoxGroupingDef, GroupSelection } from '@/components/combo-box/options'
