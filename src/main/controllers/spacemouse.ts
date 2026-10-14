/**
 * 3Dconnexion SpaceMouse input reports, as read directly over HID. The cap moves in six ways: it
 * slides three ways and tilts or twists three ways, each reported as a signed 16-bit reading.
 *
 * Report 1 carries the slides, report 2 the tilts and twist, and report 3 the buttons as a bit
 * field. Newer models (SpaceMouse Compact, Wireless, Pro Wireless) put all six readings in report 1
 * and never send report 2.
 *
 * The device's own axes are x right, y toward the user and z down. They are turned around here so
 * that, as for every controller, up and right read positive: forward, lift, tilting forward or
 * right, and twisting clockwise.
 *
 * Worked out from 3Dconnexion's HID descriptors and open-source drivers (spacenavd, pyspacemouse).
 * On a SpaceNavigator over USB on macOS: separate slide and tilt reports, a two-byte button report,
 * readings up to about ±470 at a hard push, and every direction as here. Its axes bleed into each
 * other a good deal: a tilt forward also reads as some tilt right, and a slide as some press.
 */
import type { ControlDescriptor } from './types.js'

export const SPACEMOUSE_AXES: ControlDescriptor[] = [
	{ id: 'x', label: 'Slide ↔' },
	{ id: 'y', label: 'Slide forward/back' },
	{ id: 'z', label: 'Lift/press' },
	{ id: 'pitch', label: 'Tilt forward/back' },
	{ id: 'roll', label: 'Tilt left/right' },
	{ id: 'yaw', label: 'Twist' },
]

/** Buttons are named by their bit in report 3, which means different keys on different models */
const button = (bit: number, label: string): ControlDescriptor => ({ id: `b${bit}`, label })

/** SpaceNavigator, SpaceMouse Compact and Wireless: one button either side */
export const SPACEMOUSE_TWO_BUTTONS = [button(0, 'Left button'), button(1, 'Right button')]

/** SpaceMouse Pro and Pro Wireless */
export const SPACEMOUSE_PRO_BUTTONS = [
	button(0, 'Menu'),
	button(1, 'Fit'),
	button(2, 'T (top view)'),
	button(4, 'R (right view)'),
	button(5, 'F (front view)'),
	button(8, 'Rotate view'),
	button(12, '1'),
	button(13, '2'),
	button(14, '3'),
	button(15, '4'),
	button(22, 'Esc'),
	button(23, 'Alt'),
	button(24, 'Shift'),
	button(25, 'Ctrl'),
	button(26, 'Lock rotation'),
]

/** SpaceExplorer: its fifteen buttons in bit order */
export const SPACEMOUSE_EXPLORER_BUTTONS = Array.from({ length: 15 }, (_, i) => button(i, `Button ${i + 1}`))

/** Behind the Universal Receiver could be any wireless model, so the Pro's names are given both ways */
export const SPACEMOUSE_RECEIVER_BUTTONS = [
	button(0, 'Left button / Menu'),
	button(1, 'Right button / Fit'),
	...SPACEMOUSE_PRO_BUTTONS.slice(2),
]

/** A SpaceNavigator reads about ±300 at a firm push and ±470 at its hardest */
const FULL_TRAVEL = 450

const TRANSLATION_REPORT = 1
const ROTATION_REPORT = 2
const BUTTON_REPORT = 3

export interface SpaceMouseState {
	/** -1..1 by axis id, up and right positive */
	axes: Record<string, number>
	/** Bit field from report 3 */
	buttons: number
}

export function createSpaceMouseState(): SpaceMouseState {
	return { axes: Object.fromEntries(SPACEMOUSE_AXES.map((a) => [a.id, 0])), buttons: 0 }
}

const reading = (data: Buffer, offset: number, sign: 1 | -1) =>
	Math.max(-1, Math.min(1, (sign * data.readInt16LE(offset)) / FULL_TRAVEL))

function readTranslation(data: Buffer, offset: number, state: SpaceMouseState): void {
	state.axes.x = reading(data, offset, 1)
	state.axes.y = reading(data, offset + 2, -1)
	state.axes.z = reading(data, offset + 4, -1)
}

function readRotation(data: Buffer, offset: number, state: SpaceMouseState): void {
	state.axes.pitch = reading(data, offset, -1)
	state.axes.roll = reading(data, offset + 2, -1)
	state.axes.yaw = reading(data, offset + 4, 1)
}

/** Update the state from one report; false if it wasn't one this understands */
export function parseSpaceMouseReport(data: Buffer, state: SpaceMouseState): boolean {
	switch (data[0]) {
		case TRANSLATION_REPORT:
			if (data.length < 7) return false
			readTranslation(data, 1, state)
			if (data.length >= 13) readRotation(data, 7, state)
			return true
		case ROTATION_REPORT:
			if (data.length < 7) return false
			readRotation(data, 1, state)
			return true
		case BUTTON_REPORT: {
			let bits = 0
			for (let i = 1; i < Math.min(data.length, 5); i++) bits |= data[i] << (8 * (i - 1))
			state.buttons = bits >>> 0
			return true
		}
		default:
			// Battery level on the wireless models, and anything else
			return false
	}
}

/** Whether the button named `b<bit>` is down */
export function spaceMouseButton(state: SpaceMouseState, id: string): boolean {
	const bit = Number(id.slice(1))
	return ((state.buttons >>> bit) & 1) === 1
}
