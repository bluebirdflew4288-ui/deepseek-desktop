#!/usr/bin/env bash
# Vendoring discipline, mechanized: any staged change under vendor/*/src or a
# vendored bin.js must come with a vendor/README.md change in the same commit
# (the manifest's local-modification log is the contract — see vendor/README.md).
set -euo pipefail

staged=$(git diff --cached --name-only)

vendor_src_changed=$(echo "$staged" | grep -E '^vendor/[^/]+/(src/|bin\.js)' || true)
manifest_changed=$(echo "$staged" | grep -x 'vendor/README.md' || true)

if [[ -n "$vendor_src_changed" && -z "$manifest_changed" ]]; then
  echo 'vendor manifest guard: vendored SOURCE changed without updating vendor/README.md:'
  echo "$vendor_src_changed" | sed 's/^/  /'
  echo 'Log the modification in vendor/README.md ("Local modifications") and stage it.'
  exit 1
fi

# Version consistency: the manifest table is a snapshot of the vendored
# directories, so a Version cell that disagrees with the package it describes is
# stale provenance. Read the authoritative value from each vendored manifest and
# fail on any divergence — a version cell is provable locally, which is exactly
# why nothing has to take it on trust. The Commit column is deliberately not
# checked here: no local source can prove an upstream revision.
manifest_rows=$(awk -F'|' '
  /^\| `[a-z0-9-]+\/` \|/ {
    dir = $2; ver = $5
    gsub(/[`[:space:]]/, "", dir); sub(/\/$/, "", dir)
    gsub(/[[:space:]]/, "", ver)
    print dir "=" ver
  }
' vendor/README.md)

if [[ -z "$manifest_rows" ]]; then
  echo 'vendor manifest guard: parsed no rows from the vendor/README.md manifest table'
  exit 1
fi

while IFS='=' read -r dir listed; do
  [[ -z "$dir" ]] && continue
  actual=$(node -p "require('./vendor/$dir/package.json').version" 2>/dev/null || true)
  if [[ -z "$actual" ]]; then
    echo "vendor manifest guard: vendor/$dir has no readable package.json version"
    exit 1
  fi
  if [[ "$actual" != "$listed" ]]; then
    echo "vendor manifest guard: vendor/README.md lists $dir@$listed but the vendored manifest is $dir@$actual"
    echo 'Update the manifest table Version cell (never infer the Commit cell from it).'
    exit 1
  fi
done <<< "$manifest_rows"
