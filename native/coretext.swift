// sketch2pen CoreText helper (native/coretext.swift).
//
// 1. glyphs:  outlines text pen.dev cannot render (SF Symbols, icon-font glyphs) as SVG paths.
// 2. layouts: lays out fixed-width texts exactly like Sketch (CoreText, automatic optical sizing) and measures how
//             wide each resulting line becomes in pen.dev, which renders variable fonts at their default optical
//             size. The converter widens text boxes so pen.dev keeps Sketch's line breaks.
//
// stdin : {"fonts": ["/path/font.ttf"], "glyphs": [{font,size,text}], "layouts": [{width, runs:[{text,font,size,kerning}]}]}
// stdout: {"glyphs": [{d,x,y,width,height}], "layouts": [{lines:[{start, length, sketch, pen}]}]}
import CoreText
import Foundation

struct GlyphRequest: Decodable { let font: String; let size: Double; let text: String }
struct Run: Decodable { let text: String; let font: String; let size: Double; let kerning: Double?; let weight: Double? }
struct LayoutRequest: Decodable { let width: Double; let runs: [Run] }
struct Input: Decodable { let fonts: [String]?; let glyphs: [GlyphRequest]?; let layouts: [LayoutRequest]? }

struct GlyphResponse: Encodable { let d: String; let x: Double; let y: Double; let width: Double; let height: Double }
struct Line: Encodable { let start: Int; let length: Int; let sketch: Double; let pen: Double }
struct LayoutResponse: Encodable { let lines: [Line] }
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

func attributed(_ runs: [Run], pen: Bool) -> NSAttributedString {
    let s = NSMutableAttributedString()
    for r in runs {
        var font = CTFontCreateWithName(r.font as CFString, CGFloat(r.size), nil)
        if let w = r.weight { font = withAxis(font, wghtTag, w) }
        if pen { font = defaultOpticalSize(font) }
        var attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font]
        if let k = r.kerning, k != 0 { attrs[NSAttributedString.Key(kCTKernAttributeName as String)] = k }
        s.append(NSAttributedString(string: r.text, attributes: attrs))
    }
    return s
}

func lineWidth(_ line: CTLine) -> Double {
    CTLineGetTypographicBounds(line, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth(line)
}

func layout(_ req: LayoutRequest) -> LayoutResponse {
    let sketch = attributed(req.runs, pen: false)
    let pen = attributed(req.runs, pen: true)
    let setter = CTFramesetterCreateWithAttributedString(sketch)
    let path = CGPath(rect: CGRect(x: 0, y: 0, width: req.width, height: 100_000), transform: nil)
    let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil)
    var lines: [Line] = []
    for line in (CTFrameGetLines(frame) as! [CTLine]) {
        let range = CTLineGetStringRange(line)
        let sub = pen.attributedSubstring(from: NSRange(location: range.location, length: range.length))
        lines.append(Line(start: range.location, length: range.length, sketch: lineWidth(line), pen: lineWidth(CTLineCreateWithAttributedString(sub))))
    }
    return LayoutResponse(lines: lines)
}

let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
for f in input.fonts ?? [] { CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: f) as CFURL, .process, nil) }
let out = Output(glyphs: (input.glyphs ?? []).map(outline), layouts: (input.layouts ?? []).map(layout))
FileHandle.standardOutput.write(try JSONEncoder().encode(out))
