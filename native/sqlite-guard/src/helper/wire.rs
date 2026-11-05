//! Bounded length-prefixed messages and lossless SQLite cells for the private helper channel.

use super::Failure;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};

pub(super) const VERSION: u32 = 1;
pub(super) const MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub(super) const MAX_REPLY_BYTES: usize = 24 * 1024 * 1024;
pub(super) const MAX_ROWS: usize = 10_000;
pub(super) const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_BINDING_BYTES: usize = 8192;
pub(super) const MAX_QUERIES: usize = 256;
pub(super) const MAX_LIFETIME_MS: u64 = 30_000;
pub(super) const MAX_OPERATION_MS: u64 = 5_000;

/// Wire cells never encode signed 64-bit integers as JSON numbers or blobs as text.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum Cell {
    Null,
    Integer(String),
    Real(f64),
    Text(String),
    Blob(String),
}

impl Cell {
    /// Validate canonical integer/base64 values and finite reals before binding.
    pub(super) fn validate(&self) -> Result<(), Failure> {
        match self {
            Self::Integer(value) => {
                let parsed = value.parse::<i64>().map_err(|_| Failure::Bindings)?;
                if parsed.to_string() != *value {
                    return Err(Failure::Bindings);
                }
            }
            Self::Real(value) if !value.is_finite() => return Err(Failure::Bindings),
            Self::Blob(value) => {
                let bytes = STANDARD.decode(value).map_err(|_| Failure::Bindings)?;
                if STANDARD.encode(bytes) != *value {
                    return Err(Failure::Bindings);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Match the existing tagged projection encoding, including ECMAScript number spelling.
    pub(super) fn tagged(&self) -> String {
        match self {
            Self::Null => "[\"null\",null]".into(),
            Self::Integer(value) => format!("[\"integer\",{}]", json_string(value)),
            Self::Real(value) => format!("[\"number\",{}]", real_string(*value)),
            Self::Text(value) => format!("[\"string\",{}]", json_string(value)),
            Self::Blob(value) => format!("[\"blob\",{}]", json_string(value)),
        }
    }

    /// Stream canonical projection bytes without allocating an escaped copy of a potentially large source cell.
    pub(super) fn write_tagged(&self, output: &mut impl Write) -> std::io::Result<()> {
        let (prefix, text) = match self {
            Self::Null => return output.write_all(b"[\"null\",null]"),
            Self::Real(value) => return write!(output, "[\"number\",{}]", real_string(*value)),
            Self::Integer(value) => (b"[\"integer\",".as_slice(), value),
            Self::Text(value) => (b"[\"string\",".as_slice(), value),
            Self::Blob(value) => (b"[\"blob\",".as_slice(), value),
        };
        output.write_all(prefix)?;
        serde_json::to_writer(&mut *output, text).map_err(std::io::Error::other)?;
        output.write_all(b"]")
    }
}

/// Serialize already-valid Rust text with the same escaping as the prior JSON projection witness.
pub(super) fn json_string(value: &str) -> String {
    // Serializing a Rust string cannot fail or emit a non-string value.
    serde_json::to_string(value).expect("string serialization is infallible")
}

/// Produce JavaScript's finite-number spelling for existing real keys and fingerprints.
pub(super) fn real_string(value: f64) -> String {
    ryu_js::Buffer::new().format_finite(value).to_owned()
}

/// Only application-owned declarations are allowed in the initial open request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Definition {
    pub user_versions: Vec<u32>,
    pub tables: Vec<Table>,
    pub queries: Vec<Query>,
}

/// Ordinary main-schema table and its exact primary-key order.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Table {
    pub name: String,
    pub columns: Vec<String>,
    pub primary_key: Vec<String>,
}

/// Named projection with only equality/JSON-path filters; no executable query text.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Query {
    pub id: String,
    pub table: String,
    pub columns: Vec<String>,
    pub filters: Vec<Filter>,
}

/// A placeholder-bound equality filter on a declared column or restricted JSON path.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Filter {
    pub column: String,
    pub parameter: String,
    #[serde(default, deserialize_with = "present_path")]
    pub json_path: Option<Vec<PathPart>>,
}

/// An omitted path is allowed; an explicit null is not silently treated as an omitted declaration.
fn present_path<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Option<Vec<PathPart>>, D::Error> {
    Vec::<PathPart>::deserialize(input).map(Some)
}

