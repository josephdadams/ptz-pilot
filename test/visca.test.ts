import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import net from 'node:net'
import { once } from 'node:events'
import { MockBinding, type MockPortBinding } from '@serialport/binding-mock'
import * as cmd from '../src/main/visca/commands.js'
import { parseReply, ViscaStreamSplitter, type ViscaReply } from '../src/main/visca/replies.js'
import { createTransport, setSerialBinding, sonyHeader, type ViscaTransport } from '../src/main/visca/transports.js'
import { Camera, PROFILES, type CameraConfig } from '../src/main/visca/camera.js'

const hex = (b: Buffer) => b.toString('hex').replace(/(..)(?!$)/g, '$1 ')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('pan-tilt encodes direction and speed', () => {
	assert.equal(hex(cmd.panTilt(1, 5, -3, 0x18, 0x14)), '81 01 06 01 05 03 02 02 ff')
	assert.equal(hex(cmd.panTilt(1, -24, 0, 0x18, 0x14)), '81 01 06 01 18 01 01 03 ff')
	// Clamped to the camera's range
	assert.equal(hex(cmd.panTilt(1, 99, 99, 0x18, 0x14)), '81 01 06 01 18 14 02 01 ff')
	assert.equal(hex(cmd.panTiltStop(3)), '83 01 06 01 01 01 03 03 ff')
})

test('zoom and focus use 1-based speeds onto 0-7', () => {
	assert.equal(hex(cmd.zoom(1, 1)), '81 01 04 07 20 ff')
	assert.equal(hex(cmd.zoom(1, 8)), '81 01 04 07 27 ff')
	assert.equal(hex(cmd.zoom(1, -4)), '81 01 04 07 33 ff')
	assert.equal(hex(cmd.zoom(1, 0)), '81 01 04 07 00 ff')
	assert.equal(hex(cmd.focus(1, -1)), '81 01 04 08 30 ff')
})

test('presets and misc', () => {
	assert.equal(hex(cmd.presetRecall(1, 5)), '81 01 04 3f 02 05 ff')
	assert.equal(hex(cmd.presetSet(2, 0)), '82 01 04 3f 01 00 ff')
	assert.equal(hex(cmd.home(1)), '81 01 06 04 ff')
	assert.throws(() => cmd.home(8))
	assert.throws(() => cmd.presetRecall(1, 256))
})

test('replies parse', () => {
	assert.deepEqual(parseReply(Buffer.from('9041ff', 'hex')), { kind: 'ack', address: 1, socket: 1 })
	const err = parseReply(Buffer.from('906103ff', 'hex'))
	assert.equal(err.kind, 'error')
	assert.equal(err.kind === 'error' && err.message, 'Command buffer full')
	const completion = parseReply(Buffer.from('a051ff', 'hex'))
	assert.equal(completion.kind === 'completion' && completion.address, 2)
})

test('stream splitter handles split and merged replies', () => {
	const s = new ViscaStreamSplitter()
	assert.deepEqual(s.push(Buffer.from('9041', 'hex')), [])
	assert.deepEqual(s.push(Buffer.from('ff9051ff', 'hex')).map(hex), ['90 41 ff', '90 51 ff'])
})

test('sony header', () => {
	assert.equal(hex(sonyHeader(0x0100, cmd.home(1), 0x01020304)), '01 00 00 05 01 02 03 04 81 01 06 04 ff')
})

function cameraConfig(partial: Partial<CameraConfig>): CameraConfig {
	return {
		id: 'test',
		name: 'Test',
		kind: 'sony-udp',
		host: '127.0.0.1',
		port: 0,
		serialPath: '',
		baudRate: 9600,
		address: 1,
		username: '',
		password: '',
		sendInterval: 10,
		profile: 'sony',
		...PROFILES.sony,
		...partial,
	}
}

