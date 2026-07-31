import { describe, expect, it } from 'vitest'

import * as Templating from '@/lib/templating'

describe('renderTemplate', () => {
	it('substitutes variables without HTML-escaping', () => {
		expect(Templating.renderTemplate('See {{discord}} & more', { discord: 'discord.gg/x' })).toBe('See discord.gg/x & more')
	})

	it('renders unknown variables as empty', () => {
		expect(Templating.renderTemplate('a{{missing}}b', {})).toBe('ab')
	})

	it('falls back to the raw string on a malformed template', () => {
		const bad = 'hello {{#unclosed}}'
		expect(Templating.renderTemplate(bad, {})).toBe(bad)
	})
})

describe('templateVarCycles', () => {
	const names = (defs: Templating.TemplateVarDef[]) => Templating.templateVarCycles(defs).map((c) => [...new Set(c)].sort())

	it('reports nothing for definitions that do not reference each other', () => {
		expect(
			Templating.templateVarCycles([
				{ name: 'a', value: 'x' },
				{ name: 'b', value: 'y {{a}}' },
			]),
		).toEqual([])
	})

	it('reports nothing for a diamond, which is acyclic', () => {
		const defs = [
			{ name: 'a', value: '{{b}} {{c}}' },
			{ name: 'b', value: '{{d}}' },
			{ name: 'c', value: '{{d}}' },
			{ name: 'd', value: 'leaf' },
		]
		expect(Templating.templateVarCycles(defs)).toEqual([])
	})

	it('reports a self-reference', () => {
		expect(names([{ name: 'a', value: 'loop {{a}}' }])).toEqual([['a']])
	})

	it('reports a mutual reference once, not once per entry point', () => {
		expect(
			names([
				{ name: 'a', value: '{{b}}' },
				{ name: 'b', value: '{{a}}' },
			]),
		).toEqual([['a', 'b']])
	})

	it('reports a cycle reached through a section reference', () => {
		expect(
			names([
				{ name: 'a', value: '{{#b}}x{{/b}}' },
				{ name: 'b', value: '{{a}}' },
			]),
		).toEqual([['a', 'b']])
	})

	it('ignores references to names outside the set', () => {
		expect(Templating.templateVarCycles([{ name: 'a', value: '{{duration}} {{label}}' }])).toEqual([])
	})

	it('ignores a malformed value, which never renders', () => {
		expect(Templating.templateVarCycles([{ name: 'a', value: '{{#a}}' }])).toEqual([])
	})

	it('reports two independent cycles separately', () => {
		const defs = [
			{ name: 'a', value: '{{b}}' },
			{ name: 'b', value: '{{a}}' },
			{ name: 'c', value: '{{d}}' },
			{ name: 'd', value: '{{c}}' },
		]
		expect(names(defs)).toEqual([
			['a', 'b'],
			['c', 'd'],
		])
	})
})

describe('resolveTemplateVars', () => {
	it('expands a reference to another variable', () => {
		const defs = [
			{ name: 'discord', value: 'discord.gg/x' },
			{ name: 'appeal', value: 'Appeal at {{discord}}' },
		]
		expect(Templating.resolveTemplateVars(defs)).toEqual({ discord: 'discord.gg/x', appeal: 'Appeal at discord.gg/x' })
	})

	it('expands transitively regardless of declaration order', () => {
		const defs = [
			{ name: 'a', value: '[{{b}}]' },
			{ name: 'b', value: '<{{c}}>' },
			{ name: 'c', value: 'leaf' },
		]
		expect(Templating.resolveTemplateVars(defs).a).toBe('[<leaf>]')
	})

	it('expands sections against the resolved value', () => {
		const defs = [
			{ name: 'note', value: '' },
			{ name: 'msg', value: 'hi{{#note}} ({{note}}){{/note}}' },
		]
		expect(Templating.resolveTemplateVars(defs).msg).toBe('hi')
		expect(Templating.resolveTemplateVars([{ name: 'note', value: 'x' }, defs[1]]).msg).toBe('hi (x)')
	})

	it('makes base values available to variables and passes them through', () => {
		const defs = [{ name: 'msg', value: 'banned for {{duration}}' }]
		expect(Templating.resolveTemplateVars(defs, { duration: '5m' })).toEqual({ msg: 'banned for 5m', duration: '5m' })
	})

	it('lets base win over a variable of the same name, at every depth', () => {
		const defs = [
			{ name: 'label', value: 'configured' },
			{ name: 'msg', value: 'got {{label}}' },
		]
		expect(Templating.resolveTemplateVars(defs, { label: 'per-call' })).toEqual({ label: 'per-call', msg: 'got per-call' })
	})

	it('does not re-render what a base value interpolates', () => {
		const defs = [
			{ name: 'discord', value: 'discord.gg/x' },
			{ name: 'msg', value: '{{name}} banned' },
		]
		expect(Templating.resolveTemplateVars(defs, { name: '{{discord}}' }).msg).toBe('{{discord}} banned')
	})

	it('terminates on a cycle instead of hanging', () => {
		const defs = [
			{ name: 'a', value: 'A{{b}}' },
			{ name: 'b', value: 'B{{a}}' },
		]
		const resolved = Templating.resolveTemplateVars(defs)
		expect(Object.keys(resolved).sort()).toEqual(['a', 'b'])
	})
})
