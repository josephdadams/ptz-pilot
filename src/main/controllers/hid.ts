/**
 * Controllers read directly over HID, independent of the window and of the Gamepad API: Xbox
 * controllers, with the report handling ported from companion-surface-xbox-controller, iCade
 * controllers such as the Magicsee R1, which pose as keyboards, and 3Dconnexion SpaceMice.
 *
 * Direct HID can claim a controller exclusively, so other apps on the machine don't also act on
 * it. Whatever this source handles is reported to the Gamepad API source as claimed, so the same
 * controller isn't driving cameras twice. For a keyboard-like controller, that claim also keeps its
 * letters from typing into whatever app is in front. macOS only lets an app read one with the Input
 * Monitoring permission.
 */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import HID from 'node-hid'
import { GAMEPAD_AXES } from './gamepad.js'
import { createXboxState, parseXboxReport, XBOX_BUTTON_IDS, type XboxState } from './xbox-report.js'
import {
	createIcadeState,
	icadeStick,
	parseIcadeReport,
	releaseIcade,
	ICADE_BUTTON_IDS,
	type IcadeState,
} from './icade.js'
import {
	createSpaceMouseState,
	parseSpaceMouseReport,
	spaceMouseButton,
	SPACEMOUSE_AXES,
	SPACEMOUSE_EXPLORER_BUTTONS,
	SPACEMOUSE_PRO_BUTTONS,
	SPACEMOUSE_RECEIVER_BUTTONS,
	SPACEMOUSE_TWO_BUTTONS,
} from './spacemouse.js'
import type {
	ControlDescriptor,
	ControllerInfo,
	ControllerInput,
	ControllerSource,
	ControllerSourceEvents,
} from './types.js'

interface HidProduct {
	vendorId: number
	productId: number
	name: string
	protocol: 'xbox' | 'icade' | 'spacemouse'
	/** For ids that aren't the maker's own, the product name as well, so nothing else matches */
	productName?: string
	/** Where the model's buttons differ from the protocol's usual ones */
	buttons?: ControlDescriptor[]
	/**
	 * Only use it when it can be claimed exclusively. A SpaceMouse moves the pointer as well unless
	 * it is claimed, so sharing it would leave it working the whole Mac, not just the cameras.
	 */
	exclusive?: boolean
}

const MICROSOFT = 0x045e
/** Bluetooth LE's vendor id for Apple, which the Magicsee R1 borrows */
const APPLE_BLE = 0x004c
/** 3Dconnexion's older models still carry Logitech's vendor id, so only their own product ids match */
const LOGITECH = 0x046d
const THREE_D_CONNEXION = 0x256f

const xbox = (name: string, productIds: number[]): HidProduct[] =>
	productIds.map((productId) => ({ vendorId: MICROSOFT, productId, name, protocol: 'xbox' }))

function spaceMouse(vendorId: number, name: string, productIds: number[], buttons: ControlDescriptor[]): HidProduct[] {
	return productIds.map((productId) => ({
		vendorId,
		productId,
		name,
		protocol: 'spacemouse',
		buttons,
		exclusive: true,
	}))
}

/** USB and Bluetooth product ids differ, so both are listed; so do a wireless model's cable and receiver */
export const HID_PRODUCTS: HidProduct[] = [
	...xbox('Xbox Wireless Controller', [0x0b12, 0x0b13, 0x0b20, 0x0b21]),
	...xbox('Xbox One S Controller', [0x02e0, 0x02ea, 0x02fd]),
	...xbox('Xbox Elite Controller Series 2', [0x0b00, 0x0b05, 0x0b22]),
	...xbox('Xbox Adaptive Controller', [0x0b0a, 0x0b0c]),
	{ vendorId: APPLE_BLE, productId: 0x014c, name: 'Magicsee R1', protocol: 'icade', productName: 'Magicsee R1' },
	...spaceMouse(LOGITECH, 'SpaceNavigator', [0xc626], SPACEMOUSE_TWO_BUTTONS),
	...spaceMouse(LOGITECH, 'SpaceNavigator for Notebooks', [0xc628], SPACEMOUSE_TWO_BUTTONS),
	...spaceMouse(LOGITECH, 'SpaceExplorer', [0xc627], SPACEMOUSE_EXPLORER_BUTTONS),
	...spaceMouse(LOGITECH, 'SpaceMouse Pro', [0xc62b], SPACEMOUSE_PRO_BUTTONS),
	...spaceMouse(THREE_D_CONNEXION, 'SpaceMouse Wireless', [0xc62e, 0xc62f], SPACEMOUSE_TWO_BUTTONS),
	...spaceMouse(THREE_D_CONNEXION, 'SpaceMouse Pro Wireless', [0xc631, 0xc632], SPACEMOUSE_PRO_BUTTONS),
	...spaceMouse(THREE_D_CONNEXION, 'SpaceMouse Compact', [0xc635], SPACEMOUSE_TWO_BUTTONS),
	...spaceMouse(THREE_D_CONNEXION, 'SpaceMouse', [0xc652], SPACEMOUSE_RECEIVER_BUTTONS),
]

