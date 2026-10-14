import { Menu, Tray, app, nativeImage, shell, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import type { EngineState } from './engine.js'
import type { Settings } from './settings.js'

export const DEVELOPER_URL = 'https://josephadams.dev'

export interface TrayHandle {
	update(settings: Settings, state: EngineState): void
	destroy(): void
}

export interface TrayActions {
	show(): void
	quit(): void
	checkForUpdates?(): void
	/** Point a controller at a camera, or at none */
	assign?(controllerId: string, cameraId: string | undefined): void
}

/** Whether a camera has answered recently; the engine checks in every few seconds */
function cameraLabel(state: EngineState, id: string): string {
	const status = state.cameras[id]
	if (!status?.connected) return 'not connected'
	if (status.lastReplyAt && Date.now() - status.lastReplyAt < 10_000) return 'responding'
	return status.lastReplyAt ? 'not responding' : 'waiting'
}

export function createTray(actions: TrayActions): TrayHandle {
	// macOS wants a monochrome "template" image it can tint for light and dark menu bars
	const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
	const image = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', file))
	if (process.platform === 'darwin') image.setTemplateImage(true)

	const tray = new Tray(image)
	tray.setToolTip('PTZ Pilot')
	// Rebuilding the menu is not free, and state arrives ~30 times a second
	let lastSummary = ''

	return {
		update(settings, state) {
			// State can still arrive while quitting, after the tray has gone
			if (tray.isDestroyed()) return
			const cameraItems = (controllerId: string, current: string | undefined): MenuItemConstructorOptions[] => [
				...settings.cameras.map((camera) => ({
					label: camera.name,
					type: 'radio' as const,
					checked: camera.id === current,
					click: () => actions.assign?.(controllerId, camera.id),
				})),
				{ type: 'separator' },
				{
					label: 'No camera',
					type: 'radio',
					checked: !current,
					click: () => actions.assign?.(controllerId, undefined),
				},
			]

			const connected = settings.controllers.filter((c) => state.controllers[c.id])
			const controllerItems: MenuItemConstructorOptions[] = connected.length
				? connected.map((c) => {
						const camera = settings.cameras.find((cam) => cam.id === c.cameraId)
						return { label: `${c.name} → ${camera?.name ?? 'no camera'}`, submenu: cameraItems(c.id, c.cameraId) }
					})
				: [{ label: 'No controllers connected', enabled: false }]

			const cameraStatusItems: MenuItemConstructorOptions[] = settings.cameras.length
				? settings.cameras.map((c) => ({ label: `${c.name}: ${cameraLabel(state, c.id)}`, enabled: false }))
				: [{ label: 'No cameras', enabled: false }]

			const template: MenuItemConstructorOptions[] = [
				{ label: 'Controllers', enabled: false },
				...controllerItems,
				{ type: 'separator' },
				{ label: 'Cameras', enabled: false },
				...cameraStatusItems,
				{ type: 'separator' },
				{ label: 'Show PTZ Pilot', click: actions.show },
				{ label: 'Quit PTZ Pilot', click: actions.quit },
				{ type: 'separator' },
				{ label: 'About PTZ Pilot', click: () => app.showAboutPanel() },
				{ label: 'Check for Updates…', click: () => actions.checkForUpdates?.() },
				{ label: 'About the Developer', click: () => void shell.openExternal(DEVELOPER_URL) },
			]

			const summary = JSON.stringify(template, (key, value) => (key === 'click' ? undefined : value))
			if (summary === lastSummary) return
			lastSummary = summary
			tray.setContextMenu(Menu.buildFromTemplate(template))
		},
		destroy() {
			tray.destroy()
		},
	}
}
