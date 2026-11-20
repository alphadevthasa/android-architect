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

One safe ordering applies: (1) the migration is one-way per file with a single writer and no dual-write; (2) the old file and its key are deleted only after verification and a full release cycle; (3) rollback is decided before the first release.

1. Inventory the encrypted files, keys and types, mark which keys are secrets, and list every file (and any `EncryptedFile`) that uses the same master key alias.
2. Define the seam: a secure settings interface with suspend functions and Flows, no preference types in signatures.
3. Build the encryption layer first. DataStore is not encrypted by default; use a Proto DataStore with a custom `Serializer` that encrypts and decrypts the bytes with a Tink `Aead` whose key is protected by the Android Keystore, or encrypt individual values before writing them to Preferences DataStore.
4. Implement the seam on DataStore with that layer, and keep the EncryptedSharedPreferences implementation in the code side by side behind a flag that selects one store per file. Never write the same value to both stores.
5. Write a custom one-time `DataMigration`: read each value from EncryptedSharedPreferences, write it through the encrypting DataStore, record a "migrated" marker inside the DataStore, return `false` from `shouldMigrate` once it exists, and leave the old file untouched in `cleanUp`. The built-in `SharedPreferencesMigration` expects a plain file and cannot read the encrypted one.
6. Do the per-unit cutover: move one encrypted file or one settings area at a time, with every reader and writer of that file switching in the same release.
7. After verification and a full release cycle, delete the old implementation: the EncryptedSharedPreferences code, the old file (`Context.deleteSharedPreferences(name)`) and the flag. EncryptedSharedPreferences keeps its key and value keysets inside its own file under reserved keys, so `deleteSharedPreferences(name)` removes them with the file. The separate shared keyset file `__androidx_security_crypto_encrypted_file_pref__` belongs to `EncryptedFile`: delete it only when no `EncryptedFile` remains in the app. Remove the old master key alias and the security-crypto dependency only after every file and `EncryptedFile` that used that alias is migrated and deleted (see Security checklist).

## Pitfalls

- Not encrypted by default: a DataStore file written without the layer from step 3 holds secrets in plaintext, readable from a backup or a rooted device.
- Keystore keys can be invalidated (lock screen changes with auth-bound keys, restore to a new device): decryption can fail, so the serializer must handle failure without crash loops. For credentials and tokens, a reset value means the user must authenticate again; require re-authentication instead of substituting a default.
- Do not reuse the old EncryptedSharedPreferences master key alias for new data; use a new alias. Deleting the old alias while any other encrypted file still uses it makes that file unreadable.
- The single-writer rule applies: one DataStore instance per file.
- Backed-up encrypted data cannot be decrypted on another device: exclude the DataStore file from backup.
- Decrypt only what is needed, on demand, and do not cache secrets in long-lived singletons or static fields.
- A custom migration without a marker re-runs and overwrites newer values on every start.

## Tests

- Round-trip test: write a value through the encrypting layer, read the raw file bytes, and assert the plaintext is absent.
- Migration test: seed an EncryptedSharedPreferences file with values of each type, run the migration, assert values arrive and the marker is set only at the end.
- Failure test: corrupt the ciphertext or remove the key, and assert that non-credential values fall back to defaults and that credentials and tokens force re-authentication instead of a default.
- Contract tests on the seam against both implementations during the side-by-side phase.
- Upgrade test from an installed old build on a device or emulator.

## Security checklist

- The new store is not encrypted by default, so encryption is implemented explicitly with Tink and an Android Keystore key, and a test asserts that raw bytes on disk do not contain the plaintext value.
- Keystore key handling: a new key alias, non-exportable key, no key bytes in logs or preferences. The old master key alias is deleted only after every file (and any `EncryptedFile`) that used it has been migrated and deleted.
- The old EncryptedSharedPreferences file is deleted after a verified migration and the deletion release (`Context.deleteSharedPreferences(name)`, which also removes the keysets stored inside it), together with any backup copy. The shared `EncryptedFile` keyset file is left in place while any `EncryptedFile` remains.
- Backup rules exclude the new DataStore file, and `android:allowBackup` and `dataExtractionRules` are reviewed.
- Decryption failures for credentials and tokens force re-authentication; they are logged without the value or key material.

## Rollback

Decide before the first release. Because the custom migration leaves the old file and the old key untouched, the flag or a new release that contains the old code can read the values as of the migration (later changes are lost) until the deletion release. Do not delete the old master key alias or file earlier. A rollback release (a new release that contains the old code) must read the old file, not reset defaults. After the old file and key are deleted there is no reverse migration, so treat the move as one-way.
