// Sketch ⇄ Pen – the macOS app around the sketch2pen command line tool.
// Pick or drop a .sketch or .pen file, choose the direction and options, convert, and open the result.
// The app runs the bundled CLI (Contents/Resources/sketch2pen-<arch>) with --json and shows its report.
import AppKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Localisation (English, Czech)

private let czech = Locale.preferredLanguages.first?.hasPrefix("cs") ?? false

private let cs: [String: String] = [
    "Sketch → Pen": "Sketch → Pen",
    "Pen → Sketch": "Pen → Sketch",
    "Drop a .sketch or .pen file here": "Přetáhněte sem soubor .sketch nebo .pen",
    "Drop a .sketch file here": "Přetáhněte sem soubor .sketch",
    "Drop a .pen file here": "Přetáhněte sem soubor .pen",
    "or": "nebo",
    "Choose File…": "Vybrat soubor…",
    "Change…": "Změnit…",
    "Output": "Výstup",
    "Next to the source file": "Vedle zdrojového souboru",
    "Options": "Možnosti",
    "Fonts": "Fonty",
    "Ship fonts from the Sketch file and this Mac": "Přibalit fonty ze Sketche i z tohoto Macu",
    "Ship only fonts embedded in the Sketch file": "Přibalit jen fonty vložené ve Sketchi",
    "Replace fonts with Google Fonts": "Nahradit fonty Google Fonts",
    "Embed fonts from the .pen file and Google Fonts": "Vložit fonty z .pen a Google Fonts",
    "Also embed fonts installed on this Mac": "Vložit i fonty nainstalované na tomto Macu",
    "Do not embed fonts": "Nevkládat fonty",
    "Flex layout from Sketch stacks": "Flex layout ze Sketch stacků",
    "Exact smooth corners (as paths)": "Přesné hladké rohy (jako cesty)",
    "Components as Sketch symbols": "Komponenty jako symboly Sketche",
    "Flex layout as Sketch stacks": "Flex layout jako stacky Sketche",
    "Download Google Fonts and icons": "Stahovat Google Fonts a ikony",
    "Open the result when done": "Po dokončení otevřít výsledek",
    "Convert": "Převést",
    "Converting…": "Převádím…",
    "Converted": "Převedeno",
    "Conversion failed": "Převod se nezdařil",
    "Open in pen.dev": "Otevřít v pen.dev",
    "Open in Sketch": "Otevřít ve Sketchi",
    "Show in Finder": "Ukázat ve Finderu",
    "Report": "Report",
    "Convert another": "Převést další",
    "Approximations": "Přibližné převody",
    "Everything was converted exactly.": "Vše bylo převedeno přesně.",
    "Missing fonts": "Chybějící fonty",
    "pages": "stránky",
    "frames": "framy",
    "layers": "vrstvy",
    "components": "komponenty",
    "symbols": "symboly",
    "instances": "instance",
    "images": "obrázky",
    "stacks": "stacky",
    "swatches": "swatche",
    "Choose a .sketch or .pen file": "Vyberte soubor .sketch nebo .pen",
    "The converter is missing from the app.": "V aplikaci chybí převodník.",
    "Back": "Zpět",
    "Try Again": "Zkusit znovu",
]

func L(_ s: String) -> String { czech ? (cs[s] ?? s) : s }

// MARK: - Model

enum Direction: String, CaseIterable, Identifiable {
    case sketchToPen, penToSketch
    var id: String { rawValue }
    var title: String { self == .sketchToPen ? L("Sketch → Pen") : L("Pen → Sketch") }
    var inputExtension: String { self == .sketchToPen ? "sketch" : "pen" }
    static func of(_ url: URL) -> Direction? {
        switch url.pathExtension.lowercased() {
        case "sketch": return .sketchToPen
        case "pen": return .penToSketch
        default: return nil
        }
    }
}

struct Warning: Identifiable {
    let id = UUID()
    let message: String
    let count: Int
    let examples: [String]
}

struct Outcome {
    let output: URL
    let report: URL?
    let seconds: Double
    let stats: [(String, Int)]
    let warnings: [Warning]
    let missingFonts: [String]
}

enum Phase {
    case idle
    case running
    case done(Outcome)
    case failed(String)
}

@MainActor
final class Converter: ObservableObject {
    static let shared = Converter()

    @Published var direction: Direction = .sketchToPen
    @Published var input: URL?
    @Published var output: URL?
    @Published var phase: Phase = .idle

