/**
 * The ways a VISCA message can reach a camera.
 *
 * - `sony-udp`: Sony's VISCA over IP. UDP, port 52381, every message wrapped in an 8-byte header
 *   carrying a payload type and sequence number. Sony SRG/BRC/FR7, and the many cameras that copy
 *   Sony's scheme (BirdDog, Lumens, Canon CR-N, Marshall and others).
 * - `udp`: bare VISCA in UDP datagrams, no header. PTZOptics (port 1259), AVer and most generic
 *   cameras.
 * - `tcp`: bare VISCA over a TCP stream. PTZOptics (port 5678) and many generic cameras.
 * - `serial`: bare VISCA over RS-232/RS-422, through a USB adapter. Up to 7 cameras on a daisy
 *   chain, told apart by address.
 *
 * `canon` isn't VISCA at all but Canon's XC protocol over HTTP; see canon/xc.ts.
 * `hikvision` is Hikvision's ISAPI, XML over HTTP; see hikvision/isapi.ts.
 * `panasonic` is Panasonic's AW protocol over HTTP; see panasonic/aw.ts.
 * `hanwha` is Hanwha's SUNAPI, query strings over HTTP; see hanwha/sunapi.ts.
 * `onvif` is ONVIF PTZ over SOAP and HTTP; see onvif/link.ts.
 * `kxwell-serial` and `kxwell-tcp` are KXWell's level 1 protocol, ASCII over the serial and TCP
 *   transports here; see kxwell/link.ts.
 */
import { EventEmitter } from 'node:events'
import dgram from 'node:dgram'
import net from 'node:net'
import { SerialPort } from 'serialport'
import { parseReply, ViscaStreamSplitter, type ViscaReply } from './replies.js'

export type ViscaTransportKind = 'sony-udp' | 'udp' | 'tcp' | 'serial'
export type TransportKind =
	ViscaTransportKind | 'canon' | 'hikvision' | 'panasonic' | 'hanwha' | 'onvif' | 'kxwell-serial' | 'kxwell-tcp'
export type Protocol = 'visca' | 'canon' | 'hikvision' | 'panasonic' | 'hanwha' | 'onvif' | 'kxwell'

export interface KindInfo {
	protocol: Protocol
	/** Takes a user name and password */
	login: boolean
	/** Reached through a serial port rather than an IP address and port */
	serial: boolean
	/** The highest address a camera can be given; 1 where the address is fixed */
	maxAddress: number
	/** The send interval a new camera starts with, in ms */
	sendInterval: number
}

/** What sets each kind of camera apart. Each new protocol adds its kinds here. */
export const KINDS: Record<TransportKind, KindInfo> = {
	'sony-udp': { protocol: 'visca', login: false, serial: false, maxAddress: 1, sendInterval: 20 },
	udp: { protocol: 'visca', login: false, serial: false, maxAddress: 1, sendInterval: 20 },
	tcp: { protocol: 'visca', login: false, serial: false, maxAddress: 1, sendInterval: 20 },
	// Serial is slow. Up to 7 cameras on a daisy chain.
	serial: { protocol: 'visca', login: false, serial: true, maxAddress: 7, sendInterval: 50 },
	// Each message is an HTTP request
	canon: { protocol: 'canon', login: true, serial: false, maxAddress: 1, sendInterval: 50 },
	// HTTP too, with more room than Canon: ISAPI has a "Device Busy" answer for requests it can't keep up with
	hikvision: { protocol: 'hikvision', login: true, serial: false, maxAddress: 1, sendInterval: 100 },
	// Panasonic asks for 130 ms between commands on its older models
	panasonic: { protocol: 'panasonic', login: true, serial: false, maxAddress: 1, sendInterval: 130 },
	// Each move is an HTTP request, as for Hikvision
	hanwha: { protocol: 'hanwha', login: true, serial: false, maxAddress: 1, sendInterval: 100 },
	// SOAP requests are heavier, and slow cameras stutter under a flood of moves
	onvif: { protocol: 'onvif', login: true, serial: false, maxAddress: 1, sendInterval: 100 },
	// A KXWell control panel relays to the heads it addresses, 01-FF, over IP as well as serial
	'kxwell-serial': { protocol: 'kxwell', login: false, serial: true, maxAddress: 255, sendInterval: 50 },
	'kxwell-tcp': { protocol: 'kxwell', login: false, serial: false, maxAddress: 255, sendInterval: 50 },
}

