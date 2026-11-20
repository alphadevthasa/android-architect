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

Moves a GreenDAO (generated DAO layer on SQLite) database to Room with a one-time copy. Written from memory of https://developer.android.com/training/data-storage/room; check the current docs before relying on a detail. This is the full reference for the object-database moves; the ORMLite and Realm playbooks list only their differences.

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

1. Inventory the GreenDAO entities and relations, and record real old-version database files for testing.
2. Define the seam: a Repository interface in domain types, so callers stop touching `DaoSession`, generated DAOs and entities.
3. Write Room `@Entity` classes and DAOs for the same data. A new database file name is used, so Room never opens the GreenDAO file. Relations become foreign keys and `@Relation` queries, join tables become explicit entities.
4. Implement the seam on Room and keep both implementations side by side behind a flag that selects the read source.
5. Write a one-time copy job: open the old database read-only, read table by table in batches, insert into Room inside transactions, and verify counts per table. Run it off the main thread (a WorkManager unique work is a good fit so it survives process death), resumable, with progress kept in a small marker.
6. Write a "migrated" marker only after the copy and verification succeed (a row in a Room table, or a flag in preferences written after the final commit). The marker, not the file's existence, decides which store is the source of truth.
7. Do the per-unit cutover: after the marker is set, switch each feature's reads and writes to Room, feature by feature, behind the flag. Before the marker, features keep using GreenDAO.
8. After a full release with the marker set for nearly all users, delete the old implementation: the GreenDAO plugin and generated code, the DAO session setup, and the old database file (see Security checklist for wiping it).

## Pitfalls

- A copy that is not idempotent duplicates rows if the process dies halfway: use the marker, clear partial Room data on retry, or use insert-or-replace with the original primary keys.
- Keep original primary keys and autoincrement values, or relations break.
- GreenDAO converters (enums, dates, lists as strings) must be mapped to Room `TypeConverter`s that read the legacy encoding.
- Large tables copied in one transaction can run out of memory or time: use batches of a few hundred to a few thousand rows.
- Users who never open the app between releases still need the copy later: the old reader code must stay until the deletion release.
- Two writers during the side-by-side phase cause drift: after the copy, the old store is read-only.

## Tests

- Copy tests with real old-version GreenDAO database files: run the copy and assert row counts, relations and spot values per table.
- Kill-and-resume test: stop the copy midway, restart it, and assert there are no duplicates and the marker appears only at the end.
- Empty-database, corrupt-database and low-storage cases: the app must keep working on the old store or start fresh with a clear message.
- Contract tests on the seam against both implementations during the side-by-side phase.
- Room `MigrationTestHelper` tests for later schema versions of the new database.

## Security checklist

- If the GreenDAO database is encrypted (SQLCipher), the Room database is encrypted too: pass the SQLCipher `SupportFactory` to the Room builder and test that the new file cannot be opened without the key.
- Key handling: the old key is read once for the copy, kept only in memory, and the new key is created in the Android Keystore or wrapped by a Keystore key; neither key is logged, stored in a plain preference or placed in the marker.
- The old database file and its journal, WAL and shm files are wiped after a verified copy: overwrite or delete them, and delete temporary copies and exports made during the move.
- No plaintext intermediate files: the copy streams in batches, with no CSV or JSON dump of the data to disk.
- The marker contains no user data.

## Rollback

Before the marker is set, nothing was removed: switch the flag to GreenDAO. After the marker, GreenDAO data is stale, so a rollback needs a reverse copy or an accepted loss of changes since the copy. Keep the old file until the deletion release, make that release only after the marker is set for almost all users, and treat deletion as one-way.
