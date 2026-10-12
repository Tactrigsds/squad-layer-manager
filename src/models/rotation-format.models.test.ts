import { describe, expect, it } from 'vitest'

import * as LL from '@/models/layer-list.models'
import * as LTag from '@/models/layer-tags.models'
import * as L from '@/models/layer.models'
import * as RFMT from '@/models/rotation-format.models'

const A = L.DEFAULT_LAYER_ID
const B = L.swapFactionsInId(A)
const lineOf = (id: L.LayerId) => L.getLayerCommand(id, 'none').trim()
const EVENT = { id: LTag.createTagId('Event Night'), label: 'Event Night', description: '', color: '#3b82f6' }
const SOURCE: LL.Source = { type: 'unknown' }

function single(layerId: L.LayerId, extra?: Partial<LL.SingleItem>): LL.SingleItem {
	return { ...LL.createItem({ type: 'single-list-item', layerId }, SOURCE), ...extra }
}

const LIST: LL.List = [
	single(A, { notes: [{ id: 'note01', text: 'opening layer,\nkeep it light' }] }),
	single(B, { tags: [EVENT.id, LTag.fromRotationTagId('weekend')] }),
	LL.createVoteItem([single(A), single(B, { notes: [{ id: 'note02', text: 'only above 80' }] })], SOURCE, {
		displayProps: ['map', 'factions'],
		duration: 180_000,
	}),
]

