import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** All the update window can do */
const updateApi = {
	view: () => ipcRenderer.invoke('update:view'),
	download: () => ipcRenderer.invoke('update:download'),
	later: () => ipcRenderer.invoke('update:later'),
	skip: () => ipcRenderer.invoke('update:skip'),
	restart: () => ipcRenderer.invoke('update:restart'),
	openReleases: () => ipcRenderer.invoke('update:releases'),
	onView: (listener: (view: unknown) => void) => {
		ipcRenderer.on('update:view', (_event: IpcRendererEvent, view: unknown) => listener(view))
	},
}

contextBridge.exposeInMainWorld('updateApi', updateApi)

export type UpdateApi = typeof updateApi