    // Sketch → Pen
    @Published var penFonts = "all"
    @Published var flex = true
    @Published var smoothCorners = false
    // Pen → Sketch
    @Published var sketchFonts = "document"
    @Published var symbols = true
    @Published var stacks = true
    @Published var download = true
    // both
    @Published var openResult = true

    func select(_ url: URL) {
        guard let d = Direction.of(url) else { return }
        direction = d
        input = url
        output = nil
        phase = .idle
    }

    func setDirection(_ d: Direction) {
        direction = d
        if let i = input, Direction.of(i) != d {
            input = nil
            output = nil
        }
        phase = .idle
    }

    var defaultOutputDescription: String {
        guard let i = input else { return L("Next to the source file") }
        let base = i.deletingPathExtension().lastPathComponent
        return direction == .sketchToPen ? "\(base) (Pen)/\(base).pen" : "\(base) (Sketch).sketch"
    }

    private var cli: URL? {
        if let env = ProcessInfo.processInfo.environment["SKETCH2PEN_CLI"] { return URL(fileURLWithPath: env) }
        #if arch(arm64)
            let name = "sketch2pen-arm64"
        #else
            let name = "sketch2pen-x64"
        #endif
        return Bundle.main.url(forResource: name, withExtension: nil)
    }

    func arguments(for input: URL) -> [String] {
        var args = [input.path, "--json", "--no-open"]
        if let o = output { args += ["-o", o.path] }
        switch direction {
        case .sketchToPen:
            args += ["--embed-fonts", penFonts]
            if !flex { args.append("--no-flex") }
            if smoothCorners { args.append("--smooth-corners") }
        case .penToSketch:
            args += ["--embed-fonts", sketchFonts]
            if !symbols { args.append("--no-symbols") }
            if !stacks { args.append("--no-stacks") }
            if !download { args.append("--offline") }
        }
        return args
    }

    func convert() {
        guard let input, let cli else {
            phase = .failed(L("The converter is missing from the app."))
            return
        }
        phase = .running
        let args = arguments(for: input)
        let direction = self.direction
        let openResult = self.openResult
        Task.detached {
            let result = Converter.run(cli, args)
            await MainActor.run {
                switch result {
                case let .success(json):
                    if let outcome = Converter.outcome(json, direction: direction) {
                        self.phase = .done(outcome)
                        if openResult { Converter.open(outcome.output, direction: direction) }
                    } else {
                        self.phase = .failed("Unexpected output:\n\(String(data: json, encoding: .utf8) ?? "")")
                    }
                case let .failure(message):
                    self.phase = .failed(message)
                }
            }
        }
    }

    enum RunResult { case success(Data), failure(String) }

    nonisolated static func run(_ cli: URL, _ args: [String]) -> RunResult {
        let p = Process()
        p.executableURL = cli
        p.arguments = args
        let out = Pipe()
        let err = Pipe()
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return .failure(error.localizedDescription) }
        // read before waiting: large reports must not fill the pipe
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let text = String(data: errData, encoding: .utf8) ?? ""
            return .failure(text.replacingOccurrences(of: "Error: ", with: "").trimmingCharacters(in: .whitespacesAndNewlines))
        }
        // the JSON report is the last thing printed
        if let s = String(data: data, encoding: .utf8), let start = s.firstIndex(of: "{") {
            return .success(Data(s[start...].utf8))
        }
        return .success(data)
    }

    nonisolated static func outcome(_ data: Data, direction: Direction) -> Outcome? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let output = json["output"] as? String else { return nil }
        let stats = json["stats"] as? [String: Int] ?? [:]
        let order: [(String, String)] = direction == .sketchToPen
            ? [("pages", "pages"), ("frames", "frames"), ("layers", "layers"), ("components", "components"), ("instances", "instances"), ("images", "images"), ("flexStacks", "stacks")]
            : [("pages", "pages"), ("artboards", "frames"), ("layers", "layers"), ("symbols", "symbols"), ("instances", "instances"), ("images", "images"), ("stacks", "stacks"), ("swatches", "swatches")]
        let warnings = (json["warnings"] as? [[String: Any]] ?? []).map {
            Warning(message: $0["message"] as? String ?? "", count: $0["count"] as? Int ?? 0, examples: $0["examples"] as? [String] ?? [])
        }
        let fonts = json["fonts"] as? [[String: Any]] ?? []
        let missing = Set(fonts.filter { ($0["status"] as? String) == "substituted" || ($0["source"] as? String) == "missing" }.compactMap { $0["family"] as? String }).sorted()
        let outURL = URL(fileURLWithPath: output)
        let report = direction == .sketchToPen ? outURL.deletingLastPathComponent().appendingPathComponent("report.html") : nil
        return Outcome(output: outURL, report: report, seconds: json["seconds"] as? Double ?? 0, stats: order.map { (L($0.1), stats[$0.0] ?? 0) }, warnings: warnings, missingFonts: missing)
    }

    nonisolated static func open(_ url: URL, direction: Direction) {
        let app = direction == .sketchToPen ? "Pen" : "Sketch"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-a", app, url.path]
        if (try? p.run()) == nil { NSWorkspace.shared.open(url) }
    }

    func chooseInput() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "sketch"), UTType(filenameExtension: "pen")].compactMap { $0 }
        panel.allowsMultipleSelection = false
        panel.message = L("Choose a .sketch or .pen file")
        if panel.runModal() == .OK, let url = panel.url { select(url) }
    }

    func chooseOutput() {
        guard let input else { return }
        let base = input.deletingPathExtension().lastPathComponent
        if direction == .penToSketch {
            let panel = NSSavePanel()
            panel.allowedContentTypes = [UTType(filenameExtension: "sketch")].compactMap { $0 }
            panel.nameFieldStringValue = "\(base) (Sketch).sketch"
            panel.directoryURL = input.deletingLastPathComponent()
            if panel.runModal() == .OK { output = panel.url }
        } else {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.directoryURL = input.deletingLastPathComponent()
            if panel.runModal() == .OK, let dir = panel.url { output = dir.appendingPathComponent("\(base) (Pen)") }
        }
    }
}

