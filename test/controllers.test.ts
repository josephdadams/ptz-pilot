import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readGamepad, usbIdsOf, GamepadSource, type RawGamepad } from '../src/main/controllers/gamepad.js'
import { createXboxState, parseXboxReport } from '../src/main/controllers/xbox-report.js'
import { parseChannels } from '../src/main/controllers/dji.js'
import {
	createIcadeState,
	icadeStick,
	parseIcadeReport,
	releaseIcade,
	type IcadeState,
} from '../src/main/controllers/icade.js'
import { createSpaceMouseState, parseSpaceMouseReport, spaceMouseButton } from '../src/main/controllers/spacemouse.js'

const pad = (partial: Partial<RawGamepad> = {}): RawGamepad => ({
	id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
	nth: 0,
	mapping: 'standard',
	axes: [0, 0, 0, 0],
	buttons: Array(17).fill(0),
	...partial,
})

test('gamepad: standard mapping, with up positive and triggers as one axis', () => {
	const buttons = Array(17).fill(0)
	buttons[0] = 1 // south
	buttons[6] = 0.25 // left trigger, lightly
	buttons[7] = 1 // right trigger, fully
	const input = readGamepad(pad({ axes: [0.5, -1, 0, 0.25], buttons }))
	assert.equal(input.axes.leftX, 0.5)
	assert.equal(input.axes.leftY, 1, 'pushed up reads positive')
	assert.equal(input.axes.rightY, -0.25)
	assert.equal(input.axes.triggers, 0.75)
	assert.equal(input.buttons.south, true)
	assert.equal(input.buttons.lt, false, 'a light trigger is not a press')
	assert.equal(input.buttons.rt, true)
})

test('gamepad: usb ids come out of the Chromium id string', () => {
	assert.deepEqual(usbIdsOf(pad().id), { vendorId: 0x045e, productId: 0x0b13 })
	assert.equal(usbIdsOf('Some Pad'), undefined)
})

test('gamepad source: pads claimed over HID are left alone', () => {
	const source = new GamepadSource()
	const connected: string[] = []
	source.on('connected', (info) => connected.push(info.name))

	source.setClaimCheck((vendorId, productId) => vendorId === 0x045e && productId === 0x0b13)
	source.update([pad(), pad({ id: '8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)' })])
	assert.deepEqual(connected, ['8BitDo Pro 2'])
})

test('gamepad source: a pad that disappears is reported lost and disconnected', () => {
	const source = new GamepadSource()
	const events: string[] = []
	source.on('connected', () => events.push('connected'))
	source.on('lost', () => events.push('lost'))
	source.on('disconnected', () => events.push('disconnected'))
	source.update([pad()])
	source.update([])
	assert.deepEqual(events, ['connected', 'lost', 'disconnected'])
})

test('xbox over USB (GIP): sticks, triggers and buttons', () => {
	const report = Buffer.alloc(18)
	report[0] = 0x20
	report.writeUInt16LE((1 << 4) | (1 << 12), 4) // A and left bumper
	report.writeUInt16LE(1023, 8) // right trigger fully
	report.writeInt16LE(32767, 10) // left stick full right
	report.writeInt16LE(-32767, 16) // right stick full down
	const state = createXboxState()
	assert.equal(parseXboxReport(report, state), true)
	assert.equal(state.buttons.south, true)
	assert.equal(state.buttons.lb, true)
	assert.equal(state.buttons.rt, true)
	assert.equal(state.leftX, 1)
	assert.equal(state.rightY, -1)

	const guide = Buffer.from([0x07, 0, 0, 0, 1])
	assert.equal(parseXboxReport(guide, state), true)
	assert.equal(state.buttons.home, true)
})

test('dji: channel reply decodes to axes', () => {
	// Status byte, then 3-byte slots: right X full right, left Y full down
	const payload = Buffer.alloc(26)
	const slot = (i: number, v: number) => payload.writeUInt16LE(v, 2 + i * 3)
	for (let i = 0; i < 8; i++) slot(i, 1024)
	slot(0, 1684)
	slot(2, 364)
	const axes = parseChannels(payload)!
	assert.equal(axes.rightX, 1)
	assert.equal(axes.leftY, -1)
	assert.equal(axes.wheel, 0)
})

/** A keyboard report as the Magicsee R1 sends it: report id 3, modifiers, reserved, six keys */
const keys = (...letters: string[]) => {
	const report = Buffer.alloc(9)
	report[0] = 0x03
	letters.forEach((l, i) => (report[3 + i] = 0x04 + l.charCodeAt(0) - 97))
	return report
}

/** Run a report through the parser, collecting what is held after each change */
const feed = (state: IcadeState, report: Buffer, control: keyof IcadeState['held'] = 'south') => {
	const seen: boolean[] = []
	parseIcadeReport(report, state, () => seen.push(state.held[control]))
	return seen
}