export function protocolOf(kind: TransportKind): Protocol {
	return KINDS[kind].protocol
}

export interface TransportConfig {
	kind: TransportKind
	host: string
	port: number
	serialPath: string
	baudRate: number
}

/** 0 for kinds reached through a serial port */
export const DEFAULT_PORTS: Record<TransportKind, number> = {
	'sony-udp': 52381,
	udp: 1259,
	tcp: 5678,
	canon: 80,
	hikvision: 80,
	panasonic: 80,
	hanwha: 80,
	onvif: 80,
	// KXWell doesn't document one; 23 is the usual raw TCP port on serial-over-IP panels
	'kxwell-tcp': 23,
	serial: 0,
	'kxwell-serial': 0,
}

export type MessageKind = 'command' | 'inquiry'

export interface TransportEvents {
	reply: [ViscaReply]
	/** Connected means the link is up, not that a camera has answered on it */
	status: [connected: boolean, error?: string]
}

export abstract class ViscaTransport extends EventEmitter<TransportEvents> {
	abstract open(): void
	abstract close(): Promise<void>
	abstract send(message: Buffer, kind: MessageKind): void

	protected handleMessage(message: Buffer): void {
		this.emit('reply', parseReply(message))
	}
}

export function createTransport(
	config: TransportConfig & { kind: ViscaTransportKind; address: number },
): ViscaTransport {
	switch (config.kind) {
		case 'sony-udp':
			return new SonyUdpTransport(config.host, config.port || DEFAULT_PORTS['sony-udp'])
		case 'udp':
			return new UdpTransport(config.host, config.port || DEFAULT_PORTS.udp)
		case 'tcp':
			return new TcpTransport(config.host, config.port || DEFAULT_PORTS.tcp)
		case 'serial':
			return new SerialTransport(config.serialPath, config.baudRate || 9600, config.address)
	}
}

// --- Sony VISCA over IP ------------------------------------------------------

const PAYLOAD_COMMAND = 0x0100
const PAYLOAD_INQUIRY = 0x0110
const PAYLOAD_REPLY = 0x0111
const PAYLOAD_CONTROL = 0x0200
const PAYLOAD_CONTROL_REPLY = 0x0201

const HEADER_LENGTH = 8
/** Control payload asking the camera to reset its expected sequence number */
const CONTROL_RESET = Buffer.from([0x01])
/** Control reply meaning the sequence number was not what the camera expected */
const CONTROL_ERROR = 0x0f

export function sonyHeader(payloadType: number, payload: Buffer, seq: number): Buffer {
	const header = Buffer.alloc(HEADER_LENGTH)
	header.writeUInt16BE(payloadType, 0)
	header.writeUInt16BE(payload.length, 2)
	header.writeUInt32BE(seq >>> 0, 4)
	return Buffer.concat([header, payload])
}

/** A UDP socket as a transport sees it: send to its camera, and receive that camera's datagrams */
interface UdpEndpoint {
	send(data: Buffer, port: number, host: string, callback: (error: Error | null) => void): void
	close(): Promise<void>
}

interface EndpointHandlers {
	onMessage: (data: Buffer) => void
	onReady: (warning?: string) => void
	onError: (message: string) => void
}

/** A socket of the transport's own on a random local port. Replies come back to the port that sent. */
function openPrivateEndpoint(host: string, handlers: EndpointHandlers): UdpEndpoint {
	const socket = dgram.createSocket('udp4')
	socket.on('message', (data, rinfo) => {
		if (rinfo.address === host) handlers.onMessage(data)
	})
	socket.on('error', (e) => handlers.onError(e.message))
	socket.bind(0, () => handlers.onReady())
	return {
		send: (data, port, target, callback) => socket.send(data, port, target, callback),
		close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
	}
}

