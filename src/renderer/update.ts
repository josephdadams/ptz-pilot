import type { UpdateApi } from '../preload/update-preload.js'
import type { ReleaseNote, UpdateView } from '../main/updater.js'

declare global {
	interface Window {
		updateApi: UpdateApi
	}
}

const api = window.updateApi
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!

const escape = (text: string) =>
	text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * The notes go in a frame that can't run anything, styled from this page's own stylesheet. Links
 * open a new window, which the main process sends to the browser.
 */
function notesDocument(notes: ReleaseNote[]): string {
	const body = notes.length
		? notes.map((n) => (notes.length > 1 ? `<h1 class="version">${escape(n.version)}</h1>` : '') + n.html).join('')
		: '<p>No release notes for this version.</p>'
	return `<!doctype html><html><head><base target="_blank" /><link rel="stylesheet" href="update.css" /></head><body class="notes">${body}</body></html>`
}

let shownNotes: ReleaseNote[] | undefined

function render(view: UpdateView | undefined): void {
	if (!view) return
	if (view.notes !== shownNotes) {
		shownNotes = view.notes
		$<HTMLIFrameElement>('#notes').srcdoc = notesDocument(view.notes)
	}

	const title = $('#title')
	const subtitle = $('#subtitle')
	const status = $('#status')
	const primary = $<HTMLButtonElement>('#primary')
	const later = $<HTMLButtonElement>('#later')
	const progress = $('#progress')

	subtitle.textContent = `PTZ Pilot ${view.version} is available. You have ${view.current}.`
	status.hidden = true
	status.className = 'muted'
	progress.hidden = true
	$('#skip').hidden = view.state !== 'available'
	$('#releases').hidden = view.state !== 'error'
	primary.disabled = false
	later.textContent = 'Remind Me Later'

	switch (view.state) {
		case 'available':
			title.textContent = 'A new version of PTZ Pilot is available'
			primary.textContent = 'Install Update'
			break
		case 'downloading':
			title.textContent = `Downloading PTZ Pilot ${view.version}`
			progress.hidden = false
			$('#progress-bar').style.width = `${Math.round(view.percent)}%`
			status.hidden = false
			status.textContent = `${Math.round(view.percent)}%. You can close this window; it will come back when the update is ready.`
			primary.textContent = 'Install Update'
			primary.disabled = true
			later.textContent = 'Hide'
			break
		case 'ready':
			title.textContent = `PTZ Pilot ${view.version} is ready to install`
			status.hidden = false
			status.textContent =
				'Restarting stops every camera for a moment. Not now, and it installs the next time PTZ Pilot quits.'
			primary.textContent = 'Restart Now'
			later.textContent = 'Install on Quit'
			break
		case 'error':
			title.textContent = "The update couldn't be installed"
			status.hidden = false
			status.className = 'error'
			status.textContent = view.message
			primary.textContent = 'Try Again'
			later.textContent = 'Close'
			break
	}
}

$('#primary').addEventListener('click', () => {
	void api.view().then((view: UpdateView | undefined) => {
		if (view?.state === 'ready') void api.restart()
		else void api.download()
	})
})
$('#later').addEventListener('click', () => void api.later())
$('#skip').addEventListener('click', () => void api.skip())
$('#releases').addEventListener('click', () => void api.openReleases())

api.onView((view) => render(view as UpdateView))
void api.view().then((view: UpdateView | undefined) => render(view))
