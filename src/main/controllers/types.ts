import type { EventEmitter } from 'node:events'

/** One input on a controller, as offered for assignment */
export interface ControlDescriptor {
	id: string
	label: string
}

export type ControllerKind = 'dji' | 'gamepad' | 'spacemouse'

export interface ControllerInfo {
	/**
	 * Stable across reconnects, so assignments stick to the physical controller: a serial number
	 * where the controller has one, otherwise its model name plus which of that model it is.
	 */
	id: string
	kind: ControllerKind
	/** As the controller names itself, e.g. "DJI RC-N1" or "Xbox Wireless Controller" */
	name: string
	/** Signed inputs, -1..1 with 0 at rest; up and right are positive */
	axes: ControlDescriptor[]
	buttons: ControlDescriptor[]
}

export interface ControllerInput {
	axes: Record<string, number>
	buttons: Record<string, boolean>
}

export interface ControllerSourceEvents {
	connected: [ControllerInfo]
	input: [id: string, input: ControllerInput]
	/**
	 * The controller stopped reporting. Whatever it was driving must stop at once; it may come
	 * back, or `disconnected` may follow.
	 */
	lost: [id: string]
	disconnected: [id: string]
}

/** Somewhere controllers come from: a USB serial scan, the renderer's Gamepad API... */
export interface ControllerSource extends EventEmitter<ControllerSourceEvents> {
	start(): void
	stop(): Promise<void>
}
