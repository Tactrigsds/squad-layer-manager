export const FilterNodeSchema: z.ZodType<FilterNode> = BaseFilterNodeSchema.extend({
	children: z.lazy(() => FilterNodeSchema.array().optional()),
})
	.refine((node) => node.type !== 'comp' || node.comp !== undefined, { message: 'comp must be defined for type "comp"' })
	.refine((node) => node.type !== 'comp' || node.children === undefined, { message: 'children must not be defined for type "comp"' })
	.refine((node) => !['and', 'or'].includes(node.type) || (node.children && node.children.length > 0), {
		message: 'children must be defined for type "and" or "or"',
	})
