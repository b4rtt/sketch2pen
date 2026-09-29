// sketch2pen CoreText helper (native/coretext.swift).
//
// 1. glyphs:  outlines text pen.dev cannot render (SF Symbols, icon-font glyphs) as SVG paths.
// 2. layouts: lays out fixed-width texts exactly like Sketch (CoreText, automatic optical sizing) and measures how
//             wide each resulting line becomes in pen.dev, which renders variable fonts at their default optical
//             size. The converter widens text boxes so pen.dev keeps Sketch's line breaks. For underlined and
//             struck-through runs it also returns where the lines go (pen.dev does not draw them).
//
// stdin : {"fonts": ["/path/font.ttf"], "glyphs": [{font,size,text}], "layouts": [{width, runs:[{text,font,size,kerning,weight,penFont,underline,strike,compensate}]}]}
// stdout: {"glyphs": [{d,x,y,width,height}], "layouts": [{lines:[{start, length, sketch, pen, deco?}], metrics?, tracking?}]}
import CoreText
import Foundation

struct GlyphRequest: Decodable { let font: String; let size: Double; let text: String }
struct Run: Decodable {
    let text: String; let font: String; let size: Double; let kerning: Double?; let weight: Double?; let penFont: String?
    let underline: Bool?; let strike: Bool?
    /// pen.dev renders another file / optical size: return the letter spacing that restores Sketch's widths
    let compensate: Bool?
}
struct LayoutRequest: Decodable { let width: Double; let runs: [Run] }
struct Input: Decodable { let fonts: [String]?; let glyphs: [GlyphRequest]?; let layouts: [LayoutRequest]? }

struct GlyphResponse: Encodable { let d: String; let x: Double; let y: Double; let width: Double; let height: Double }
/// An underlined or struck-through stretch of a line: x offsets in pen.dev's rendering of the line.
struct Deco: Encodable { let run: Int; let kind: String; let x0: Double; let x1: Double }
struct Line: Encodable { let start: Int; let length: Int; let sketch: Double; let pen: Double; let deco: [Deco]? }
/// Vertical metrics of the font pen.dev renders a run with (points, y up from the baseline).
struct Metrics: Encodable { let ascent: Double; let descent: Double; let leading: Double; let underlinePosition: Double; let underlineThickness: Double; let xHeight: Double }
struct LayoutResponse: Encodable { let lines: [Line]; let metrics: [Metrics]?; let tracking: [Double]? }
struct Output: Encodable { let glyphs: [GlyphResponse]; let layouts: [LayoutResponse] }

func fmt(_ v: CGFloat) -> String {
    let r = (Double(v) * 1000).rounded() / 1000
    return r == r.rounded() ? String(Int(r)) : String(r)
}

let opszTag = 0x6F70_737A // 'opsz'
let wghtTag = 0x7767_6874 // 'wght'

/// Variable-font named instances ("Inter-Regular_Bold") are the base font with a different weight.
func withAxis(_ font: CTFont, _ tag: Int, _ value: Double) -> CTFont {
    guard let axes = CTFontCopyVariationAxes(font) as? [[String: Any]],
          axes.contains(where: { ($0[kCTFontVariationAxisIdentifierKey as String] as? Int) == tag }) else { return font }
    var variation = (CTFontCopyVariation(font) as? [Int: Double]) ?? [:]
    variation[tag] = value
    let desc = CTFontDescriptorCreateWithAttributes([kCTFontVariationAttribute: variation] as CFDictionary)
    return CTFontCreateCopyWithAttributes(font, 0, nil, desc)
}

/// pen.dev ignores automatic optical sizing – pin the opsz axis to its default value.
func defaultOpticalSize(_ font: CTFont) -> CTFont {
    guard let axes = CTFontCopyVariationAxes(font) as? [[String: Any]] else { return font }
    for axis in axes {
        guard let id = axis[kCTFontVariationAxisIdentifierKey as String] as? Int, id == opszTag,
              let def = axis[kCTFontVariationAxisDefaultValueKey as String] as? Double else { continue }
        return withAxis(font, opszTag, def)
    }
    return font
}

func outline(_ req: GlyphRequest) -> GlyphResponse {
    let font = CTFontCreateWithName(req.font as CFString, CGFloat(req.size), nil)
    let attr = NSAttributedString(string: req.text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
    let line = CTLineCreateWithAttributedString(attr)
    let ascent = CTFontGetAscent(font)
    let path = CGMutablePath()
    for run in (CTLineGetGlyphRuns(line) as! [CTRun]) {
        let attrs = CTRunGetAttributes(run) as NSDictionary
        let runFont = attrs[kCTFontAttributeName as String] as! CTFont
        let count = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: count)
        var positions = [CGPoint](repeating: .zero, count: count)
        CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
        for i in 0..<count {
            guard let g = CTFontCreatePathForGlyph(runFont, glyphs[i], nil) else { continue }
            // CoreText is y-up with the baseline at 0 → flip into a y-down box whose top is the ascent line.
            let t = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: positions[i].x, ty: ascent - positions[i].y)
            path.addPath(g, transform: t)
        }
    }
    var d = ""
    path.applyWithBlock { el in
        let p = el.pointee.points
        switch el.pointee.type {
        case .moveToPoint: d += "M\(fmt(p[0].x)) \(fmt(p[0].y))"
        case .addLineToPoint: d += "L\(fmt(p[0].x)) \(fmt(p[0].y))"
        case .addQuadCurveToPoint: d += "Q\(fmt(p[0].x)) \(fmt(p[0].y)) \(fmt(p[1].x)) \(fmt(p[1].y))"
        case .addCurveToPoint: d += "C\(fmt(p[0].x)) \(fmt(p[0].y)) \(fmt(p[1].x)) \(fmt(p[1].y)) \(fmt(p[2].x)) \(fmt(p[2].y))"
        case .closeSubpath: d += "Z"
        @unknown default: break
        }
    }
    let b = path.isEmpty ? CGRect.zero : path.boundingBoxOfPath
    return GlyphResponse(d: d, x: Double(b.minX), y: Double(b.minY), width: Double(b.width), height: Double(b.height))
}