test('sony udp: resets sequence, sends latest motion, repeats stops, refreshes', async () => {
	const server = dgram.createSocket('udp4')
	server.bind(0, '127.0.0.1')
	await once(server, 'listening')
	const received: { at: number; data: Buffer }[] = []
	server.on('message', (data, rinfo) => {
		received.push({ at: Date.now(), data })
		// Answer commands with an ack, like a camera would
		if (data.readUInt16BE(0) === 0x0100)
			server.send(sonyHeader(0x0111, Buffer.from('9041ff', 'hex'), data.readUInt32BE(4)), rinfo.port, rinfo.address)
	})

	const camera = new Camera(cameraConfig({ port: server.address().port }))
	camera.open()
	await sleep(30)

	// A burst of changes within one interval: only the last should go out
	camera.setMotion({ pan: 3, tilt: 0, zoom: 0, focus: 0 })
	camera.setMotion({ pan: 5, tilt: 2, zoom: 0, focus: 0 })
	await sleep(600)
	camera.stop()
	await sleep(60)

	assert.ok(camera.status.lastReplyAt, 'camera saw a reply')
	await camera.close()
	server.close()

	const packets = received.map((r) => hex(r.data))
	assert.equal(packets[0], '02 00 00 01 00 00 00 00 01', 'first packet resets the sequence number')

	const moves = received.filter((r) => r.data.readUInt16BE(0) === 0x0100).map((r) => hex(r.data.subarray(8)))
	assert.equal(moves[0], '81 01 06 01 05 02 02 01 ff', 'coalesced to the latest motion')
	assert.ok(moves.filter((m) => m === '81 01 06 01 05 02 02 01 ff').length >= 2, 'refreshed while held')
	const stops = moves.filter((m) => m === '81 01 06 01 01 01 03 03 ff')
	assert.ok(stops.length >= 2, `stop sent at least twice (got ${stops.length})`)

	// Sequence numbers increase by one
	const seqs = received.filter((r) => r.data.readUInt16BE(0) === 0x0100).map((r) => r.data.readUInt32BE(4))
	seqs.forEach((s, i) => i && assert.equal(s, seqs[i - 1] + 1))
})

test('tcp: bare VISCA, no header', async () => {
	const chunks: Buffer[] = []
	const server = net.createServer((socket) => socket.on('data', (d) => chunks.push(d)))
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const port = (server.address() as net.AddressInfo).port

	const camera = new Camera(cameraConfig({ kind: 'tcp', port }))
	camera.open()
	await sleep(50)
	camera.setMotion({ pan: 0, tilt: 0, zoom: 3, focus: 0 })
	await sleep(50)
	await camera.close()
	server.close()

	const stream = hex(Buffer.concat(chunks))
	// An idle check-in may go first; the zoom must follow, bare, with no header
	assert.match(stream, /^(81 09 04 00 ff )?81 01 04 07 22 ff/)
})

test('sony udp: replies sent to port 52381 rather than the source port are received', async (t) => {
	// Needs 52381 free on this machine, which a running copy of the app would hold
	const probe = dgram.createSocket('udp4')
	const free = await new Promise<boolean>((resolve) => {
		probe.once('error', () => resolve(false))
		probe.bind(52381, () => resolve(true))
	})
	probe.close()
	if (!free) return t.skip('port 52381 is in use')

	const server = dgram.createSocket('udp4')
	server.bind(0, '127.0.0.1')
	await once(server, 'listening')
	server.on('message', (data) => {
		// Like the real camera: always answer to 52381, whatever port the command came from
		server.send(sonyHeader(0x0111, Buffer.from('9041ff', 'hex'), data.readUInt32BE(4)), 52381, '127.0.0.1')
	})

	const camera = new Camera(cameraConfig({ port: server.address().port }))
	camera.open()
	await sleep(100)
	const replied = camera.status.lastReplyAt !== undefined
	await camera.close()
	server.close()
	assert.ok(replied, 'reply to 52381 reached the camera')
})

test('a stop goes ahead of a speed change on another axis', async () => {
	const server = dgram.createSocket('udp4')
	server.bind(0, '127.0.0.1')
	await once(server, 'listening')
	const received: string[] = []
	server.on('message', (data) => received.push(hex(data)))

	const camera = new Camera(cameraConfig({ kind: 'udp', port: server.address().port, sendInterval: 40 }))
	camera.open()
	await sleep(60)
	camera.setMotion({ pan: 5, tilt: 0, zoom: 0, focus: 0 })
	await sleep(80)
	// Zoom has waited longer than pan, but letting go of pan must not wait behind it
	camera.setMotion({ pan: 0, tilt: 0, zoom: 3, focus: 0 })
	await sleep(120)
	await camera.close()
	server.close()

	const stop = received.indexOf('81 01 06 01 01 01 03 03 ff')
	const zoom = received.indexOf('81 01 04 07 22 ff')
	assert.ok(stop >= 0 && zoom >= 0, 'both sent')
	assert.ok(stop < zoom, `stop before zoom (got ${received.join(' | ')})`)
})


