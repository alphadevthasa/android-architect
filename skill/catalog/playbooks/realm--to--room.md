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

Moves a Realm database to Room with a one-time copy. The full procedure (seam, copy job, marker, deletion) is in the GreenDAO to Room playbook; this one covers what differs for Realm. Written from memory of https://developer.android.com/training/data-storage/room; check the current docs before relying on a detail.

## When it is worth it

The project wants plain SQLite tooling, a Room-based test and migration story, or one persistence stack shared with other modules, or needs to leave Realm because of its support status or licensing and sync changes. Realm's live objects and thread-confined model also make it hard to fit clean architecture layers.

## When not to

The app depends on Realm features with no Room equivalent, such as live object updates across threads, Realm Sync, or very large object graphs where the relational rewrite is costly, and there is no pressing reason to leave. Not before a Repository interface (the seam) hides Realm objects from the rest of the code.

## Preconditions

- Realm model classes, their schema versions and `RealmMigration` history are listed, and the Realm file location and encryption status are known.
- Callers that hold live `RealmObject` or `RealmResults` instances are found; they must move to plain domain models first.
- Real old-version `.realm` files are collected for tests.

## Steps

1. Inventory the model classes, primary keys, indexed fields, `RealmList` fields and links.
2. Define the seam: Repository interfaces returning domain models, copied out of Realm inside a transaction, so no managed object crosses the boundary.
3. Design the relational schema: links become foreign keys, `RealmList` of objects becomes a child table or join table, lists of primitives become a child table or a converter-encoded column. Write Room entities and DAOs on a new database file.
4. Implement the seam on Room and keep both implementations side by side behind a flag that selects the read source.
5. Write the one-time copy: open the Realm file on a background thread with the correct schema version, read in batches, insert into Room in transactions, keep primary keys, verify counts per model, then write the "migrated" marker last.
6. Do the per-unit cutover model by model, or feature by feature, after the marker is set.
7. Delete the old implementation after a full release: the Realm plugin and dependency, model classes, migrations, the Realm configuration, and the `.realm` files together with their `.lock`, `.note` and `.management` companions.

## Pitfalls

- Opening a Realm file at the wrong schema version triggers a migration or an exception, and with a delete-if-migration-needed setting it can erase the data before the copy: never use that option in the copy path.
- Realm objects are thread-confined; copy values out on the thread that opened the realm.
- Realm has no NOT NULL or foreign key enforcement the way SQLite does; old data may have nulls and dangling links that Room will reject, so the copy needs rules for them.
- Realm ids (`ObjectId`, UUID, strings) map to text columns; auto-increment integers do not exist, so keep the original ids.
- The Realm file can be large: copy in batches and check free space first.
- Realm Sync data, if used, lives on the server; this playbook only covers the local file.

## Tests

- Copy tests with real old Realm files: assert counts, links resolving to the right rows, list ordering and spot values, including null and empty lists.
- Resume test: kill the copy midway, restart, assert no duplicates and a late marker.
- A test with a Realm file at an older schema version than the current model.
- Contract tests on the seam against both implementations during the side-by-side phase.
- Room `MigrationTestHelper` tests for later versions of the new database.

## Security checklist

- An encrypted Realm becomes an encrypted Room database: Realm uses a 64-byte key, so open it with that key for the copy, and create the Room database with a SQLCipher `SupportFactory` and a new key; a test fails to open the new file without the key.
- Key handling: the Realm key is read once from its protected storage, kept only in memory, and the new key lives in the Android Keystore or is wrapped by a Keystore key; neither key is logged, stored in a plain preference or written to the marker.
- Leftover plaintext is wiped: delete the `.realm` file and its `.lock`, `.note` and `.management` companions after a verified copy, and delete any Realm compaction copy or export.
- The key material for the old Realm is removed from its storage once the old file is gone.
- No plaintext dump of the data to disk during the copy.

## Rollback

Before the marker is set, switch the flag back to Realm: nothing was removed. After the marker the Realm data is stale, so rollback needs a reverse copy or accepted loss of newer changes. Keep the Realm file and reader until the deletion release and treat deletion as one-way.