describe('rotation exchange formats', () => {
	it('writes YAML that reads back as the same items, notes and tags', () => {
		const yaml = RFMT.toYaml(LIST, { notes: true, tags: true, configuredTags: [EVENT] })
		expect(yaml).toBe(
			[
				'# opening layer, keep it light',
				`- ${lineOf(A)}`,
				`- layer: ${lineOf(B)}`,
				'  tags: [Event Night]',
				'- vote:',
				`    - ${lineOf(A)}`,
				'    # only above 80',
				`    - ${lineOf(B)}`,
				'  display: [map, factions]',
				'  duration: 3m',
				'',
			].join('\n'),
		)

		const parsed = RFMT.parse(yaml)
		expect(parsed.format).toBe('yaml')
		expect(parsed.errors).toEqual([])
		expect(RFMT.layerLines(parsed).map((line) => line.code)).toEqual(['ok', 'ok', 'ok', 'ok'])
		expect(RFMT.noteCount(parsed)).toBe(2)
		const labels = RFMT.tagLabels(parsed, [EVENT])
		expect(labels).toEqual([{ label: 'Event Night', match: EVENT }])

		const items = RFMT.toNewItems(parsed, new Map([['event night', EVENT.id]]))
		expect(items.map((item) => item.layerId)).toEqual([A, B, A])
		const [first, second, vote] = items
		if (first.type !== 'single-list-item' || second.type !== 'single-list-item' || vote.type !== 'vote-list-item')
			throw new Error('types')
		expect(first.notes?.map((note) => note.text)).toEqual(['opening layer, keep it light'])
		expect(second.tags).toEqual([EVENT.id])
		expect(vote.choices.map((choice) => choice.layerId)).toEqual([A, B])
		expect(vote.choices[1].notes?.map((note) => note.text)).toEqual(['only above 80'])
		expect(vote.voteConfig).toEqual({ displayProps: ['map', 'factions'], duration: 180_000, source: { type: 'unknown' } })
	})

	it('leaves notes and tags out of YAML when asked to', () => {
		const yaml = RFMT.toYaml(LIST, { notes: false, tags: false, configuredTags: [EVENT] })
		expect(yaml).not.toContain('#')
		expect(yaml).not.toContain('tags')
	})

	it('writes a vote in plain text as a VOTE line over its indented choices, and reads it back', () => {
		const text = RFMT.toPlainText(LIST, { notes: true })
		expect(text).toBe(
			[
				'# opening layer, keep it light',
				lineOf(A),
				lineOf(B),
				'# VOTE: display map, factions; duration 3m',
				`  ${lineOf(A)}`,
				'  # only above 80',
				`  ${lineOf(B)}`,
				'',
			].join('\n'),
		)
		expect(RFMT.plainTextDroppedTags(LIST)).toBe(1)

		const parsed = RFMT.parse(`AdminSetNextLayer ${lineOf(B)}\n${text}${lineOf(A)}\n`)
		expect(parsed.format).toBe('text')
		expect(parsed.errors).toEqual([])
		const items = RFMT.toNewItems(parsed, new Map())
		expect(items.map((item) => item.type)).toEqual([
			'single-list-item',
			'single-list-item',
			'single-list-item',
			'vote-list-item',
			'single-list-item',
		])
		expect(items[1].type === 'single-list-item' && items[1].notes?.map((note) => note.text)).toEqual(['opening layer, keep it light'])
		const vote = items[3]
		if (vote.type !== 'vote-list-item') throw new Error('types')
		expect(vote.choices.map((choice) => choice.layerId)).toEqual([A, B])
		expect(vote.choices[1].notes?.map((note) => note.text)).toEqual(['only above 80'])
		expect(vote.voteConfig).toEqual({ displayProps: ['map', 'factions'], duration: 180_000, source: { type: 'unknown' } })
	})

	it('takes notes above a VOTE line as notes on the vote, and a bare VOTE line as the server defaults', () => {
		const parsed = RFMT.parse(['# closer', '# VOTE:', `  ${lineOf(A)}`, `  ${lineOf(B)}`].join('\n'))
		const [vote] = RFMT.toNewItems(parsed, new Map())
		if (vote.type !== 'vote-list-item') throw new Error('types')
		expect(vote.voteConfig).toBeUndefined()
		expect(vote.choices[0].notes?.map((note) => note.text)).toEqual(['closer'])
	})

	it('names a VOTE line it cannot read, and a vote with no choices', () => {
		const parsed = RFMT.parse(['# VOTE: show everything', `  ${lineOf(A)}`, '# VOTE: duration 2m', lineOf(B)].join('\n'))
		expect(parsed.errors.map((error) => [error.line, error.code])).toEqual([
			[1, 'err:bad-vote-header'],
			[3, 'err:bad-item'],
		])
	})

	it('detects YAML by its first item line, past any leading comments', () => {
		expect(RFMT.detectFormat(`# heading\n\n- ${lineOf(A)}`)).toBe('yaml')
		expect(RFMT.detectFormat(`# heading\n${lineOf(A)}`)).toBe('text')
		expect(RFMT.detectFormat('')).toBe('text')
	})

	it('names the line of each item it cannot read', () => {
		const parsed = RFMT.parse(`- ${lineOf(A)}\n- layer: 3\n- Nowhere_RAAS_v9 USA RGF\n- vote: []\n`)
		expect(parsed.errors.map((error) => [error.line, error.code])).toEqual([
			[2, 'err:bad-item'],
			[4, 'err:bad-item'],
		])
		expect(RFMT.layerLines(parsed).map((line) => [line.lineNumber, line.code])).toEqual([
			[1, 'ok'],
			[3, 'err:unparsable'],
		])

		const broken = RFMT.parse(`- ${lineOf(A)}\n- [unclosed\n`)
		expect(broken.errors).toHaveLength(1)
		expect(broken.errors[0].code).toBe('err:yaml')
	})

	it('drops a tag label the mapping leaves out', () => {
		const parsed = RFMT.parse(`- layer: ${lineOf(A)}\n  tags: [Rush Hour, event night]\n`)
		expect(RFMT.tagLabels(parsed, [EVENT]).map((label) => [label.label, label.match?.id])).toEqual([
			['Rush Hour', undefined],
			['event night', EVENT.id],
		])
		const [item] = RFMT.toNewItems(parsed, new Map([['event night', EVENT.id]]))
		expect(item.type === 'single-list-item' && item.tags).toEqual([EVENT.id])
	})
})
