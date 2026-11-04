/**
 * Rendering an SVG to a PNG, for posting a chart or a card where SVG is not shown, such as a discord embed.
 * Text is drawn in the fonts `FONT_FAMILIES` names, since the host loads no system fonts.
 */
export { FONT_FAMILIES, svgToPng } from '@/systems/svg-raster.server'
