# PTZ Pilot WebSocket API

PTZ Pilot runs a WebSocket server for remote control and telemetry — the Companion module uses it,
and anything else that speaks WebSockets can too.

- **Address:** `ws://127.0.0.1:8765` by default. The port, and whether other computers may connect,
  are under **Settings** in the app.
- **Format:** every message is a JSON object with a `type`.
- **Version:** this is API version **1**, as reported in `hello`.

There is no authentication. By default only this computer can connect; allow other computers only on
a network you trust.

## Messages from PTZ Pilot

### `hello`

Sent once, when you connect.

```json
{ "type": "hello", "app": "PTZ Pilot", "version": "0.1.0", "apiVersion": 1 }
```

### `state`

Sent when you connect, and again whenever cameras or controllers change: added, renamed, connected,
reassigned, or their health changes.

```json
{
	"type": "state",
	"activeCamera": "b4c7…",
	"cameras": [
		{
			"id": "b4c7…",
			"number": 1,
			"name": "Stage Left",
			"protocol": "sony-udp",
			"address": "10.0.0.81:52381",
			"status": "responding",
			"controllers": ["hid:3032…"]
		}
	],
	"controllers": [
		{
			"id": "hid:3032…",
			"name": "Xbox Wireless Controller",
			"kind": "gamepad",
			"connected": true,
			"live": true,
			"camera": "b4c7…"
		}
	]
}
```

| Field                   | Meaning                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `activeCamera`          | The camera the window is showing, which requests without a `camera` act on                                                |
| `cameras[].protocol`    | `sony-udp`, `udp`, `tcp`, `serial`, `canon`, `hikvision`, `panasonic`, `hanwha`, `onvif`, `kxwell-serial` or `kxwell-tcp` |
| `cameras[].status`      | `responding`, `not-responding`, `waiting` (no reply yet), `not-connected` or `error`                                      |
| `cameras[].error`       | With `status: "error"`, what went wrong                                                                                   |
| `cameras[].controllers` | Connected controllers currently driving this camera                                                                       |
| `controllers[].kind`    | `gamepad`, `dji` or `spacemouse`                                                                                          |
| `controllers[].live`    | Connected and reporting; `false` while it has gone quiet (and its camera is stopped)                                      |
| `controllers[].camera`  | The camera it drives, or `null`                                                                                           |

Disconnected controllers are included, with `connected: false`, so their assignments can be shown.

### `telemetry`

What every camera and controller is doing, sent up to 10 times a second while it changes.

```json
{
	"type": "telemetry",
	"cameras": { "b4c7…": { "pan": -24, "tilt": 3, "zoom": 0, "focus": 0 } },
	"controllers": { "hid:3032…": { "pan": -24, "tilt": 3, "zoom": 0, "focus": 0 } }
}
```

Speeds are signed: pan positive is right, tilt positive is up, zoom positive is in (tele), focus
positive is far. Pan and tilt run up to the camera's maximum (24 for pan on most cameras); zoom and
focus run 1–8, for the camera's speeds 0–7. `0` is stopped.

A camera's speeds combine every controller and API client driving it: for each movement, whichever
pushes hardest.

### `response`

The outcome of a request that carried an `id`:

```json
{ "type": "response", "id": 7, "ok": true }
{ "type": "response", "id": 8, "ok": false, "error": "No camera \"Stage Rigt\"" }
```

Failed requests are always answered, with or without an `id`.

## Requests

Add an `id` (any string or number) to get a `response`.

Wherever a request takes a `camera`, it may be the camera's `id`, its name (any case), or its
`number` in the list. Leave it out to act on the camera the window is showing. Controllers are
named by `id` or name.

| Request                | Fields                                        | Does                                                                      |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| `getState`             | —                                             | Answers with the current `state` as `result`                              |
| `selectCamera`         | `camera`                                      | Shows that camera in the window                                           |
| `setControllerCamera`  | `controller`, `camera` (or `null`)            | Points a controller at a camera, or at none                               |
| `stepControllerCamera` | `controller`, `step` (`1` or `-1`)            | Moves a controller to the next or previous camera                         |
| `presetRecall`         | `preset` (1–256), `camera`?                   | Recalls a preset, numbered from 1 as in the window                        |
| `presetStore`          | `preset` (1–256), `camera`?                   | Stores the camera's current position as a preset                          |
| `home`                 | `camera`?                                     | Sends the camera home                                                     |
| `onePushFocus`         | `camera`?                                     | Focuses once, then holds                                                  |
| `autoFocus`            | `enabled`, `camera`?                          | Turns autofocus on or off                                                 |
| `move`                 | `camera`?, `pan`?, `tilt`?, `zoom`?, `focus`? | Starts or changes a movement (see below)                                  |
| `stop`                 | `camera`?                                     | Stops your movements: on that camera, or with no `camera`, on all of them |

### Moving cameras

`move` takes each movement as a fraction of the camera's top speed, from `-1` to `1`. Movements you
leave out keep their current value, so `pan` and `zoom` can be driven separately.

```json
{ "type": "move", "camera": "Stage Left", "pan": -0.5 }
{ "type": "move", "camera": "Stage Left", "zoom": 1 }
{ "type": "stop", "camera": "Stage Left" }
```

A movement holds until you change it, `stop` it, or disconnect. Connections are checked every 5
seconds, and one that stops answering is dropped — so a crashed client can't leave a camera
turning.
