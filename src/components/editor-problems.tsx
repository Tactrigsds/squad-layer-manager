import * as Icons from 'lucide-react'
import type React from 'react'

import * as Typo from '@/components/typography'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import type * as EP from '@/models/editor-problems.models'
import * as EditorProblemsClient from '@/systems/editor-problems.client'
import { tr } from '@/systems/messages.client'

// The problems a text editor found in its text, one row each. Selecting a row puts the cursor on its problem.
// `children` are `otherCount` further rows, as <li> elements, for problems that are not about a place in the text.
export default function EditorProblems(props: {
	problems: readonly EP.Problem[]
	onSelect: (problem: EP.Problem) => void
	className?: string
	children?: React.ReactNode
	otherCount?: number
}) {
	const count = props.problems.length + (props.otherCount ?? 0)
	const heading = tr.text(UI_Msgs.problemsHeading(count))
	const empty = count === 0
	return (
		<section aria-label={heading} className={cn('flex min-h-0 flex-col rounded-md border bg-muted/30', props.className)}>
			<header className="flex items-center gap-2 border-b px-2 py-1">
				<h3 className={Typo.Small}>{heading}</h3>
				<span className="flex-1" />
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={tr.text(UI_Msgs.copyProblems())}
					title={tr.text(UI_Msgs.copyProblems())}
					disabled={props.problems.length === 0}
					onClick={() => void EditorProblemsClient.Actions.copy(props.problems)}
				>
					<Icons.Copy />
				</Button>
			</header>
			{empty ? (
				<p className="p-2 text-xs text-muted-foreground">{tr.text(UI_Msgs.noProblems())}</p>
			) : (
				<ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1 text-xs">
					{props.problems.map((problem) => (
						<li key={`${problem.from}:${problem.message}`}>
							<button
								type="button"
								className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-start hover:bg-muted"
								onClick={() => props.onSelect(problem)}
							>
								<Icons.CircleAlert className="h-3.5 w-3.5 shrink-0 self-center text-destructive" aria-hidden />
								<span className="shrink-0 font-mono text-muted-foreground">{tr.text(UI_Msgs.problemLine(problem.line))}</span>
								<span className="min-w-0 whitespace-pre-wrap break-words">{problem.message}</span>
							</button>
						</li>
					))}
					{props.children}
				</ul>
			)}
		</section>
	)
}
