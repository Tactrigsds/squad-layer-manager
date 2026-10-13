// The exchange formats for a rotation's items, YAML and plain text. Neither carries the rotation's name, description,
// rotation tags or ruleset. A layer is written as the line SLM sends with AdminSetNextLayer, so a layer line copied
// from either format pastes into the other.
//
// YAML is a list. An item is a layer line, a `{ layer, tags }` map, or a `{ vote: [...], display?, duration? }` map
// whose first choice is the default; a choice takes either item form. Tags are written by label. Each `#` line
// directly above an item or a choice is one note on it.
//
// Plain text is one layer per line. A `#` line is a note on the next layer, and a `# TAGS: a, b` line names the next
// layer's tags. A vote is a `# VOTE:` line carrying its display settings (`# VOTE: display map, factions; duration 3m`),
// followed by its choices, indented. An indented `#` line is a note or the tags of the next choice, and the vote ends at
// the next line that is not indented. Tags named above a `# VOTE:` line go on its default choice.
//
// WARNING: this pulls in the whole `yaml` package (see src/lib/yaml.ts), so only lazily-loaded code may import it.
import type * as DH from '@/lib/display-helpers'
import { LAYER_DISPLAY_PROP } from '@/lib/display-helpers'
import * as Yaml from '@/lib/yaml'
import * as ZodUtils from '@/lib/zod-utils'
import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'
import * as LTag from '@/models/layer-tags.models'
import * as L from '@/models/layer.models'

export type Format = 'yaml' | 'text'

// what a vote shows players and how long it runs; unset fields fall back to the server's vote settings
export type VoteConfig = { displayProps?: DH.LayerDisplayProp[]; duration?: number }

function voteConfigOf(item: LL.VoteItem): VoteConfig {
	const config: VoteConfig = {}
	if (item.voteConfig?.displayProps && item.voteConfig.displayProps.length > 0) config.displayProps = item.voteConfig.displayProps
	if (item.voteConfig?.duration !== undefined) config.duration = item.voteConfig.duration
	return config
}

const VOTE_HEADER = /^#\s*VOTE:(.*)$/i
const TAGS_LINE = /^#\s*TAGS:(.*)$/i

function voteHeader(config: VoteConfig): string {
	const parts: string[] = []
	if (config.displayProps) parts.push(`display ${config.displayProps.join(', ')}`)
	if (config.duration !== undefined) parts.push(`duration ${ZodUtils.formatHumanTime(config.duration)}`)
	return parts.length > 0 ? `# VOTE: ${parts.join('; ')}` : '# VOTE:'
}

function parseDisplayProps(values: string[]): DH.LayerDisplayProp[] | null {
	const props: DH.LayerDisplayProp[] = []
	for (const value of values) {
		const res = LAYER_DISPLAY_PROP.safeParse(value.trim().toLowerCase())
		if (!res.success) return null
		props.push(res.data)
	}
	return props
}

// the settings after `# VOTE:`, or null when a part is not `display <props>` or `duration <time>`
function parseVoteHeader(rest: string): VoteConfig | null {
	const config: VoteConfig = {}
	for (const part of rest.split(';').map((part) => part.trim())) {
		if (part.length === 0) continue
		const [key, ...words] = part.split(/\s+/)
		const value = words.join(' ')
		switch (key.toLowerCase()) {
			case 'display': {
				const props = parseDisplayProps(value.split(','))
				if (!props || props.length === 0) return null
				config.displayProps = props
				break
			}
			case 'duration': {
				const duration = ZodUtils.tryParseHumanTimeToken(value)
				if (duration === undefined) return null
				config.duration = duration
				break
			}
			default:
				return null
		}
	}
	return config
}

function layerLine(layerId: L.LayerId): string {
	return L.getLayerCommand(layerId, 'none').trim()
}

// a note is one comment line, so a note written over several lines is joined into one
function noteLine(note: LNote.Note): string {
	return note.text.replace(/\s*\n\s*/g, ' ').trim()
}

