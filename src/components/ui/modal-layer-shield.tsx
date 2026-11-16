// Blocks pointer events on the page behind an open modal Radix layer (Select, and DropdownMenu and ContextMenu unless
// `modal={false}`). Render it in the layer's portal, before the content, at the content's z-index. Radix's portals slot
// onto a single child, so wrap the two in a `contents` div.
//
// Radix makes a layer modal by setting `pointer-events: none` on <body>. That property is inherited, so setting and
// clearing it restyled every element on the page: 12,017 elements and about 100 ms on the settings page, on open and
// again on close. index.css gives #root `pointer-events: auto`, which keeps the change from reaching the app, and
// shows this shield while <body> carries `pointer-events: none`. An outside click lands on the shield, which Radix
// treats as outside the layer and dismisses it, and nothing beneath it is clicked. A toggle now restyles about 11
// elements, however large the page.
export function ModalLayerShield({ zIndex }: { zIndex: number }) {
	return <div data-modal-layer-shield="" aria-hidden style={{ zIndex }} />
}
