import * as superjson from 'superjson'
import * as Discord from './systems/discord.ts'
import * as Fastify from './systems/fastify.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as MatchHistory from './systems/match-history.ts'
import * as Rbac from './systems/rbac.system.ts'
import * as Sessions from './systems/sessions.ts'
import * as SquadServer from './systems/squad-server'

const w = global as any
w.Discord = Discord
w.Fastify = Fastify
w.LayerQueue = LayerQueue
w.MatchHistory = MatchHistory
w.Rbac = Rbac
w.Sessions = Sessions
w.SquadServer = SquadServer
w.superjson = superjson

w.debug__setTicketOutcome = (team1: number, team2: number) => {
	SquadServer.state.debug__ticketOutcome = { team1, team2 }
}
console.log('-------- DEVELOPER CONSOLE LOADED --------')

debugger
