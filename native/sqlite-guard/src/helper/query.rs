//! Compile trusted declarations into bounded read-only projections and original-row witnesses.

use super::{Failure, wire::*};
use crate::{ApprovedSource, GuardError, GuardedDatabase};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// One source connection and its remaining aggregate budgets; no results survive the process.
pub(super) struct Session {
    database: GuardedDatabase,
    definition: Definition,
    started_at_ms: u64,
    initial_data_version: i64,
    user_version: i64,
    scope: &'static str,
    queries: usize,
    rows_left: usize,
    bytes_left: usize,
}

/// Admit only the identifier alphabet shared with the existing application-owned declarations.
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i != 0 && b.is_ascii_digit()))
}

/// Validate bounded unique columns before constructing any query text.
fn identifiers(values: &[String], limit: usize) -> bool {
    !values.is_empty()
        && values.len() <= limit
        && values.iter().all(|value| identifier(value))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

impl Definition {
    /// Validate declaration references, uniqueness and primary-key preservation without opening a source.
    pub(super) fn validate(&self) -> Result<(), Failure> {
        if self.user_versions.is_empty()
            || self.user_versions.len() > 32
            || self.user_versions.iter().any(|v| *v > i32::MAX as u32)
            || self.tables.is_empty()
            || self.tables.len() > 32
            || self.queries.is_empty()
            || self.queries.len() > 64
            || self
                .tables
                .iter()
                .map(|t| &t.name)
                .collect::<BTreeSet<_>>()
                .len()
                != self.tables.len()
            || self
                .queries
                .iter()
                .map(|q| &q.id)
                .collect::<BTreeSet<_>>()
                .len()
                != self.queries.len()
        {
            return Err(Failure::Schema);
        }
        for table in &self.tables {
            if !identifier(&table.name)
                || !identifiers(&table.columns, 64)
                || !identifiers(&table.primary_key, 16)
                || table
                    .primary_key
                    .iter()
                    .any(|key| !table.columns.contains(key))
            {
                return Err(Failure::Schema);
            }
        }
        for query in &self.queries {
            let table = self
                .tables
                .iter()
                .find(|table| table.name == query.table)
                .ok_or(Failure::Schema)?;
            if !identifier(&query.id)
                || !identifiers(&query.columns, 64)
                || query.filters.len() > 16
                || query
                    .columns
                    .iter()
                    .any(|name| !table.columns.contains(name))
                || table
                    .primary_key
                    .iter()
                    .any(|key| !query.columns.contains(key))
            {
                return Err(Failure::Schema);
            }
            for filter in &query.filters {
                if !table.columns.contains(&filter.column) || !identifier(&filter.parameter) {
                    return Err(Failure::Schema);
                }
                if let Some(path) = &filter.json_path
                    && (path.is_empty()
                        || path.len() > 16
                        || path.iter().any(|part| match part {
                            PathPart::Name(name) => !identifier(name),
                            PathPart::Index(index) => *index > 10000,
                        }))
                {
                    return Err(Failure::Schema);
                }
            }
        }
        Ok(())
    }
}

/// Quote only a previously validated code-owned identifier; values always remain placeholders.
fn quoted(value: &str) -> String {
    format!("\"{value}\"")
}

/// Checked wall-clock observation; deadlines use a separate monotonic clock.
fn now_ms() -> Result<u64, Failure> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Failure::Clock)?
        .as_millis();
    if ms > 9_007_199_254_740_991 {
        return Err(Failure::Clock);
    }
    Ok(ms as u64)
}

/// Run schema/data work in one bounded transaction while preserving a pre-existing WAL snapshot.
fn snapshot<T>(
    database: &mut GuardedDatabase,
    operation: impl FnOnce(&mut GuardedDatabase) -> Result<T, Failure>,
) -> Result<T, Failure> {
    let started = database.begin_read_scope()?;
    let result = operation(database);
    database.end_read_scope(started)?;
    result
}