const XBOX_BUTTON_LABELS: Record<(typeof XBOX_BUTTON_IDS)[number], string> = {
	south: 'A',
	east: 'B',
	west: 'X',
	north: 'Y',
	lb: 'Left bumper',
	rb: 'Right bumper',
	lt: 'Left trigger',
	rt: 'Right trigger',
	select: 'View',
	start: 'Menu',
	ls: 'Left stick press',
	rs: 'Right stick press',
	up: 'D-pad up',
	down: 'D-pad down',
	left: 'D-pad left',
	right: 'D-pad right',
	home: 'Xbox button',
	share: 'Share',
}
const XBOX_BUTTONS: ControlDescriptor[] = XBOX_BUTTON_IDS.map((id) => ({ id, label: XBOX_BUTTON_LABELS[id] }))

const ICADE_AXES: ControlDescriptor[] = [
	{ id: 'leftX', label: 'Stick ↔' },
	{ id: 'leftY', label: 'Stick ↕' },
]
const ICADE_BUTTON_LABELS: Record<(typeof ICADE_BUTTON_IDS)[number], string> = {
	south: 'A',
	east: 'B',
	west: 'C',
	north: 'D',
	lb: 'Lower trigger',
	rb: 'Upper trigger',
}
const ICADE_BUTTONS: ControlDescriptor[] = ICADE_BUTTON_IDS.map((id) => ({ id, label: ICADE_BUTTON_LABELS[id] }))

const CONTROLS: Record<HidProduct['protocol'], Pick<ControllerInfo, 'kind' | 'axes' | 'buttons'>> = {
	xbox: { kind: 'gamepad', axes: GAMEPAD_AXES, buttons: XBOX_BUTTONS },
	icade: { kind: 'gamepad', axes: ICADE_AXES, buttons: ICADE_BUTTONS },
	spacemouse: { kind: 'spacemouse', axes: SPACEMOUSE_AXES, buttons: SPACEMOUSE_TWO_BUTTONS },
}

/**
 * An iCade stick is only on or off, so it eases in: a tap nudges the camera and holding a
 * direction builds to full speed over this long.
 */
const ICADE_RAMP_MS = 1500
/** Where the ease starts, as a fraction of full travel */
const ICADE_RAMP_START = 0.3
const ICADE_RAMP_TICK = 20
/**
 * With no key down for this long, nothing is held, whatever the letters said: the release letters
 * would have come by now. It keeps a lost release from leaving a camera moving.
 */
const ICADE_SILENCE_RELEASE = 300

/**
 * A SpaceMouse repeats its readings every 8ms or so while the cap is off centre, and goes quiet
 * once it is back. Quiet for this long while off centre, the readings are stale, say from a
 * wireless model gone out of range, and the cap is taken as let go.
 */
const SPACEMOUSE_SILENCE_RELEASE = 150

const SCAN_INTERVAL = 2000
const USAGE_PAGE_GENERIC_DESKTOP = 0x01
const GAMEPAD_USAGES = new Set([0x04, 0x05, 0x08])
const KEYBOARD_USAGES = new Set([0x06])
/** What opening a keyboard-like device fails with until the app has Input Monitoring */
const NOT_PERMITTED = /not permitted|0xE00002E2/i

function findProduct(device: HID.Device): HidProduct | undefined {
	return HID_PRODUCTS.find(
		(p) =>
			p.vendorId === device.vendorId &&
			p.productId === device.productId &&
			(!p.productName || p.productName === device.product),
	)
}

