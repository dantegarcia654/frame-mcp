// Word-timed transcript with Apple's on-device SpeechAnalyzer (macOS 26+). Nothing is uploaded.
//   apple-speech <audio-or-video> [locale=en-US] [chunks=1] [vocabulary,comma,separated]
// Prints JSON {engine, seconds, words:[{text,start,end}]} on stdout.
// With chunks > 1 the file is split into that many time ranges and each range gets its own analyzer,
// all running at once; words are kept only inside their own range so seams don't duplicate.
import AVFoundation
import Foundation
import Speech

struct Word: Codable { let text: String; let start: Double; let end: Double }
struct Out: Codable { let engine: String; let seconds: Double; let words: [Word] }

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func transcribe(url: URL, locale: Locale, from: Double, to: Double, total: Double, vocabulary: [String]) async throws -> [Word] {
  let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  if !vocabulary.isEmpty {
    // Names the recognizer should prefer (e.g. "Claude" over "clawed").
    let context = AnalysisContext()
    context.contextualStrings[.general] = vocabulary
    try await analyzer.setContext(context)
  }
  let file = try AVAudioFile(forReading: url)
  let rate = file.processingFormat.sampleRate
  // Overlap each range by 1.5 s on both sides so a word on a seam is heard whole by one analyzer.
  let lo = max(0, from - 1.5), hi = min(total, to + 1.5)
  file.framePosition = AVAudioFramePosition(lo * rate)
  let frames = AVAudioFrameCount((hi - lo) * rate)
  let collector = Task { () -> [Word] in
    var words: [Word] = []
    for try await r in transcriber.results {
      for run in r.text.runs {
        guard let tr = run.audioTimeRange else { continue }
        let t = String(r.text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { continue }
        let s = tr.start.seconds + lo, e = tr.end.seconds + lo
        let mid = (s + e) / 2
        if mid >= from && mid < to { words.append(Word(text: t, start: s, end: e)) }
      }
    }
    return words
  }
  let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
  try await analyzer.start(inputSequence: stream)
  let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) ?? file.processingFormat
  let conv = AVAudioConverter(from: file.processingFormat, to: format)!
  var left = frames
  let block: AVAudioFrameCount = AVAudioFrameCount(rate * 4)
  while left > 0 {
    let n = min(block, left)
    let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: n)!
    try file.read(into: buf, frameCount: n)
    if buf.frameLength == 0 { break }
    left -= buf.frameLength
    let outCap = AVAudioFrameCount(Double(buf.frameLength) * format.sampleRate / rate) + 64
    let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: outCap)!
    var fed = false
    var err: NSError?
    conv.convert(to: out, error: &err) { _, status in
      if fed { status.pointee = .noDataNow; return nil }
      fed = true; status.pointee = .haveData; return buf
    }
    if let err { throw err }
    cont.yield(AnalyzerInput(buffer: out))
  }
  cont.finish()
  try await analyzer.finalizeAndFinishThroughEndOfInput()
  return try await collector.value
}

@main struct Main {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count > 1 else { log("usage: apple-speech <file> [locale] [chunks]"); exit(2) }
    let url = URL(fileURLWithPath: args[1])
    let want = Locale(identifier: args.count > 2 ? args[2] : "en-US")
    let chunks = max(1, Int(args.count > 3 ? args[3] : "1") ?? 1)
    let vocabulary = args.count > 4 ? args[4].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } : []
    let t0 = Date()
    do {
      guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: want) else { log("locale \(want.identifier) is not supported by SpeechTranscriber"); exit(3) }
      let probe = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
      if let req = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
        log("downloading the on-device speech model for \(locale.identifier)…")
        try await req.downloadAndInstall()
      }
      let f = try AVAudioFile(forReading: url)
      let total = Double(f.length) / f.processingFormat.sampleRate
      let step = total / Double(chunks)
      let words = try await withThrowingTaskGroup(of: [Word].self) { g in
        for i in 0..<chunks {
          let from = Double(i) * step, to = i == chunks - 1 ? total + 1 : Double(i + 1) * step
          g.addTask { try await transcribe(url: url, locale: locale, from: from, to: to, total: total, vocabulary: vocabulary) }
        }
        var all: [Word] = []
        for try await w in g { all += w }
        return all.sorted { $0.start < $1.start }
      }
      let out = Out(engine: "apple-speech \(locale.identifier)", seconds: Date().timeIntervalSince(t0), words: words)
      FileHandle.standardOutput.write(try JSONEncoder().encode(out))
    } catch {
      log("apple-speech failed: \(error)")
      exit(1)
    }
  }
}