// MARK: - Views

struct ContentView: View {
    @EnvironmentObject var model: Converter

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: Binding(get: { model.direction }, set: { model.setDirection($0) })) {
                ForEach(Direction.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 320)
            .padding(.top, 18)
            .padding(.bottom, 14)
            .disabled(isRunning)

            switch model.phase {
            case .idle, .running:
                SetupView(running: isRunning)
            case let .done(outcome):
                ResultView(outcome: outcome)
            case let .failed(message):
                FailureView(message: message)
            }
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 20)
        .frame(width: 560)
        .frame(minHeight: 560)
    }

    var isRunning: Bool { if case .running = model.phase { true } else { false } }
}

struct DropZone: View {
    @EnvironmentObject var model: Converter
    @State private var targeted = false

    var body: some View {
        VStack(spacing: 10) {
            if let input = model.input {
                Image(nsImage: NSWorkspace.shared.icon(forFile: input.path))
                    .resizable()
                    .frame(width: 56, height: 56)
                Text(input.lastPathComponent).font(.headline).lineLimit(1).truncationMode(.middle)
                Text(input.deletingLastPathComponent().path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                Button(L("Change…")) { model.chooseInput() }.controlSize(.small)
            } else {
                Image(systemName: "arrow.down.doc").font(.system(size: 34, weight: .light)).foregroundStyle(.secondary)
                Text(L(model.direction == .sketchToPen ? "Drop a .sketch file here" : "Drop a .pen file here")).font(.headline)
                Text(L("or")).font(.caption).foregroundStyle(.secondary)
                Button(L("Choose File…")) { model.chooseInput() }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 170)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: model.input == nil ? [6, 4] : []))
                .foregroundStyle(targeted ? Color.accentColor : Color.secondary.opacity(0.4))
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(targeted ? Color.accentColor.opacity(0.08) : Color.primary.opacity(0.03)))
        )
        .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
            guard let provider = providers.first else { return false }
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                if let url, Direction.of(url) != nil { Task { @MainActor in model.select(url) } }
            }
            return true
        }
    }
}

struct SetupView: View {
    @EnvironmentObject var model: Converter
    let running: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            DropZone()

            HStack(alignment: .firstTextBaseline) {
                Text(L("Output")).font(.subheadline.weight(.semibold))
                Text(model.output?.path ?? model.defaultOutputDescription)
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button(L("Change…")) { model.chooseOutput() }.controlSize(.small).disabled(model.input == nil)
            }

