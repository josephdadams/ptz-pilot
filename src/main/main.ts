import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { SerialPort } from 'serialport'
import { Engine, type CameraAction, type MotionFraction } from './engine.js'
import { SettingsStore, newCamera, type Settings } from './settings.js'
import { LIMIT_RANGES, PROFILES, type CameraConfig } from './visca/camera.js'
import { DEFAULT_PORTS, KINDS } from './visca/transports.js'
import {
	LAYOUTS,
	assignAction,
	layoutMapping,
	type AxisMapping,
	type ButtonAction,
	type MotionChannel,
} from './mapping.js'
import { DjiSource, DJI_VENDOR_ID } from './controllers/dji.js'
import { GamepadSource, type RawGamepad } from './controllers/gamepad.js'
import { HidSource } from './controllers/hid.js'
import { createTray, DEVELOPER_URL, type TrayHandle } from './tray.js'
import { ApiServer } from './api.js'
import { discover } from './onvif/discovery.js'
import { Updater } from './updater.js'

// Lets a test run use its own settings instead of the real ones
if (process.env.PTZ_PILOT_USER_DATA) app.setPath('userData', process.env.PTZ_PILOT_USER_DATA)

// A second copy would fight the first over the controllers and port 52381
if (!app.requestSingleInstanceLock()) app.exit(0)

const execFileAsync = promisify(execFile)

let engine: Engine | undefined
let api: ApiServer | undefined
let window: BrowserWindow | undefined
/** Who the engine thinks is moving a camera when it's the window's own controls */
const WINDOW_MOTION = 'window:'
let tray: TrayHandle | undefined
let updater: Updater | undefined
let quitting = false

const INPUT_MONITORING_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'
let askedForInputMonitoring = false

type InputMonitoring = 'granted' | 'denied' | 'unknown'

/**
 * Ask the bundled helper about Input Monitoring. The app runs it, so macOS takes it as the app
 * asking: a request is what puts PTZ Pilot in the list in System Settings.
 */
async function inputMonitoring(command: 'check' | 'request'): Promise<InputMonitoring | undefined> {
	const helper = app.isPackaged
		? path.join(process.resourcesPath, 'native', 'input-monitoring')
		: path.join(app.getAppPath(), 'dist', 'native', 'input-monitoring')
	try {
		const { stdout } = await execFileAsync(helper, [command], { timeout: 5000 })
		const answer = stdout.trim()
		return answer === 'granted' || answer === 'denied' || answer === 'unknown' ? answer : undefined
	} catch {
		return undefined
	}
}

/** Keyboard-like controllers, such as the Magicsee R1, can't be read until the user allows it */
async function askForInputMonitoring(name: string): Promise<void> {
	if (process.platform !== 'darwin' || askedForInputMonitoring) return
	askedForInputMonitoring = true

	// Never asked before: macOS shows its own prompt, which leads to the switch
	if ((await inputMonitoring('check')) === 'unknown') {
		await inputMonitoring('request')
		return
	}

	// Run from source there is no PTZ Pilot.app: the permission belongs to Electron, or to whatever launched it
	const holder = app.isPackaged ? 'PTZ Pilot' : 'Electron (or the terminal or app you started it from)'
	const options: Electron.MessageBoxOptions = {
		type: 'info',
		message: `PTZ Pilot needs Input Monitoring to use the ${name}`,
		detail:
			'The controller connects as a keyboard, and macOS only lets apps read keyboards with this permission. ' +
			`Turn on ${holder} under Privacy & Security → Input Monitoring, then quit and reopen PTZ Pilot.`,
		buttons: ['Open System Settings', 'Not Now'],
		defaultId: 0,
		cancelId: 1,
	}
	const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
	if (response === 0) void shell.openExternal(INPUT_MONITORING_SETTINGS)
}

let toldControllerBusy = false

/** A controller PTZ Pilot needs to itself, such as a SpaceMouse, is held by another app */
async function tellControllerBusy(name: string): Promise<void> {
	if (toldControllerBusy) return
	toldControllerBusy = true
	const options: Electron.MessageBoxOptions = {
		type: 'info',
		message: `Another app is using the ${name}`,
		detail:
			'PTZ Pilot takes the controller over, so it only moves your cameras and not the pointer or other apps. ' +
			"Quit whatever has it, such as 3Dconnexion's own driver (3DxWare), and PTZ Pilot will pick it up within a few seconds.",
	}
	await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
}

/** Settings from before the app was renamed, carried over once */
function migrateOldSettings(): void {
	const target = path.join(app.getPath('userData'), 'settings.json')
	const old = path.join(app.getPath('appData'), 'DJI VISCA Controller', 'settings.json')
	if (existsSync(target) || !existsSync(old)) return
	mkdirSync(path.dirname(target), { recursive: true })
	copyFileSync(old, target)
}

