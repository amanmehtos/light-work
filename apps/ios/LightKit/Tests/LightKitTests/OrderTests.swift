import XCTest
@testable import LightKit

/// Order keys, against vectors generated from `packages/core/src/order.ts`.
///
/// The two clients mint keys into the same list. They need not choose the same
/// key for the same gap, but they must agree on what a key is and how it
/// compares — so these check the actual strings, which is the strictest form
/// of that agreement and the one that catches a port drifting.
final class OrderParityTests: XCTestCase {

    func testMatchesTheTypeScriptForKnownPairs() {
        let vectors: [(String?, String?, String)] = [
            (nil, nil, "V"),
            ("V", nil, "l"),
            (nil, "V", "G"),
            ("a05", "a1", "a0Y"),
            ("a", "b", "aV"),
            ("Zz", "a", "ZzV"),
            ("a1", "a2", "a1V"),
            ("zzzzzz", nil, "zzzzzzV"),
            ("a0V", "a1", "a0l"),
            ("1", "2", "1V"),
            ("zy", "zz", "zyV"),
        ]
        for (lower, upper, expected) in vectors {
            XCTAssertEqual(Order.between(lower, upper), expected,
                           "between(\(lower ?? "nil"), \(upper ?? "nil"))")
        }
    }

    func testAppendingRepeatedlyFollowsTheSamePath() {
        // Appending is the common case and the one where a port usually
        // diverges, because it is where keys start to lengthen.
        let expected = ["V", "l", "t", "x", "z", "zV", "zl", "zt", "zx", "zz", "zzV", "zzl", "zzt"]
        var key = Order.first
        var chain = [key]
        for _ in 0..<12 {
            key = Order.between(key, nil)
            chain.append(key)
        }
        XCTAssertEqual(chain, expected)
    }

    func testInsertingAtTheHeadRepeatedlyFollowsTheSamePath() {
        let expected = ["V", "G", "8", "4", "2", "1", "0V", "0G", "08", "04", "02", "01", "00V"]
        var key = Order.first
        var heads = [key]
        for _ in 0..<12 {
            key = Order.between(nil, key)
            heads.append(key)
        }
        XCTAssertEqual(heads, expected)
    }

    func testAKeyAlwaysLandsStrictlyBetweenItsBounds() {
        // The property the whole scheme rests on, checked by churning the same
        // gap: a thousand inserts in one place must still sort correctly.
        var lower = Order.first
        let upper = Order.between(lower, nil)
        for _ in 0..<1000 {
            let mid = Order.between(lower, upper)
            XCTAssertTrue(lower < mid, "\(lower) < \(mid)")
            XCTAssertTrue(mid < upper, "\(mid) < \(upper)")
            lower = mid
        }
    }

    func testAfterLastAppendsPastEverySiblingWhateverOrderTheyAreIn() {
        let keys = ["V", "l", "a1", "zz"]
        let appended = Order.afterLast(keys.shuffled())
        for key in keys { XCTAssertTrue(key < appended, "\(key) < \(appended)") }
    }
}