function tagLabel(id: LTag.TagId, tags: LTag.Tag[]): string | undefined {
	if (LTag.rotationIdOfTag(id) !== undefined) return undefined
	return tags.find((tag) => tag.id === id)?.label ?? LTag.originalLabel(id)
}

function writtenTagLabels(item: LL.SingleItem, configuredTags: LTag.Tag[]): string[] {
	return (item.tags ?? []).flatMap((id) => tagLabel(id, configuredTags) ?? [])
}

type WriteOpts = { notes: boolean; tags: boolean; configuredTags: LTag.Tag[] }

export function toYaml(items: LL.List, opts: WriteOpts): string {
	const doc = new Yaml.Document([] as unknown[])
	const seq = doc.contents as Yaml.YAMLSeq
	const single = (item: LL.SingleItem) => {
		const labels = opts.tags ? writtenTagLabels(item, opts.configuredTags) : []
		const node =
			labels.length > 0 ? doc.createNode({ layer: layerLine(item.layerId), tags: labels }) : doc.createNode(layerLine(item.layerId))
		if (Yaml.isMap(node)) {
			const tagsNode = node.get('tags', true)
			if (Yaml.isSeq(tagsNode)) tagsNode.flow = true
		}
		withNotes(node, item.notes)
		return node
	}
	const withNotes = (node: Yaml.Node, notes: LNote.Note[] | undefined) => {
		if (!opts.notes || !notes || notes.length === 0) return
		node.commentBefore = notes.map((note) => ` ${noteLine(note)}`).join('\n')
	}
	for (const item of items) {
		if (item.type === 'single-list-item') {
			seq.items.push(single(item))
			continue
		}
		const choices = new Yaml.YAMLSeq()
		choices.items.push(...item.choices.map(single))
		const node = new Yaml.YAMLMap()
		node.items.push(new Yaml.Pair(doc.createNode('vote'), choices))
		const config = voteConfigOf(item)
		if (config.displayProps) {
			const display = doc.createNode(config.displayProps)
			display.flow = true
			node.items.push(new Yaml.Pair(doc.createNode('display'), display))
		}
		if (config.duration !== undefined)
			node.items.push(new Yaml.Pair(doc.createNode('duration'), doc.createNode(ZodUtils.formatHumanTime(config.duration))))
		seq.items.push(node)
	}
	if (seq.items.length === 0) return ''
	return doc.toString({ lineWidth: 0, flowCollectionPadding: false })
}

