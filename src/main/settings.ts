import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
	DEFAULT_AXIS,
	MOTION_CHANNELS,
	type AxisMapping,
	type ButtonAction,
	type ButtonMapping,
	type Mapping,
	type MotionChannel,
} from './mapping.js'
import { DEFAULT_PROFILE, LIMIT_RANGES, PROFILES, type CameraConfig } from './visca/camera.js'
import { DEFAULT_PORTS, KINDS, protocolOf, type TransportKind } from './visca/transports.js'
import type { ControllerKind } from './controllers/types.js'

/** Everything remembered about one physical controller, connected or not */
export interface ControllerSettings {
	id: string
	kind: ControllerKind
	/** As the controller last named itself, for showing it while disconnected */
	name: string
	/** The camera it drives, if any */
	cameraId: string | undefined
	axes: Mapping
	buttons: ButtonMapping
}

export interface ApiSettings {
	enabled: boolean
	port: number
	/** Listen on every network interface, not just this computer */
	allowRemote: boolean
}

export const DEFAULT_API: ApiSettings = { enabled: true, port: 8765, allowRemote: false }

export interface Settings {
	/** The WebSocket API, for Companion and other remote control */
	api: ApiSettings
	cameras: CameraConfig[]
	/** The camera the window is showing, and the one on-screen presets act on */
	activeCameraId: string | undefined
	controllers: ControllerSettings[]
	/**
	 * Stick assignments from before controllers were set up one by one. The first DJI controller
	 * to connect takes them over.
	 */
	legacyDjiMapping: Mapping | undefined
}

const TRANSPORTS = Object.keys(KINDS) as TransportKind[]
const DJI_AXIS_IDS = ['leftX', 'leftY', 'rightX', 'rightY', 'wheel']

export function newCamera(partial: Partial<CameraConfig> = {}): CameraConfig {
	const kind = partial.kind ?? 'sony-udp'
	const profile = DEFAULT_PROFILE[protocolOf(kind)]
	const { label: _label, protocol: _protocol, ...limits } = PROFILES[profile]!
	return sanitiseCamera({
		id: randomUUID(),
		name: 'Camera',
		kind,
		host: '192.168.0.100',
		port: DEFAULT_PORTS[kind],
		serialPath: '',
		baudRate: 9600,
		address: 1,
		username: '',
		password: '',
		sendInterval: defaultSendInterval(kind),
		profile,
		...limits,
		...partial,
	})
}

const num = (value: unknown, fallback: number, min: number, max: number) => {
	const n = typeof value === 'number' ? value : Number(value)
	return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}
const str = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)

export function defaultSendInterval(kind: TransportKind): number {
	return KINDS[kind].sendInterval
}

export function sanitiseCamera(c: Partial<CameraConfig>): CameraConfig {
	const kind = TRANSPORTS.includes(c.kind as TransportKind) ? (c.kind as TransportKind) : 'sony-udp'
	const protocol = protocolOf(kind)
	const ranges = LIMIT_RANGES[protocol]
	const defaults = PROFILES[DEFAULT_PROFILE[protocol]]!
	const limit = (key: keyof typeof ranges) => Math.round(num(c[key], defaults[key], ...ranges[key]))
	return {
		id: str(c.id, randomUUID()),
		name: str(c.name, 'Camera'),
		kind,
		host: str(c.host, '').trim(),
		port: Math.round(num(c.port, DEFAULT_PORTS[kind], 0, 65535)),
		serialPath: str(c.serialPath, ''),
		baudRate: Math.round(num(c.baudRate, 9600, 1200, 115200)),
		// Fixed at 1 for most kinds; a VISCA serial chain and a KXWell panel use the others
		address: Math.round(num(c.address, 1, 1, KINDS[kind].maxAddress)),
		username: KINDS[kind].login ? str(c.username, '') : '',
		password: KINDS[kind].login ? str(c.password, '') : '',
		sendInterval: Math.round(num(c.sendInterval, defaultSendInterval(kind), 5, 500)),
		maxPan: limit('maxPan'),
		maxTilt: limit('maxTilt'),
		maxZoom: limit('maxZoom'),
		maxFocus: limit('maxFocus'),
		profile: typeof c.profile === 'string' && PROFILES[c.profile]?.protocol === protocol ? c.profile : '',
	}
}

function sanitiseAxisMapping(m: Partial<AxisMapping> | undefined): AxisMapping {
	const action = m?.action === 'none' || MOTION_CHANNELS.includes(m?.action as MotionChannel) ? m!.action! : 'none'
	return {
		action,
		invert: typeof m?.invert === 'boolean' ? m.invert : DEFAULT_AXIS.invert,
		deadzone: num(m?.deadzone, DEFAULT_AXIS.deadzone, 0, 0.5),
		saturation: num(m?.saturation, DEFAULT_AXIS.saturation, 0, 0.3),
		curve: num(m?.curve, DEFAULT_AXIS.curve, 0.5, 4),
		maxSpeed: num(m?.maxSpeed, DEFAULT_AXIS.maxSpeed, 0.05, 1),
	}
}

/** Sanitise each axis, and keep each camera movement on one axis only (the first that has it) */
export function sanitiseMapping(m: unknown): Mapping {
	const input = m && typeof m === 'object' ? (m as Record<string, Partial<AxisMapping>>) : {}
	const out: Mapping = {}
	const taken = new Set<MotionChannel>()
	for (const [axis, value] of Object.entries(input)) {
		const axisMapping = sanitiseAxisMapping(value)
		if (axisMapping.action !== 'none') {
			if (taken.has(axisMapping.action)) axisMapping.action = 'none'
			else taken.add(axisMapping.action)
		}
		out[axis] = axisMapping
	}
	return out
}