test('icade: one letter holds a control down and another lets it go', () => {
	const state = createIcadeState()
	assert.deepEqual(feed(state, keys('u')), [true], 'A on an R1')
	assert.deepEqual(feed(state, keys()), [], 'the key coming up changes nothing')
	assert.equal(state.held.south, true, 'still held until the release letter')
	assert.deepEqual(feed(state, keys('f')), [false])
})

test('icade: a quick tap with both letters in one report still presses and lets go', () => {
	const state = createIcadeState()
	// The release letter F has the lower key code, so it comes first in the report
	assert.deepEqual(feed(state, keys('f', 'u')), [true, false])
	assert.equal(state.held.south, false, 'not left stuck down')
	assert.deepEqual(feed(state, keys()), [])
	assert.deepEqual(feed(state, keys('u')), [true], 'the next press is a press')
	assert.deepEqual(feed(state, keys()), [])
	// Let go and pressed again within one report: it ends up held, and the press is seen
	assert.deepEqual(feed(state, keys('f', 'u')), [false, true])
})

test('icade: the stick reads up and right positive, with diagonals as two directions', () => {
	const state = createIcadeState()
	// As recorded from an R1 pushed up-left: W and A together
	feed(state, keys('w', 'a'))
	assert.deepEqual(icadeStick(state), { x: -1, y: 1 })
	feed(state, keys())
	feed(state, keys('e'))
	assert.deepEqual(icadeStick(state), { x: -1, y: 0 })
	feed(state, keys('q'))
	assert.deepEqual(icadeStick(state), { x: 0, y: 0 })
})

test('icade: other reports and letters are ignored', () => {
	const state = createIcadeState()
	assert.deepEqual(feed(state, Buffer.from([0x02, 0x01])), [], 'a media key report')
	assert.deepEqual(feed(state, keys('b')), [])
	assert.deepEqual(feed(state, keys('f')), [], 'releasing what was never pressed')
})

test('icade: letting go of everything, for when a release letter went missing', () => {
	const state = createIcadeState()
	feed(state, keys('a'))
	feed(state, keys('o'))
	feed(state, keys())
	assert.equal(releaseIcade(state), true)
	assert.deepEqual(icadeStick(state), { x: 0, y: 0 })
	assert.equal(state.held.lb, false)
	assert.equal(releaseIcade(state), false, 'nothing left to let go')
})

test('icade: swinging the stick across lets go of where it was, release letter or not', () => {
	const state = createIcadeState()
	// As recorded from an R1 swung left to right: A, then D, and only right's release letter
	feed(state, keys('a'))
	feed(state, keys('d'))
	assert.deepEqual(icadeStick(state), { x: 1, y: 0 })
	feed(state, keys('c'))
	assert.deepEqual(icadeStick(state), { x: 0, y: 0 }, 'not left stuck going left')
})

/** A SpaceMouse report: its id, then signed 16-bit readings */
const smReport = (id: number, ...values: number[]) => {
	const data = Buffer.alloc(1 + values.length * 2)
	data[0] = id
	values.forEach((v, i) => data.writeInt16LE(v, 1 + i * 2))
	return data
}

test('spacemouse: older models send slides and tilts apart, turned so up and right read positive', () => {
	const state = createSpaceMouseState()
	// Slid right, pushed away from you, pressed down
	assert.ok(parseSpaceMouseReport(smReport(1, 225, -450, 450), state))
	assert.deepEqual([state.axes.x, state.axes.y, state.axes.z], [0.5, 1, -1])
	assert.equal(state.axes.pitch, 0, 'tilts untouched by a slide report')

	// Tilted back, tilted left, twisted clockwise
	assert.ok(parseSpaceMouseReport(smReport(2, 450, 450, 225), state))
	assert.deepEqual([state.axes.pitch, state.axes.roll, state.axes.yaw], [-1, -1, 0.5])
	assert.equal(state.axes.x, 0.5, 'slides kept from before')
})

test('spacemouse: newer models send all six at once, clamped to full travel', () => {
	const state = createSpaceMouseState()
	assert.ok(parseSpaceMouseReport(smReport(1, 0, 0, -900, -450, 0, 0), state))
	assert.equal(state.axes.z, 1, 'lifted past full travel reads 1')
	assert.equal(state.axes.pitch, 1, 'tilted forward')
})

test('spacemouse: buttons by bit; other reports ignored', () => {
	const state = createSpaceMouseState()
	assert.ok(parseSpaceMouseReport(Buffer.from([3, 0x02, 0x10, 0x00, 0x04]), state))
	assert.equal(spaceMouseButton(state, 'b0'), false)
	assert.equal(spaceMouseButton(state, 'b1'), true)
	assert.equal(spaceMouseButton(state, 'b12'), true)
	assert.equal(spaceMouseButton(state, 'b26'), true)
	assert.equal(parseSpaceMouseReport(Buffer.from([0x17, 0x50]), state), false, 'battery level')
	assert.equal(parseSpaceMouseReport(Buffer.from([1, 0]), state), false, 'too short')
})
