use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthChar;
use wasm_bindgen::prelude::*;

/// Strips ANSI escape sequences from a string.
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut in_escape = false;
    for ch in s.chars() {
        if ch == '\x1b' {
            in_escape = true;
        } else if in_escape {
            // End of escape sequence: letters, '@', or certain symbols
            if ch.is_ascii_alphabetic() || ch == '@' || ch == '\\' {
                in_escape = false;
            }
            // Skip all characters within escape sequence
        } else {
            result.push(ch);
        }
    }
    result
}

/// Returns true if a codepoint is a zero-width character (combining marks,
/// variation selectors, format characters, etc.) that should not contribute
/// to display width.
fn is_zero_width(cp: char) -> bool {
    match cp as u32 {
        // Control characters (C0 and C1)
        0x00..=0x1F | 0x7F..=0x9F => true,
        // Soft hyphen
        0x00AD => true,
        // Zero-width space, ZWJ, zero-width non-joiner
        0x200B..=0x200D | 0x200E | 0x200F => true,
        // BOM, word joiner, and other format characters
        0xFEFF => true,
        0x2060..=0x2064 | 0x2066..=0x206F => true,
        // Variation selectors
        0xFE00..=0xFE0F => true,
        0xE0100..=0xE01EF => true,
        // Combining diacritical marks
        0x0300..=0x036F => true,
        0x1AB0..=0x1AFF => true,
        0x1DC0..=0x1DFF => true,
        0x20D0..=0x20FF => true,
        0xFE20..=0xFE2F => true,
        // Indic script combining marks (Devanagari through Malayalam)
        0x0900..=0x0903 | 0x093A..=0x094F | 0x0951..=0x0957 | 0x0962..=0x0963 => true,
        0x0981..=0x0983 | 0x09BC | 0x09BE..=0x09C4 | 0x09C7 | 0x09C8 | 0x09CB..=0x09CD | 0x09D7 => true,
        0x09E2..=0x09E3 => true,
        0x0A01..=0x0A03 | 0x0A3C | 0x0A3E..=0x0A42 | 0x0A47 | 0x0A48 | 0x0A4B..=0x0A4D | 0x0A51 => true,
        0x0A70 | 0x0A71 | 0x0A75 => true,
        0x0A81..=0x0A83 | 0x0ABC | 0x0ABE..=0x0AC5 | 0x0AC7..=0x0AC9 | 0x0ACB..=0x0ACD => true,
        0x0B01..=0x0B03 | 0x0B3C | 0x0B3E..=0x0B44 | 0x0B47 | 0x0B48 | 0x0B4B..=0x0B4D | 0x0B56 | 0x0B57 => true,
        0x0B62..=0x0B63 => true,
        0x0C00..=0x0C04 | 0x0C3C | 0x0C3E..=0x0C44 | 0x0C46..=0x0C48 | 0x0C4A..=0x0C4D | 0x0C55 | 0x0C56 => true,
        0x0C62 | 0x0C63 => true,
        0x0C81..=0x0C83 | 0x0CBC | 0x0CBE | 0x0CC0..=0x0CC4 | 0x0CC6 | 0x0CCC | 0x0CCD | 0x0CD5 | 0x0CD6 => true,
        0x0CE2 | 0x0CE3 => true,
        0x0D00..=0x0D03 | 0x0D3B | 0x0D3C | 0x0D3E..=0x0D44 | 0x0D46..=0x0D48 | 0x0D4A..=0x0D4D | 0x0D57 => true,
        0x0D62 | 0x0D63 => true,
        // Thai/Lao combining marks (excluding spacing vowels SARA AA/AM)
        0x0E31 | 0x0E34..=0x0E3A | 0x0E47..=0x0E4E => true,
        0x0EB1 | 0x0EB4..=0x0EBC | 0x0EC8..=0x0ECD => true,
        // Arabic formatting
        0x0600..=0x0605 | 0x06DD | 0x070F | 0x08E2 => true,
        // Surrogates
        0xD800..=0xDFFF => true,
        // Tag characters
        0xE0000..=0xE007F => true,
        _ => false,
    }
}

/// Returns true if a codepoint is an emoji (simplified detection).
/// Matches the emoji ranges used in the TypeScript implementation.
fn is_emoji(cp: char) -> bool {
    match cp as u32 {
        0x1F300..=0x1FAFF => true,
        0x2600..=0x27BF => true,
        0x1F1E6..=0x1F1FF => true,
        _ => false,
    }
}

