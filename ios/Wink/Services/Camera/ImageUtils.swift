import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Cropping, resizing and JPEG encoding. Pure CoreGraphics/ImageIO so it is safe off the main actor.
nonisolated enum ImageUtils {
    /// Crops to a normalized box (origin top-left). Returns the input for a nil or degenerate box.
    static func crop(_ image: CGImage, to box: Box?) -> CGImage {
        guard let box = box?.clamped, box.w > 0.02, box.h > 0.02 else { return image }
        let width = Double(image.width), height = Double(image.height)
        let rect = CGRect(x: box.x * width, y: box.y * height, width: box.w * width, height: box.h * height).integral
        return image.cropping(to: rect) ?? image
    }

    /// Scales down so the longest side is at most `maxSide` pixels.
    static func downscale(_ image: CGImage, maxSide: Int) -> CGImage {
        let longest = max(image.width, image.height)
        guard longest > maxSide else { return image }
        let scale = Double(maxSide) / Double(longest)
        let w = max(Int((Double(image.width) * scale).rounded()), 1)
        let h = max(Int((Double(image.height) * scale).rounded()), 1)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return image }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage() ?? image
    }

    static func jpegData(_ image: CGImage, maxSide: Int, quality: Double = 0.8) -> Data? {
        let scaled = downscale(image, maxSide: maxSide)
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, scaled, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }
}
