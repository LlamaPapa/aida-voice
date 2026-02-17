import AVFoundation
import Foundation

// ── Configuration ────────────────────────────────────────────
let sampleRate: Double = 16000
let channels: UInt32 = 1
let bitDepth: UInt32 = 16
let socketPath = (ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()) + "aida-voice-helper.sock"
let tempDir = (ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()) + "voice-pipeline/"
let levelFilePath = (ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()) + "aida-voice-level"

// ── Audio Engine ─────────────────────────────────────────────
let engine = AVAudioEngine()
let audioQueue = DispatchQueue(label: "com.aida.audio", qos: .userInteractive)
var audioBuffer = Data()
var isRecording = false
var tapInstalled = false
var lastLevelWrite: Date = .distantPast

/// Enable Apple's Voice Processing on the input node.
/// Gives us noise suppression, echo cancellation, and AGC for free.
func enableVoiceProcessing() {
    let inputNode = engine.inputNode
    do {
        try inputNode.setVoiceProcessingEnabled(true)
        log("Voice processing ENABLED (noise suppression + echo cancel + AGC)")
    } catch {
        log("WARNING: voice processing unavailable: \(error) — using raw mic input")
    }
}

/// Install the tap once and keep it running. The isRecording flag gates buffering.
/// Tap uses hardware native format; we downsample + convert to 16kHz mono int16 in the callback.
func installPersistentTap() {
    guard !tapInstalled else { return }

    let inputNode = engine.inputNode
    let hwFormat = inputNode.outputFormat(forBus: 0)

    log("Hardware format: \(hwFormat)")
    log("Target: \(Int(sampleRate)) Hz, mono, int16")

    let hwRate = hwFormat.sampleRate
    let decimationRatio = hwRate / sampleRate  // e.g. 48000/16000 = 3

    // Use nil format = hardware native format (avoids format mismatch crash)
    inputNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { (buffer, _) in
        guard let floatData = buffer.floatChannelData else { return }
        let srcFrames = Int(buffer.frameLength)
        let src = floatData[0]

        var recording = false
        audioQueue.sync { recording = isRecording }

        // Compute RMS level from raw samples (always, for the level file)
        var sumSq: Float = 0
        let step = max(1, srcFrames / 256) // subsample for speed
        var count = 0
        for i in stride(from: 0, to: srcFrames, by: step) {
            sumSq += src[i] * src[i]
            count += 1
        }
        let rms = sqrt(sumSq / Float(max(count, 1)))
        // Log-scale mapping: makes quiet sounds visible, loud sounds dramatic
        // RMS range: ~0.005 (silence) to ~0.3 (loud speech)
        // Convert to dB-ish scale, then normalize to 0..1
        let dbish = 20.0 * log10(max(rms, 0.0001))  // -80 to ~-5 dB
        let level = min(1.0, max(0.0, (dbish + 50.0) / 40.0))  // map -50..-10 dB → 0..1

        // Write level file ~15x/sec while recording
        if recording {
            let now = Date()
            if now.timeIntervalSince(lastLevelWrite) >= 0.065 {
                lastLevelWrite = now
                let str = String(format: "%.3f", level)
                try? str.write(toFile: levelFilePath, atomically: true, encoding: .utf8)
            }
        }

        guard recording else { return }

        // Downsample: pick every Nth sample (simple decimation)
        let dstFrames = Int(Double(srcFrames) / decimationRatio)
        guard dstFrames > 0 else { return }

        var int16Data = Data(count: dstFrames * 2)
        int16Data.withUnsafeMutableBytes { rawBuf in
            let dst = rawBuf.bindMemory(to: Int16.self)
            for i in 0..<dstFrames {
                let srcIdx = Int(Double(i) * decimationRatio)
                guard srcIdx < srcFrames else { break }
                let clamped = max(-1.0, min(1.0, src[srcIdx]))
                dst[i] = Int16(clamped * 32767.0)
            }
        }

        audioQueue.async {
            if isRecording {
                audioBuffer.append(int16Data)
            }
        }
    }

    tapInstalled = true
    log("Persistent tap installed (decimation ratio: \(decimationRatio))")
}

