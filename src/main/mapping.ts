import type { ControllerKind } from './controllers/types.js'
import type { Motion, SpeedLimits } from './visca/camera.js'

export type MotionChannel = keyof Motion
export const MOTION_CHANNELS: MotionChannel[] = ['pan', 'tilt', 'zoom', 'focus']

/** What one controller axis does */
export interface AxisMapping {
	/** Which camera movement this axis drives, or none */
	action: MotionChannel | 'none'
	invert: boolean
	/** Readings within this fraction of centre count as zero */
	deadzone: number
	/** Readings within this fraction of the end count as full travel, so worn sticks still reach max */
	saturation: number
	/**
	 * Response curve exponent. 1 is linear; higher gives finer control near centre while still
	 * reaching full speed at the end.
	 */
	curve: number
	/** Fraction of the camera's top speed that full travel reaches */
	maxSpeed: number
}

/** Keyed by axis id, as the controller describes its axes */
export type Mapping = Record<string, AxisMapping>

export type ButtonAction =
	| { type: 'none' }
	| { type: 'nextCamera' }
	| { type: 'previousCamera' }
	| { type: 'selectCamera'; cameraId: string }
	| { type: 'presetRecall'; preset: number }
	| { type: 'home' }
	| { type: 'onePushFocus' }
	| { type: 'autoFocus'; enabled: boolean }
	/** Moves the camera for as long as the button is held, easing up to full speed */
	| { type: 'hold'; channel: MotionChannel; direction: 1 | -1 }

/** Keyed by button id */
export type ButtonMapping = Record<string, ButtonAction>

export const DEFAULT_AXIS: Omit<AxisMapping, 'action'> = {
	invert: false,
	deadzone: 0.08,
	saturation: 0.03,
	curve: 2,
	maxSpeed: 1,
}

/** Zoom and focus feel better with a gentler curve than pan and tilt */
export const DEFAULT_CURVE: Record<MotionChannel | 'none', number> = { pan: 2, tilt: 2, zoom: 1.5, focus: 1.5, none: 2 }

/**
 * Where a SpaceMouse starts. Its cap reads off centre under a resting finger and its axes bleed
 * into each other, so it ignores more around centre, and it eases in more steeply, so the small
 * pushes it is so sensitive to stay slow.
 */
const SPACEMOUSE_DEADZONE = 0.15
const SPACEMOUSE_CURVE_BOOST = 1

/** The tuning an axis starts with when it takes on `action` */
export function defaultAxis(action: MotionChannel | 'none', kind?: ControllerKind): AxisMapping {
	const axis: AxisMapping = { ...DEFAULT_AXIS, curve: DEFAULT_CURVE[action], action }
	if (kind === 'spacemouse') {
		axis.deadzone = SPACEMOUSE_DEADZONE
		axis.curve += SPACEMOUSE_CURVE_BOOST
	}
	return axis
}

type Actions = Record<string, MotionChannel | 'none'>

export interface Layout {
	label: string
	actions: Actions
}

/** Ready-made assignments per kind of controller, for switching the whole layout at once */
export const LAYOUTS: Record<ControllerKind, Record<string, Layout>> = {
	dji: {
		right: {
			label: 'Right stick pan/tilt, left stick zoom, wheel focus',
			actions: { rightX: 'pan', rightY: 'tilt', leftY: 'zoom', wheel: 'focus' },
		},
		left: {
			label: 'Left stick pan/tilt, right stick zoom, wheel focus',
			actions: { leftX: 'pan', leftY: 'tilt', rightY: 'zoom', wheel: 'focus' },
		},
		split: {
			label: 'Left stick pan, right stick tilt/zoom, wheel focus',
			actions: { leftX: 'pan', rightY: 'tilt', rightX: 'zoom', wheel: 'focus' },
		},
		wheelZoom: {
			label: 'Right stick pan/tilt, wheel zoom, left stick focus',
			actions: { rightX: 'pan', rightY: 'tilt', wheel: 'zoom', leftY: 'focus' },
		},
	},
	gamepad: {
		leftTriggers: {
			label: 'Left stick pan/tilt, triggers zoom, right stick focus',
			actions: { leftX: 'pan', leftY: 'tilt', triggers: 'zoom', rightY: 'focus' },
		},
		rightTriggers: {
			label: 'Right stick pan/tilt, triggers zoom, left stick focus',
			actions: { rightX: 'pan', rightY: 'tilt', triggers: 'zoom', leftY: 'focus' },
		},
		leftStickZoom: {
			label: 'Left stick pan/tilt, right stick zoom, triggers focus',
			actions: { leftX: 'pan', leftY: 'tilt', rightY: 'zoom', triggers: 'focus' },
		},
		/** For a single stick, such as the Magicsee R1's */
		oneStick: {
			label: 'Stick pan/tilt',
			actions: { leftX: 'pan', leftY: 'tilt' },
		},
	},
	spacemouse: {
		tilt: {
			label: 'Tilt the cap to pan/tilt, lift/press zoom, twist focus',
			actions: { roll: 'pan', pitch: 'tilt', z: 'zoom', yaw: 'focus' },
		},
		slide: {
			label: 'Slide the cap to pan/tilt, lift/press zoom, twist focus',
			actions: { x: 'pan', y: 'tilt', z: 'zoom', yaw: 'focus' },
		},
		twist: {
			label: 'Twist to pan, tilt forward/back to tilt, lift/press zoom, tilt sideways focus',
			actions: { yaw: 'pan', pitch: 'tilt', z: 'zoom', roll: 'focus' },
		},
	},
}