function createWindow(): void {
	window = new BrowserWindow({
		width: 1180,
		height: 800,
		minWidth: 880,
		minHeight: 600,
		title: 'PTZ Pilot',
		backgroundColor: '#15171a',
		show: false,
		webPreferences: {
			preload: path.join(__dirname, '../preload/preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// The window polls gamepads; that has to keep going while it is hidden
			backgroundThrottling: false,
		},
	})

	// Renderer and preload failures are otherwise silent unless DevTools happens to be open
	window.webContents.on('preload-error', (_event, preloadPath, error) => {
		console.error(`Preload failed (${preloadPath}):`, error)
	})
	window.webContents.on('console-message', (event) => {
		if (event.level === 'warning' || event.level === 'error') console.error(`[renderer] ${event.message}`)
	})

	// Links in the page open in the browser, never in the app window
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith('https://')) void shell.openExternal(url)
		return { action: 'deny' }
	})
	window.webContents.on('will-navigate', (event, url) => {
		event.preventDefault()
		if (url.startsWith('https://')) void shell.openExternal(url)
	})

	// Movement held in the window must never outlive the press: let go if the window can't see the release
	const stopWindowMotion = () => engine?.clearExternalMotion(WINDOW_MOTION)
	window.on('blur', stopWindowMotion)
	window.on('hide', stopWindowMotion)
	window.webContents.on('did-start-loading', stopWindowMotion)
	window.webContents.on('render-process-gone', stopWindowMotion)

	// Closing the window only hides it: cameras keep being driven, and it lives on in the tray
	window.on('close', (event) => {
		if (quitting) return
		event.preventDefault()
		window?.hide()
		if (process.platform === 'darwin') app.dock?.hide()
	})
	window.once('ready-to-show', () => window?.show())

	void window.loadFile(path.join(app.getAppPath(), 'src/renderer/index.html'))
}

function showWindow(): void {
	if (!window || window.isDestroyed()) createWindow()
	if (process.platform === 'darwin') void app.dock?.show()
	window!.show()
	window!.focus()
}

function send(channel: string, payload: unknown): void {
	if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function editController(e: Engine, id: string, change: (c: Settings['controllers'][number], s: Settings) => void) {
	return e.updateSettings((s) => {
		const controller = s.controllers.find((c) => c.id === id)
		if (controller) change(controller, s)
	})
}

function registerIpc(e: Engine, gamepads: GamepadSource, apiServer: ApiServer): void {
	ipcMain.handle('init', () => ({
		settings: e.settings,
		state: e.state,
		profiles: PROFILES,
		limitRanges: LIMIT_RANGES,
		defaultPorts: DEFAULT_PORTS,
		kinds: KINDS,
		layouts: LAYOUTS,
		version: app.getVersion(),
		apiStatus: apiServer.status,
	}))

	ipcMain.handle('api:save', (_event, config: Partial<Settings['api']>) =>
		e.updateSettings((s) => {
			s.api = { ...s.api, ...config }
		}),
	)
	apiServer.on('status', (status) => send('api-status', status))

	// --- Cameras
	ipcMain.handle('camera:add', (_event, partial: Partial<CameraConfig>) =>
		e.updateSettings((s) => {
			const camera = newCamera({ name: `Camera ${s.cameras.length + 1}`, ...partial })
			s.cameras.push(camera)
			s.activeCameraId = camera.id
		}),
	)
	ipcMain.handle('camera:save', (_event, camera: CameraConfig) =>
		e.updateSettings((s) => {
			s.cameras = s.cameras.map((c) => (c.id === camera.id ? camera : c))
		}),
	)
	ipcMain.handle('camera:remove', (_event, id: string) =>
		e.updateSettings((s) => {
			s.cameras = s.cameras.filter((c) => c.id !== id)
		}),
	)
	ipcMain.handle('camera:select', (_event, id: string) =>
		e.updateSettings((s) => {
			s.activeCameraId = id
		}),
	)
	ipcMain.handle('camera:action', (_event, action: CameraAction) => e.cameraAction(action))
	// Held movement from the window's own controls, as fractions of top speed. One key, so moving
	// another camera takes over from the last rather than leaving it running.
	ipcMain.handle('camera:move', (_event, cameraId: string, fraction: Partial<MotionFraction>) =>
		e.setExternalMotion(WINDOW_MOTION, cameraId, fraction),
	)
	ipcMain.handle('camera:stop', () => e.clearExternalMotion(WINDOW_MOTION))

	// --- Controllers
	ipcMain.handle('controller:camera', (_event, id: string, cameraId: string | null) =>
		editController(e, id, (c) => {
			c.cameraId = cameraId ?? undefined
		}),
	)
	ipcMain.handle('controller:assignAxis', (_event, id: string, axis: string, action: MotionChannel | 'none') =>
		editController(e, id, (c) => {
			c.axes = assignAction(c.axes, axis, action, c.kind)
		}),
	)
	ipcMain.handle(
		'controller:tuneAxis',
		(_event, id: string, axis: string, tuning: Partial<Omit<AxisMapping, 'action'>>) =>
			editController(e, id, (c) => {
				// The action only changes through assignAxis, which keeps each movement on one axis
				if (c.axes[axis]) c.axes[axis] = { ...c.axes[axis], ...tuning, action: c.axes[axis].action }
			}),
	)
	ipcMain.handle('controller:layout', (_event, id: string, layoutId: string) =>
		editController(e, id, (c) => {
			const layout = LAYOUTS[c.kind][layoutId]
			if (layout) c.axes = layoutMapping(Object.keys(c.axes), layout.actions, c.axes, c.kind)
		}),
	)
	ipcMain.handle('controller:button', (_event, id: string, button: string, action: ButtonAction) =>
		editController(e, id, (c) => {
			c.buttons[button] = action
		}),
	)
	ipcMain.handle('controller:forget', (_event, id: string) =>
		e.updateSettings((s) => {
			s.controllers = s.controllers.filter((c) => c.id !== id)
		}),
	)

	// The window's Gamepad API polling
	ipcMain.on('gamepads', (_event, pads: RawGamepad[]) => gamepads.update(pads))

	ipcMain.handle('serial:list', async () => {
		const ports = await SerialPort.list()
		// Leave out DJI controllers, which are not cameras
		return ports
			.filter((p) => parseInt(p.vendorId ?? '0', 16) !== DJI_VENDOR_ID)
			.map((p) => ({ path: p.path, label: p.manufacturer ?? '' }))
	})
	ipcMain.handle('onvif:discover', () => discover())

	e.on('state', (state) => {
		send('state', state)
		tray?.update(e.settings, state)
	})
	e.on('action', (cameraId, action) => send('camera-action', { cameraId, action }))
	e.on('settings', (settings) => {
		send('settings', settings)
		tray?.update(settings, e.state)
	})
}

app.on('second-instance', () => showWindow())

// Being asked to terminate (logout, shutdown, `kill`) should stop the cameras just like Quit does
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => app.quit())

