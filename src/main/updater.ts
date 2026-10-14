/**
 * Updates from the GitHub releases electron-builder publishes. Nothing downloads or installs
 * without asking: a new version opens a window with its release notes, and the app only restarts
 * when told to, since restarting stops every camera for a moment.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'

const RELEASES_URL = 'https://github.com/josephdadams/ptz-pilot/releases'
/** Long enough for the app to settle and controllers to connect before the network is asked */
const FIRST_CHECK_DELAY = 10_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

export interface ReleaseNote {
	version: string
	/** As GitHub renders the release's description */
	html: string
}

/** What the update window shows */
export type UpdateView =
	| { state: 'available'; version: string; current: string; notes: ReleaseNote[] }
	| { state: 'downloading'; version: string; current: string; notes: ReleaseNote[]; percent: number }
	| { state: 'ready'; version: string; current: string; notes: ReleaseNote[] }
	| { state: 'error'; version: string; current: string; notes: ReleaseNote[]; message: string }

export interface UpdaterHooks {
	/** Just before the app quits to install: anything keeping windows open has to let them close */
	beforeInstall(): void
}

/** Release notes for every version between this one and the new one, newest first */
export function releaseNotes(info: Pick<UpdateInfo, 'version' | 'releaseNotes'>): ReleaseNote[] {
	const notes = info.releaseNotes
	if (!notes) return []
	if (typeof notes === 'string') return [{ version: info.version, html: notes }]
	return notes.filter((n) => n.note).map((n) => ({ version: n.version, html: n.note! }))
}

/** The version the user said not to be told about again, kept apart from the settings */
class SkippedVersion {
	readonly #file = path.join(app.getPath('userData'), 'update.json')

