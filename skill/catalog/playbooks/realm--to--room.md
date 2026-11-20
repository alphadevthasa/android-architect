---
id: realm--to--room
dimension: persistence
from: realm
to: room
title: Realm to Room
irreversible: true
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves a Realm database to Room with a one-time copy into a new Room database file. The overall approach matches the GreenDAO to Room playbook; the steps are repeated here so this file stands alone. Realm Java and the Realm Kotlin SDK are different libraries with different APIs (the Kotlin SDK uses frozen objects and its own configuration); identify which one the project uses before starting. Written from memory of https://developer.android.com/training/data-storage/room; check the current docs before relying on a detail.

## When it is worth it

The project wants plain SQLite tooling, a Room-based test and migration story, or one persistence stack shared with other modules, or needs to leave Realm because of its support status or licensing and sync changes. Realm's live objects and thread-confined model also make it hard to fit clean architecture layers.

## When not to

The app depends on Realm features with no Room equivalent, such as live object updates across threads, Realm Sync, or very large object graphs where the relational rewrite is costly, and there is no pressing reason to leave. Not before a Repository interface (the seam) hides Realm objects from the rest of the code.

## Preconditions

- Realm model classes, their schema versions and `RealmMigration` history are listed, and the Realm file location and encryption status are known.
- Callers that hold live `RealmObject` or `RealmResults` instances are found; they must move to plain domain models first.
- Real old-version `.realm` files are collected for tests.

## Steps

One safe ordering applies: (1) a verified backup of the old store exists before the first release that touches it with new code; (2) one writer at a time; (3) the copy runs behind a write gate on the old store, or runs before any data-access code, or is re-verified before the marker flips; (4) the old store is never deleted or overwritten before verification and a full release cycle; (5) rollback needs no destructive fallback.

1. Inventory the model classes, primary keys, indexed fields, list fields and links, schema versions and migrations, the Realm file location, encryption status, and which SDK (Java or Kotlin) is used. Collect real old-version `.realm` files.
2. Define the seam: a Repository interface in domain types, so callers stop touching Realm types and generated or managed objects.
3. Design the relational schema: links become foreign keys, lists of objects become a child or join table, lists of primitives become a child table or a converter-encoded column. Write Room entities and DAOs on a new database file.
4. Implement the seam on Room and keep both implementations side by side behind a flag that selects the source of truth. Until the marker is set, the old store is the source of truth and Room is written only by the copy.
5. Backup: before the first release that contains the copy, close every open realm instance, then copy the `.realm` file together with its `.lock`, `.note` and `.management` companions to app-private storage, and open the copy with the same configuration to check it. Realm is not SQLite, so there is no write-ahead log to checkpoint.
6. Write the one-time copy. Open the Realm file on a background thread with the correct schema version and read in batches, copying values out as plain objects (frozen or detached copies), never keeping managed objects across threads. Run it behind a write gate: either run it at start before any data-access code touches the old store, or make the old store read-only to the app while it runs (writers wait or queue). Without the gate, a write during the copy is lost. Copy in batches inside Room transactions, keep primary keys, and make the job resumable (a WorkManager unique work survives process death) and idempotent (clear partial Room data on retry).
7. Verify before the marker: compare row counts per table, checksums or spot values, and re-read any old rows changed since the copy started (a version or modified column, or a second pass); re-copy those. Write the "migrated" marker only after this passes, as the last step. The marker, not the file's existence, decides the source of truth.
8. Switch at the marker, all at once: at the marker flip every read and write of this store moves to Room through a single switch point behind the repository seam, and the old store becomes read-only (nothing writes to it any more). Any per-feature flagging happens before the marker, with the old store still the source of truth, and never moves one feature's writes to Room while another feature still writes to the old store, because those writes would never reach Room. Per-unit cutover of the code that uses the seam (moving feature by feature to the new repository implementation) is allowed only while both implementations still write to the same source of truth.
9. After the marker has been set for nearly all users and one full release cycle has passed, delete the old implementation: the Realm plugin and dependency, model classes, migrations and configuration. Delete the old store files with `Context.deleteDatabase()` (SQLite-based stores) or the library's delete call, never before step 7 and never in the same release as the first copy.

