import SwiftUI

/// Live camera preview with hand landmarks, pointer and the current selection box drawn on top.
struct PreviewView: View {
    let image: CGImage?
    let hands: [Hand]
    let selection: WinkController.ActiveSelection?
    let pointer: PointerSample?
    let showPointer: Bool

    var body: some View {
        GeometryReader { geo in
            let aspect = image.map { CGFloat($0.width) / CGFloat(max($0.height, 1)) } ?? (9.0 / 16.0)
            let fit = fittedRect(container: geo.size, aspect: aspect)
            ZStack(alignment: .topLeading) {
                Color.black
                if let image {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .frame(width: fit.width, height: fit.height)
                        .offset(x: fit.minX, y: fit.minY)
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "eye.slash").font(.largeTitle)
                        Text("No camera feed").font(.headline)
                    }
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                Canvas { ctx, _ in
                    func pt(_ l: Landmark) -> CGPoint { CGPoint(x: fit.minX + l.x * fit.width, y: fit.minY + l.y * fit.height) }
                    for hand in hands where hand.landmarks.count == 21 {
                        var bones = Path()
                        for (a, b) in Hand.connections {
                            bones.move(to: pt(hand[a]))
                            bones.addLine(to: pt(hand[b]))
                        }
                        ctx.stroke(bones, with: .color(.white.opacity(0.85)), lineWidth: 2)
                        for (i, l) in hand.landmarks.enumerated() {
                            let r: CGFloat = [4, 8].contains(i) ? 5 : 3
                            let p = pt(l)
                            ctx.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)),
                                     with: .color(i == 8 ? .yellow : .cyan))
                        }
                    }
                    if let s = selection {
                        let rect = CGRect(x: fit.minX + s.box.x * fit.width, y: fit.minY + s.box.y * fit.height,
                                          width: s.box.w * fit.width, height: s.box.h * fit.height)
                        ctx.stroke(Path(roundedRect: rect, cornerRadius: 8), with: .color(.yellow), lineWidth: 3)
                    }
                    if showPointer, let p = pointer {
                        let c = CGPoint(x: fit.minX + p.x * fit.width, y: fit.minY + p.y * fit.height)
                        let r: CGFloat = p.pinching ? 14 : 9
                        ctx.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)),
                                 with: .color(p.pinching ? .pink : .pink.opacity(0.5)))
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }

    private func fittedRect(container: CGSize, aspect: CGFloat) -> CGRect {
        guard container.width > 0, container.height > 0 else { return .zero }
        var w = container.width, h = w / aspect
        if h > container.height { h = container.height; w = h * aspect }
        return CGRect(x: (container.width - w) / 2, y: (container.height - h) / 2, width: w, height: h)
    }
}