	get(): string | undefined {
		try {
			const { skipped } = JSON.parse(readFileSync(this.#file, 'utf8')) as { skipped?: unknown }
			return typeof skipped === 'string' ? skipped : undefined
		} catch {
			return undefined
		}
	}

	set(version: string | undefined): void {
		try {
			writeFileSync(this.#file, JSON.stringify({ skipped: version }))
		} catch {
			// Worst case they're told about it again
		}
	}
}

export class Updater {
	readonly #hooks: UpdaterHooks
	readonly #skipped = new SkippedVersion()
	#view: UpdateView | undefined
	#window: BrowserWindow | undefined
	#timer: ReturnType<typeof setInterval> | undefined
	/** A check the user asked for, so they hear back even when there's nothing new */
	#manual = false
	#checking = false

	constructor(hooks: UpdaterHooks) {
		this.#hooks = hooks
		autoUpdater.autoDownload = false
		// Chose "later" once it's downloaded: it goes in the next time the app quits
		autoUpdater.autoInstallOnAppQuit = true
		// Notes for every version since this one, not just the newest
		autoUpdater.fullChangelog = true
		autoUpdater.logger = null
		// Lets a copy run from source check too, against dev-app-update.yml, for trying this out
		if (process.env.PTZ_PILOT_UPDATE_TEST) autoUpdater.forceDevUpdateConfig = true

		autoUpdater.on('update-available', (info) => this.#onAvailable(info))
		autoUpdater.on('update-not-available', () => this.#onNotAvailable())
		autoUpdater.on('download-progress', (progress: ProgressInfo) => this.#onProgress(progress))
		autoUpdater.on('update-downloaded', () => this.#show({ ...this.#base(), state: 'ready' }))
		autoUpdater.on('error', (err) => this.#onError(err))

		ipcMain.handle('update:view', () => this.#view)
		ipcMain.handle('update:download', () => this.#download())
		ipcMain.handle('update:later', () => this.#window?.close())
		ipcMain.handle('update:skip', () => {
			if (this.#view) this.#skipped.set(this.#view.version)
			this.#window?.close()
		})
		ipcMain.handle('update:restart', () => this.#install())
		ipcMain.handle('update:releases', () => shell.openExternal(RELEASES_URL))
	}

	/** Check now and every few hours. Only a packaged app has anything to update. */
	start(): void {
		if (!app.isPackaged && !autoUpdater.forceDevUpdateConfig) return
		setTimeout(() => void this.check(false), FIRST_CHECK_DELAY)
		this.#timer = setInterval(() => void this.check(false), CHECK_INTERVAL)
	}

	stop(): void {
		clearInterval(this.#timer)
	}

	/** `manual` for a check the user asked for: it says so when there's nothing new, and ignores a skip */
	async check(manual: boolean): Promise<void> {
		// Already found one: a manual check just brings the window back
		if (this.#view && this.#view.state !== 'error') {
			if (manual) this.#show(this.#view)
			return
		}
		if (this.#checking) {
			this.#manual ||= manual
			return
		}
		if (manual && !app.isPackaged && !autoUpdater.forceDevUpdateConfig) {
			void this.#tell('Updates are only checked for in the installed app', 'This copy is running from source.')
			return
		}
		this.#checking = true
		this.#manual = manual
		try {
			await autoUpdater.checkForUpdates()
		} catch {
			// Reported through the error event
		} finally {
			this.#checking = false
		}
	}

	#base(): Omit<UpdateView, 'state'> {
		const { version = '', current = app.getVersion(), notes = [] } = this.#view ?? {}
		return { version, current, notes }
	}

	#onAvailable(info: UpdateInfo): void {
		const manual = this.#manual
		this.#manual = false
		if (!manual && this.#skipped.get() === info.version) return
		this.#show({ state: 'available', version: info.version, current: app.getVersion(), notes: releaseNotes(info) })
	}

	#onNotAvailable(): void {
		if (!this.#manual) return
		this.#manual = false
		void this.#tell("You're up to date", `PTZ Pilot ${app.getVersion()} is the newest version.`)
	}

	#onProgress(progress: ProgressInfo): void {
		if (this.#view?.state !== 'downloading') return
		this.#view = { ...this.#view, percent: progress.percent }
		this.#send()
	}

	#onError(err: Error): void {
		const manual = this.#manual
		this.#manual = false
		// A failed background check (offline, say) isn't worth interrupting anyone for
		if (!this.#view) {
			if (manual) void this.#tell("Couldn't check for updates", err.message)
			return
		}
		this.#show({ ...this.#base(), state: 'error', message: err.message })
	}

	#download(): void {
		if (this.#view?.state !== 'available' && this.#view?.state !== 'error') return
		this.#skipped.set(undefined)
		this.#view = { ...this.#base(), state: 'downloading', percent: 0 }
		this.#send()
		autoUpdater.downloadUpdate().catch(() => undefined)
	}

	#install(): void {
		if (this.#view?.state !== 'ready') return
		this.#hooks.beforeInstall()
		autoUpdater.quitAndInstall()
	}

	#show(view: UpdateView): void {
		this.#view = view
		if (this.#window && !this.#window.isDestroyed()) {
			this.#send()
			this.#window.show()
			return
		}
		const win = new BrowserWindow({
			width: 620,
			height: 640,
			minWidth: 480,
			minHeight: 420,
			title: 'Software Update',
			backgroundColor: '#15171a',
			show: false,
			fullscreenable: false,
			webPreferences: {
				preload: path.join(__dirname, '../preload/update-preload.js'),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		})
		this.#window = win
		// Links in the notes open in the browser
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (url.startsWith('https://')) void shell.openExternal(url)
			return { action: 'deny' }
		})
		win.webContents.on('will-navigate', (event) => event.preventDefault())
		win.once('ready-to-show', () => {
			if (process.platform === 'darwin') void app.dock?.show()
			win.show()
		})
		win.on('closed', () => {
			if (this.#window === win) this.#window = undefined
			// Back to living in the menu bar, if that's where the app was
			const visible = BrowserWindow.getAllWindows().some((w) => w !== win && w.isVisible())
			if (process.platform === 'darwin' && !visible) app.dock?.hide()
			// Turned down: forget it, so the next check can offer it again
			if (this.#view?.state === 'available' || this.#view?.state === 'error') this.#view = undefined
		})
		void win.loadFile(path.join(app.getAppPath(), 'src/renderer/update.html'))
	}

	#send(): void {
		if (this.#window && !this.#window.isDestroyed()) this.#window.webContents.send('update:view', this.#view)
	}

	async #tell(message: string, detail: string): Promise<void> {
		await dialog.showMessageBox({ type: 'info', message, detail })
	}
}
