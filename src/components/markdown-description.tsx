import React from 'react'
import Markdown from 'react-markdown'

import * as Typo from '@/components/typography'
import { cn } from '@/lib/utils'

export function MarkdownDescription({ description }: { description?: string | null }) {
	if (!description) return null
	description = description.trim()

	return (
		<div>
			<Markdown components={markdownComponents}>{description}</Markdown>
		</div>
	)
}

const markdownComponents = {
	h1: ({ ...props }: React.ComponentPropsWithoutRef<'h1'>) => <h1 {...props} className={cn('text-xl font-semibold mt-4 mb-2', Typo.H3)} />,
	h2: ({ ...props }: React.ComponentPropsWithoutRef<'h2'>) => <h2 {...props} className={cn('text-lg font-medium mt-3 mb-2', Typo.H3)} />,
	h3: ({ ...props }: React.ComponentPropsWithoutRef<'h3'>) => <h3 {...props} className={cn('text-lg font-medium mt-3 mb-2', Typo.H3)} />,
	h4: ({ ...props }: React.ComponentPropsWithoutRef<'h4'>) => <h4 {...props} className={cn('text-base font-medium mt-2 mb-1', Typo.H4)} />,
	p: ({ ...props }: React.ComponentPropsWithoutRef<'p'>) => <p {...props} className="py-2" />,
	ul: ({ ...props }: React.ComponentPropsWithoutRef<'ul'>) => <ul {...props} className="list-disc ps-6 py-2" />,
	ol: ({ ...props }: React.ComponentPropsWithoutRef<'ol'>) => <ol {...props} className="list-decimal ps-6 py-2" />,
	li: ({ ...props }: React.ComponentPropsWithoutRef<'li'>) => <li {...props} className="my-1" />,
	blockquote: ({ ...props }: React.ComponentPropsWithoutRef<'blockquote'>) => (
		<blockquote {...props} className={cn('border-s-4 border-line-soft py-2 ps-4 italic', Typo.Blockquote)} />
	),
	code: ({ inline, ...props }: React.ComponentPropsWithoutRef<'code'> & { inline?: boolean }) =>
		inline ? (
			<code {...props} className="rounded bg-panel-hi px-1 py-0.5 font-mono text-sm dark:bg-ground ltr-isolate" />
		) : (
			<code {...props} className="my-3 block overflow-x-auto rounded-md bg-panel-hi p-3 font-mono text-sm dark:bg-ground ltr-isolate" />
		),
	a: ({ ...props }: React.ComponentPropsWithoutRef<'a'>) => <a {...props} className={Typo.Link} />,
	hr: ({ ...props }: React.ComponentPropsWithoutRef<'hr'>) => <hr {...props} className="my-6 border-line-soft dark:border-gray-700" />,
	img: ({ ...props }: React.ComponentPropsWithoutRef<'img'>) => <img {...props} className="my-4 h-auto max-w-full rounded-md" />,
	table: ({ ...props }: React.ComponentPropsWithoutRef<'table'>) => (
		<div className="my-4 overflow-x-auto">
			<table {...props} className="min-w-full divide-y divide-gray-300 dark:divide-gray-700" />
		</div>
	),
	thead: ({ ...props }: React.ComponentPropsWithoutRef<'thead'>) => <thead {...props} className="bg-panel-hi dark:bg-ground" />,
	tbody: ({ ...props }: React.ComponentPropsWithoutRef<'tbody'>) => (
		<tbody {...props} className="divide-y divide-gray-200 dark:divide-gray-800" />
	),
	tr: ({ ...props }: React.ComponentPropsWithoutRef<'tr'>) => <tr {...props} className="hover:bg-panel-hi dark:hover:bg-ground" />,
	th: ({ ...props }: React.ComponentPropsWithoutRef<'th'>) => <th {...props} className="px-4 py-3 text-start text-sm font-semibold" />,
	td: ({ ...props }: React.ComponentPropsWithoutRef<'td'>) => <td {...props} className="px-4 py-3 text-sm" />,
}