function sanitiseButtonAction(a: Partial<ButtonAction> | undefined, cameraIds: Set<string>): ButtonAction {
	switch (a?.type) {
		case 'nextCamera':
		case 'previousCamera':
		case 'home':
		case 'onePushFocus':
			return { type: a.type }
		case 'selectCamera': {
			const cameraId = (a as { cameraId?: unknown }).cameraId
			return typeof cameraId === 'string' && cameraIds.has(cameraId)
				? { type: 'selectCamera', cameraId }
				: { type: 'none' }
		}
		case 'presetRecall':
			return { type: 'presetRecall', preset: Math.round(num((a as { preset?: unknown }).preset, 0, 0, 255)) }
		case 'autoFocus':
			return { type: 'autoFocus', enabled: (a as { enabled?: unknown }).enabled !== false }
		case 'hold': {
			const { channel, direction } = a as { channel?: unknown; direction?: unknown }
			return MOTION_CHANNELS.includes(channel as MotionChannel)
				? { type: 'hold', channel: channel as MotionChannel, direction: direction === -1 ? -1 : 1 }
				: { type: 'none' }
		}
		default:
			return { type: 'none' }
	}
}

/** What to call a remembered controller that somehow lost its name */
const CONTROLLER_NAMES: Record<ControllerKind, string> = {
	dji: 'DJI controller',
	gamepad: 'Gamepad',
	spacemouse: 'SpaceMouse',
}

function sanitiseController(c: Partial<ControllerSettings>, cameraIds: Set<string>): ControllerSettings | undefined {
	const kind = c.kind
	if (typeof c.id !== 'string' || !kind || !Object.hasOwn(CONTROLLER_NAMES, kind)) return undefined
	const buttons: ButtonMapping = {}
	for (const [button, action] of Object.entries(c.buttons ?? {}))
		buttons[button] = sanitiseButtonAction(action, cameraIds)
	return {
		id: c.id,
		kind,
		name: str(c.name, CONTROLLER_NAMES[kind]),
		cameraId: typeof c.cameraId === 'string' && cameraIds.has(c.cameraId) ? c.cameraId : undefined,
		axes: sanitiseMapping(c.axes),
		buttons,
	}
}

/**
 * The very first version kept one mapping keyed by camera movement, each naming the axis that
 * drove it: `{ pan: { source: 'rightX', ... } }`. Turn that around into the per-axis form.
 */
function migrateLegacyMapping(m: unknown): Mapping | undefined {
	if (!m || typeof m !== 'object') return undefined
	const record = m as Record<string, Record<string, unknown> | undefined>
	const perMovement = MOTION_CHANNELS.some((c) => typeof record[c]?.source === 'string')
	if (!perMovement) return sanitiseMapping(record)

	const out: Record<string, Partial<AxisMapping>> = {}
	for (const channel of MOTION_CHANNELS) {
		const { source, ...tuning } = (record[channel] ?? {}) as { source?: string } & Partial<AxisMapping>
		if (source && DJI_AXIS_IDS.includes(source) && !out[source]) out[source] = { ...tuning, action: channel }
	}
	return sanitiseMapping(out)
}

export function sanitiseSettings(raw: Partial<Settings> & { mapping?: unknown }): Settings {
	const cameras = Array.isArray(raw.cameras) ? raw.cameras.map(sanitiseCamera) : []
	const cameraIds = new Set(cameras.map((c) => c.id))
	const controllers = (Array.isArray(raw.controllers) ? raw.controllers : [])
		.map((c) => sanitiseController(c, cameraIds))
		.filter((c): c is ControllerSettings => c !== undefined)

	const api = (raw.api ?? {}) as Partial<ApiSettings>
	return {
		api: {
			enabled: typeof api.enabled === 'boolean' ? api.enabled : DEFAULT_API.enabled,
			port: Math.round(num(api.port, DEFAULT_API.port, 1024, 65535)),
			allowRemote: typeof api.allowRemote === 'boolean' ? api.allowRemote : DEFAULT_API.allowRemote,
		},
		cameras,
		activeCameraId: raw.activeCameraId && cameraIds.has(raw.activeCameraId) ? raw.activeCameraId : cameras[0]?.id,
		controllers,
		legacyDjiMapping: raw.legacyDjiMapping ? sanitiseMapping(raw.legacyDjiMapping) : migrateLegacyMapping(raw.mapping),
	}
}

export class SettingsStore {
	readonly #file: string
	#settings: Settings

	constructor(directory: string) {
		this.#file = path.join(directory, 'settings.json')
		this.#settings = this.#load()
	}

	get(): Settings {
		return structuredClone(this.#settings)
	}

	update(change: (settings: Settings) => void): Settings {
		const next = structuredClone(this.#settings)
		change(next)
		this.#settings = sanitiseSettings(next)
		this.#save()
		return this.get()
	}

	#load(): Settings {
		try {
			return sanitiseSettings(JSON.parse(readFileSync(this.#file, 'utf8')))
		} catch {
			return sanitiseSettings({})
		}
	}

	#save(): void {
		mkdirSync(path.dirname(this.#file), { recursive: true })
		// Write then rename, so a crash mid-write can't leave a truncated file
		const temp = `${this.#file}.tmp`
		writeFileSync(temp, JSON.stringify(this.#settings, null, '\t'))
		renameSync(temp, this.#file)
	}
}
