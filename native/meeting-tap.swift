/**
 * meeting-tap — captures everything the Mac is playing (all processes, whatever output
 * device they play to) through a Core Audio process tap, and writes it to stdout as raw
 * mono Float32 little-endian PCM at the requested sample rate.
 *
 * Unlike the BlackHole + Multi-Output approach, the system output device is never touched,
 * so meeting apps keep playing to the AirPods/speakers the user picked.
 *
 * macOS 14.2+. The "System Audio Recording" permission is attributed to the responsible
 * app (Obsidian when the plugin spawns this binary).
 *
 * Usage:
 *   meeting-tap [--rate 16000] [--exclude-pid PID]...   capture until SIGTERM/SIGINT or stdin EOF
 *   meeting-tap --check                                 print permission status and exit
 *
 * stderr: one JSON object per line ({"event": "ready" | "level" | "format" | "error", ...}).
 * Exit codes: 0 ok, 1 Core Audio error, 2 bad arguments, 3 permission denied.
 */

import AVFoundation
import CoreAudio
import Foundation

// MARK: - Output helpers

func emit(_ event: String, _ fields: [String: Any] = [:]) {
	var obj = fields
	obj["event"] = event
	if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
	   let line = String(data: data, encoding: .utf8) {
		FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
	}
}

func fail(_ message: String, status: OSStatus = 0, code: Int32 = 1) -> Never {
	emit("error", ["message": message, "status": Int(status)])
	exit(code)
}

// MARK: - Permission (private TCC SPI, same approach as Apple's own sample-adjacent tools)

enum Permission: String { case granted, denied, undetermined, unavailable }

private let tccHandle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)
private let tccService = "kTCCServiceAudioCapture" as CFString

func preflightPermission() -> Permission {
	typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
	guard let sym = dlsym(tccHandle, "TCCAccessPreflight") else { return .unavailable }
	switch unsafeBitCast(sym, to: Preflight.self)(tccService, nil) {
	case 0: return .granted
	case 1: return .denied
	default: return .undetermined
	}
}

/** Shows the system prompt (attributed to the responsible app) and waits for the answer. */
func requestPermission() -> Bool {
	typealias Request = @convention(c) (CFString, CFDictionary?, @escaping (Bool) -> Void) -> Void
	guard let sym = dlsym(tccHandle, "TCCAccessRequest") else { return false }
	let done = DispatchSemaphore(value: 0)
	var granted = false
	unsafeBitCast(sym, to: Request.self)(tccService, nil) { ok in
		granted = ok
		done.signal()
	}
	done.wait()
	return granted
}

// MARK: - Core Audio helpers

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
	AudioObjectPropertyAddress(
		mSelector: selector,
		mScope: kAudioObjectPropertyScopeGlobal,
		mElement: kAudioObjectPropertyElementMain
	)
}

func processObject(for pid: pid_t) -> AudioObjectID? {
	var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
	var pid = pid
	var object = AudioObjectID(kAudioObjectUnknown)
	var size = UInt32(MemoryLayout<AudioObjectID>.size)
	let status = AudioObjectGetPropertyData(
		AudioObjectID(kAudioObjectSystemObject), &addr,
		UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object
	)
	// Processes that have never touched Core Audio have no process object.
	return status == noErr && object != kAudioObjectUnknown ? object : nil
}

func tapFormat(_ tap: AudioObjectID) -> AudioStreamBasicDescription? {
	var addr = address(kAudioTapPropertyFormat)
	var asbd = AudioStreamBasicDescription()
	var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
	return AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, &asbd) == noErr ? asbd : nil
}

// MARK: - Arguments

var outputRate = 16_000.0
var excludePIDs: [pid_t] = []
var checkOnly = false

var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
	switch arg {
	case "--rate":
		guard let v = args.next().flatMap(Double.init), v > 0 else { fail("--rate needs a number", code: 2) }
		outputRate = v
	case "--exclude-pid":
		guard let v = args.next().flatMap(Int32.init) else { fail("--exclude-pid needs a PID", code: 2) }
		excludePIDs.append(v)
	case "--check":
		checkOnly = true
	default:
		fail("unknown argument \(arg)", code: 2)
	}
}

if checkOnly {
	print(preflightPermission().rawValue)
	exit(0)
}

// MARK: - Permission gate

switch preflightPermission() {
case .denied:
	fail("System audio recording permission denied", code: 3)
case .undetermined:
	emit("permission", ["state": "requesting"])
	if !requestPermission() { fail("System audio recording permission denied", code: 3) }
case .granted, .unavailable:
	break
}

// MARK: - Tap + private aggregate device

let excluded = excludePIDs.compactMap(processObject(for:))
let description = CATapDescription(monoGlobalTapButExcludeProcesses: excluded)
description.uuid = UUID()
description.name = "Meeting Recorder tap"
description.isPrivate = true
description.muteBehavior = .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
var status = AudioHardwareCreateProcessTap(description, &tapID)
guard status == noErr else { fail("AudioHardwareCreateProcessTap failed", status: status) }

guard var sourceASBD = tapFormat(tapID) else { fail("could not read tap format") }

// Tap-only aggregate: no hardware sub-device, so Bluetooth profile switches and
// disconnects of the user's output device cannot take the capture down with them.
let aggregateDescription: [String: Any] = [
	kAudioAggregateDeviceNameKey: "Meeting Recorder",
	kAudioAggregateDeviceUIDKey: "meeting-recorder-\(UUID().uuidString)",
	kAudioAggregateDeviceIsPrivateKey: true,
	kAudioAggregateDeviceIsStackedKey: false,
	kAudioAggregateDeviceSubDeviceListKey: [] as [Any],
	kAudioAggregateDeviceTapListKey: [
		[
			kAudioSubTapUIDKey: description.uuid.uuidString,
			kAudioSubTapDriftCompensationKey: true,
		],
	],
]

