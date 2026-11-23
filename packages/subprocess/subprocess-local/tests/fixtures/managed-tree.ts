import { spawn } from 'node:child_process'
import { rename, writeFile } from 'node:fs/promises'

const [statePath] = process.argv.slice(2)
if (statePath === undefined) throw new Error('usage: managed-tree.ts <state-path>')

process.on('SIGTERM', () => {})
process.on('SIGHUP', () => {})
const descendant = spawn(process.execPath, [
  '-e',
  'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},60_000)',
], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('managed descendant did not publish a pid')

// Publish the state atomically: a reader (the parent test, and this fixture's
// own bootstrap) treats the file's existence as "complete". Writing in place
// creates a window where the file exists but is empty/truncated, so a read that
// lands there throws `Unexpected end of JSON input`. Write a sibling temp file
// and rename it into place so existence implies a fully written document.
const staging = `${statePath}.staging-${process.pid}`
await writeFile(staging, JSON.stringify({ root: process.pid, descendant: descendant.pid }))
await rename(staging, statePath)
setInterval(() => {}, 60_000)