export function toPlainText(items: LL.List, opts: WriteOpts): string {
	const lines: string[] = []
	const single = (item: LL.SingleItem, indent: string) => {
		if (opts.notes) for (const note of item.notes ?? []) lines.push(`${indent}# ${noteLine(note)}`)
		const labels = opts.tags ? writtenTagLabels(item, opts.configuredTags) : []
		if (labels.length > 0) lines.push(`${indent}# TAGS: ${labels.join(', ')}`)
		lines.push(`${indent}${layerLine(item.layerId)}`)
	}
	for (const item of items) {
		if (item.type === 'single-list-item') {
			single(item, '')
			continue
		}
		lines.push(voteHeader(voteConfigOf(item)))
		for (const choice of item.choices) single(choice, '  ')
	}
	return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

// -------- import --------

export type ParsedSingle = { line: number; layer: L.RawLayerLine; tagLabels: string[]; notes: string[] }
export type ParsedItem =
	| { type: 'single'; single: ParsedSingle }
	| { type: 'vote'; line: number; choices: ParsedSingle[]; notes: string[]; config: VoteConfig }

export type ParseError = { line: number; text: string; code: 'err:yaml' | 'err:not-a-list' | 'err:bad-item' | 'err:bad-vote-header' }

export type Parsed = {
	format: Format
	items: ParsedItem[]
	errors: ParseError[]
}

// YAML when the first line that is neither blank nor a comment starts a list item
export function detectFormat(text: string): Format {
	for (const raw of text.split('\n')) {
		const line = raw.trim()
		if (line.length === 0 || line.startsWith('#')) continue
		return line.startsWith('- ') || line === '-' ? 'yaml' : 'text'
	}
	return 'text'
}

export function parse(text: string, opts?: { installedMods?: readonly string[] }): Parsed {
	return detectFormat(text) === 'yaml' ? parseYaml(text, opts) : parsePlainText(text, opts)
}

function parseLayerLine(text: string, line: number, opts?: { installedMods?: readonly string[] }): L.RawLayerLine {
	const [parsed] = L.parseRawLayerLines(text, opts)
	if (!parsed) return { code: 'err:unparsable', lineNumber: line, text, layer: null, problems: [] }
	return { ...parsed, lineNumber: line }
}

export function parsePlainText(text: string, opts?: { installedMods?: readonly string[] }): Parsed {
	const items: ParsedItem[] = []
	const errors: ParseError[] = []
	type Pending = { notes: string[]; tagLabels: string[] }
	const nothingPending = (): Pending => ({ notes: [], tagLabels: [] })
	let pending = nothingPending()
	let vote: { line: number; text: string; config: VoteConfig; notes: string[]; choices: ParsedSingle[]; choicePending: Pending } | null =
		null
	// notes and tags left after a vote's last choice fall to whatever follows the vote
	const closeVote = () => {
		if (!vote) return
		if (vote.choices.length === 0) errors.push({ line: vote.line, text: vote.text, code: 'err:bad-item' })
		else items.push({ type: 'vote', line: vote.line, choices: vote.choices, notes: vote.notes, config: vote.config })
		pending = vote.choicePending
		vote = null
	}
	text.split('\n').forEach((raw, index) => {
		const line = raw.trim()
		if (line.length === 0) return
		const lineNumber = index + 1
		const indented = /^\s/.test(raw)
		const header = VOTE_HEADER.exec(line)
		if (header) {
			closeVote()
			const config = parseVoteHeader(header[1])
			if (!config) errors.push({ line: lineNumber, text: line, code: 'err:bad-vote-header' })
			vote = {
				line: lineNumber,
				text: line,
				config: config ?? {},
				notes: pending.notes,
				choices: [],
				choicePending: { notes: [], tagLabels: pending.tagLabels },
			}
			pending = nothingPending()
			return
		}
		if (!indented) closeVote()
		const target = vote ? vote.choicePending : pending
		const tags = TAGS_LINE.exec(line)
		if (tags) {
			for (const label of tags[1].split(',')) if (label.trim().length > 0) target.tagLabels.push(label.trim())
			return
		}
		if (line.startsWith('#')) {
			const note = line.replace(/^#+\s?/, '').trim()
			if (note.length > 0) target.notes.push(note)
			return
		}
		const single: ParsedSingle = {
			line: lineNumber,
			layer: parseLayerLine(line, lineNumber, opts),
			tagLabels: target.tagLabels,
			notes: target.notes,
		}
		if (vote) {
			vote.choices.push(single)
			vote.choicePending = nothingPending()
		} else {
			items.push({ type: 'single', single })
			pending = nothingPending()
		}
	})
	closeVote()
	return { format: 'text', items, errors }
}

function commentNotes(node: Yaml.Node): string[] {
	if (!node.commentBefore) return []
	return node.commentBefore
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
}

export function parseYaml(text: string, opts?: { installedMods?: readonly string[] }): Parsed {
	const lineCounter = new Yaml.LineCounter()
	const doc = Yaml.parseDocument(text, { lineCounter })
	const lineOf = (node: { range?: [number, number, number] | null } | null | undefined) =>
		node?.range ? lineCounter.linePos(node.range[0]).line : 1
	if (doc.errors.length > 0) {
		const error = doc.errors[0]
		return {
			format: 'yaml',
			items: [],
			errors: [{ line: lineCounter.linePos(error.pos[0]).line, text: error.message, code: 'err:yaml' }],
		}
	}
	if (doc.contents === null) return { format: 'yaml', items: [], errors: [] }
	if (!Yaml.isSeq(doc.contents)) {
		return { format: 'yaml', items: [], errors: [{ line: lineOf(doc.contents as Yaml.Node), text: '', code: 'err:not-a-list' }] }
	}
	const items: ParsedItem[] = []
	const errors: ParseError[] = []
	const single = (node: unknown): ParsedSingle | null => {
		if (Yaml.isScalar(node) && typeof node.value === 'string') {
			const line = lineOf(node)
			return { line, layer: parseLayerLine(node.value, line, opts), tagLabels: [], notes: commentNotes(node) }
		}
		if (!Yaml.isMap(node)) return null
		const layer = node.get('layer')
		const tags = node.get('tags')
		if (typeof layer !== 'string') return null
		if (tags !== undefined && !(Yaml.isSeq(tags) && tags.items.every((tag) => Yaml.isScalar(tag) && typeof tag.value === 'string')))
			return null
		const line = lineOf(node)
		const tagLabels = tags ? (tags as Yaml.YAMLSeq<Yaml.Scalar<string>>).items.map((tag) => tag.value.trim()) : []
		return { line, layer: parseLayerLine(layer, line, opts), tagLabels, notes: commentNotes(node) }
	}
	const voteConfig = (node: Yaml.YAMLMap): VoteConfig | null => {
		const config: VoteConfig = {}
		const display = node.get('display')
		if (display !== undefined) {
			if (!Yaml.isSeq(display) || !display.items.every((value) => Yaml.isScalar(value) && typeof value.value === 'string')) return null
			const props = parseDisplayProps((display as Yaml.YAMLSeq<Yaml.Scalar<string>>).items.map((value) => value.value))
			if (!props || props.length === 0) return null
			config.displayProps = props
		}
		const duration = node.get('duration')
		if (duration !== undefined) {
			const ms = typeof duration === 'string' ? ZodUtils.tryParseHumanTimeToken(duration) : undefined
			if (ms === undefined) return null
			config.duration = ms
		}
		return config
	}
	for (const node of doc.contents.items) {
		const vote = Yaml.isMap(node) ? node.get('vote') : undefined
		if (Yaml.isSeq(vote)) {
			const choices = vote.items.map(single)
			const config = voteConfig(node as Yaml.YAMLMap)
			if (choices.length === 0 || choices.some((choice) => choice === null) || !config) {
				errors.push({ line: lineOf(node as Yaml.Node), text: String(node), code: 'err:bad-item' })
				continue
			}
			items.push({
				type: 'vote',
				line: lineOf(node as Yaml.Node),
				choices: choices as ParsedSingle[],
				notes: commentNotes(node as Yaml.Node),
				config,
			})
			continue
		}
		const parsed = single(node)
		if (!parsed) {
			errors.push({ line: lineOf(node as Yaml.Node), text: String(node), code: 'err:bad-item' })
			continue
		}
		items.push({ type: 'single', single: parsed })
	}
	return { format: 'yaml', items, errors }
}

export function layerLines(parsed: Parsed): L.RawLayerLine[] {
	return parsed.items.flatMap((item) => (item.type === 'single' ? [item.single.layer] : item.choices.map((choice) => choice.layer)))
}

export function noteCount(parsed: Parsed): number {
	let count = 0
	for (const item of parsed.items) {
		if (item.type === 'single') count += item.single.notes.length
		else count += item.notes.length + item.choices.reduce((sum, choice) => sum + choice.notes.length, 0)
	}
	return count
}

// every tag label the import names, each once, matched case-insensitively against the configured tags
export function tagLabels(parsed: Parsed, configured: LTag.Tag[]): { label: string; match: LTag.Tag | undefined }[] {
	const seen = new Map<string, string>()
	for (const item of parsed.items) {
		const singles = item.type === 'single' ? [item.single] : item.choices
		for (const single of singles)
			for (const label of single.tagLabels) if (!seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label)
	}
	return [...seen.values()].map((label) => ({
		label,
		match: configured.find((tag) => tag.label.trim().toLowerCase() === label.toLowerCase()),
	}))
}

// What happens to a tag label the import names. Labels left out of the mapping are dropped.
export type TagMapping = ReadonlyMap<string, LTag.TagId>

// The parsed items as new list items. Only call this once every layer line is ok. A vote's own notes go on its default
// choice, since a vote item holds no notes of its own.
export function toNewItems(parsed: Parsed, mapping: TagMapping): LL.NewItem[] {
	const single = (parsed: ParsedSingle, extraNotes: string[] = []): LL.NewSingleItem => {
		if (parsed.layer.code === 'err:unparsable' && !parsed.layer.layer) throw new Error(`line ${parsed.line} has no layer`)
		const layer = parsed.layer.layer!
		const tags = [...new Set(parsed.tagLabels.flatMap((label) => mapping.get(label.toLowerCase()) ?? []))]
		const notes = [...extraNotes, ...parsed.notes].map((text): LNote.Note => ({
			id: LNote.createNoteId(),
			text: text.slice(0, LNote.MAX_LENGTH),
		}))
		const item: LL.NewSingleItem = { type: 'single-list-item', itemId: LL.createItemId(), layerId: layer.id }
		if (tags.length > 0) item.tags = tags
		if (notes.length > 0) item.notes = notes
		return item
	}
	return parsed.items.map((item): LL.NewItem => {
		if (item.type === 'single') return single(item.single)
		const source: LL.Source = { type: 'unknown' }
		const choices = item.choices.map((choice, i) => LL.createItem(single(choice, i === 0 ? item.notes : []), source))
		const vote: LL.NewVoteItem = { type: 'vote-list-item', itemId: LL.createItemId(), layerId: choices[0].layerId, choices }
		if (item.config.displayProps || item.config.duration !== undefined) vote.voteConfig = { ...item.config, source }
		return vote
	})
}

// -------- editing as text --------

// the whole list in `format`, with every note and tag
export function serialize(items: LL.List, format: Format, configuredTags: LTag.Tag[]): string {
	const opts = { notes: true, tags: true, configuredTags }
	return format === 'yaml' ? toYaml(items, opts) : toPlainText(items, opts)
}

// Gives each parsed item that repeats an item of `existing` what the text could not say about it: its id, the authors
// of the notes it keeps, and its rotation tags, which neither format writes. A layer repeats the first unclaimed
// existing layer with the same layer id, and a vote the first unclaimed vote with the same choices.
export function carryOver(existing: LL.List, items: LL.NewItem[]): LL.NewItem[] {
	const singles = new Map<L.LayerId, LL.SingleItem[]>()
	const votes = new Map<string, LL.VoteItem[]>()
	for (const item of existing) {
		if (item.type === 'single-list-item') claimable(singles, item.layerId).push(item)
		else claimable(votes, voteKey(item.choices)).push(item)
	}
	const unsaid = (id: LTag.TagId) => LTag.rotationIdOfTag(id) !== undefined
	const merge = <T extends LL.NewSingleItem>(item: T, prev: LL.SingleItem): T => {
		const out: T = { ...item, itemId: prev.itemId }
		const tags = [...new Set([...(item.tags ?? []), ...(prev.tags ?? []).filter(unsaid)])]
		if (tags.length > 0) out.tags = tags
		else delete out.tags
		if (item.notes) out.notes = item.notes.map((note) => prev.notes?.find((kept) => kept.text === note.text) ?? note)
		return out
	}
	return items.map((item): LL.NewItem => {
		if (item.type === 'single-list-item') {
			const prev = singles.get(item.layerId)?.shift()
			return prev ? merge(item, prev) : item
		}
		const prev = votes.get(voteKey(item.choices))?.shift()
		if (!prev) return item
		return {
			...item,
			choices: item.choices.map((choice, i) => ({ ...merge(choice, prev.choices[i]), source: prev.choices[i].source })),
		}
	})
}

function claimable<K, V>(map: Map<K, V[]>, key: K): V[] {
	let list = map.get(key)
	if (!list) map.set(key, (list = []))
	return list
}

function voteKey(choices: { layerId: L.LayerId }[]): string {
	return choices.map((choice) => choice.layerId).join('\n')
}