func startCapture() {
    audioQueue.sync {
        audioBuffer = Data()
        isRecording = true
    }
    log("Capture started (buffering audio)")
}

/// Trim leading and trailing silence from int16 PCM data.
/// Uses an energy-based VAD: scans in chunks, finds first/last chunk above threshold.
/// Keeps a small padding (100ms) on each side so Whisper has context.
func trimSilence(_ pcmData: Data) -> Data {
    let bytesPerSample = 2
    let totalSamples = pcmData.count / bytesPerSample
    guard totalSamples > 0 else { return pcmData }

    let chunkSamples = Int(sampleRate * 0.03)  // 30ms chunks
    let chunkCount = totalSamples / chunkSamples
    guard chunkCount > 0 else { return pcmData }

    // Compute RMS per chunk
    var chunkRMS = [Float](repeating: 0, count: chunkCount)
    pcmData.withUnsafeBytes { rawBuf in
        let samples = rawBuf.bindMemory(to: Int16.self)
        for c in 0..<chunkCount {
            var sumSq: Float = 0
            let offset = c * chunkSamples
            for i in 0..<chunkSamples {
                let s = Float(samples[offset + i]) / 32767.0
                sumSq += s * s
            }
            chunkRMS[c] = sqrt(sumSq / Float(chunkSamples))
        }
    }

    // Threshold: 3x the minimum RMS (noise floor), with a floor of 0.005
    let noiseFloor = chunkRMS.min() ?? 0
    let threshold = max(0.005, noiseFloor * 3.0)

    // Find first and last chunk above threshold
    var firstSpeech = 0
    var lastSpeech = chunkCount - 1
    for i in 0..<chunkCount {
        if chunkRMS[i] > threshold { firstSpeech = i; break }
    }
    for i in stride(from: chunkCount - 1, through: 0, by: -1) {
        if chunkRMS[i] > threshold { lastSpeech = i; break }
    }

    // Add padding: 100ms (~3 chunks) on each side
    let padChunks = 3
    firstSpeech = max(0, firstSpeech - padChunks)
    lastSpeech = min(chunkCount - 1, lastSpeech + padChunks)

    let startByte = firstSpeech * chunkSamples * bytesPerSample
    let endByte = min(pcmData.count, (lastSpeech + 1) * chunkSamples * bytesPerSample)

    guard endByte > startByte else { return pcmData }

    let trimmed = pcmData.subdata(in: startByte..<endByte)
    let trimmedMs = (pcmData.count - trimmed.count) / Int(sampleRate * 2) * 1000
    if trimmedMs > 100 {
        log("VAD trimmed \(trimmedMs)ms of silence (\(pcmData.count) → \(trimmed.count) bytes)")
    }
    return trimmed
}

func stopCapture() -> String? {
    var pcmData = Data()
    audioQueue.sync {
        isRecording = false
        pcmData = audioBuffer
        audioBuffer = Data()
    }

    // Clear the level file so Hammerspoon bars go flat
    try? "0".write(toFile: levelFilePath, atomically: true, encoding: .utf8)

    if pcmData.isEmpty {
        log("WARNING: no audio data captured")
    }

    // Trim leading/trailing silence (VAD)
    pcmData = trimSilence(pcmData)

    // Write WAV file
    let filePath = tempDir + "recording-\(Int(Date().timeIntervalSince1970 * 1000)).wav"
    let wavData = makeWAV(pcmData: pcmData)

    do {
        try FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)
        try wavData.write(to: URL(fileURLWithPath: filePath))
        let durationMs = Int(Double(pcmData.count) / (sampleRate * Double(channels) * Double(bitDepth / 8)) * 1000)
        log("WAV written: \(filePath) (\(pcmData.count) bytes PCM, \(durationMs)ms)")
        return filePath
    } catch {
        log("ERROR: write failed: \(error)")
        return nil
    }
}

