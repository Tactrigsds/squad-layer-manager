// Feed rows as html strings: the templates are inert jsx, so "rendering" is a synchronous serialize with no
// fiber and no per-row lifecycle. The server runs this for history results, which travel to the client as
// html. The activity feed renders the same templates straight to dom instead (see static-render.ts), having
// no serialize step to pay for.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type * as CHAT from '@/models/chat.models'

import type * as RC from './render-context'
import { Row } from './rows'

/** One row as html, or '' when the event draws nothing. */
export function renderRow(ctx: RC.RenderCtx, event: CHAT.EventEnriched): string {
	return renderToStaticMarkup(createElement(Row, { ctx, event }))
}