/** A controller can publish several HID collections; only one of them carries its input */
function isInputCollection(device: HID.Device, product: HidProduct): boolean {
	if (device.usagePage === undefined || device.usage === undefined) return true
	const usages = product.protocol === 'icade' ? KEYBOARD_USAGES : GAMEPAD_USAGES
	return device.usagePage === USAGE_PAGE_GENERIC_DESKTOP && usages.has(device.usage)
}

/** Some platforms invent a serial by hashing the ids, which is no use for telling pads apart */
function realSerial(device: HID.Device): string | undefined {
	if (!device.serialNumber) return undefined
	const synthetic = createHash('sha1').update(`${device.vendorId}:${device.productId}`).digest('hex').slice(0, 20)
	return device.serialNumber === synthetic ? undefined : device.serialNumber
}

interface Attached {
	info: ControllerInfo
	device: HID.HIDAsync
	usb: { vendorId: number; productId: number }
	/** Undoes anything the protocol set going, such as a ramp timer */
	release?: () => void
}

function xboxInput(s: XboxState): ControllerInput {
	return {
		axes: {
			leftX: s.leftX,
			leftY: s.leftY,
			rightX: s.rightX,
			rightY: s.rightY,
			triggers: s.rightTrigger - s.leftTrigger,
		},
		buttons: { ...s.buttons },
	}
}

export class HidSource extends EventEmitter<ControllerSourceEvents> implements ControllerSource {
	readonly #attached = new Map<string, Attached>()
	readonly #opening = new Set<string>()
	/** Controllers already reported as needing Input Monitoring, so each is reported once */
	readonly #blocked = new Set<string>()
	/** Controllers already reported as held by another app, so each is reported once */
	readonly #busy = new Set<string>()
	#onBlocked: (name: string) => void = () => undefined
	#onBusy: (name: string) => void = () => undefined
	#scan: ReturnType<typeof setTimeout> | undefined
	#stopped = true

	/** Be told when macOS won't let a controller be read until the app has Input Monitoring */
	setBlockedHandler(handler: (name: string) => void): void {
		this.#onBlocked = handler
	}

	/** Be told when a controller that has to be claimed exclusively is held by another app */
	setBusyHandler(handler: (name: string) => void): void {
		this.#onBusy = handler
	}

	/** Whether a pad with these USB ids is being handled here */
	claims(vendorId: number, productId: number): boolean {
		for (const a of this.#attached.values()) {
			if (a.usb.vendorId === vendorId && a.usb.productId === productId) return true
		}
		return false
	}

	start(): void {
		this.#stopped = false
		void this.#search()
	}