export const DEFAULT_LAYOUT: Record<ControllerKind, string> = {
	dji: 'right',
	gamepad: 'leftTriggers',
	spacemouse: 'tilt',
}

/**
 * The layouts worth offering a controller: those it has every axis for, and of those, the ones that
 * use the most of them, so a full gamepad isn't offered the one-stick layout.
 */
export function layoutsFor(kind: ControllerKind, axisIds: string[]): [string, Layout][] {
	const fits = Object.entries(LAYOUTS[kind]).filter(([, l]) => Object.keys(l.actions).every((a) => axisIds.includes(a)))
	const most = Math.max(0, ...fits.map(([, l]) => Object.keys(l.actions).length))
	return fits.filter(([, l]) => Object.keys(l.actions).length === most)
}

/** The layout a new controller starts with: the usual one for its kind, if it fits */
export function defaultLayout(kind: ControllerKind, axisIds: string[]): Layout {
	const fits = layoutsFor(kind, axisIds)
	return (fits.find(([id]) => id === DEFAULT_LAYOUT[kind]) ?? fits[0])?.[1] ?? LAYOUTS[kind][DEFAULT_LAYOUT[kind]]
}

/** Buttons a gamepad starts with. D-pad and bumpers get around; face buttons recall presets. */
export const DEFAULT_GAMEPAD_BUTTONS: ButtonMapping = {
	lb: { type: 'previousCamera' },
	rb: { type: 'nextCamera' },
	left: { type: 'previousCamera' },
	right: { type: 'nextCamera' },
	south: { type: 'presetRecall', preset: 0 },
	east: { type: 'presetRecall', preset: 1 },
	west: { type: 'presetRecall', preset: 2 },
	north: { type: 'presetRecall', preset: 3 },
	start: { type: 'home' },
	select: { type: 'onePushFocus' },
}

/**
 * Buttons a SpaceMouse starts with, by bit: its two side buttons (Menu and Fit on a Pro) switch
 * cameras, and a Pro's 1-4 recall presets.
 */
export const DEFAULT_SPACEMOUSE_BUTTONS: ButtonMapping = {
	b0: { type: 'previousCamera' },
	b1: { type: 'nextCamera' },
	b12: { type: 'presetRecall', preset: 0 },
	b13: { type: 'presetRecall', preset: 1 },
	b14: { type: 'presetRecall', preset: 2 },
	b15: { type: 'presetRecall', preset: 3 },
}

const DEFAULT_BUTTONS: Record<ControllerKind, ButtonMapping> = {
	dji: {},
	gamepad: DEFAULT_GAMEPAD_BUTTONS,
	spacemouse: DEFAULT_SPACEMOUSE_BUTTONS,
}

/**
 * Buttons a new controller starts with. A gamepad with nowhere for the layout to put zoom, such as
 * the Magicsee R1 with its single stick, zooms on the bumpers instead of switching cameras with them.
 */
export function defaultButtons(
	kind: ControllerKind,
	axisIds: string[],
	buttonIds: string[],
	layout: Layout,
): ButtonMapping {
	const zoomAxis = Object.entries(layout.actions).find(([, action]) => action === 'zoom')?.[0]
	const buttons: ButtonMapping = { ...DEFAULT_BUTTONS[kind] }
	if (kind === 'gamepad' && (!zoomAxis || !axisIds.includes(zoomAxis))) {
		buttons.lb = { type: 'hold', channel: 'zoom', direction: -1 }
		buttons.rb = { type: 'hold', channel: 'zoom', direction: 1 }
	}
	return Object.fromEntries(Object.entries(buttons).filter(([id]) => buttonIds.includes(id)))
}

/**
 * Build a mapping from a set of actions. Axes the layout doesn't mention do nothing. An axis that
 * keeps its job keeps its tuning; otherwise it starts from the defaults for its new one.
 */
export function layoutMapping(axisIds: string[], actions: Actions, base?: Mapping, kind?: ControllerKind): Mapping {
	const out: Mapping = {}
	for (const axis of axisIds) {
		const action = actions[axis] ?? 'none'
		const previous = base?.[axis]
		out[axis] = previous && previous.action === action ? { ...previous } : defaultAxis(action, kind)
	}
	return out
}

