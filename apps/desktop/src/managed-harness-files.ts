/** Safe filesystem primitives for paths below the managed Harness root. */

import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

function assertContained(path: string, anchor: string): { path: string; anchor: string } {
  const absolutePath = resolve(path)
  const absoluteAnchor = resolve(anchor)
  const fromAnchor = relative(absoluteAnchor, absolutePath)
  if (fromAnchor === '..' || fromAnchor.startsWith('..' + sep) || isAbsolute(fromAnchor)) {
    throw new Error('managed Harness path is outside its trusted directory')
  }
  return { path: absolutePath, anchor: absoluteAnchor }
}

/** Check the directory chain from an existing trusted anchor without creating it. */
export async function assertSafeDirectoryTree(path: string, anchor: string): Promise<void> {
  const checked = assertContained(path, anchor)
  const chain: string[] = []
  let current = checked.path
  while (true) {
    chain.push(current)
    if (relative(checked.anchor, current) === '') break
    const parent = dirname(current)
    if (parent === current) throw new Error('managed Harness trust anchor is not an ancestor')
    current = parent
  }
  for (const directory of chain.reverse()) {
    const metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`managed Harness directory contains a reparse point or non-directory: ${directory}`)
    }
  }
}

/** Create missing directories one at a time after validating every existing ancestor. */
export async function ensureSafeDirectoryTree(path: string, anchor: string): Promise<void> {
  const checked = assertContained(path, anchor)
  const chain: string[] = []
  let current = checked.path
  while (true) {
    chain.push(current)
    if (relative(checked.anchor, current) === '') break
    const parent = dirname(current)
    if (parent === current) throw new Error('managed Harness trust anchor is not an ancestor')
    current = parent
  }
  for (const directory of chain.reverse()) {
    try {
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`managed Harness directory contains a reparse point or non-directory: ${directory}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(directory, { recursive: false, mode: 0o700 })
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`managed Harness directory contains a reparse point or non-directory: ${directory}`)
      }
    }
  }
}

/** Reject a missing, linked, non-file, or multiply-linked leaf when it must exist. */
export async function assertSafeRegularFile(path: string, anchor: string, allowMissing = false): Promise<void> {
  const checked = assertContained(path, anchor)
  await assertSafeDirectoryTree(dirname(checked.path), checked.anchor)
  let metadata
  try { metadata = await lstat(checked.path) } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
    throw new Error(`managed Harness file is a reparse point, linked, or not a regular file: ${checked.path}`)
  }
}

/** Create or validate the empty npm configuration files without truncating existing paths. */
export async function ensureEmptyManagedFile(path: string, anchor: string): Promise<void> {
  const checked = assertContained(path, anchor)
  await ensureSafeDirectoryTree(dirname(checked.path), checked.anchor)
  try {
    await assertSafeRegularFile(checked.path, checked.anchor)
    const content = await readFile(checked.path, 'utf8')
    if (content !== '') throw new Error(`managed Harness config is not empty: ${checked.path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(checked.path, '', { flag: 'wx', mode: 0o600 })
    await assertSafeRegularFile(checked.path, checked.anchor)
  }
}
