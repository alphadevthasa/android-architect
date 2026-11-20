---
id: encrypted-sharedpreferences--to--datastore
dimension: keyvalue
from: encrypted-sharedpreferences
to: datastore
title: EncryptedSharedPreferences to DataStore
irreversible: true
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves values from EncryptedSharedPreferences to DataStore without losing at-rest encryption. Written from memory of https://developer.android.com/topic/libraries/architecture/datastore and https://developer.android.com/privacy-and-security/keystore; check the current docs before relying on a detail. The plain SharedPreferences steps are in the SharedPreferences to DataStore playbook; this one covers the encryption pitfall.

## When it is worth it

The security-crypto library that provides EncryptedSharedPreferences is deprecated, and the team wants asynchronous, Flow-based storage with a supported path. Move when the dependency blocks an update or when synchronous reads of encrypted values hurt startup.

## When not to

The values are few, work reliably and no dependency upgrade is blocked, and there is no budget to design the new encryption layer correctly. Moving to plain DataStore without encryption would be a security regression, so do not move without the plan below.

## Preconditions

- Every encrypted preferences file and the sensitivity of each key are listed.
- A design for encryption at rest in the new store exists: a Tink `Aead` backed by an Android Keystore master key, or a Keystore-wrapped key used with a serializer for Proto DataStore.
- Reads go through a settings interface (the seam) or can be put behind one first.

## Steps

1. Inventory the encrypted files, keys and types, and mark which keys are secrets.
2. Define the seam: a secure settings interface with suspend functions and Flows, no preference types in signatures.
3. Build the encryption layer first. DataStore is not encrypted by default; use a Proto DataStore with a custom `Serializer` that encrypts and decrypts the bytes with a Tink `Aead` whose key is protected by the Android Keystore, or encrypt individual values before writing them to Preferences DataStore.
4. Implement the seam on DataStore with that layer, and keep the EncryptedSharedPreferences implementation side by side behind a flag.
5. Write a custom one-time migration: read each value from EncryptedSharedPreferences, write it through the encrypting DataStore, verify, and write a "migrated" marker last. The built-in `SharedPreferencesMigration` expects a plain file and cannot read the encrypted one, so use a `DataMigration` of your own.
6. Do the per-unit cutover: move one encrypted file or one settings area at a time, after its marker is set.
7. Delete the old implementation: the EncryptedSharedPreferences code, the security-crypto dependency, the old file and its master key entry (see Security checklist).

## Pitfalls

- Not encrypted by default: a DataStore file written without the layer from step 3 holds secrets in plaintext, readable from a backup or a rooted device.
- Keystore keys can be invalidated (lock screen changes with auth-bound keys, restore to a new device): decryption can fail, so the serializer must handle failure by resetting the value, not crash in a loop.
- Do not reuse the old EncryptedSharedPreferences master key alias for new data; use a new alias and remove the old one at the end.
- The single-writer rule applies: one DataStore instance per file.
- Backed-up encrypted data cannot be decrypted on another device: exclude the DataStore file from backup.
- Decrypt only what is needed, on demand, and do not cache secrets in long-lived singletons or static fields.

## Tests

- Round-trip test: write a value through the encrypting layer, read the raw file bytes, and assert the plaintext is absent.
- Migration test: seed an EncryptedSharedPreferences file with values of each type, run the migration, assert values arrive and the marker is set only at the end.
- Failure test: corrupt the ciphertext or remove the key, and assert the app recovers with defaults.
- Contract tests on the seam against both implementations during the side-by-side phase.
- Upgrade test from an installed old build on a device or emulator.

## Security checklist

- The new store is not encrypted by default, so encryption is implemented explicitly with Tink and an Android Keystore key, and a test asserts that raw bytes on disk do not contain the plaintext value.
- Keystore key handling: a new key alias, non-exportable key, no key bytes in logs or preferences, and the old master key entry is deleted after migration.
- The old EncryptedSharedPreferences file is deleted after a verified migration, together with any backup copy.
- Backup rules exclude the new DataStore file, and `android:allowBackup` and `dataExtractionRules` are reviewed.
- Decryption failures reset the value and are logged without the value or key material.

## Rollback

Before the old implementation is deleted, flip the flag back to EncryptedSharedPreferences; keep the old file until the marker is set for nearly all users. After deletion there is no reverse migration, so treat it as one-way, and keep the old key alias until the old file is removed.
