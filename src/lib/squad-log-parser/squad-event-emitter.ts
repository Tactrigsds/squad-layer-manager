import type * as CS from '@/models/context-shared'
import * as SM from '@/models/squad.models'
import * as C from '@/server/context'
import * as Otel from '@opentelemetry/api'
import * as Rx from 'rxjs'
import { matchLog } from '../log-parsing'
import type { SftpTailOptions } from '../sftp-tail'
import { SftpTail } from '../sftp-tail'
import { assertNever } from '../type-guards'

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
	event$: Rx.Subject<[EventCtx, SM.Events.Event]> = new Rx.Subject()

	constructor(private ctx: CS.Log, options: { sftp: SftpTailOptions }) {
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
	squadLogEventToSquadEvent(ctx: CS.Log, logEvt: SM.LogEvents.Event): SM.Events.Event | undefined {
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
				const event: SM.Events.RoundEnded = {
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
				return logEvt satisfies SM.LogEvents.NewGame
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
				for (const matcher of SM.LogEvents.EventMatchers) {
					try {
						const [matched, error] = matchLog(line, matcher)
						if (!matched) continue
						if (error) {
							return {
								code: 'err:failed-to-parse-log-line' as const,
								error,
							}
						}
						const event = this.squadLogEventToSquadEvent(ctx, matched)
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
		this.reader.watch()
	}

	async disconnect() {
		this.event$.complete()
		await this.reader.disconnect()
	}
}
