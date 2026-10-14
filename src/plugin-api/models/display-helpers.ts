/**
 * Naming a layer the way SLM names it everywhere else. A layer id is a number or canonical text
 * (`Sumari_Seed_v1:USA+CombinedArms:RGF+CombinedArms`); these render the name an admin recognises
 * (`Sumari_Seed_v1 - USA CA vs RGF CA`).
 *
 * Use these for text: warns, broadcasts, Discord posts, and the `message` on an app event. For a React
 * surface use `LayerName` from slm/components/layer, which renders the same name in parts, styled and
 * clickable like the rest of the app.
 */
export {
	toExtraShortLayerNameFromId,
	toFullLayerName,
	toFullLayerNameFromId,
	toShortLayerName,
	toShortLayerNameFromId,
	toShortTeamsDisplay,
} from '@/models/display-helpers.models'
export type { LayerDisplayProp } from '@/models/display-helpers.models'