/// Verify ordinary tables, declared columns and the exact primary-key order in the current snapshot.
fn admit(database: &mut GuardedDatabase, definition: &Definition) -> Result<i64, Failure> {
    let version = database.scalar_i64(c"PRAGMA user_version")?;
    if !definition
        .user_versions
        .iter()
        .any(|v| i64::from(*v) == version)
    {
        return Err(Failure::Schema);
    }
    for table in &definition.tables {
        let sql = CString::new(format!("PRAGMA main.table_list({})", quoted(&table.name)))
            .map_err(|_| Failure::Schema)?;
        let mut ordinary = false;
        database.read_rows(&sql, &[], 2, MAX_RESULT_BYTES, |row| {
            if row.len() != 6
                || row[0] != Cell::Text("main".into())
                || row[1] != Cell::Text(table.name.clone())
                || row[2] != Cell::Text("table".into())
            {
                return Err(GuardError::Schema);
            }
            ordinary = true;
            Ok(())
        })?;
        if !ordinary {
            return Err(Failure::Schema);
        }
        let sql = CString::new(format!("PRAGMA main.table_xinfo({})", quoted(&table.name)))
            .map_err(|_| Failure::Schema)?;
        let mut columns = BTreeSet::new();
        let mut primary = BTreeMap::new();
        database.read_rows(&sql, &[], 2000, MAX_RESULT_BYTES, |row| {
            if row.len() != 7 || row[6] != Cell::Integer("0".into()) {
                return Err(GuardError::Schema);
            }
            let Cell::Text(name) = &row[1] else {
                return Err(GuardError::Schema);
            };
            let Cell::Integer(pk) = &row[5] else {
                return Err(GuardError::Schema);
            };
            let pk = pk.parse::<u32>().map_err(|_| GuardError::Schema)?;
            columns.insert(name.clone());
            if pk > 0 && primary.insert(pk, name.clone()).is_some() {
                return Err(GuardError::Schema);
            }
            Ok(())
        })?;
        if table.columns.iter().any(|name| !columns.contains(name))
            || primary.into_values().collect::<Vec<_>>() != table.primary_key
        {
            return Err(Failure::Schema);
        }
    }
    Ok(version)
}

/// Count the prior binding contract's tagged JSON bytes before copying/decoding values.
fn binding_bytes(bindings: &BTreeMap<String, Cell>) -> Result<usize, Failure> {
    if bindings.len() > 16 || bindings.keys().any(|name| !identifier(name)) {
        return Err(Failure::Bindings);
    }
    let mut size = 2;
    for (index, value) in bindings.values().enumerate() {
        if matches!(value, Cell::Text(text) | Cell::Blob(text) | Cell::Integer(text) if text.len() > MAX_BINDING_BYTES)
        {
            return Err(Failure::Limit);
        }
        value.validate()?;
        size += usize::from(index != 0) + value.tagged().len();
        if size > MAX_BINDING_BYTES {
            return Err(Failure::Limit);
        }
    }
    Ok(size)
}

/// Build a SELECT with placeholders, deterministic primary-key ordering and one-over row detection.
fn compile(
    query: &Query,
    table: &Table,
    bindings: &BTreeMap<String, Cell>,
    max_rows: usize,
) -> Result<(CString, Vec<Cell>), Failure> {
    binding_bytes(bindings)?;
    let names = query
        .filters
        .iter()
        .map(|f| f.parameter.as_str())
        .collect::<BTreeSet<_>>();
    if bindings.len() != names.len() || names.iter().any(|name| !bindings.contains_key(*name)) {
        return Err(Failure::Bindings);
    }
    let mut values = Vec::new();
    let mut predicates = Vec::new();
    for filter in &query.filters {
        let mut column = quoted(&filter.column);
        if let Some(parts) = &filter.json_path {
            let mut path = String::from("$");
            for part in parts {
                match part {
                    PathPart::Name(name) => {
                        path.push('.');
                        path.push_str(name);
                    }
                    PathPart::Index(index) => path.push_str(&format!("[{index}]")),
                }
            }
            column = format!("json_extract({column}, ?)");
            values.push(Cell::Text(path));
        }
        values.push(
            bindings
                .get(&filter.parameter)
                .ok_or(Failure::Bindings)?
                .clone(),
        );
        predicates.push(format!("{column} IS ?"));
    }
    let mut sql = format!(
        "SELECT {} FROM main.{}",
        query
            .columns
            .iter()
            .map(|n| quoted(n))
            .collect::<Vec<_>>()
            .join(","),
        quoted(&table.name)
    );
    if !predicates.is_empty() {
        sql.push_str(&format!(" WHERE {}", predicates.join(" AND ")));
    }
    sql.push_str(&format!(
        " ORDER BY {} LIMIT ?",
        table
            .primary_key
            .iter()
            .map(|n| quoted(n))
            .collect::<Vec<_>>()
            .join(",")
    ));
    values.push(Cell::Integer((max_rows + 1).to_string()));
    Ok((CString::new(sql).map_err(|_| Failure::Query)?, values))
}

