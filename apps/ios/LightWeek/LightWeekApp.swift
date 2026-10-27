import SwiftUI
import LightKit

@main
struct LightWeekApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Light Week \(HLC(wall: 0, counter: 0, node: "n0").encoded)")
        }
    }
}