/// Reject duplicate binding names rather than accepting serde's default last-value-wins map behavior.
fn unique_bindings<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<BTreeMap<String, Cell>, D::Error> {
    /// A bounded map visitor for exact placeholder names.
    struct Bindings;
    impl<'de> serde::de::Visitor<'de> for Bindings {
        type Value = BTreeMap<String, Cell>;
        /// Describe the fixed expected shape, without exposing received content.
        fn expecting(&self, output: &mut std::fmt::Formatter) -> std::fmt::Result {
            output.write_str("unique bounded bindings")
        }
        /// Count and reject duplicate entries as the map is decoded.
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut input: A,
        ) -> Result<Self::Value, A::Error> {
            let mut values = BTreeMap::new();
            while let Some((key, value)) = input.next_entry::<String, Cell>()? {
                if values.len() >= 16 || values.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("invalid binding names"));
                }
            }
            Ok(values)
        }
    }
    input.deserialize_map(Bindings)
}

/// JSON-path components cannot inject query text or arbitrary path syntax.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum PathPart {
    Name(String),
    Index(u32),
}

/// Strict messages from the trusted parent; captured/browser/model content never supplies declarations or paths.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Request {
    Open {
        id: u32,
        protocol_version: u32,
        path: String,
        definition: Definition,
        timeout_ms: u64,
    },
    Query {
        id: u32,
        query_id: String,
        #[serde(deserialize_with = "unique_bindings")]
        bindings: BTreeMap<String, Cell>,
        max_rows: usize,
        max_bytes: usize,
        timeout_ms: u64,
    },
    Close {
        id: u32,
    },
    Cancel {
        id: u32,
    },
}

impl Request {
    /// A strictly increasing request number prevents stale/duplicate replies from being accepted.
    pub(super) fn id(&self) -> u32 {
        match self {
            Self::Open { id, .. }
            | Self::Query { id, .. }
            | Self::Close { id }
            | Self::Cancel { id } => *id,
        }
    }

    /// Open/query limits can only lower the fixed native operation deadline.
    pub(super) fn timeout(&self) -> Result<u64, Failure> {
        let value = match self {
            Self::Open { timeout_ms, .. } | Self::Query { timeout_ms, .. } => *timeout_ms,
            _ => MAX_OPERATION_MS,
        };
        if value == 0 || value > MAX_OPERATION_MS {
            return Err(Failure::Limit);
        }
        Ok(value)
    }
}

/// Original primary-key cells, compatible with the existing reader key contract.
#[derive(Debug, Serialize)]
pub(super) struct KeyPart {
    pub column: String,
    pub r#type: &'static str,
    pub value: String,
}

/// Exact selected values plus the original row witness, not a normalized evidence object.
#[derive(Debug, Serialize)]
pub(super) struct Row {
    pub values: BTreeMap<String, Cell>,
    pub table: String,
    pub key: Vec<KeyPart>,
    pub fingerprint: String,
}

/// Controlled observations describe this source read, not event timestamps or a global snapshot.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Observation {
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub changed: bool,
    pub snapshot_scope: &'static str,
}

/// All successful/error replies use bounded frames; terminal exit codes also cover blocked-channel failure.
#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum Reply {
    Hello {
        protocol_version: u32,
        guard_version: &'static str,
        sqlite_source_id: &'static str,
        target: &'static str,
        qualification_hooks: bool,
        max_request_bytes: usize,
        max_reply_bytes: usize,
    },
    Started {
        id: u32,
    },
    Opened {
        id: u32,
        user_version: i64,
        snapshot_scope: &'static str,
    },
    Rows {
        id: u32,
        rows: Vec<Row>,
        bytes: usize,
        observation: Observation,
    },
    Closed {
        id: u32,
        observation: Observation,
    },
    Error {
        id: u32,
        code: &'static str,
    },
}

/// Read a fixed-width prefix and reject oversized payloads before allocating their storage.
pub(super) fn read_frame(input: &mut impl Read) -> Result<Vec<u8>, Failure> {
    let mut prefix = [0; 4];
    input
        .read_exact(&mut prefix)
        .map_err(|_| Failure::Channel)?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > MAX_REQUEST_BYTES {
        return Err(Failure::Limit);
    }
    let mut payload = vec![0; length];
    input
        .read_exact(&mut payload)
        .map_err(|_| Failure::Channel)?;
    Ok(payload)
}