/// Count and hash only a bounded serialized prefix; oversized rows do not allocate escaped projections.
struct WitnessWriter {
    bytes: usize,
    limit: usize,
    digest: Sha256,
}

impl WitnessWriter {
    /// Start a bounded witness stream without reserving space for source data.
    fn new(limit: usize) -> Self {
        Self {
            bytes: 0,
            limit,
            digest: Sha256::new(),
        }
    }
}

impl Write for WitnessWriter {
    /// Check encoded-byte growth before hashing, without accumulating a payload buffer.
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let bytes = self
            .bytes
            .checked_add(data.len())
            .filter(|n| *n <= self.limit)
            .ok_or_else(|| std::io::Error::other("bounded witness"))?;
        self.digest.update(data);
        self.bytes = bytes;
        Ok(data.len())
    }
    /// Hashing has no external buffer to flush.
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Hash the existing JavaScript projection encoding in declaration order, checking each encoded chunk.
fn projection(
    columns: &[String],
    values: &[Cell],
    limit: usize,
) -> Result<(usize, String), GuardError> {
    let mut output = WitnessWriter::new(limit);
    let encoded = (|| -> std::io::Result<()> {
        output.write_all(b"[")?;
        for (index, (name, value)) in columns.iter().zip(values).enumerate() {
            if index != 0 {
                output.write_all(b",")?;
            }
            output.write_all(b"[")?;
            serde_json::to_writer(&mut output, name).map_err(std::io::Error::other)?;
            output.write_all(b",")?;
            value.write_tagged(&mut output)?;
            output.write_all(b"]")?;
        }
        output.write_all(b"]")
    })();
    encoded.map_err(|_| GuardError::Limit)?;
    Ok((output.bytes, format!("{:x}", output.digest.finalize())))
}

/// Metadata counted by the existing encoded-row budget; field order does not change byte length.
#[derive(Serialize)]
struct Witness<'a> {
    table: &'a str,
    key: &'a [KeyPart],
    fingerprint: &'a str,
}

impl Session {
    /// Open exactly one parent-authorized source and admit its code-owned declarations without publishing partial state.
    ///
    /// # Safety
    /// The process exclusively owns this SQLite engine, as required by GuardedDatabase::open.
    pub(super) unsafe fn open(path: &str, definition: Definition) -> Result<(Self, i64), Failure> {
        definition.validate()?;
        if !Path::new(path).is_absolute() || path.contains('\0') {
            return Err(Failure::Protocol);
        }
        let started_at_ms = now_ms()?;
        let source = ApprovedSource::capture(Path::new(path))?;
        let mut database = unsafe { GuardedDatabase::open(source) }?;
        let initialized = (|| {
            let scope = if database.retained_snapshot() {
                "connection"
            } else {
                "request"
            };
            let version = snapshot(&mut database, |db| admit(db, &definition))?;
            let initial_data_version = database.scalar_i64(c"PRAGMA data_version")?;
            Ok((version, scope, initial_data_version))
        })();
        let (version, scope, initial_data_version) = match initialized {
            Ok(values) => values,
            Err(error) => {
                database.discard()?;
                return Err(error);
            }
        };
        Ok((
            Self {
                database,
                definition,
                started_at_ms,
                initial_data_version,
                user_version: version,
                scope,
                queries: 0,
                rows_left: MAX_ROWS,
                bytes_left: MAX_RESULT_BYTES,
            },
            version,
        ))
    }

