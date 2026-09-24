# Agent Note: Preserve unproven Harness paths during recovery and collection

Status: implemented

English | [中文](2026-09-23-managed-harness-gc-ownership.zh.md)

## Problem

Harness recovery and retention previously treated path names or copied ownership markers as enough proof to recursively remove a directory. Reinstall recovery could also lose the old current path after a crash between target and backup renames.

## Decision

Pending transactions carry a transaction ID, durable phase, and (when replacing an existing install) the old install ID. Recovery removes, restores, or clears only paths whose marker matches the journal. If a journal expects an old install but neither target nor transaction backup proves it, recovery preserves the journal, blocks new mutations, and does not advertise a launch path.

Legacy pending records without a transaction ID are left untouched and diagnosed. A valid recorded current install can remain available for read-only launch. An older current install without the new trusted ownership marker cannot be reinstalled in place; Desktop reports that ownership proof is missing and leaves it launchable. Installing a different newer version can still proceed into an empty target, retaining the old one for rollback.

Garbage collection never deletes an unreferenced version directory. A complete install tree or ownership marker can be copied into a manual backup, so neither is proof that the directory is disposable. The app diagnoses managed-looking and unknown orphans and preserves both. Transaction staging, health, and replacement backups use separate transaction IDs and are cleaned only through their journal and matching marker. The health home is a sibling of program versions, outside promoted trees. Before recovery or mutation, Desktop checks the managed path and existing ancestors for symbolic links or reparse points.

## Alternatives considered

**Delete an orphan with a valid SemVer name and matching marker/package.** Rejected because a user can copy a complete version directory and its marker as a backup.

**Clear a legacy pending record and infer which fixed backup belongs to it.** Rejected because the old state has no transaction identity; fixed-name artifacts may be user data.

**Automatically migrate an unmarked current installation before reinstall.** Rejected because Desktop cannot prove ownership of that exact target without replacing or editing it.

## Consequences

Unknown paths and unreferenced versions can use additional disk space; this is an intentional safety tradeoff. Legacy current versions remain launchable, and a normal update to a different version remains available. Same-version reinstall of an unmarked current version fails with a clear ownership explanation. A missing expected backup blocks launch and mutation until the state is reviewed or repaired.
