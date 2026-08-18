import AppKit
import Foundation

let canvasSize = NSSize(width: 720, height: 460)
let inputPath = CommandLine.arguments.dropFirst().first
  ?? "desktop/resources/dmg-background-texture.png"
let outputPath = CommandLine.arguments.dropFirst(2).first
  ?? "desktop/resources/dmg-background.png"

guard let texture = NSImage(contentsOfFile: inputPath) else {
  fputs("Could not load DMG texture at \(inputPath)\n", stderr)
  exit(1)
}

func centeredParagraphStyle() -> NSParagraphStyle {
  let style = NSMutableParagraphStyle()
  style.alignment = .center
  return style
}

func drawText(
  _ text: String,
  in rect: NSRect,
  font: NSFont,
  color: NSColor,
  tracking: CGFloat = 0
) {
  text.draw(in: rect, withAttributes: [
    .font: font,
    .foregroundColor: color,
    .paragraphStyle: centeredParagraphStyle(),
    .kern: tracking,
  ])
}

func drawCard(_ rect: NSRect) {
  NSGraphicsContext.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowColor = NSColor(calibratedWhite: 0.12, alpha: 0.12)
  shadow.shadowBlurRadius = 18
  shadow.shadowOffset = NSSize(width: 0, height: -7)
  shadow.set()

  let card = NSBezierPath(roundedRect: rect, xRadius: 28, yRadius: 28)
  NSColor(calibratedWhite: 1, alpha: 0.58).setFill()
  card.fill()
  NSGraphicsContext.restoreGraphicsState()

  NSColor(calibratedWhite: 1, alpha: 0.58).setStroke()
  card.lineWidth = 1
  card.stroke()
}

func drawArrow() {
  let color = NSColor(calibratedRed: 0.74, green: 0.29, blue: 0.18, alpha: 0.88)
  let path = NSBezierPath()
  path.move(to: NSPoint(x: 302, y: 208))
  path.line(to: NSPoint(x: 410, y: 208))
  path.lineCapStyle = .round
  path.lineJoinStyle = .round
  path.lineWidth = 4
  color.setStroke()
  path.stroke()

  let arrowhead = NSBezierPath()
  arrowhead.move(to: NSPoint(x: 398, y: 219))
  arrowhead.line(to: NSPoint(x: 411, y: 208))
  arrowhead.line(to: NSPoint(x: 398, y: 197))
  arrowhead.lineCapStyle = .round
  arrowhead.lineJoinStyle = .round
  arrowhead.lineWidth = 4
  color.setStroke()
  arrowhead.stroke()
}

func render(scale: CGFloat, to path: String) throws {
  let pixelWidth = Int(canvasSize.width * scale)
  let pixelHeight = Int(canvasSize.height * scale)
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: pixelWidth,
    pixelsHigh: pixelHeight,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    throw NSError(domain: "NeedleDMG", code: 1)
  }

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context
  context.cgContext.scaleBy(x: scale, y: scale)

  let sourceRatio = texture.size.width / texture.size.height
  let targetRatio = canvasSize.width / canvasSize.height
  var sourceRect = NSRect(origin: .zero, size: texture.size)
  if sourceRatio < targetRatio {
    let sourceHeight = texture.size.width / targetRatio
    sourceRect.origin.y = (texture.size.height - sourceHeight) / 2
    sourceRect.size.height = sourceHeight
  } else {
    let sourceWidth = texture.size.height * targetRatio
    sourceRect.origin.x = (texture.size.width - sourceWidth) / 2
    sourceRect.size.width = sourceWidth
  }
  texture.draw(
    in: NSRect(origin: .zero, size: canvasSize),
    from: sourceRect,
    operation: .copy,
    fraction: 1
  )

  drawCard(NSRect(x: 85, y: 102, width: 190, height: 218))
  drawCard(NSRect(x: 445, y: 102, width: 190, height: 218))
  drawArrow()

  let charcoal = NSColor(calibratedRed: 0.15, green: 0.14, blue: 0.13, alpha: 0.96)
  let muted = NSColor(calibratedRed: 0.33, green: 0.30, blue: 0.27, alpha: 0.78)
  let titleFont = NSFont(name: "NewYork-Regular", size: 38)
    ?? NSFont(name: "Georgia", size: 38)
    ?? NSFont.systemFont(ofSize: 38, weight: .medium)

  drawText("Needle", in: NSRect(x: 120, y: 381, width: 480, height: 48), font: titleFont, color: charcoal)
  drawText(
    "your music, on the desktop",
    in: NSRect(x: 120, y: 353, width: 480, height: 25),
    font: NSFont.systemFont(ofSize: 15, weight: .medium),
    color: muted,
    tracking: 0.25
  )
  drawText(
    "drag Needle into Applications",
    in: NSRect(x: 120, y: 34, width: 480, height: 24),
    font: NSFont.systemFont(ofSize: 14, weight: .semibold),
    color: muted,
    tracking: 0.12
  )

  NSGraphicsContext.restoreGraphicsState()

  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "NeedleDMG", code: 2)
  }
  try data.write(to: URL(fileURLWithPath: path))
}

let outputURL = URL(fileURLWithPath: outputPath)
let retinaURL = outputURL.deletingLastPathComponent().appendingPathComponent(
  "\(outputURL.deletingPathExtension().lastPathComponent)@2x.\(outputURL.pathExtension)"
)

try render(scale: 1, to: outputURL.path)
try render(scale: 2, to: retinaURL.path)
print("Built \(outputURL.path) and \(retinaURL.path)")