const MOCK_SERIAL_PATH = '/dev/ptz-chain'

/**
 * A virtual serial device that can be used by multiple cameras. Spies on MockBinding.open to
 * (a) count how many underlying ports are really opened for the path and
 * (b) grab the live binding so the test can push inbound bytes, as a camera on the chain would answer.
 */
function mockSerialDevice() {
	MockBinding.reset()
	MockBinding.createPort(MOCK_SERIAL_PATH, { echo: false, record: true })
	setSerialBinding(MockBinding)

	const opened: MockPortBinding[] = []
	const open = MockBinding.open.bind(MockBinding)
	MockBinding.open = async (options) => {
		const binding = (await open(options)) as MockPortBinding
		opened.push(binding)
		return binding
	}

	return {
		/** Every underlying port opened for the shared path; should be exactly one per device */
		opened,
		/** The one live port, to feed inbound replies through */
		get device(): MockPortBinding {
			return opened[opened.length - 1]
		},
		restore() {
			MockBinding.open = open
			setSerialBinding(undefined)
			MockBinding.reset()
		},
	}
}

/** A serial transport for one camera on the chain, with its replies and connected state captured */
function serialCamera(address: number) {
	const transport: ViscaTransport = createTransport({
		kind: 'serial',
		host: '',
		port: 0,
		serialPath: MOCK_SERIAL_PATH,
		baudRate: 9600,
		address,
	})
	const replies: ViscaReply[] = []
	let connected = false
	transport.on('reply', (reply) => replies.push(reply))
	transport.on('status', (up) => (connected = up))
	transport.open()
	return {
		transport,
		replies,
		get connected() {
			return connected
		},
	}
}

/** y0 ...: a VISCA ack from a camera, where y = address + 8, so address 1 -> 0x90, address 3 -> 0xB0 */
const ackFrom = (address: number) => Buffer.from([((address + 8) << 4) | 0x00, 0x41, 0xff])

