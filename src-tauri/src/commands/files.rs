//! Reading large local files piece by piece, so a restore never has to hold
//! a multi-gigabyte dump in memory.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    /// The text read, cut at a character boundary.
    pub text: String,
    /// Bytes of the file `text` covers; the next read starts at offset + this.
    pub bytes: u64,
    /// True when the end of the file was reached.
    pub eof: bool,
}

#[tauri::command]
pub fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| format!("Could not read {path}: {e}"))
}

/// First code point of the private-use range a byte that isn't valid UTF-8
/// is mapped to (byte 0x80..=0xFF → U+F780..=U+F7FF). Dumps of binary
/// columns contain such bytes (mysqldump writes BLOBs raw inside string
/// literals); mapping each to its own character keeps every byte, and the
/// restore turns those literals back into exact X'..' bytes
/// (core/backup/restoreStream.ts, `restoreBinaryLiterals`).
pub const RAW_BYTE_BASE: u32 = 0xF700;

/// Reads up to `max_bytes` of `path` from `offset` as text. A character
/// split by the end of the chunk is left for the next read; bytes that
/// aren't valid UTF-8 are mapped one-to-one as described at RAW_BYTE_BASE.
#[tauri::command]
pub fn file_read_chunk(path: String, offset: u64, max_bytes: u64) -> Result<FileChunk, String> {
    let mut file = std::fs::File::open(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(max_bytes.min(len.saturating_sub(offset)) as usize);
    file.take(max_bytes).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let at_end = offset + buf.len() as u64 >= len;
    let (text, used) = decode_preserving_bytes(&buf, at_end);
    Ok(FileChunk { text, bytes: used as u64, eof: offset + used as u64 >= len })
}

/// UTF-8 text with invalid bytes mapped (RAW_BYTE_BASE); returns the text
/// and how many bytes it covers. Unless `at_end`, an incomplete character
/// at the end is left out, for the next read to finish.
fn decode_preserving_bytes(buf: &[u8], at_end: bool) -> (String, usize) {
    let mut text = String::with_capacity(buf.len());
    let mut pos = 0;
    while pos < buf.len() {
        match std::str::from_utf8(&buf[pos..]) {
            Ok(rest) => {
                text.push_str(rest);
                pos = buf.len();
            }
            Err(e) => {
                let valid = e.valid_up_to();
                text.push_str(std::str::from_utf8(&buf[pos..pos + valid]).unwrap_or_default());
                pos += valid;
                let bad = match e.error_len() {
                    Some(n) => n,
                    // Cut off by the end of the buffer: finish it next read.
                    None if !at_end => break,
                    None => buf.len() - pos,
                };
                for &b in &buf[pos..pos + bad] {
                    text.push(char::from_u32(RAW_BYTE_BASE + b as u32).unwrap_or('\u{FFFD}'));
                }
                pos += bad;
            }
        }
    }
    (text, pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_cut_at_character_boundaries() {
        let path = std::env::temp_dir().join(format!("rdsql-chunk-{}.sql", std::process::id()));
        std::fs::write(&path, "ab€cd").unwrap(); // € is 3 bytes
        let p = path.to_string_lossy().to_string();
        // 4 bytes would cut € after its first byte: only "ab" comes back.
        let first = file_read_chunk(p.clone(), 0, 4).unwrap();
        assert_eq!((first.text.as_str(), first.bytes, first.eof), ("ab", 2, false));
        let second = file_read_chunk(p.clone(), 2, 100).unwrap();
        assert_eq!((second.text.as_str(), second.bytes, second.eof), ("€cd", 5, true));
        assert_eq!(file_size(p).unwrap(), 7);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn invalid_bytes_map_one_to_one() {
        let (text, used) = decode_preserving_bytes(b"a\xff\x00b\xe2\x82", true);
        assert_eq!(used, 6);
        assert_eq!(text, "a\u{F7FF}\u{0}b\u{F7E2}\u{F782}");
        // Not at the end: the incomplete € (e2 82 ..) waits for the next read.
        let (text, used) = decode_preserving_bytes(b"a\xffb\xe2\x82", false);
        assert_eq!((text.as_str(), used), ("a\u{F7FF}b", 3));
    }
}
