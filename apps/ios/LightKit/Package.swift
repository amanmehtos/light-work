// swift-tools-version: 5.9
import PackageDescription

/// LightKit is the contract between the Light Suite apps.
///
/// Light Minute writes focus sessions; Light Week reads them. Rather than each
/// app inventing its own idea of what a session is, both depend on this.
let package = Package(
    name: "LightKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "LightKit", targets: ["LightKit"])
    ],
    targets: [
        .target(name: "LightKit"),
        .testTarget(name: "LightKitTests", dependencies: ["LightKit"]),
    ]
)