/// Checks if any character in the grapheme is an emoji or triggers
/// grapheme segmentation (variation selectors, ZWJ, regional indicators).
fn grapheme_needs_segmentation(grapheme: &str) -> bool {
    for ch in grapheme.chars() {
        let cp = ch as u32;
        // Emoji ranges
        if cp >= 0x1F300 && cp <= 0x1FAFF {
            return true;
        }
        if cp >= 0x2600 && cp <= 0x27BF {
            return true;
        }
        if cp >= 0x1F1E6 && cp <= 0x1F1FF {
            return true;
        }
        // Variation selectors, ZWJ
        if cp >= 0xFE00 && cp <= 0xFE0F {
            return true;
        }
        if cp == 0x200D {
            return true;
        }
    }
    false
}

/// Calculate the width of an emoji grapheme cluster.
/// Matches the TypeScript `getEmojiWidth()` behavior.
fn get_emoji_grapheme_width(grapheme: &str) -> usize {
    let first = grapheme.chars().next().map(|c| c as u32).unwrap_or(0);

    // Regional indicators: single = 1, pair = 2
    if first >= 0x1F1E6 && first <= 0x1F1FF {
        let count = grapheme.chars().count();
        return if count == 1 { 1 } else { 2 };
    }

    // Incomplete keycap: digit/symbol + VS16 without U+20E3
    let chars: Vec<char> = grapheme.chars().collect();
    if chars.len() == 2 {
        let second = chars[1] as u32;
        if second == 0xFE0F && ((first >= 0x30 && first <= 0x39) || first == 0x23 || first == 0x2A) {
            return 1;
        }
    }

    // All other emoji sequences are width 2
    2
}

/// Calculates the display width of a string as it would appear in a terminal.
///
/// This matches the behavior of `src/ink/stringWidth.ts` in the TypeScript
/// implementation, handling:
/// - ASCII fast path
/// - ANSI escape sequence stripping
/// - East Asian width (ambiguous as narrow, via unicode-width crate)
/// - Emoji (width 2) with proper grapheme cluster awareness for ZWJ sequences
/// - Zero-width combining marks
/// - Regional indicator pairs (flag emoji)
pub fn string_width(s: &str) -> usize {
    if s.is_empty() {
        return 0;
    }

    // Fast path: pure ASCII (no escape, no non-ASCII)
    // Control chars below 0x20 except tab (0x09) and newline (0x0a) are zero-width
    let is_pure_ascii = s.bytes().all(|b| b < 127 && b != 0x1b);
    if is_pure_ascii {
        return s.chars().filter(|&c| c > '\x1f' || c == '\t' || c == '\n').count();
    }

    // Strip ANSI if present
    let text: String = if s.contains('\x1b') {
        strip_ansi(s)
    } else {
        s.to_string()
    };

    if text.is_empty() {
        return 0;
    }

    // Check if we need grapheme-aware processing (emoji, ZWJ, variation selectors)
    let needs_grapheme = text.chars().any(|ch| {
        let cp = ch as u32;
        cp >= 0x1F300 && cp <= 0x1FAFF
            || cp >= 0x2600 && cp <= 0x27BF
            || cp >= 0x1F1E6 && cp <= 0x1F1FF
            || cp >= 0xFE00 && cp <= 0xFE0F
            || cp == 0x200D
    });

    if needs_grapheme {
        // Use grapheme cluster iteration for emoji and ZWJ sequences
        let mut width = 0;
        for grapheme in text.graphemes(true) {
            if grapheme_needs_segmentation(grapheme) {
                if get_emoji_grapheme_width(grapheme) == 0 {
                    // Emoji regex didn't match, calculate width by counting first non-zero-width char
                    for ch in grapheme.chars() {
                        if !is_zero_width(ch) {
                            if let Some(w) = UnicodeWidthChar::width(ch) {
                                width += w;
                            }
                            break;
                        }
                    }
                } else {
                    width += get_emoji_grapheme_width(grapheme);
                }
            } else {
                // Simple grapheme: sum non-zero-width characters
                for ch in grapheme.chars() {
                    if !is_zero_width(ch) {
                        if let Some(w) = UnicodeWidthChar::width(ch) {
                            width += w;
                        }
                    }
                }
            }
        }
        return width;
    }

    // Simple path: no emoji/ZWJ, iterate characters directly
    let mut width = 0;
    for ch in text.chars() {
        if is_zero_width(ch) {
            continue;
        }

        // Emoji detection: most emoji are width 2
        if is_emoji(ch) {
            width += 2;
            continue;
        }

        // Regular character: use unicode-width (ambiguous as narrow)
        if let Some(w) = UnicodeWidthChar::width(ch) {
            if w > 0 {
                width += w;
            }
        }
    }

    width
}

