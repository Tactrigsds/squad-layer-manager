/**
 * Column widths for a `table-layout: fixed` table, allocated by priority rather than by the browser's proportional
 * auto layout.
 *
 * Every column not listed in the spec keeps its natural (max-content) width. The listed columns share what is left in
 * priority order: each first gets its minimum, then each in turn grows toward its natural width, and anything left
 * over goes to the fill column. The fill column is the one whose `<col>` carries no width, so the fixed layout hands
 * it the remainder by itself. When even the minimums do not fit, the lowest priorities shrink below theirs first.
 *
 * Natural widths come from a measuring pass that briefly switches the table to `table-layout: auto; width:
 * max-content`, where each header cell is as wide as its column's widest cell. Rows with a spanning cell are hidden
 * for the pass, since the auto layout would otherwise widen the spanned columns to fit them. Every table due a
 * measurement is measured together in the next animation frame, with all reads and all writes grouped into phases,
 * so the whole batch costs two forced layouts however many tables and triggers it covers. Resizes only redo the
 * arithmetic against the cached measurement. A table hidden when its turn comes is skipped, and measured once
 * revealing it resizes its container. Widths are written straight to the `<col>` elements, so none of this re-renders
 * React.
 *
 * `onFit` receives the measurement and the available width after every allocation, so a caller can see how cramped
 * the table is (see `minimumWidth`) without measuring again.
 */
import * as React from 'react'

export type Spec = {
	// in priority order. The first is the fill column.
	shrinkable: { id: string; minEm: number }[]
	onFit?: (m: Measurement, available: number) => void
}

const MIN_SQUEEZED_EM = 2

export type Measurement = { natural: Map<string, number>; emPx: number }

type MeasurePass = {
	table: HTMLTableElement
	headerCells: HTMLCollectionOf<HTMLTableCellElement>
	cols: NodeListOf<HTMLTableColElement>
	spanRows: HTMLTableRowElement[]
}

function beginMeasure(table: HTMLTableElement): MeasurePass | null {
	const headerRow = table.tHead?.rows[0]
	if (!headerRow) return null
	const cols = table.querySelectorAll<HTMLTableColElement>('col[data-col-id]')
	const spanRows: HTMLTableRowElement[] = []
	for (const row of table.tBodies[0]?.rows ?? []) {
		if (row.cells.length === 1 && row.cells[0].colSpan > 1) spanRows.push(row)
	}
	for (const row of spanRows) row.style.display = 'none'
	for (const col of cols) col.style.width = ''
	table.style.tableLayout = 'auto'
	table.style.width = 'max-content'
	return { table, headerCells: headerRow.cells, cols, spanRows }
}

// null while the table is not rendered (an inactive tab), where every width reads as zero
function readMeasure({ table, headerCells, cols }: MeasurePass): Measurement | null {
	if (table.getBoundingClientRect().width === 0) return null
	const natural = new Map<string, number>()
	for (let i = 0; i < cols.length && i < headerCells.length; i++) {
		natural.set(cols[i].dataset.colId!, Math.ceil(headerCells[i].getBoundingClientRect().width))
	}
	return { natural, emPx: parseFloat(getComputedStyle(table).fontSize) }
}

function endMeasure({ table, spanRows }: MeasurePass) {
	table.style.tableLayout = ''
	table.style.width = ''
	for (const row of spanRows) row.style.display = ''
}

// the table's own width, since collapsed borders leave it a pixel short of its parent. The parent caps it while a
// previous allocation overflows.
function availableWidth(table: HTMLTableElement) {
	return Math.min(table.getBoundingClientRect().width, table.parentElement!.getBoundingClientRect().width)
}

// the narrowest the table gets without squeezing a shrinkable column below its minimum, leaving out the `omit` columns
export function minimumWidth(shrinkable: Spec['shrinkable'], m: Measurement, omit?: string) {
	let total = 0
	for (const [id, natural] of m.natural) {
		if (id === omit) continue
		const shrink = shrinkable.find((s) => s.id === id)
		total += shrink ? Math.min(natural, shrink.minEm * m.emPx) : natural
	}
	return total
}

