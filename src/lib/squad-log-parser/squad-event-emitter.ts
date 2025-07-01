import * as CS from '@/models/context-shared'
import * as SME from '@/models/squad-models.events'
import * as SM from '@/models/squad.models'
import * as C from '@/server/context'
import * as Otel from '@opentelemetry/api'
import * as Rx from 'rxjs'
import { SftpTail, SftpTailOptions } from '../sftp-tail'
import { assertNever } from '../type-guards'
import * as SLE from './squad-log-events.models'

type EventCtx = CS.Log

const tracer = Otel.trace.getTracer('squad-log-event-emitter')
type LogState = {
	roundWinner: SM.SquadOutcomeTeam | null
	roundLoser: SM.SquadOutcomeTeam | null
	roundEndState: {
		winner: string | null
		layer: string
	} | null
}

/**
 * Consolidates and emits events parsed from squad logs.
 */
export class SquadEventEmitter {
	reader: SftpTail
	event$: Rx.Subject<[EventCtx, SME.Event]> = new Rx.Subject()

	constructor(private ctx: CS.Log, options: { sftp: SftpTailOptions }) {
		this.ctx = ctx
		this.reader = new SftpTail(ctx, options.sftp)
	}

	// -------- Log state tracking & consolidation --------
	state: LogState = {
		roundWinner: null,
		roundLoser: null,
		roundEndState: null,
	}

	/**
	 * Performs state tracking and event consolidation for squad log events.
	 * @param ctx The context of the log event.
	 * @param logEvt The log event to process.
	 * @returns an event if one should be emitted
	 */
	squadLogEventToSquadEvent(ctx: CS.Log, logEvt: SLE.Event): SME.Event | undefined {
		switch (logEvt.type) {
			case 'ROUND_DECIDED': {
				const prop = logEvt.action === 'won' ? 'roundWinner' : 'roundLoser'
				this.state[prop] = {
					faction: logEvt.faction,
					unit: logEvt.unit,
					team: logEvt.team,
					tickets: logEvt.tickets,
				}
				break
			}

			// TODO: might be able to remove this case and backing code
			case 'ROUND_TEAM_OUTCOME': {
				this.state.roundEndState = {
					// ported from existing behavior from squadjs -- unsure why it exists though https://github.com/Tactrigsds/SquadJS/blob/psg/squad-server/log-parser/round-winner.js
					winner: this.state.roundEndState ? logEvt.winner : null,
					layer: logEvt.layer,
				}
				break
			}

			case 'ROUND_ENDED': {
				const event: SME.RoundEnded = {
					type: 'ROUND_ENDED',
					time: logEvt.time,
					loser: this.state.roundLoser,
					winner: this.state.roundWinner,
				}
				this.state.roundLoser = null
				this.state.roundWinner = null
				return event
			}

			case 'NEW_GAME': {
				if (logEvt.layerClassname === 'TransitionMap') return
				return logEvt satisfies SLE.NewGame
			}

			default:
				assertNever(logEvt)
		}
	}
	// -------- Log state tracking & consolidation end --------

	async connect() {
		this.reader.on(
			'line',
			C.spanOp('squad-log-event-emitter:on-line-parsed', { tracer, eventLogLevel: 'trace', root: true }, async (line: string) => {
				const ctx = C.pushOtelCtx(this.ctx)
				for (const matcher of SLE.EventMatchers) {
					try {
						const match = line.match(matcher.regex)
						if (!match) continue
						const parsedRes = matcher.schema.safeParse(matcher.onMatch(match))
						if (!parsedRes.success) {
							C.recordGenericError('Failed to parse log line: ' + parsedRes.error.message)
							continue
						}
						ctx.log.debug(parsedRes.data, 'parsed log line into log event %s', parsedRes.data.type)
						const event = this.squadLogEventToSquadEvent(ctx, parsedRes.data)
						if (event) {
							ctx.log.info(event, 'Emitting Squad Event: %s', event.type)
							this.event$.next([this.ctx, event])
						}
						return { code: 'ok' as const }
					} catch (error) {
						C.recordGenericError(error)
					}
				}
			}),
		)
		await this.reader.watch()
	}

	async disconnect() {
		await this.reader.disconnect()
	}
}