/// A serialization sink checks each write before growing, instead of checking an already-unbounded result.
struct BoundedBuffer {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for BoundedBuffer {
    /// Refuse a write that would exceed the exact encoded-byte cap.
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self
            .bytes
            .len()
            .checked_add(data.len())
            .is_none_or(|n| n > self.limit)
        {
            return Err(std::io::Error::other("bounded frame"));
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }

    /// No operating-system output exists at this in-memory stage.
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Encode within the cap before writing a prefix; a failed encode never publishes a success-shaped partial frame.
pub(super) fn write_frame(output: &mut impl Write, reply: &Reply) -> Result<(), Failure> {
    let mut buffer = BoundedBuffer {
        bytes: Vec::new(),
        limit: MAX_REPLY_BYTES,
    };
    serde_json::to_writer(&mut buffer, reply).map_err(|_| Failure::Limit)?;
    output
        .write_all(&(buffer.bytes.len() as u32).to_be_bytes())
        .map_err(|_| Failure::Channel)?;
    output
        .write_all(&buffer.bytes)
        .map_err(|_| Failure::Channel)?;
    output.flush().map_err(|_| Failure::Channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_limits_are_checked_before_payload_reads() {
        let exact = vec![b' '; MAX_REQUEST_BYTES];
        let mut bytes = (exact.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(&exact);
        assert_eq!(
            read_frame(&mut bytes.as_slice()).unwrap().len(),
            MAX_REQUEST_BYTES
        );
        assert_eq!(
            read_frame(&mut ((MAX_REQUEST_BYTES + 1) as u32).to_be_bytes().as_slice()),
            Err(Failure::Limit)
        );
        assert_eq!(
            read_frame(&mut [0, 0, 0, 0].as_slice()),
            Err(Failure::Limit)
        );
        assert_eq!(
            read_frame(&mut [0, 0, 0, 2, b'x'].as_slice()),
            Err(Failure::Channel)
        );
    }

    #[test]
    fn bounded_serialization_accepts_exact_size_only() {
        let mut buffer = BoundedBuffer {
            bytes: Vec::new(),
            limit: 3,
        };
        buffer.write_all(b"abc").unwrap();
        assert!(buffer.write_all(b"d").is_err());
        assert_eq!(buffer.bytes, b"abc");
    }

    #[test]
    fn tagged_values_match_existing_javascript_spelling() {
        assert_eq!(
            Cell::Integer(i64::MAX.to_string()).tagged(),
            "[\"integer\",\"9223372036854775807\"]"
        );
        assert_eq!(Cell::Real(-0.0).tagged(), "[\"number\",0]");
        assert_eq!(Cell::Real(1e21).tagged(), "[\"number\",1e+21]");
        assert_eq!(
            Cell::Text("x\n\u{1f980}".into()).tagged(),
            "[\"string\",\"x\\n\u{1f980}\"]"
        );
        assert_eq!(
            Cell::Blob(STANDARD.encode([0, 255])).tagged(),
            "[\"blob\",\"AP8=\"]"
        );
        assert!(Cell::Integer("01".into()).validate().is_err());
        assert!(
            Cell::Integer("9223372036854775808".into())
                .validate()
                .is_err()
        );
        assert!(Cell::Blob("AP8".into()).validate().is_err());
    }

    #[test]
    fn malformed_fields_and_duplicate_bindings_are_not_defaulted() {
        assert!(
            serde_json::from_str::<Request>(r#"{"kind":"cancel","id":1,"sql":"SELECT 1"}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<Request>(r#"{"kind":"query","id":1,"queryId":"q","bindings":{"x":{"type":"null"},"x":{"type":"null"}},"maxRows":1,"maxBytes":1,"timeoutMs":1}"#).is_err());
        assert!(
            serde_json::from_str::<Filter>(r#"{"column":"x","parameter":"p","jsonPath":null}"#)
                .is_err()
        );
        let cell: Cell =
            serde_json::from_str(r#"{"type":"real","value":1.0000000000000002}"#).unwrap();
        assert_eq!(cell, Cell::Real(f64::from_bits(1.0f64.to_bits() + 1)));
    }
}
