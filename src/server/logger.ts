import pino from 'pino'

const logger = pino({
	level: 'info',
	timestamp: pino.stdTimeFunctions.isoTime,
	transport: {
		targets: [
			// {
			// 	target: 'pino/file',
			// 	options: { destination: path.join(__dirname, 'query.log') },
			// },
			{
				target: 'pino-pretty',
				options: { colorize: true },
			},
		],
	},
})

export default logger