func makeWAV(pcmData: Data) -> Data {
    var wav = Data()
    let dataSize = UInt32(pcmData.count)
    let fileSize = 36 + dataSize

    // RIFF header
    wav.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // "RIFF"
    wav.append(withUnsafeBytes(of: fileSize.littleEndian) { Data($0) })
    wav.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // "WAVE"

    // fmt chunk
    wav.append(contentsOf: [0x66, 0x6D, 0x74, 0x20]) // "fmt "
    wav.append(withUnsafeBytes(of: UInt32(16).littleEndian) { Data($0) })       // chunk size
    wav.append(withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) })        // PCM format
    wav.append(withUnsafeBytes(of: UInt16(channels).littleEndian) { Data($0) }) // channels
    wav.append(withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Data($0) }) // sample rate
    let byteRate = UInt32(sampleRate) * channels * (bitDepth / 8)
    wav.append(withUnsafeBytes(of: byteRate.littleEndian) { Data($0) })         // byte rate
    let blockAlign = UInt16(channels * (bitDepth / 8))
    wav.append(withUnsafeBytes(of: blockAlign.littleEndian) { Data($0) })       // block align
    wav.append(withUnsafeBytes(of: UInt16(bitDepth).littleEndian) { Data($0) }) // bits per sample

    // data chunk
    wav.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // "data"
    wav.append(withUnsafeBytes(of: dataSize.littleEndian) { Data($0) })
    wav.append(pcmData)

    return wav
}

// ── Logging ──────────────────────────────────────────────────
func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write("[\(ts)] \(msg)\n".data(using: .utf8)!)
}

// ── Unix Domain Socket Server ────────────────────────────────
class SocketServer {
    let path: String
    var serverFD: Int32 = -1
    var clients: [Int32] = []

    init(path: String) {
        self.path = path
    }

    func start() {
        // Clean up stale socket
        unlink(path)

        serverFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFD >= 0 else {
            log("ERROR: socket() failed: \(errno)")
            exit(1)
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = path.utf8CString
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        withUnsafeMutableBytes(of: &addr.sun_path) { rawBuf in
            let count = min(pathBytes.count, maxLen - 1)
            for i in 0..<count {
                rawBuf[i] = UInt8(bitPattern: pathBytes[i])
            }
        }

        let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
        guard withUnsafePointer(to: &addr, {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(serverFD, $0, addrLen)
            }
        }) == 0 else {
            log("ERROR: bind() failed: \(errno)")
            exit(1)
        }

        guard listen(serverFD, 5) == 0 else {
            log("ERROR: listen() failed: \(errno)")
            exit(1)
        }

        log("Socket server listening at \(path)")

        // Accept loop on background queue
        DispatchQueue.global(qos: .userInitiated).async {
            while true {
                let clientFD = accept(self.serverFD, nil, nil)
                guard clientFD >= 0 else { continue }
                self.clients.append(clientFD)
                self.handleClient(clientFD)
            }
        }
    }