app.whenReady().then(() => {
	migrateOldSettings()

	const hid = new HidSource()
	hid.setBlockedHandler((name) => void askForInputMonitoring(name))
	hid.setBusyHandler((name) => void tellControllerBusy(name))
	const gamepads = new GamepadSource()
	// Pads handled over HID also appear to the Gamepad API; drive them from HID only
	gamepads.setClaimCheck((vendorId, productId) => hid.claims(vendorId, productId))

	engine = new Engine(new SettingsStore(app.getPath('userData')), [new DjiSource(), hid, gamepads])
	api = new ApiServer(engine, app.getVersion())
	registerIpc(engine, gamepads, api)
	engine.start()
	api.start()

	app.setAboutPanelOptions({
		applicationName: 'PTZ Pilot',
		applicationVersion: app.getVersion(),
		copyright: 'Made by Joseph Adams',
		website: DEVELOPER_URL,
		iconPath: path.join(app.getAppPath(), 'assets', 'icon.png'),
	})

	// Installing quits the app, which needs the window to really close rather than hide
	const u = new Updater({ beforeInstall: () => (quitting = true) })
	updater = u
	u.start()

	const e = engine
	tray = createTray({
		show: showWindow,
		quit: () => app.quit(),
		checkForUpdates: () => void u.check(true),
		assign: (controllerId, cameraId) =>
			editController(e, controllerId, (c) => {
				c.cameraId = cameraId
			}),
	})
	tray.update(engine.settings, engine.state)
	createWindow()

	app.on('activate', () => showWindow())
})

// Keep running in the tray with no window
app.on('window-all-closed', () => undefined)

app.on('before-quit', (event) => {
	quitting = true
	updater?.stop()
	if (!engine) return
	// Give every camera its stop before the process goes away
	event.preventDefault()
	const e = engine
	engine = undefined
	// Nothing should reach the tray or window once they start going away
	e.removeAllListeners()
	api?.removeAllListeners()
	// However shutdown goes, don't let it keep the app from quitting
	const stopping = Promise.allSettled([api?.stop(), e.stop()])
	void Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, 2000))]).finally(() => {
		tray?.destroy()
		tray = undefined
		// Exit directly: re-running quit from inside before-quit doesn't reliably finish, and
		// everything that needed doing (stopping cameras, closing ports) is done
		app.exit(0)
	})
})