/**
 * Sony cameras reply to port 52381 on the controller, whatever port the command came from, so
 * every Sony camera shares one socket bound there, and replies are routed by the camera's address.
 *
 * If something else already holds 52381 (another controller app, say), the socket falls back to a
 * random port: commands still work, but replies from cameras that insist on 52381 are lost.
 */
const SONY_LOCAL_PORT = 52381

class SharedSonySocket {
	static #instance: SharedSonySocket | undefined

	static acquire(host: string, handlers: EndpointHandlers): UdpEndpoint {
		const shared = (SharedSonySocket.#instance ??= new SharedSonySocket())
		return shared.#add(host, handlers)
	}

	#socket: dgram.Socket
	#ready = false
	#warning: string | undefined
	readonly #routes = new Map<string, Set<EndpointHandlers>>()

	private constructor() {
		this.#socket = this.#bind(SONY_LOCAL_PORT)
	}

	#bind(port: number): dgram.Socket {
		const socket = dgram.createSocket('udp4')
		socket.on('message', (data, rinfo) => {
			for (const handlers of this.#routes.get(rinfo.address) ?? []) handlers.onMessage(data)
		})
		socket.on('error', (e: NodeJS.ErrnoException) => {
			if (!this.#ready && e.code === 'EADDRINUSE' && port !== 0) {
				socket.close()
				this.#warning = `Port ${SONY_LOCAL_PORT} is in use by another program, so camera replies can't be received`
				this.#socket = this.#bind(0)
				return
			}
			for (const set of this.#routes.values()) for (const handlers of set) handlers.onError(e.message)
		})
		socket.bind(port, () => {
			this.#ready = true
			for (const set of this.#routes.values()) for (const handlers of set) handlers.onReady(this.#warning)
		})
		return socket
	}

	#add(host: string, handlers: EndpointHandlers): UdpEndpoint {
		let set = this.#routes.get(host)
		if (!set) this.#routes.set(host, (set = new Set()))
		set.add(handlers)
		if (this.#ready) queueMicrotask(() => handlers.onReady(this.#warning))

		return {
			send: (data, port, target, callback) => this.#socket.send(data, port, target, callback),
			close: async () => {
				set.delete(handlers)
				if (set.size === 0) this.#routes.delete(host)
				if (this.#routes.size === 0) await this.#close()
			},
		}
	}

	async #close(): Promise<void> {
		if (SharedSonySocket.#instance === this) SharedSonySocket.#instance = undefined
		await new Promise<void>((resolve) => this.#socket.close(() => resolve()))
	}
}

class UdpTransport extends ViscaTransport {
	protected endpoint: UdpEndpoint | undefined

	constructor(
		protected readonly host: string,
		protected readonly port: number,
	) {
		super()
	}

	open(): void {
		if (this.endpoint) return

		this.endpoint = this.openEndpoint({
			onMessage: (data) => this.handleDatagram(data),
			onReady: (warning) => {
				this.emit('status', true, warning)
				this.onOpen()
			},
			onError: (message) => this.emit('status', false, message),
		})
	}

	protected openEndpoint(handlers: EndpointHandlers): UdpEndpoint {
		return openPrivateEndpoint(this.host, handlers)
	}

	protected onOpen(): void {
		// Nothing to set up for bare VISCA
	}

	protected handleDatagram(data: Buffer): void {
		// A datagram can carry more than one reply
		for (const message of new ViscaStreamSplitter().push(data)) this.handleMessage(message)
	}

	protected sendRaw(data: Buffer): void {
		this.endpoint?.send(data, this.port, this.host, (e) => {
			if (e) this.emit('status', false, e.message)
		})
	}

	send(message: Buffer, _kind: MessageKind): void {
		this.sendRaw(message)
	}

	async close(): Promise<void> {
		const endpoint = this.endpoint
		this.endpoint = undefined
		if (!endpoint) return
		await endpoint.close()
		this.emit('status', false)
	}
}

class SonyUdpTransport extends UdpTransport {
	#seq = 0

	protected override openEndpoint(handlers: EndpointHandlers): UdpEndpoint {
		return SharedSonySocket.acquire(this.host, handlers)
	}

	protected override onOpen(): void {
		this.#reset()
	}

	#reset(): void {
		this.sendRaw(sonyHeader(PAYLOAD_CONTROL, CONTROL_RESET, 0))
		this.#seq = 0
	}

	protected override handleDatagram(data: Buffer): void {
		let offset = 0
		while (offset + HEADER_LENGTH <= data.length) {
			const type = data.readUInt16BE(offset)
			const length = data.readUInt16BE(offset + 2)
			const payload = data.subarray(offset + HEADER_LENGTH, offset + HEADER_LENGTH + length)
			offset += HEADER_LENGTH + length

			if (type === PAYLOAD_REPLY) {
				this.handleMessage(payload)
			} else if ((type === PAYLOAD_CONTROL_REPLY || type === PAYLOAD_CONTROL) && payload[0] === CONTROL_ERROR) {
				// Out of step with the camera, typically because it rebooted. Start again from 0.
				// Sony documents this as a control reply (0x0201); some cameras send it as 0x0200.
				this.#reset()
			} else if (type === PAYLOAD_CONTROL_REPLY || type === PAYLOAD_CONTROL) {
				// Acknowledges our reset. Counts as a sign of life, like any reply.
				this.emit('reply', { kind: 'ack', address: 1, socket: 0 })
			}
		}
	}

	override send(message: Buffer, kind: MessageKind): void {
		this.#seq = (this.#seq + 1) >>> 0
		this.sendRaw(sonyHeader(kind === 'inquiry' ? PAYLOAD_INQUIRY : PAYLOAD_COMMAND, message, this.#seq))
	}
}

// --- TCP ---------------------------------------------------------------------

const TCP_RECONNECT_DELAY = 2000

class TcpTransport extends ViscaTransport {
	#socket: net.Socket | undefined
	#connected = false
	#closed = false
	#reconnect: ReturnType<typeof setTimeout> | undefined
	readonly #splitter = new ViscaStreamSplitter()

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {
		super()
	}

	open(): void {
		this.#closed = false
		this.#connect()
	}

	#connect(): void {
		if (this.#socket || this.#closed) return

		const socket = net.createConnection({ host: this.host, port: this.port })
		socket.setNoDelay(true)
		this.#socket = socket

		socket.on('connect', () => {
			this.#connected = true
			this.emit('status', true)
		})
		socket.on('data', (data) => {
			for (const message of this.#splitter.push(data)) this.handleMessage(message)
		})
		socket.on('error', (e) => this.emit('status', false, e.message))
		socket.on('close', () => {
			this.#socket = undefined
			if (this.#connected) this.emit('status', false)
			this.#connected = false
			if (!this.#closed) this.#reconnect = setTimeout(() => this.#connect(), TCP_RECONNECT_DELAY)
		})
	}

	send(message: Buffer, _kind: MessageKind): void {
		// While disconnected, drop rather than queue: a movement sent late is worse than none
		if (this.#connected) this.#socket?.write(message)
	}

	async close(): Promise<void> {
		this.#closed = true
		clearTimeout(this.#reconnect)
		const socket = this.#socket
		this.#socket = undefined
		if (!socket) return
		await new Promise<void>((resolve) => socket.end(() => resolve()))
		socket.destroy()
	}
}

// --- Serial ------------------------------------------------------------------

const SERIAL_RETRY_DELAY = 2000

/**
 * The serial binding that opening a port goes through. Left undefined so SerialPort falls back to
 * its own auto-detected native binding; The test suite overrides this with an in-memory mock.
 */
let serialBinding: unknown

export function setSerialBinding(binding: unknown): void {
	serialBinding = binding
}

/**
 * The interface returned to a camera when it joins a shared port: send to write that camera's
 * bytes onto the line, close to leave the chain (closing the real port once the last camera leaves).
 */
interface SerialEndpoint {
	send(data: Buffer): void
	close(): Promise<void>
}

/**
 * The interface a camera supplies when it joins a shared port: its address, so replies can be
 * routed to it, and the callbacks the shared port invokes to deliver that camera's replies and
 * connection state.
 */
interface SerialHandlers {
	address: number
	onMessage: (reply: ViscaReply) => void
	onStatus: (connected: boolean, error?: string) => void
}

/**
 * Up to 7 cameras share one RS-232/RS-422 line, told apart by address. The OS device opens only
 * once, so every camera on a path shares one real SerialPort, keyed by path and baud rate. Writes
 * multiplex onto it; inbound bytes are framed and parsed once, and each reply is routed to the
 * camera whose address matches (replies for an address no camera holds are dropped). Open, retry
 * and close are refcounted: the port opens with the first camera and closes with the last.
 */
class SharedSerialPort {
	static readonly #instances = new Map<string, SharedSerialPort>()
	/** The still-running teardown of a just-closed instance, so its replacement waits for the handle */
	static readonly #closings = new Map<string, Promise<void>>()

	static acquire(path: string, baudRate: number, handlers: SerialHandlers): SerialEndpoint {
		const key = `${path}|${baudRate}`
		let shared = SharedSerialPort.#instances.get(key)
		if (!shared) {
			shared = new SharedSerialPort(key, path, baudRate)
			// If the previous instance for this key is still closing, open only once the OS releases
			// the handle, so we don't race a 'busy' error against a device the kernel still holds
			shared.#closing = SharedSerialPort.#closings.get(key)
			SharedSerialPort.#instances.set(key, shared)
		}
		return shared.#add(handlers)
	}

	#port: SerialPort | undefined
	#opening = false
	/** The port whose open() is outstanding, so #close can tell a real in-flight open apart */
	#pendingOpen: SerialPort | undefined
	#retry: ReturnType<typeof setTimeout> | undefined
	/** Teardown of the previous instance, so a re-acquire waits for the OS handle to be released */
	#closing: Promise<void> | undefined
	/** Resolves the teardown once a close-during-open has shut the orphaned port down */
	#resolveOpenClose: (() => void) | undefined
	readonly #splitter = new ViscaStreamSplitter()
	/** Routes keyed by camera address; several cameras could share one in a misconfiguration */
	readonly #routes = new Map<number, Set<SerialHandlers>>()

	private constructor(
		private readonly key: string,
		private readonly path: string,
		private readonly baudRate: number,
	) {}

	#eachHandler(fn: (handlers: SerialHandlers) => void): void {
		for (const set of this.#routes.values()) for (const handlers of set) fn(handlers)
	}

	#openPort(): void {
		// #opening guards against a second camera racing open a duplicate port while the first is pending
		if (this.#port || this.#opening || this.#routes.size === 0) return
		if (!this.path) {
			this.#eachHandler((h) => h.onStatus(false, 'No serial port selected'))
			return
		}
		this.#opening = true

		// A prior instance for this key may still be releasing the OS handle; wait it out first
		if (this.#closing) {
			const closing = this.#closing
			this.#closing = undefined
			closing.then(() => {
				this.#opening = false
				// Every camera left during the wait: settle the #close awaiting us so its #closings drains
				if (this.#routes.size === 0) {
					const done = this.#resolveOpenClose
					this.#resolveOpenClose = undefined
					done?.()
					return
				}
				this.#openPort()
			})
			return
		}

		const options = { path: this.path, baudRate: this.baudRate, autoOpen: false }
		// The binding option exists on the underlying stream but is hidden by SerialPort's type, so cast
		const port = new SerialPort(
			(serialBinding ? { ...options, binding: serialBinding } : options) as ConstructorParameters<typeof SerialPort>[0],
		)
		// Mark the real open outstanding, so #close can tell it from the #closing-wait branch above
		this.#pendingOpen = port
		port.on('data', (data: Buffer) => {
			for (const message of this.#splitter.push(data)) {
				const reply = parseReply(message)
				const address = 'address' in reply ? reply.address : undefined
				if (address === undefined) {
					// Unaddressable: can't attribute it on a multi-camera chain, so drop it; but hand it to
					// a lone camera, which saw every reply back when it owned its own port
					if (this.#routes.size === 1) for (const set of this.#routes.values()) for (const h of set) h.onMessage(reply)
					continue
				}
				for (const handlers of this.#routes.get(address) ?? []) handlers.onMessage(reply)
			}
		})
		port.on('close', () => {
			this.#port = undefined
			this.#eachHandler((h) => h.onStatus(false))
			this.#scheduleRetry()
		})
		port.open((e) => {
			this.#opening = false
			this.#pendingOpen = undefined
			// A close that landed mid-open is waiting on this resolver; the open is over either way
			if (this.#resolveOpenClose) {
				const done = this.#resolveOpenClose
				this.#resolveOpenClose = undefined
				if (!e && port.isOpen) port.close(() => done())
				else done()
				return
			}
			if (e) {
				this.#eachHandler((h) => h.onStatus(false, e.message))
				this.#scheduleRetry()
				return
			}
			// Chain emptied without a close awaiting us: close the orphan rather than re-lock the path
			if (this.#routes.size === 0) {
				port.close(() => {})
				return
			}
			this.#port = port
			this.#eachHandler((h) => h.onStatus(true))
		})
	}

	#scheduleRetry(): void {
		if (this.#routes.size === 0) return
		clearTimeout(this.#retry)
		this.#retry = setTimeout(() => this.#openPort(), SERIAL_RETRY_DELAY)
	}

	#add(handlers: SerialHandlers): SerialEndpoint {
		let set = this.#routes.get(handlers.address)
		if (!set) this.#routes.set(handlers.address, (set = new Set()))
		set.add(handlers)
		// The first camera opens the port; later ones learn its state from the next status change
		this.#openPort()
		// A late joiner is told the port is already up on the next tick - but only if it is still
		// here and still open by then, so a close in that gap doesn't fire a stale connected=true
		if (this.#port?.isOpen)
			queueMicrotask(() => {
				if (set.has(handlers) && this.#port?.isOpen) handlers.onStatus(true)
			})

		return {
			send: (data) => this.#port?.write(data),
			close: async () => {
				set.delete(handlers)
				if (set.size === 0) this.#routes.delete(handlers.address)
				if (this.#routes.size === 0) await this.#close()
			},
		}
	}

	async #close(): Promise<void> {
		clearTimeout(this.#retry)
		// #pendingOpen, not #opening: the #closing-wait branch sets #opening but holds no handle
		const openInFlight = this.#pendingOpen !== undefined
		this.#opening = false
		if (SharedSerialPort.#instances.get(this.key) === this) SharedSerialPort.#instances.delete(this.key)

		// Build a teardown a re-acquire of this key waits on: close an open port now; let an in-flight
		// open's callback close the orphan via a resolver; otherwise this instance holds no handle
		const port = this.#port
		this.#port = undefined
		let teardown: Promise<void>
		if (port?.isOpen) {
			teardown = new Promise<void>((resolve) => port.close(() => resolve()))
		} else if (openInFlight) {
			teardown = new Promise<void>((resolve) => (this.#resolveOpenClose = resolve))
		} else {
			teardown = Promise.resolve()
		}

		SharedSerialPort.#closings.set(this.key, teardown)
		try {
			await teardown
		} finally {
			if (SharedSerialPort.#closings.get(this.key) === teardown) SharedSerialPort.#closings.delete(this.key)
		}
	}
}

class SerialTransport extends ViscaTransport {
	#endpoint: SerialEndpoint | undefined

	constructor(
		private readonly path: string,
		private readonly baudRate: number,
		private readonly address: number,
	) {
		super()
	}

	open(): void {
		if (this.#endpoint) return
		// The shared layer parses each reply once, so forward it rather than parse again
		this.#endpoint = SharedSerialPort.acquire(this.path, this.baudRate, {
			address: this.address,
			onMessage: (reply) => this.emit('reply', reply),
			onStatus: (connected, error) => this.emit('status', connected, error),
		})
	}

	send(message: Buffer, _kind: MessageKind): void {
		this.#endpoint?.send(message)
	}

	async close(): Promise<void> {
		const endpoint = this.#endpoint
		this.#endpoint = undefined
		if (!endpoint) return
		await endpoint.close()
	}
}
