---
id: greendao--to--room
dimension: persistence
from: greendao
to: room
title: GreenDAO to Room
irreversible: true
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves a GreenDAO (generated DAO layer on SQLite) database to Room with a one-time copy into a new Room database file. Written from memory of https://developer.android.com/training/data-storage/room; check the current docs before relying on a detail.

## When it is worth it

GreenDAO is no longer actively developed, generates code with its own Gradle plugin and does not support coroutines or Flow. Move when the plugin blocks a Gradle or AGP upgrade, or when features need reactive queries and compile-time SQL checks.

## When not to

The database is read-only reference data that can be re-downloaded: then just ship Room with a fresh download and skip the copy. Also not when the GreenDAO schema is entangled with generated sessions across many modules and no seam exists, until the seam is introduced.

## Preconditions

- Data access is reachable through a Repository interface (the seam) or can be put behind one first.
- The GreenDAO schema is listed: entities, table and column names, relations (ToOne, ToMany, join tables), converters, indexes.
- The old database file name, location and whether it is encrypted (GreenDAO with SQLCipher) are known.
- Enough free storage is checked at runtime for a second copy of the data.

## Steps

One safe ordering applies: (1) a verified backup of the old store exists before the first release that touches it with new code; (2) one writer at a time; (3) the copy runs behind a write gate on the old store, or runs before any data-access code, or is re-verified before the marker flips; (4) the old store is never deleted or overwritten before verification and a full release cycle; (5) rollback needs no destructive fallback.

1. Inventory the GreenDAO entities, relations (ToOne, ToMany, join tables), converters, indexes, the database file name and whether it is encrypted, and record real old-version database files for testing.
2. Define the seam: a Repository interface in domain types, so callers stop touching GreenDAO types and generated or managed objects.
3. Write Room `@Entity` classes and DAOs for the same data on a new database file name, so Room never opens the GreenDAO file. Relations become foreign keys and `@Relation` queries, join tables become explicit entities.
4. Implement the seam on Room and keep both implementations side by side behind a flag that selects the source of truth. Until the marker is set, the old store is the source of truth and Room is written only by the copy.
5. Backup: before the first release that contains the copy, close the old store (for SQLite-based stores checkpoint the write-ahead log first with `PRAGMA wal_checkpoint(TRUNCATE)`), copy the file and its `-wal`, `-shm`, `-journal` or companion files to app-private storage, and open the copy to check it.
6. Write the one-time copy. Open the old database read-only (through the GreenDAO session or a plain read-only SQLite connection), table by table. Run it behind a write gate: either run it at start before any data-access code touches the old store, or make the old store read-only to the app while it runs (writers wait or queue). Without the gate, a write during the copy is lost. Copy in batches inside Room transactions, keep primary keys, and make the job resumable (a WorkManager unique work survives process death) and idempotent (clear partial Room data on retry).
7. Verify before the marker: compare row counts per table, checksums or spot values, and re-read any old rows changed since the copy started (a version or modified column, or a second pass); re-copy those. Write the "migrated" marker only after this passes, as the last step. The marker, not the file's existence, decides the source of truth.
8. Do the per-unit cutover: after the marker is set, switch each feature's reads and writes to Room, feature by feature, behind the flag. Before the marker, features keep using the old store.
9. After the marker has been set for nearly all users and one full release cycle has passed, delete the old implementation: the GreenDAO plugin and generated code, the DAO session setup, and the flag. Delete the old store files with `Context.deleteDatabase()` (SQLite-based stores) or the library's delete call, never before step 7 and never in the same release as the first copy.

## Pitfalls

- GreenDAO converters (enums, dates, lists as strings) must be mapped to Room `TypeConverter`s that read the legacy encoding.
- A copy that is not idempotent duplicates rows if the process dies halfway: use the marker, clear partial Room data on retry, or insert-or-replace with the original primary keys.
- Writes to the old store during the copy are lost unless the write gate is in place; re-verify before the marker.
- Keep original primary keys and autoincrement values, or relations break.
- Large tables copied in one transaction can run out of memory or time: use batches of a few hundred to a few thousand rows.
- Users who never open the app between releases still need the copy later: the old reader code must stay until the deletion release.
- Never enable `fallbackToDestructiveMigration` or its variants on the new Room database; a failed schema check must not erase the copied data.

## Tests

- Copy tests with real old-version GreenDAO database files: run the copy and assert row counts, relations and spot values per table.
- Kill-and-resume test: stop the copy midway, restart it, and assert there are no duplicates and the marker appears only at the end.
- Write-gate test: issue writes to the old store while the copy runs and assert none is lost (queued and applied, or re-copied by the verification pass) before the marker is set.
- Empty-database, corrupt-database and low-storage cases: the app must keep working on the old store or start fresh with a clear message.
- Contract tests on the seam against both implementations during the side-by-side phase.
- Room `MigrationTestHelper` tests for later schema versions of the new database.

## Security checklist

- Encryption carried over: if the old store is encrypted, the Room database is encrypted too: pass the SQLCipher open helper factory to the Room builder (`SupportOpenHelperFactory` with `sqlcipher-android`, `SupportFactory` with the older library) and a new key, and a test fails to open the new file without the key. Key handling for a SQLCipher 3 file read by SQLCipher 4 needs the compatibility settings or `cipher_migrate` from the SQLCipher upgrade notes.
- Key handling: the old key is read once for the copy, kept only in memory, and the new key is created in the Android Keystore or wrapped by a Keystore key; neither key is logged, stored in a plain preference or placed in the marker. The old key material is removed once the old store is deleted.
- Leftover plaintext is wiped: after the verified copy and the deletion release, `Context.deleteDatabase()` removes the GreenDAO database with its journal, WAL and shm files; delete any temporary copy as well. Flash storage cannot be reliably overwritten, so the protection is encryption at rest plus deletion, not overwriting; delete temporary copies and exports made during the move.
- The backup from step 5 is the old store itself (encrypted if the original was), kept in app-private storage excluded from cloud backup, and removed when the rollback window ends.
- No plaintext intermediate files: the copy streams in batches, with no CSV or JSON dump of the data to disk, and the marker contains no user data.

## Rollback

Before the marker is set, nothing was removed: switch the flag back to GreenDAO; the old store is still the source of truth. After the marker, the old data is stale: roll back by shipping a build that reads Room, or accept loss of the changes since the copy (a reverse copy is not provided). Never use `fallbackToDestructiveMigration` variants as recovery. Keep the old store and its reader until the deletion release, which comes only after verification and a full release cycle; if the old store was damaged, restore the backup from step 5. Treat deletion as one-way.