var aggregateID = AudioObjectID(kAudioObjectUnknown)
status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
guard status == noErr else {
	AudioHardwareDestroyProcessTap(tapID)
	fail("AudioHardwareCreateAggregateDevice failed", status: status)
}

func cleanup() {
	AudioHardwareDestroyAggregateDevice(aggregateID)
	AudioHardwareDestroyProcessTap(tapID)
}

// MARK: - Conversion to the requested rate

guard let sourceFormat = AVAudioFormat(streamDescription: &sourceASBD),
      let targetFormat = AVAudioFormat(
		commonFormat: .pcmFormatFloat32, sampleRate: outputRate, channels: 1, interleaved: false
      ),
      let converter = AVAudioConverter(from: sourceFormat, to: targetFormat)
else {
	cleanup()
	fail("unsupported tap format \(sourceASBD)")
}

let writeQueue = DispatchQueue(label: "meeting-tap.write")

// Level window for the periodic "level" event (written only on writeQueue).
var windowPeak: Float = 0
var windowSumSquares: Double = 0
var windowFrames = 0
var totalFrames = 0

func convertAndWrite(_ input: AVAudioPCMBuffer) {
	let capacity = AVAudioFrameCount(Double(input.frameLength) * outputRate / sourceFormat.sampleRate) + 32
	guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
	var consumed = false
	var error: NSError?
	converter.convert(to: output, error: &error) { _, outStatus in
		if consumed {
			outStatus.pointee = .noDataNow
			return nil
		}
		consumed = true
		outStatus.pointee = .haveData
		return input
	}
	guard error == nil, output.frameLength > 0, let samples = output.floatChannelData?[0] else { return }

	let count = Int(output.frameLength)
	for i in 0..<count {
		let s = samples[i]
		windowPeak = max(windowPeak, abs(s))
		windowSumSquares += Double(s * s)
	}
	windowFrames += count
	totalFrames += count

	// POSIX write so a closed pipe (parent gone) surfaces as EPIPE instead of an exception.
	var raw = UnsafeRawPointer(samples)
	var remaining = count * MemoryLayout<Float>.size
	while remaining > 0 {
		let n = write(STDOUT_FILENO, raw, remaining)
		if n < 0 {
			if errno == EINTR { continue }
			DispatchQueue.main.async { shutdown(0) }
			return
		}
		raw += n
		remaining -= n
	}
}

// MARK: - IO

var ioProcID: AudioDeviceIOProcID?
status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) { _, inInputData, _, _, _ in
	// Copy out of the real-time callback, convert and write off-thread.
	guard let copy = AVAudioPCMBuffer(
		pcmFormat: sourceFormat,
		bufferListNoCopy: inInputData,
		deallocator: nil
	).flatMap({ buffer -> AVAudioPCMBuffer? in
		guard let dup = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: buffer.frameLength) else { return nil }
		dup.frameLength = buffer.frameLength
		let src = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
		let dst = UnsafeMutableAudioBufferListPointer(dup.mutableAudioBufferList)
		for (s, d) in zip(src, dst) {
			if let from = s.mData, let to = d.mData {
				memcpy(to, from, Int(min(s.mDataByteSize, d.mDataByteSize)))
			}
		}
		return dup
	}) else { return }
	writeQueue.async { convertAndWrite(copy) }
}
guard status == noErr, let procID = ioProcID else {
	cleanup()
	fail("AudioDeviceCreateIOProcIDWithBlock failed", status: status)
}

status = AudioDeviceStart(aggregateID, procID)
guard status == noErr else {
	AudioDeviceDestroyIOProcID(aggregateID, procID)
	cleanup()
	fail("AudioDeviceStart failed", status: status)
}

emit("ready", [
	"sourceRate": sourceFormat.sampleRate,
	"sourceChannels": Int(sourceFormat.channelCount),
	"rate": outputRate,
	"excluded": excluded.count,
])

// Report if the tap's format changes mid-capture (e.g. output device sample-rate change).
var formatAddr = address(kAudioTapPropertyFormat)
AudioObjectAddPropertyListenerBlock(tapID, &formatAddr, writeQueue) { _, _ in
	if let f = tapFormat(tapID) {
		emit("format", ["sourceRate": f.mSampleRate, "sourceChannels": Int(f.mChannelsPerFrame)])
	}
}

// MARK: - Lifecycle

func shutdown(_ code: Int32) -> Never {
	if let ioProcID {
		AudioDeviceStop(aggregateID, ioProcID)
		AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
	}
	cleanup()
	writeQueue.sync {}
	emit("stopped", ["frames": totalFrames])
	exit(code)
}

let levelTimer = DispatchSource.makeTimerSource(queue: writeQueue)
levelTimer.schedule(deadline: .now() + 5, repeating: 5)
levelTimer.setEventHandler {
	let rms = windowFrames > 0 ? sqrt(windowSumSquares / Double(windowFrames)) : 0
	emit("level", ["peak": Double(windowPeak), "rms": rms, "frames": windowFrames])
	windowPeak = 0
	windowSumSquares = 0
	windowFrames = 0
}
levelTimer.resume()

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
signal(SIGPIPE, SIG_IGN)
var sources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
	let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
	source.setEventHandler { shutdown(0) }
	source.resume()
	sources.append(source)
}

// Exit when the parent closes our stdin (e.g. Obsidian quit without signalling us).
FileHandle.standardInput.readabilityHandler = { handle in
	if handle.availableData.isEmpty {
		handle.readabilityHandler = nil
		DispatchQueue.main.async { shutdown(0) }
	}
}

dispatchMain()