func runFont(_ r: Run, pen: Bool) -> CTFont {
    // pen.dev may render another file than Sketch (penFont), and never applies automatic optical sizing
    var font = CTFontCreateWithName((pen ? r.penFont ?? r.font : r.font) as CFString, CGFloat(r.size), nil)
    if let w = r.weight { font = withAxis(font, wghtTag, w) }
    if pen { font = defaultOpticalSize(font) }
    return font
}

func attributed(_ runs: [Run], pen: Bool, tracking: [Double] = []) -> NSAttributedString {
    let s = NSMutableAttributedString()
    for (i, r) in runs.enumerated() {
        var attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): runFont(r, pen: pen)]
        let k = (r.kerning ?? 0) + (pen && i < tracking.count ? tracking[i] : 0)
        if k != 0 { attrs[NSAttributedString.Key(kCTKernAttributeName as String)] = k }
        s.append(NSAttributedString(string: r.text, attributes: attrs))
    }
    return s
}

/// Extra letter spacing that makes the run as wide in pen.dev as in Sketch. Apple's variable SF fonts change their
/// spacing along the optical-size axis (their size-specific tracking), which pen.dev does not apply.
func compensation(_ r: Run) -> Double {
    guard r.compensate == true else { return 0 }
    let text = r.text.replacingOccurrences(of: "\n", with: "")
    let n = (text as NSString).length
    if n == 0 { return 0 }
    func width(_ pen: Bool) -> Double {
        var attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): runFont(r, pen: pen)]
        if let k = r.kerning, k != 0 { attrs[NSAttributedString.Key(kCTKernAttributeName as String)] = k }
        return CTLineGetTypographicBounds(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs)), nil, nil, nil)
    }
    let delta = (width(false) - width(true)) / Double(n)
    return abs(delta) < 0.005 ? 0 : (delta * 1000).rounded() / 1000
}

func metrics(_ r: Run) -> Metrics {
    let f = runFont(r, pen: true)
    return Metrics(ascent: Double(CTFontGetAscent(f)), descent: Double(CTFontGetDescent(f)), leading: Double(CTFontGetLeading(f)),
                   underlinePosition: Double(CTFontGetUnderlinePosition(f)), underlineThickness: Double(CTFontGetUnderlineThickness(f)),
                   xHeight: Double(CTFontGetXHeight(f)))
}

func lineWidth(_ line: CTLine) -> Double {
    CTLineGetTypographicBounds(line, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth(line)
}

func layout(_ req: LayoutRequest) -> LayoutResponse {
    let tracking = req.runs.map(compensation)
    let sketch = attributed(req.runs, pen: false)
    let pen = attributed(req.runs, pen: true, tracking: tracking)
    let setter = CTFramesetterCreateWithAttributedString(sketch)
    let path = CGPath(rect: CGRect(x: 0, y: 0, width: req.width, height: 100_000), transform: nil)
    let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil)
    // UTF-16 ranges of the runs, for underline / strikethrough stretches
    var runRanges: [(Int, Int)] = []
    var at = 0
    for r in req.runs {
        let n = (r.text as NSString).length
        runRanges.append((at, at + n))
        at += n
    }
    let decorated = req.runs.contains { $0.underline == true || $0.strike == true }
    let chars = pen.string as NSString
    var lines: [Line] = []
    for line in (CTFrameGetLines(frame) as! [CTLine]) {
        let range = CTLineGetStringRange(line)
        let sub = pen.attributedSubstring(from: NSRange(location: range.location, length: range.length))
        let penLine = CTLineCreateWithAttributedString(sub)
        var deco: [Deco]? = nil
        if decorated {
            deco = []
            let lineEnd = range.location + range.length
            for (i, r) in req.runs.enumerated() {
                let from = max(range.location, runRanges[i].0)
                var to = min(lineEnd, runRanges[i].1)
                // whitespace that ends the line is not decorated
                if to == lineEnd {
                    while to > from, let u = UnicodeScalar(chars.character(at: to - 1)), CharacterSet.whitespacesAndNewlines.contains(u) { to -= 1 }
                }
                if to <= from { continue }
                let x0 = Double(CTLineGetOffsetForStringIndex(penLine, from - range.location, nil))
                let x1 = Double(CTLineGetOffsetForStringIndex(penLine, to - range.location, nil))
                if r.underline == true { deco!.append(Deco(run: i, kind: "u", x0: x0, x1: x1)) }
                if r.strike == true { deco!.append(Deco(run: i, kind: "s", x0: x0, x1: x1)) }
            }
        }
        lines.append(Line(start: range.location, length: range.length, sketch: lineWidth(line), pen: lineWidth(penLine), deco: deco))
    }
    return LayoutResponse(lines: lines, metrics: decorated ? req.runs.map(metrics) : nil, tracking: tracking.contains { $0 != 0 } ? tracking : nil)
}

let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
for f in input.fonts ?? [] { CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: f) as CFURL, .process, nil) }
let out = Output(glyphs: (input.glyphs ?? []).map(outline), layouts: (input.layouts ?? []).map(layout))
FileHandle.standardOutput.write(try JSONEncoder().encode(out))