            GroupBox(L("Options")) {
                VStack(alignment: .leading, spacing: 8) {
                    if model.direction == .sketchToPen {
                        Picker(L("Fonts"), selection: $model.penFonts) {
                            Text(L("Ship fonts from the Sketch file and this Mac")).tag("all")
                            Text(L("Ship only fonts embedded in the Sketch file")).tag("document")
                            Text(L("Replace fonts with Google Fonts")).tag("none")
                        }
                        Toggle(L("Flex layout from Sketch stacks"), isOn: $model.flex)
                        Toggle(L("Exact smooth corners (as paths)"), isOn: $model.smoothCorners)
                    } else {
                        Picker(L("Fonts"), selection: $model.sketchFonts) {
                            Text(L("Embed fonts from the .pen file and Google Fonts")).tag("document")
                            Text(L("Also embed fonts installed on this Mac")).tag("all")
                            Text(L("Do not embed fonts")).tag("none")
                        }
                        Toggle(L("Components as Sketch symbols"), isOn: $model.symbols)
                        Toggle(L("Flex layout as Sketch stacks"), isOn: $model.stacks)
                        Toggle(L("Download Google Fonts and icons"), isOn: $model.download)
                    }
                    Divider()
                    Toggle(L("Open the result when done"), isOn: $model.openResult)
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .disabled(running)

            Spacer(minLength: 0)

            HStack {
                if running {
                    ProgressView().controlSize(.small)
                    Text(L("Converting…")).foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    model.convert()
                } label: {
                    Text(L("Convert")).frame(minWidth: 110)
                }
                .keyboardShortcut(.defaultAction)
                .controlSize(.large)
                .buttonStyle(.borderedProminent)
                .disabled(model.input == nil || running)
            }
        }
    }
}

struct StatChip: View {
    let value: Int
    let label: String
    var body: some View {
        VStack(spacing: 2) {
            Text("\(value)").font(.title3.weight(.semibold)).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.05)))
    }
}

struct ResultView: View {
    @EnvironmentObject var model: Converter
    let outcome: Outcome

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 28)).foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Converted")).font(.title3.weight(.semibold))
                    Text("\(outcome.output.lastPathComponent) · \(String(format: "%.1f", outcome.seconds)) s")
                        .font(.subheadline).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                ForEach(outcome.stats.filter { $0.1 > 0 }, id: \.0) { StatChip(value: $0.1, label: $0.0) }
            }

            if !outcome.missingFonts.isEmpty {
                Label("\(L("Missing fonts")): \(outcome.missingFonts.joined(separator: ", "))", systemImage: "textformat")
                    .font(.subheadline).foregroundStyle(.orange)
            }

            GroupBox(L("Approximations")) {
                if outcome.warnings.isEmpty {
                    Text(L("Everything was converted exactly.")).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(6)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(outcome.warnings) { w in
                                HStack(alignment: .firstTextBaseline) {
                                    Text(w.message).font(.callout)
                                    Spacer()
                                    Text("\(w.count)×").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                                }
                                .help(w.examples.joined(separator: "\n"))
                            }
                        }
                        .padding(6)
                    }
                    .frame(maxHeight: 170)
                }
            }

            Spacer(minLength: 0)

            HStack {
                Button(L("Convert another")) { model.phase = .idle; model.input = nil; model.output = nil }
                Spacer()
                if let report = outcome.report {
                    Button(L("Report")) { NSWorkspace.shared.open(report) }
                }
                Button(L("Show in Finder")) { NSWorkspace.shared.activateFileViewerSelecting([outcome.output]) }
                Button(L(model.direction == .sketchToPen ? "Open in pen.dev" : "Open in Sketch")) { Converter.open(outcome.output, direction: model.direction) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.large)
        }
    }
}

struct FailureView: View {
    @EnvironmentObject var model: Converter
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(L("Conversion failed"), systemImage: "xmark.octagon.fill").font(.title3.weight(.semibold)).foregroundStyle(.red)
            ScrollView {
                Text(message).font(.system(.callout, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: .infinity)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
            HStack {
                Button(L("Back")) { model.phase = .idle }
                Spacer()
                Button(L("Try Again")) { model.convert() }.buttonStyle(.borderedProminent)
            }
            .controlSize(.large)
        }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Files dropped on the app icon or opened from Finder are converted right away (like the old droplet).
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: { Direction.of($0) != nil }) else { return }
        Task { @MainActor in
            Converter.shared.select(url)
            Converter.shared.convert()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

#if !SNAPSHOT
@main
struct SketchPenApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = Converter.shared

    var body: some Scene {
        Window("Sketch ⇄ Pen", id: "main") {
            ContentView().environmentObject(model)
        }
        .windowResizability(.contentSize)
    }
}
#endif