function allocate(table: HTMLTableElement, spec: Spec, m: Measurement, available: number) {
	const cols = table.querySelectorAll<HTMLTableColElement>('col[data-col-id]')
	const shrinkIds = new Set(spec.shrinkable.map((s) => s.id))

	let budget = available
	for (const col of cols) {
		const id = col.dataset.colId!
		if (shrinkIds.has(id)) continue
		const w = m.natural.get(id) ?? 0
		col.style.width = `${w}px`
		budget -= w
	}

	const present = spec.shrinkable.filter((s) => m.natural.has(s.id))
	const widths = present.map((s) => {
		const natural = m.natural.get(s.id)!
		return { id: s.id, natural, w: Math.min(natural, s.minEm * m.emPx) }
	})
	budget -= widths.reduce((sum, c) => sum + c.w, 0)
	// too narrow for every minimum: the lowest priorities give up theirs first, down to MIN_SQUEEZED_EM
	for (let i = widths.length - 1; i > 0 && budget < 0; i--) {
		const give = Math.min(-budget, Math.max(0, widths[i].w - MIN_SQUEEZED_EM * m.emPx))
		widths[i].w -= give
		budget += give
	}
	for (const c of widths) {
		const grow = Math.max(0, Math.min(budget, c.natural - c.w))
		c.w += grow
		budget -= grow
	}

	const fillId = present[0]?.id
	for (const c of widths) {
		const col = table.querySelector<HTMLTableColElement>(`col[data-col-id="${c.id}"]`)!
		col.style.width = c.id === fillId ? '' : `${Math.floor(c.w)}px`
	}
	spec.onFit?.(m, available)
}

type MeasureJob = { spec: Spec; measurement: React.RefObject<Measurement | null> }

const pendingMeasures = new Map<HTMLTableElement, MeasureJob>()
let measureFrame = 0

function scheduleMeasure(table: HTMLTableElement, job: MeasureJob) {
	pendingMeasures.set(table, job)
	if (!measureFrame) measureFrame = requestAnimationFrame(flushMeasures)
}

// for a table being revealed: the observer reports it before paint, so measuring then avoids a frame of unfitted columns
function measureNow(table: HTMLTableElement, job: MeasureJob) {
	pendingMeasures.set(table, job)
	cancelAnimationFrame(measureFrame)
	flushMeasures()
}

function flushMeasures() {
	measureFrame = 0
	const batch = [...pendingMeasures].filter(([table]) => table.isConnected)
	pendingMeasures.clear()
	const passes = batch.map(([table]) => beginMeasure(table))
	const measurements = passes.map((pass) => (pass ? readMeasure(pass) : null))
	for (const pass of passes) if (pass) endMeasure(pass)
	const available = batch.map(([table], i) => (measurements[i] ? availableWidth(table) : 0))
	for (let i = 0; i < batch.length; i++) {
		const [table, job] = batch[i]
		const m = measurements[i]
		job.measurement.current = m
		if (m) allocate(table, job.spec, m, available[i])
	}
}

/**
 * Fits the columns of `tableRef`'s table. Its `<col>` elements must carry `data-col-id`, in the same order as the
 * header row's cells. One of `contentKeys` must change whenever anything that could change a natural width does.
 */
export function useFittedColumns(
	tableRef: React.RefObject<HTMLTableElement | null>,
	spec: Spec | undefined,
	contentKeys: readonly unknown[],
) {
	const measurementRef = React.useRef<Measurement | null>(null)

	React.useLayoutEffect(() => {
		const table = tableRef.current
		if (!spec || !table) return
		scheduleMeasure(table, { spec, measurement: measurementRef })
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [tableRef, spec, ...contentKeys])

	React.useEffect(() => {
		const table = tableRef.current
		if (!spec || !table?.parentElement) return
		const refit = () => {
			if (measurementRef.current) allocate(table, spec, measurementRef.current, availableWidth(table))
			else if (table.getClientRects().length > 0) measureNow(table, { spec, measurement: measurementRef })
		}
		// widths measured against a fallback font are wrong once a webfont arrives. `document.fonts.ready` does not
		// cover this: a font starts loading only once text needs it, which can be after the first measurement.
		const remeasure = () => scheduleMeasure(table, { spec, measurement: measurementRef })
		const observer = new ResizeObserver(refit)
		observer.observe(table.parentElement)
		document.fonts.addEventListener('loadingdone', remeasure)
		return () => {
			observer.disconnect()
			document.fonts.removeEventListener('loadingdone', remeasure)
			pendingMeasures.delete(table)
		}
	}, [tableRef, spec])
}