/** The layout id `mapping` matches exactly, if any */
export function matchingLayout(kind: ControllerKind, axisIds: string[], mapping: Mapping): string | undefined {
	return Object.entries(LAYOUTS[kind]).find(([, layout]) =>
		axisIds.every((axis) => (layout.actions[axis] ?? 'none') === (mapping[axis]?.action ?? 'none')),
	)?.[0]
}

/**
 * Give `axis` the action `action`. A camera movement belongs to one axis at a time, so whichever
 * axis had it before is freed.
 */
export function assignAction(
	mapping: Mapping,
	axis: string,
	action: MotionChannel | 'none',
	kind?: ControllerKind,
): Mapping {
	const out = structuredClone(mapping)
	if (action !== 'none') {
		for (const other of Object.keys(out)) {
			if (other !== axis && out[other].action === action) out[other].action = 'none'
		}
	}
	const current = out[axis] ?? defaultAxis('none', kind)
	out[axis] = current.action === action ? current : { ...current, action, curve: defaultAxis(action, kind).curve }
	return out
}

/** Apply deadzone, saturation and curve: -1..1 in, -1..1 out */
export function shapeAxis(value: number, m: Omit<AxisMapping, 'action'>): number {
	const magnitude = Math.abs(value)
	const low = Math.min(Math.max(m.deadzone, 0), 0.9)
	const high = Math.max(1 - Math.max(m.saturation, 0), low + 0.05)

	if (magnitude <= low) return 0
	const scaled = Math.min((magnitude - low) / (high - low), 1)
	const curved = scaled ** Math.max(m.curve, 0.1)

	const sign = Math.sign(value) * (m.invert ? -1 : 1)
	return curved * sign
}

/**
 * Scale a shaped value onto 1..max. Anything past the deadzone moves at least at speed 1, so the
 * first nudge off centre is never swallowed by rounding.
 */
export function toSpeed(shaped: number, max: number, maxFraction: number): number {
	if (shaped === 0) return 0
	const top = Math.max(1, Math.round(max * Math.min(Math.max(maxFraction, 0.05), 1)))
	const speed = 1 + Math.round(Math.abs(shaped) * (top - 1))
	return speed * Math.sign(shaped)
}

const CHANNEL_LIMIT: Record<MotionChannel, keyof SpeedLimits> = {
	pan: 'maxPan',
	tilt: 'maxTilt',
	zoom: 'maxZoom',
	focus: 'maxFocus',
}

/**
 * Zoom and focus speeds are 0-7 on the wire, but here speed 1 has to mean "slowest" so that 0 can
 * mean stop. So their range is shifted up by one: 1-8 here is 0-7 on the wire (see commands.ts).
 */
const RANGE_OFFSET: Record<MotionChannel, number> = { pan: 0, tilt: 0, zoom: 1, focus: 1 }

export function axesToMotion(axes: Record<string, number>, mapping: Mapping, limits: SpeedLimits): Motion {
	const motion: Motion = { pan: 0, tilt: 0, zoom: 0, focus: 0 }
	for (const [axis, m] of Object.entries(mapping)) {
		if (m.action === 'none') continue
		const max = limits[CHANNEL_LIMIT[m.action]] + RANGE_OFFSET[m.action]
		const speed = toSpeed(shapeAxis(axes[axis] ?? 0, m), max, m.maxSpeed)
		// Should two axes ever share a job, the one pushed further wins
		if (Math.abs(speed) > Math.abs(motion[m.action])) motion[m.action] = speed
	}
	return motion
}

/**
 * A button is only on or off, so a held one eases in: a tap moves at the slowest speed and holding
 * it reaches full speed after this long.
 */
export const HOLD_RAMP_MS = 2000

/** Motion from buttons assigned to `hold` actions. `heldSince` is when each held button went down. */
export function buttonsToMotion(
	heldSince: Record<string, number>,
	buttons: ButtonMapping,
	limits: SpeedLimits,
	now: number,
): Motion {
	const motion: Motion = { pan: 0, tilt: 0, zoom: 0, focus: 0 }
	for (const [button, since] of Object.entries(heldSince)) {
		const action = buttons[button]
		if (action?.type !== 'hold') continue
		const travel = Math.min(1, Math.max(0, now - since) / HOLD_RAMP_MS)
		const max = limits[CHANNEL_LIMIT[action.channel]] + RANGE_OFFSET[action.channel]
		// toSpeed treats 0 as stopped, so a button just pressed still moves at the slowest speed
		const speed = toSpeed(Math.max(travel, Number.EPSILON) * action.direction, max, 1)
		// Opposite buttons held together cancel out
		motion[action.channel] += speed
	}
	return motion
}

/** When several controllers drive one camera, each movement goes to whichever pushes hardest */
export function mergeMotion(a: Motion, b: Motion): Motion {
	const pick = (x: number, y: number) => (Math.abs(y) > Math.abs(x) ? y : x)
	return {
		pan: pick(a.pan, b.pan),
		tilt: pick(a.tilt, b.tilt),
		zoom: pick(a.zoom, b.zoom),
		focus: pick(a.focus, b.focus),
	}
}