#[wasm_bindgen]
pub fn string_width_wasm(s: &str) -> usize {
    string_width(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_string() {
        assert_eq!(string_width(""), 0);
    }

    #[test]
    fn test_ascii() {
        assert_eq!(string_width("hello"), 5);
        assert_eq!(string_width("Hello World!"), 12);
    }

    #[test]
    fn test_ascii_with_control_chars() {
        assert_eq!(string_width("hello\tworld"), 11); // tab is width 1
        assert_eq!(string_width("\x01\x02"), 0);
    }

    #[test]
    fn test_cjk_characters() {
        assert_eq!(string_width("\u{4E2D}\u{6587}"), 4); // Chinese chars are width 2 each
        assert_eq!(string_width("\u{3042}\u{3044}\u{3046}"), 6); // Hiragana (width 2 each)
    }

    #[test]
    fn test_emoji() {
        assert_eq!(string_width("\u{1F600}"), 2); // grinning face
        assert_eq!(string_width("\u{2764}"), 2); // heavy black heart
        assert_eq!(string_width("\u{26A0}"), 2); // warning sign
    }

    #[test]
    fn test_ansi_stripping() {
        let colored = "\x1b[31mred\x1b[0m";
        assert_eq!(string_width(colored), 3);
    }

    #[test]
    fn test_mixed() {
        assert_eq!(string_width("hello\u{4E2D}"), 7); // 5 + 2
    }

    #[test]
    fn test_combining_marks() {
        // e + combining acute accent = should be width 1 (combining mark is zero-width)
        assert_eq!(string_width("e\u{0301}"), 1);
    }

    #[test]
    fn test_variation_selector() {
        // # with variation selector 16 (VS16 is zero-width)
        assert_eq!(string_width("#\u{FE0F}"), 1);
    }

    #[test]
    fn test_regional_indicators() {
        // Single regional indicator (incomplete flag)
        assert_eq!(string_width("\u{1F1FA}"), 1); // US flag - first char
        // Pair of regional indicators (complete flag = width 2)
        assert_eq!(string_width("\u{1F1FA}\u{1F1F8}"), 2); // US flag
    }

    #[test]
    fn test_zero_width_space() {
        assert_eq!(string_width("hello\u{200B}world"), 10);
    }

    #[test]
    fn test_wide_punctuation() {
        // Fullwidth characters
        assert_eq!(string_width("\u{FF21}\u{FF22}\u{FF23}"), 6);
    }

    #[test]
    fn test_tabs_and_spaces() {
        assert_eq!(string_width("  hello  "), 9);
        assert_eq!(string_width("\thello"), 6); // tab is printable
    }

    #[test]
    fn test_newline() {
        assert_eq!(string_width("hello\nworld"), 11); // newline > 0x1f
    }

    // ZWJ sequence tests (fix for M1)
    #[test]
    fn test_zwj_family_emoji() {
        // Family emoji: man + ZWJ + woman + ZWJ + girl should be width 2
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        assert_eq!(string_width(family), 2);
    }

    #[test]
    fn test_zwj_profession_emoji() {
        // Man health worker: man + ZWJ + stethoscope + VS16 should be width 2
        let worker = "\u{1F468}\u{200D}\u{2695}\u{FE0F}";
        assert_eq!(string_width(worker), 2);
    }

    #[test]
    fn test_zwj_rainbow_flag() {
        // White flag + ZWJ + rainbow should be width 2
        let rainbow = "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}";
        assert_eq!(string_width(rainbow), 2);
    }

    #[test]
    fn test_simple_emoji_with_zwj_not_involved() {
        // Two separate emoji should be width 4
        assert_eq!(string_width("\u{1F600}\u{1F600}"), 4);
    }

    #[test]
    fn test_soft_hyphen() {
        // Soft hyphen (U+00AD) should be zero-width
        assert_eq!(string_width("hel\u{00AD}lo"), 5);
    }

    #[test]
    fn test_incomplete_keycap() {
        // Hash + VS16 without U+20E3 should be width 1
        assert_eq!(string_width("#\u{FE0F}"), 1);
    }
}