    /// State the snapshot scope without pretending independent rollback requests share one immutable view.
    pub(super) fn scope(&self) -> &'static str {
        self.scope
    }

    /// Execute a named projection and consume aggregate budgets only after a fully validated result.
    pub(super) fn query(
        &mut self,
        id: u32,
        query_id: &str,
        bindings: &BTreeMap<String, Cell>,
        max_rows: usize,
        max_bytes: usize,
    ) -> Result<Reply, Failure> {
        if max_rows > MAX_ROWS || max_bytes > MAX_RESULT_BYTES || self.queries >= MAX_QUERIES {
            return Err(Failure::Limit);
        }
        self.queries += 1;
        let query = self
            .definition
            .queries
            .iter()
            .find(|q| q.id == query_id)
            .ok_or(Failure::Query)?;
        let table = self
            .definition
            .tables
            .iter()
            .find(|t| t.name == query.table)
            .ok_or(Failure::Schema)?;
        let max_rows = max_rows.min(self.rows_left);
        let max_bytes = max_bytes.min(self.bytes_left);
        let (sql, values) = compile(query, table, bindings, max_rows)?;
        let (rows, bytes) = snapshot(&mut self.database, |db| {
            if admit(db, &self.definition)? != self.user_version {
                return Err(Failure::Schema);
            }
            let mut rows = Vec::new();
            let mut bytes = 0usize;
            db.read_rows(&sql, &values, max_rows, MAX_RESULT_BYTES, |cells| {
                if cells.len() != query.columns.len() {
                    return Err(GuardError::Data);
                }
                let mut key = Vec::new();
                for name in &table.primary_key {
                    let index = query
                        .columns
                        .iter()
                        .position(|column| column == name)
                        .ok_or(GuardError::Schema)?;
                    let (kind, value) = match &cells[index] {
                        Cell::Integer(value) => ("integer", value.clone()),
                        Cell::Real(value) => ("real", real_string(*value)),
                        Cell::Text(value) => ("text", value.clone()),
                        _ => return Err(GuardError::Data),
                    };
                    key.push(KeyPart {
                        column: name.clone(),
                        r#type: kind,
                        value,
                    });
                }
                let (encoded_bytes, fingerprint) =
                    projection(&query.columns, &cells, max_bytes - bytes)?;
                let mut witness = WitnessWriter::new(max_bytes - bytes - encoded_bytes);
                serde_json::to_writer(
                    &mut witness,
                    &Witness {
                        table: &table.name,
                        key: &key,
                        fingerprint: &fingerprint,
                    },
                )
                .map_err(|_| GuardError::Limit)?;
                bytes = bytes
                    .checked_add(encoded_bytes + witness.bytes)
                    .ok_or(GuardError::Limit)?;
                if bytes > max_bytes {
                    return Err(GuardError::Limit);
                }
                rows.push(Row {
                    values: query.columns.iter().cloned().zip(cells).collect(),
                    table: table.name.clone(),
                    key,
                    fingerprint,
                });
                Ok(())
            })?;
            Ok((rows, bytes))
        })?;
        self.rows_left -= rows.len();
        self.bytes_left -= bytes;
        Ok(Reply::Rows {
            id,
            rows,
            bytes,
            observation: self.observation()?,
        })
    }

    /// Report only observed metadata/data-version changes; this is not a global atomic snapshot.
    fn observation(&mut self) -> Result<Observation, Failure> {
        let finished_at_ms = now_ms()?;
        if finished_at_ms < self.started_at_ms {
            return Err(Failure::Clock);
        }
        Ok(Observation {
            started_at_ms: self.started_at_ms,
            finished_at_ms,
            changed: self.database.source_changed()?
                || self.database.scalar_i64(c"PRAGMA data_version")? != self.initial_data_version,
            snapshot_scope: self.scope,
        })
    }

    /// Cleanup for a failed request must not compute observations that could obscure its original error.
    pub(super) fn abort(self) -> Result<(), Failure> {
        self.database.discard().map_err(Failure::from)
    }

    /// Release the actual connection before sending its successful close observation.
    pub(super) fn close(mut self, id: u32) -> Result<Reply, Failure> {
        let observation = (|| {
            self.database.release_snapshot()?;
            self.observation()
        })();
        self.database.close()?;
        Ok(Reply::Closed {
            id,
            observation: observation?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_byte_limit_is_exact_and_values_remain_typed() {
        let mut values = BTreeMap::new();
        // ["string",""] plus the outer array consumes 15 bytes.
        values.insert(
            "value".into(),
            Cell::Text("x".repeat(MAX_BINDING_BYTES - 15)),
        );
        assert_eq!(binding_bytes(&values), Ok(MAX_BINDING_BYTES));
        values.insert(
            "value".into(),
            Cell::Text("x".repeat(MAX_BINDING_BYTES - 14)),
        );
        assert_eq!(binding_bytes(&values), Err(Failure::Limit));
        values.insert("value".into(), Cell::Integer("-9223372036854775808".into()));
        assert!(binding_bytes(&values).is_ok());
    }

    #[test]
    fn projection_witness_preserves_column_order_and_number_format() {
        let expected = "[[\"id\",[\"integer\",\"9007199254740993\"]],[\"v\",[\"number\",1e-7]]]";
        let columns = ["id".into(), "v".into()];
        let values = [Cell::Integer("9007199254740993".into()), Cell::Real(1e-7)];
        assert_eq!(
            projection(&columns, &values, expected.len()),
            Ok((
                expected.len(),
                format!("{:x}", Sha256::digest(expected.as_bytes()))
            ))
        );
        assert_eq!(
            projection(&columns, &values, expected.len() - 1),
            Err(GuardError::Limit)
        );
    }
}
