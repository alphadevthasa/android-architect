---
id: ormlite--to--room
dimension: persistence
from: ormlite
to: room
title: ORMLite to Room
irreversible: true
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves an ORMLite database to Room with a one-time copy. The full procedure (seam, copy job, marker, deletion) is in the GreenDAO to Room playbook; this one covers what differs for ORMLite. Written from memory of https://developer.android.com/training/data-storage/room; check the current docs before relying on a detail.

## When it is worth it

ORMLite relies on reflection and annotations at runtime, is slow to start on large schemas, has weak support for coroutines and Flow, and is rarely maintained for current Android toolchains. Move when it blocks R8 shrinking, startup time or a build upgrade.

## When not to

The data is a disposable cache that can be rebuilt from the network: ship Room with a fresh fill and skip the copy. Also not before a Repository interface (the seam) exists around the `Dao` and `DatabaseHelper` usage.

## Preconditions

- The `OrmLiteSqliteOpenHelper` subclass, its `onUpgrade` history and every `@DatabaseTable` class are listed.
- Real old-version database files are collected for tests.
- Callers of `Dao`, `QueryBuilder` and `ForeignCollection` are identified; lazy foreign collections hide queries that Room will need explicitly.

## Steps

1. Inventory tables, `@DatabaseField` options (`canBeNull`, `defaultValue`, `unique`, `foreign`, `dataType`) and the helper's upgrade history.
2. Define the seam: a Repository interface in domain types, hiding `Dao`, `QueryBuilder` and entity classes from features.
3. Write Room entities and DAOs on a new database file. Map `foreign = true` and `foreignAutoRefresh` to foreign keys plus explicit `@Relation` or join queries; ORMLite auto-refresh has no Room equivalent, so each load becomes a deliberate query.
4. Implement the seam on Room and keep both implementations side by side behind a flag that selects the read source.
5. Write the one-time copy: read the ORMLite database read-only through the old helper, copy in batches inside Room transactions, keep primary keys, verify counts, then write the "migrated" marker last.
6. Do the per-unit cutover table by table or feature by feature after the marker is set.
7. Delete the old implementation after a full release: the helper, the table classes, ORMLite dependencies, the config file generated for it, and the old database file.

## Pitfalls

- ORMLite persists some types in its own encodings (dates as text or millis depending on `dataType`, serializable blobs, enums by name or ordinal): read each with the same encoding in the copy, and prefer re-encoding into plain columns instead of copying `SERIALIZABLE` blobs into Room.
- `@DatabaseField(canBeNull = false)` without a default does not guarantee clean data in old rows; the copy must handle nulls rather than crash.
- ORMLite `generatedId` columns rely on autoincrement; keep ids so that foreign keys still match.
- The helper may have opened the file with foreign keys off; dangling references surface when Room enforces them.
- Rows can exist in tables that no current class maps; list tables with a schema query and decide to copy or drop each.

## Tests

- Copy tests with real old ORMLite database files: assert counts, foreign key resolution and spot values, including rows with null and legacy encodings.
- Resume test: kill the copy midway, restart, assert no duplicates and a late marker.
- Contract tests on the seam against both implementations during the side-by-side phase.
- Room `MigrationTestHelper` tests for later versions of the new database.

## Security checklist

- If the ORMLite file is encrypted through SQLCipher, the Room database is encrypted with a SQLCipher `SupportFactory`, and a test fails to open it without the key.
- Key handling: the old key is held only in memory during the copy, the new key lives in the Android Keystore or is wrapped by a Keystore key, and neither appears in logs, preferences or the marker.
- Leftover plaintext is wiped: the old database, its journal and WAL files, and any temporary copy are deleted or overwritten once the copy is verified.
- Serialized blobs from ORMLite are not deserialized with Java object streams during the copy; read the raw bytes and map known formats only.
- No plaintext dump of the data to disk during the copy.

## Rollback

Before the marker is set, switch the flag back to ORMLite: nothing was removed. After the marker the old data is stale, so rollback needs a reverse copy or accepted loss of newer changes. Keep the old file and reader until the deletion release and treat deletion as one-way.
