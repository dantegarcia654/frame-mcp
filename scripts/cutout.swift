// Frame cutout helper (macOS): person matte + face box for every frame, using Apple's Vision framework (on-device).
// Protocol, shared with scripts/cutout_rembg.py so the service can use either:
//   stdin  raw BGRA frames, W×H each (ffmpeg -pix_fmt bgra -f rawvideo)
//   stdout one 8-bit matte per frame, W×H bytes (255 = person)
//   argv   <W> <H> <fast|balanced|accurate> <track.jsonl>
//   track.jsonl gets one line per frame: {"f":[x0,y0,x1,y1]|null,"p":[x0,y0,x1,y1]|null,"c":coverage}
//   (f = largest face, p = box around the matte, both 0..1 with the origin top-left; c = share of the frame that is person)
// Built by the service with `swiftc -O` the first time it is needed.
import Foundation
import Vision
import CoreImage
import CoreVideo

let args = CommandLine.arguments
guard args.count >= 5, let W = Int(args[1]), let H = Int(args[2]), W > 1, H > 1 else {
    FileHandle.standardError.write("usage: frame-cutout <width> <height> <fast|balanced|accurate> <track.jsonl>\n".data(using: .utf8)!)
    exit(2)
}
FileManager.default.createFile(atPath: args[4], contents: nil)
guard let track = FileHandle(forWritingAtPath: args[4]) else { FileHandle.standardError.write("cannot write \(args[4])\n".data(using: .utf8)!); exit(2) }

let ctx = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull(), .cacheIntermediates: false])
let frameBytes = W * H * 4
let inBuf = UnsafeMutableRawPointer.allocate(byteCount: frameBytes, alignment: 64)
let outBuf = UnsafeMutableRawPointer.allocate(byteCount: W * H, alignment: 64)
let seg = VNGeneratePersonSegmentationRequest()
seg.qualityLevel = args[3] == "fast" ? .fast : args[3] == "balanced" ? .balanced : .accurate
seg.outputPixelFormat = kCVPixelFormatType_OneComponent8
let face = VNDetectFaceRectanglesRequest()
// A sequence handler keeps state between frames, which Vision uses to keep the matte steady over time.
let sequence = VNSequenceRequestHandler()

func readFrame() -> Bool {
    var got = 0
    while got < frameBytes {
        let n = read(0, inBuf + got, frameBytes - got)
        if n <= 0 { return false }
        got += n
    }
    return true
}
func fmt(_ v: Double) -> String { String(format: "%.4f", v) }
func box(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double) -> String { "[\(fmt(x0)),\(fmt(y0)),\(fmt(x1)),\(fmt(y1))]" }

while readFrame() {
    var pb: CVPixelBuffer?
    CVPixelBufferCreateWithBytes(kCFAllocatorDefault, W, H, kCVPixelFormatType_32BGRA, inBuf, W * 4, nil, nil, nil, &pb)
    var faceJ = "null", personJ = "null", cover = 0.0
    memset(outBuf, 0, W * H)
    if let pb = pb {
        do { try sequence.perform([seg, face], on: pb) } catch { FileHandle.standardError.write("vision: \(error)\n".data(using: .utf8)!) }
        if let mask = seg.results?.first?.pixelBuffer {
            let mw = CGFloat(CVPixelBufferGetWidth(mask)), mh = CGFloat(CVPixelBufferGetHeight(mask))
            let ci = CIImage(cvPixelBuffer: mask).transformed(by: CGAffineTransform(scaleX: CGFloat(W) / mw, y: CGFloat(H) / mh))
            ctx.render(ci, toBitmap: outBuf, rowBytes: W, bounds: CGRect(x: 0, y: 0, width: W, height: H), format: .L8, colorSpace: nil)
        }
        if let f = face.results?.max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) {
            let b = f.boundingBox
            faceJ = box(Double(b.minX), Double(1 - b.maxY), Double(b.maxX), Double(1 - b.minY))
        }
    }
    // Box around the person and how much of the frame they fill, measured on the matte itself.
    let px = outBuf.assumingMemoryBound(to: UInt8.self)
    var x0 = W, y0 = H, x1 = -1, y1 = -1, count = 0
    for y in 0..<H {
        let row = px + y * W
        var rowHit = false
        for x in 0..<W where row[x] > 127 {
            count += 1; rowHit = true
            if x < x0 { x0 = x }
            if x > x1 { x1 = x }
        }
        if rowHit { if y < y0 { y0 = y }; y1 = y }
    }
    if count > 0 {
        cover = Double(count) / Double(W * H)
        personJ = box(Double(x0) / Double(W), Double(y0) / Double(H), Double(x1 + 1) / Double(W), Double(y1 + 1) / Double(H))
    }
    track.write("{\"f\":\(faceJ),\"p\":\(personJ),\"c\":\(fmt(cover))}\n".data(using: .utf8)!)
    var off = 0
    while off < W * H {
        let n = write(1, outBuf + off, W * H - off)
        if n <= 0 { exit(0) }
        off += n
    }
}
track.closeFile()
