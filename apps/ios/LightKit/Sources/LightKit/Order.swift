import Foundation

/// Fractional index ordering.
///
/// A port of `packages/core/src/order.ts`, and a port rather than a
/// reimplementation on purpose: an order key is a base-62 fraction compared as
/// a string, and the two clients mint keys into the same list. They do not have
/// to agree on which key they pick, but they do have to agree on what a key is
/// and how it compares, or a task ordered on the phone would land somewhere
/// else on the web. `OrderParityTests` checks that against vectors generated
/// from the TypeScript.
public enum Order {
    private static let digits = Array(
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")

    /// The lowest key the generator will mint, useful as a seed.
    public static var first: String { between(nil, nil) }

    /// A key strictly between `lower` and `upper`.
    ///
    /// Nil `lower` inserts at the head, nil `upper` appends at the tail, and
    /// nil for both seeds an empty list. Bounds in the wrong order are a
    /// programming error, and return the head key rather than trapping: an
    /// out-of-order list is worth less than a crash.
    public static func between(_ lower: String?, _ upper: String?) -> String {
        if let lower, let upper, lower >= upper { return midpoint("", nil) }
        return midpoint(lower ?? "", upper)
    }

    private static func midpoint(_ lower: String, _ upper: String?) -> String {
        if let upper {
            // Carry any shared prefix through untouched and recurse on the rest.
            var shared = 0
            while true {
                let l = character(lower, at: shared) ?? "0"
                guard let u = character(upper, at: shared) else { break }
                if l != u { break }
                shared += 1
            }
            if shared > 0 {
                return String(upper.prefix(shared))
                    + midpoint(String(lower.dropFirst(shared)), String(upper.dropFirst(shared)))
            }
        }

        let low = lower.isEmpty ? 0 : index(of: lower.first!)
        let high = upper.flatMap { $0.first.map(index(of:)) } ?? digits.count

        if high - low > 1 {
            // Room for a digit in between; take the midpoint of the two.
            return String(digits[Int((0.5 * Double(low + high)).rounded())])
        }

        // The leading digits are adjacent, so descend a place.
        if let upper, upper.count > 1 { return String(upper.prefix(1)) }
        return String(digits[low]) + midpoint(String(lower.dropFirst()), nil)
    }

    private static func character(_ text: String, at offset: Int) -> Character? {
        guard offset < text.count else { return nil }
        return text[text.index(text.startIndex, offsetBy: offset)]
    }

    private static func index(of digit: Character) -> Int {
        digits.firstIndex(of: digit) ?? 0
    }

    /// Where a new item belongs at the end of a list.
    public static func afterLast(_ keys: [String]) -> String {
        between(keys.max(), nil)
    }
}