// One parent test so the subtests run in order: they share the global mock binding and the one
// shared serial port keyed by path, so they must not overlap the way the IP tests (own sockets) can.
test('serial daisy chain shares one port and routes replies by address', async (t) => {
	await t.test('two cameras on one path both open through a single shared port', async () => {
		const mock = mockSerialDevice()
		const camera1 = serialCamera(1)
		const camera3 = serialCamera(3)
		await sleep(30)

		// Neither open failed with a busy/lock error, and both reached connected
		assert.ok(camera1.connected, 'camera 1 opened')
		assert.ok(camera3.connected, 'camera 3 opened')
		// one real port for the path, not one per camera
		assert.equal(mock.opened.length, 1, 'only one underlying serial port was opened for the path')

		await camera1.transport.close()
		await camera3.transport.close()
		await sleep(10)
		mock.restore()
	})

	await t.test('replies route to the camera whose address matches the source byte', async () => {
		const mock = mockSerialDevice()
		const camera1 = serialCamera(1)
		const camera3 = serialCamera(3)
		await sleep(30)

		// parseReply reads the source address as (raw[0] >> 4) - 8, so these acks name 1 and 3
		mock.device.emitData(ackFrom(1))
		mock.device.emitData(ackFrom(3))
		await sleep(30)

		assert.equal(camera1.replies.length, 1, 'camera 1 heard exactly its own ack')
		assert.equal(camera1.replies[0].kind === 'ack' && camera1.replies[0].address, 1)
		assert.equal(camera3.replies.length, 1, 'camera 3 heard exactly its own ack')
		assert.equal(camera3.replies[0].kind === 'ack' && camera3.replies[0].address, 3)

		await camera1.transport.close()
		await camera3.transport.close()
		await sleep(10)
		mock.restore()
	})

	await t.test('the last camera closing mid-open does not orphan the port, and the path stays reusable', async () => {
		const mock = mockSerialDevice()

		// Close the sole camera in the same tick it opened, with no sleep in between, so close() runs
		// while the port's open() is still in flight.
		const camera1 = serialCamera(1)
		await camera1.transport.close()
		await sleep(30)

		// The open resolved to a port nothing owns; it must have been closed, not left holding the lock
		assert.equal(mock.opened.length, 1, 'one underlying port was opened by the mid-open camera')
		assert.equal(mock.opened[0].isOpen, false, 'the orphaned port was closed, not left open')

		// And because the lock was released, a fresh camera can open the same path again
		const camera1b = serialCamera(1)
		await sleep(30)
		assert.ok(camera1b.connected, 'a new camera opens the same path after the mid-open close')
		assert.equal(mock.opened.length, 2, 'the reused path opened a second, clean port')
		assert.ok(mock.opened[1].isOpen, 'the reused port is open')

		await camera1b.transport.close()
		await sleep(10)
		mock.restore()
	})

	await t.test('an unknown reply still reaches the sole camera on a one-camera chain', async () => {
		const mock = mockSerialDevice()
		const camera1 = serialCamera(1)
		await sleep(30)

		// A frame that parseReply cannot address (wrong shape: no valid y0..FF) comes back as 'unknown'.
		// A lone serial camera used to see every reply, so the one camera on the chain should still get it.
		mock.device.emitData(Buffer.from([0x01, 0x02, 0x03, 0xff]))
		await sleep(20)

		assert.equal(camera1.replies.length, 1, 'the sole camera received the unaddressable reply')
		assert.equal(camera1.replies[0].kind, 'unknown', 'it arrived as an unknown reply')

		await camera1.transport.close()
		await sleep(10)
		mock.restore()
	})

	await t.test('an unknown reply is dropped when more than one camera shares the chain', async () => {
		const mock = mockSerialDevice()
		const camera1 = serialCamera(1)
		const camera3 = serialCamera(3)
		await sleep(30)

		// With two cameras there is no way to attribute an unaddressable frame, so it is dropped
		mock.device.emitData(Buffer.from([0x01, 0x02, 0x03, 0xff]))
		await sleep(20)

		assert.equal(camera1.replies.length, 0, 'camera 1 did not receive the unaddressable reply')
		assert.equal(camera3.replies.length, 0, 'camera 3 did not receive the unaddressable reply')

		await camera1.transport.close()
		await camera3.transport.close()
		await sleep(10)
		mock.restore()
	})

	await t.test('closing a camera during the prior teardown wait does not hang, and the path reopens', async () => {
		const mock = mockSerialDevice()

		// Open a camera, then close it to start its teardown. The teardown is published to #closings.
		const camera1 = serialCamera(1)
		await sleep(30)
		assert.ok(camera1.connected, 'first camera opened')
		const firstClose = camera1.transport.close()

		// Immediately re-acquire the same path while the prior instance is still tearing down.
		const camera2 = serialCamera(1)

		// Close that camera DURING the wait window.
		const camera2Close = camera2.transport.close()
		const timedOut = Symbol('timeout')
		const closeResult = await Promise.race([camera2Close.then(() => 'closed'), sleep(500).then(() => timedOut)])
		assert.equal(closeResult, 'closed', 'close() during the teardown wait resolved instead of hanging')

		await firstClose
		await sleep(30)

		// The #closings entry drained, so a fresh camera can still open the same path.
		const camera3 = serialCamera(1)
		await sleep(30)
		assert.ok(camera3.connected, 'a new camera opens the same path after the close-during-wait')

		await camera3.transport.close()
		await sleep(10)
		mock.restore()
	})

	await t.test('closing one camera leaves the other working, port closes with the last', async () => {
		const mock = mockSerialDevice()
		const camera1 = serialCamera(1)
		const camera3 = serialCamera(3)
		await sleep(30)
		const device = mock.device

		// Camera 1 leaves; the shared port stays open for camera 3
		await camera1.transport.close()
		await sleep(10)
		assert.ok(device.isOpen, 'shared port still open after one camera closes')

		// Camera 3 still writes to the one device...
		camera3.transport.send(cmd.home(3), 'command')
		await sleep(10)
		assert.equal(hex(device.recording), hex(cmd.home(3)), 'camera 3 write still reached the device')

		// ...and still receives its routed replies
		device.emitData(ackFrom(3))
		await sleep(20)
		assert.equal(camera3.replies.length, 1, 'camera 3 still receives replies')

		// The last camera leaving tears the real port down
		await camera3.transport.close()
		await sleep(20)
		assert.equal(device.isOpen, false, 'underlying port closed once the last camera left')
		mock.restore()
	})
})