	async stop(): Promise<void> {
		this.#stopped = true
		clearTimeout(this.#scan)
		await Promise.all([...this.#attached.keys()].map((id) => this.#detach(id)))
	}

	async #search(): Promise<void> {
		if (this.#stopped) return
		try {
			await this.#scanOnce()
		} catch {
			// Try again on the next scan
		}
		if (!this.#stopped) this.#scan = setTimeout(() => void this.#search(), SCAN_INTERVAL)
	}

	async #scanOnce(): Promise<void> {
		const devices = await HID.devicesAsync()
		const seenPaths = new Set([...this.#attached.values()].map((a) => a.info.id))
		const countByModel = new Map<string, number>()

		for (const device of devices) {
			const product = findProduct(device)
			if (!product || !device.path || !isInputCollection(device, product)) continue

			const serial = realSerial(device)
			const model = `${device.vendorId}:${device.productId}`
			const nth = countByModel.get(model) ?? 0
			countByModel.set(model, nth + 1)
			const id = serial ? `hid:${serial}` : `hid:${model}#${nth}`

			if (seenPaths.has(id) || this.#opening.has(id)) continue
			this.#opening.add(id)
			void this.#open(id, device, product).finally(() => this.#opening.delete(id))
		}
	}

	async #open(id: string, device: HID.Device, product: HidProduct): Promise<void> {
		let handle: HID.HIDAsync
		try {
			// Prefer an exclusive claim, so the button presses don't also reach other apps
			handle = await HID.HIDAsync.open(device.path!)
		} catch (err) {
			try {
				// Try again on the next scan, by when whatever has it may have let go
				if (product.exclusive) throw err
				handle = await HID.HIDAsync.open(device.path!, { nonExclusive: true })
			} catch (err) {
				const name = device.product || product.name
				if (NOT_PERMITTED.test(String(err))) {
					if (!this.#blocked.has(id)) this.#onBlocked(name)
					this.#blocked.add(id)
				} else if (product.exclusive) {
					if (!this.#busy.has(id)) this.#onBusy(name)
					this.#busy.add(id)
				}
				return
			}
		}
		if (this.#stopped) {
			await handle.close().catch(() => undefined)
			return
		}

		const attached: Attached = {
			info: {
				id,
				name: device.product || product.name,
				...CONTROLS[product.protocol],
				buttons: product.buttons ?? CONTROLS[product.protocol].buttons,
			},
			device: handle,
			usb: { vendorId: device.vendorId, productId: device.productId },
		}
		this.#blocked.delete(id)
		this.#busy.delete(id)
		this.#attached.set(id, attached)
		this.emit('connected', attached.info)

		if (product.protocol === 'icade') {
			this.#readIcade(attached)
		} else if (product.protocol === 'spacemouse') {
			this.#readSpaceMouse(attached)
		} else {
			const state = createXboxState()
			handle.on('data', (data: Buffer) => {
				if (parseXboxReport(data, state)) this.emit('input', id, xboxInput(state))
			})
		}
		handle.on('error', () => void this.#gone(id))
	}

	#readIcade(attached: Attached): void {
		const id = attached.info.id
		const state: IcadeState = createIcadeState()
		let heldSince: number | undefined
		let ramp: ReturnType<typeof setInterval> | undefined

		const send = () => {
			const stick = icadeStick(state)
			const moving = stick.x !== 0 || stick.y !== 0
			if (moving) heldSince ??= Date.now()
			else heldSince = undefined
			const travel = moving
				? Math.min(1, ICADE_RAMP_START + ((Date.now() - heldSince!) / ICADE_RAMP_MS) * (1 - ICADE_RAMP_START))
				: 0
			this.emit('input', id, {
				axes: { leftX: stick.x * travel, leftY: stick.y * travel },
				buttons: Object.fromEntries(ICADE_BUTTON_IDS.map((b) => [b, state.held[b]])),
			})
			// Keep easing in while a direction is held; nothing to send once it is let go
			if (moving && travel < 1) ramp ??= setInterval(send, ICADE_RAMP_TICK)
			else {
				clearInterval(ramp)
				ramp = undefined
			}
		}

		let silence: ReturnType<typeof setTimeout> | undefined
		attached.release = () => {
			clearInterval(ramp)
			clearTimeout(silence)
		}
		attached.device.on('data', (data: Buffer) => {
			parseIcadeReport(data, state, send)
			clearTimeout(silence)
			if (state.keys.size === 0) {
				silence = setTimeout(() => {
					if (releaseIcade(state)) send()
				}, ICADE_SILENCE_RELEASE)
			}
		})
	}

	#readSpaceMouse(attached: Attached): void {
		const id = attached.info.id
		const state = createSpaceMouseState()
		const buttonIds = attached.info.buttons.map((b) => b.id)
		const send = () =>
			this.emit('input', id, {
				axes: { ...state.axes },
				buttons: Object.fromEntries(buttonIds.map((b) => [b, spaceMouseButton(state, b)])),
			})

		let silence: ReturnType<typeof setTimeout> | undefined
		attached.release = () => clearTimeout(silence)
		attached.device.on('data', (data: Buffer) => {
			if (!parseSpaceMouseReport(data, state)) return
			send()
			clearTimeout(silence)
			if (Object.values(state.axes).some((v) => v !== 0)) {
				silence = setTimeout(() => {
					for (const axis of Object.keys(state.axes)) state.axes[axis] = 0
					send()
				}, SPACEMOUSE_SILENCE_RELEASE)
			}
		})
	}

	async #gone(id: string): Promise<void> {
		if (!this.#attached.has(id)) return
		this.emit('lost', id)
		await this.#detach(id)
		this.emit('disconnected', id)
	}

	async #detach(id: string): Promise<void> {
		const attached = this.#attached.get(id)
		if (!attached) return
		this.#attached.delete(id)
		attached.release?.()
		await attached.device.close().catch(() => undefined)
	}
}
