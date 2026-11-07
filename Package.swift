// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Memable",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Memable", targets: ["Memable"])
    ],
    targets: [
        // Platform-independent data model, file formats and export logic (unit tested).
        .target(
            name: "MemableCore",
            path: "Sources/MemableCore",
            swiftSettings: [.enableUpcomingFeature("BareSlashRegexLiterals")]
        ),
        // SwiftUI / AppKit application.
        .executableTarget(
            name: "Memable",
            dependencies: ["MemableCore"],
            path: "Sources/Memable",
            exclude: ["Resources"]
        ),
        .testTarget(
            name: "MemableCoreTests",
            dependencies: ["MemableCore"],
            path: "Tests/MemableCoreTests"
        )
    ]
)