## Pitfalls

- Opening a Realm file at the wrong schema version triggers a migration or an exception, and with a delete-if-migration-needed setting it can erase the data before the copy: never use that option in the copy path.
- Realm objects are thread-confined (Java SDK) or must be frozen to cross threads (Kotlin SDK); copy values out on the thread that opened the realm.
- Required-field enforcement differs from SQLite: Realm enforces required fields on write, and a deleted target object leaves a nulled link rather than a dangling id, so the copy needs rules for null links that Room foreign keys will reject.
- Realm ids (`ObjectId`, UUID, strings) map to text columns; auto-increment integers do not exist, so keep the original ids.
- The Realm file can be large: copy in batches and check free space first.
- Realm Sync data, if used, lives on the server; this playbook only covers the local file.
- A copy that is not idempotent duplicates rows if the process dies halfway: use the marker, clear partial Room data on retry, or insert-or-replace with the original primary keys.
- Writes to the old store during the copy are lost unless the write gate is in place; re-verify before the marker.
- After the marker the old store is read-only: a feature that still writes to it loses those writes, so the switch to Room is a single point, not feature by feature.
- Keep original primary keys and autoincrement values, or relations break.
- Large tables copied in one transaction can run out of memory or time: use batches of a few hundred to a few thousand rows.
- Users who never open the app between releases still need the copy later: the old reader code must stay until the deletion release.
- Never enable `fallbackToDestructiveMigration` or its variants on the new Room database; a failed schema check must not erase the copied data.

## Tests

- Copy tests with real old Realm files: assert counts, links resolving to the right rows, list ordering and spot values, including null and empty lists.
- Resume test: kill the copy midway, restart, assert no duplicates and a late marker.
- Write-gate test: issue writes to the old store while the copy runs and assert none is lost (queued and applied, or re-copied by the verification pass) before the marker is set.
- A test with a Realm file at an older schema version than the current model.
- Contract tests on the seam against both implementations during the side-by-side phase.
- Room `MigrationTestHelper` tests for later versions of the new database.

## Security checklist

- Encryption carried over: if the old store is encrypted, the Room database is encrypted too: pass the SQLCipher open helper factory to the Room builder (`SupportOpenHelperFactory` with `sqlcipher-android`, `SupportFactory` with the older library) and a new key, and a test fails to open the new file without the key. Realm uses a 64-byte key: open the old file with it for the copy only.
- Key handling: the old key is read once for the copy, kept only in memory, and the new key is created in the Android Keystore or wrapped by a Keystore key; neither key is logged, stored in a plain preference or placed in the marker. The old key material is removed once the old store is deleted.
- Leftover plaintext is wiped: after the verified copy and the deletion release, delete the old realm with `Realm.deleteRealm(config)` (Java SDK) or the Kotlin SDK equivalent, which removes the file and its `.lock`, `.note` and `.management` companions together; delete any compacted copy or export as well, and remove the stored Realm key. Flash storage cannot be reliably overwritten, so the protection is encryption at rest plus deletion, not overwriting; delete temporary copies and exports made during the move.
- The backup from step 5 is the old store itself (encrypted if the original was), kept in app-private storage excluded from cloud backup, and removed when the rollback window ends.
- No plaintext intermediate files: the copy streams in batches, with no CSV or JSON dump of the data to disk, and the marker contains no user data.

## Rollback

Before the marker is set, nothing was removed: switch the flag back to Realm; the old store is still the source of truth. After the marker, the old data is stale: roll back by shipping a build that reads Room, or accept loss of the changes since the copy (a reverse copy is not provided). Never use `fallbackToDestructiveMigration` variants as recovery. Keep the old store and its reader until the deletion release, which comes only after verification and a full release cycle; if the old store was damaged, restore the backup from step 5. Treat deletion as one-way.