    func handleClient(_ fd: Int32) {
        DispatchQueue.global(qos: .userInitiated).async {
            var lineBuffer = ""
            let readSize = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: readSize)
            defer { buffer.deallocate() }

            while true {
                let n = read(fd, buffer, readSize)
                if n <= 0 { break }

                lineBuffer += String(bytes: UnsafeBufferPointer(start: buffer, count: n), encoding: .utf8) ?? ""

                while let newlineIdx = lineBuffer.firstIndex(of: "\n") {
                    let line = String(lineBuffer[lineBuffer.startIndex..<newlineIdx]).trimmingCharacters(in: .whitespaces)
                    lineBuffer = String(lineBuffer[lineBuffer.index(after: newlineIdx)...])

                    if !line.isEmpty {
                        let response = self.handleCommand(line)
                        let responseData = (response + "\n").data(using: .utf8)!
                        _ = responseData.withUnsafeBytes { rawBuf in
                            write(fd, rawBuf.baseAddress!, rawBuf.count)
                        }
                    }
                }
            }

            close(fd)
            self.clients.removeAll { $0 == fd }
        }
    }

    func handleCommand(_ raw: String) -> String {
        // Parse JSON command
        guard let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = json["cmd"] as? String else {
            // Try plain text commands for simplicity
            return handlePlainCommand(raw)
        }

        switch cmd {
        case "start":
            startCapture()
            return encode(["status": "recording"])
        case "stop":
            if let path = stopCapture() {
                return encode(["status": "stopped", "path": path])
            } else {
                return encode(["status": "error", "error": "Failed to write WAV"])
            }
        case "ping":
            return encode(["status": "ok", "engine": engine.isRunning])
        case "quit":
            log("Quit requested")
            cleanup()
            exit(0)
        default:
            return encode(["status": "error", "error": "Unknown command: \(cmd)"])
        }
    }

    func handlePlainCommand(_ cmd: String) -> String {
        switch cmd.lowercased() {
        case "start":
            startCapture()
            return encode(["status": "recording"])
        case "stop":
            if let path = stopCapture() {
                return encode(["status": "stopped", "path": path])
            } else {
                return encode(["status": "error", "error": "Failed to write WAV"])
            }
        case "ping":
            return encode(["status": "ok", "engine": engine.isRunning])
        case "quit":
            log("Quit requested")
            cleanup()
            exit(0)
        default:
            return encode(["status": "error", "error": "Unknown command: \(cmd)"])
        }
    }

    func encode(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else {
            return "{\"status\":\"error\",\"error\":\"encode failed\"}"
        }
        return str
    }

    func cleanup() {
        if engine.isRunning { engine.stop() }
        close(serverFD)
        unlink(path)
    }
}

// ── Warm up the engine ───────────────────────────────────────
func warmEngine() {
    do {
        // Touch inputNode to force audio hardware init
        let _ = engine.inputNode
        // Enable Apple's voice processing (noise suppression, echo cancel, AGC)
        enableVoiceProcessing()
        // Install the tap BEFORE starting (required by AVAudioEngine)
        installPersistentTap()
        try engine.start()
        log("Engine warmed up — mic is hot (hw rate: \(engine.inputNode.outputFormat(forBus: 0).sampleRate) Hz)")
    } catch {
        log("WARNING: engine warm-up failed: \(error) — will retry on first capture")
    }
}

// ── Signal handling ──────────────────────────────────────────
// Store global reference for signal handler (C function pointers can't capture context)
var globalServer: SocketServer?

func setupSignals(_ server: SocketServer) {
    globalServer = server
    signal(SIGINT) { _ in
        globalServer?.cleanup()
        _exit(0)
    }
    signal(SIGTERM) { _ in
        globalServer?.cleanup()
        _exit(0)
    }
}

// ── Main ─────────────────────────────────────────────────────

// --test mode: record 3 seconds, write WAV, open in QuickLook
if CommandLine.arguments.contains("--test") {
    log("TEST MODE: recording 3 seconds of mic audio...")
    warmEngine()

    // Small delay for engine to stabilize
    Thread.sleep(forTimeInterval: 0.1)

    startCapture()
    log("Recording... speak now!")
    Thread.sleep(forTimeInterval: 3.0)

    if let path = stopCapture() {
        log("Test WAV: \(path)")
        log("Playing back...")
        // Open in default player so you hear it
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
        proc.arguments = [path]
        try? proc.run()
        proc.waitUntilExit()
        log("Done. If you heard your voice, the mic is working!")
    } else {
        log("ERROR: no WAV produced")
    }
    exit(0)
}

log("AidaVoiceHelper starting...")
log("Socket path: \(socketPath)")

let server = SocketServer(path: socketPath)
setupSignals(server)

warmEngine()
server.start()

log("Ready — waiting for commands")
dispatchMain()
