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

Moves an ORMLite database to Room with a one-time copy into a new Room database file. The overall approach matches the GreenDAO to Room playbook; the steps are repeated here so this file stands alone. Written from memory of https://developer.android.com/training/data-storage/room; check the current docs before relying on a detail.

## When it is worth it

ORMLite relies on reflection and annotations at runtime, is slow to start on large schemas, has weak support for coroutines and Flow, and is rarely maintained for current Android toolchains. Move when it blocks R8 shrinking, startup time or a build upgrade.

## When not to

The data is a disposable cache that can be rebuilt from the network: ship Room with a fresh fill and skip the copy. Also not before a Repository interface (the seam) exists around the `Dao` and `DatabaseHelper` usage.

## Preconditions

- The `OrmLiteSqliteOpenHelper` subclass, its `onUpgrade` history and every `@DatabaseTable` class are listed.
- Real old-version database files are collected for tests.
- Callers of `Dao`, `QueryBuilder` and `ForeignCollection` are identified; lazy foreign collections hide queries that Room will need explicitly.

## Steps

One safe ordering applies: (1) a verified backup of the old store exists before the first release that touches it with new code; (2) one writer at a time; (3) the copy runs behind a write gate on the old store, or runs before any data-access code, or is re-verified before the marker flips; (4) the old store is never deleted or overwritten before verification and a full release cycle; (5) rollback needs no destructive fallback.

1. Inventory tables, `@DatabaseField` options (`canBeNull`, `defaultValue`, `unique`, `foreign`, `dataType`), the `OrmLiteSqliteOpenHelper` upgrade history and real old-version database files.
2. Define the seam: a Repository interface in domain types, so callers stop touching ORMLite types and generated or managed objects.
3. Write Room entities and DAOs on a new database file. Map `foreign = true` and `foreignAutoRefresh` to foreign keys plus explicit `@Relation` or join queries; ORMLite auto-refresh has no Room equivalent, so each load becomes a deliberate query.
4. Implement the seam on Room and keep both implementations side by side behind a flag that selects the source of truth. Until the marker is set, the old store is the source of truth and Room is written only by the copy.
5. Backup: before the first release that contains the copy, close the old store (for SQLite-based stores checkpoint the write-ahead log first with `PRAGMA wal_checkpoint(TRUNCATE)`), copy the file and its `-wal`, `-shm`, `-journal` or companion files to app-private storage, and open the copy to check it.
6. Write the one-time copy. Read the ORMLite database read-only through the old helper. Run it behind a write gate: either run it at start before any data-access code touches the old store, or make the old store read-only to the app while it runs (writers wait or queue). Without the gate, a write during the copy is lost. Copy in batches inside Room transactions, keep primary keys, and make the job resumable (a WorkManager unique work survives process death) and idempotent (clear partial Room data on retry).
7. Verify before the marker: compare row counts per table, checksums or spot values, and re-read any old rows changed since the copy started (a version or modified column, or a second pass); re-copy those. Write the "migrated" marker only after this passes, as the last step. The marker, not the file's existence, decides the source of truth.
8. Do the per-unit cutover: after the marker is set, switch each feature's reads and writes to Room, feature by feature, behind the flag. Before the marker, features keep using the old store.
9. After the marker has been set for nearly all users and one full release cycle has passed, delete the old implementation: the helper, the table classes, ORMLite dependencies and the config file generated for it. Delete the old store files with `Context.deleteDatabase()` (SQLite-based stores) or the library's delete call, never before step 7 and never in the same release as the first copy.

## Pitfalls

- ORMLite persists some types in its own encodings (dates as text or millis depending on `dataType`, serializable blobs, enums by name or ordinal): read each with the same encoding in the copy, and prefer re-encoding into plain columns instead of copying `SERIALIZABLE` blobs into Room.
- `@DatabaseField(canBeNull = false)` without a default does not guarantee clean data in old rows; the copy must handle nulls rather than crash.
- The helper may have opened the file with foreign keys off; dangling references surface when Room enforces them.
- Rows can exist in tables that no current class maps; list tables with a schema query and decide to copy or drop each.
- A copy that is not idempotent duplicates rows if the process dies halfway: use the marker, clear partial Room data on retry, or insert-or-replace with the original primary keys.
- Writes to the old store during the copy are lost unless the write gate is in place; re-verify before the marker.
- Keep original primary keys and autoincrement values, or relations break.
- Large tables copied in one transaction can run out of memory or time: use batches of a few hundred to a few thousand rows.
- Users who never open the app between releases still need the copy later: the old reader code must stay until the deletion release.
- Never enable `fallbackToDestructiveMigration` or its variants on the new Room database; a failed schema check must not erase the copied data.

## Tests

- Copy tests with real old ORMLite database files: assert counts, foreign key resolution and spot values, including rows with null and legacy encodings.
- Resume test: kill the copy midway, restart, assert no duplicates and a late marker.
- Write-gate test: issue writes to the old store while the copy runs and assert none is lost (queued and applied, or re-copied by the verification pass) before the marker is set.
- Contract tests on the seam against both implementations during the side-by-side phase.
- Room `MigrationTestHelper` tests for later versions of the new database.

## Security checklist

- Encryption carried over: if the old store is encrypted, the Room database is encrypted too: pass the SQLCipher open helper factory to the Room builder (`SupportOpenHelperFactory` with `sqlcipher-android`, `SupportFactory` with the older library) and a new key, and a test fails to open the new file without the key. If the ORMLite file used SQLCipher 3 and the new library is SQLCipher 4, apply the compatibility settings or `cipher_migrate` from the SQLCipher upgrade notes.
- Key handling: the old key is read once for the copy, kept only in memory, and the new key is created in the Android Keystore or wrapped by a Keystore key; neither key is logged, stored in a plain preference or placed in the marker. The old key material is removed once the old store is deleted.
- Leftover plaintext is wiped: after the verified copy and the deletion release, `Context.deleteDatabase()` removes the ORMLite database with its journal, WAL and shm files; delete any temporary copy as well. Serialized blobs from ORMLite are not deserialized with Java object streams during the copy: read the raw bytes and map known formats only. Flash storage cannot be reliably overwritten, so the protection is encryption at rest plus deletion, not overwriting; delete temporary copies and exports made during the move.
- The backup from step 5 is the old store itself (encrypted if the original was), kept in app-private storage excluded from cloud backup, and removed when the rollback window ends.
- No plaintext intermediate files: the copy streams in batches, with no CSV or JSON dump of the data to disk, and the marker contains no user data.

## Rollback

Before the marker is set, nothing was removed: switch the flag back to ORMLite; the old store is still the source of truth. After the marker, the old data is stale: roll back by shipping a build that reads Room, or accept loss of the changes since the copy (a reverse copy is not provided). Never use `fallbackToDestructiveMigration` variants as recovery. Keep the old store and its reader until the deletion release, which comes only after verification and a full release cycle; if the old store was damaged, restore the backup from step 5. Treat deletion as one-way.
