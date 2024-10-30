import { Writable } from 'stream'

export class WritableBuffer extends Writable {
	private data: Buffer[] = []

	constructor(options?: any) {
		super(options)
		this.data = []
	}

	_write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.data.push(chunk)
		callback()
	}

	getBuffer(): Buffer {
		return Buffer.concat(this.data)
	}

	toString(encoding: BufferEncoding = 'utf8'): string {
		return this.getBuffer().toString(encoding)
	}
}
export default WritableBuffer
