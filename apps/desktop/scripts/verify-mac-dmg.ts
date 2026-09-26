/** Verify the macOS release DMG's visible contents and app bundle identity. */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
  readonly version: string
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

function plistValue(app: string, key: string): string {
  return execFileSync('/usr/libexec/PlistBuddy', [
    '-c', `Print :${key}`, join(app, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim()
}

function verifyDmg(dmgPath: string): void {
  if (process.platform !== 'darwin') throw new Error('DMG verification requires macOS')
  const absoluteDmg = resolve(dmgPath)
  if (!basename(absoluteDmg).endsWith('-mac-arm64.dmg')) throw new Error('Expected a macOS arm64 release DMG')
  run('hdiutil', ['verify', absoluteDmg])

  const temp = mkdtempSync(join(tmpdir(), 'deepseek-desktop-dmg-'))
  const mountPoint = join(temp, 'mount')
  const app = join(mountPoint, 'DeepSeek Desktop.app')
  const guide = join(mountPoint, '安装指南.txt')
  let mounted = false
  try {
    run('mkdir', ['-p', mountPoint])
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, absoluteDmg])
    mounted = true

    const entries = new Set(readdirSync(mountPoint).map(entry => entry.normalize('NFC')))
    for (const expected of ['DeepSeek Desktop.app', 'Applications', '安装指南.txt']) {
      if (!entries.has(expected)) throw new Error(`DMG is missing its root item: ${expected}`)
    }
    if (!lstatSync(app).isDirectory()) throw new Error('DMG app bundle is not a directory')
    if (!lstatSync(join(mountPoint, 'Applications')).isSymbolicLink()
      || realpathSync(join(mountPoint, 'Applications')) !== '/Applications') {
      throw new Error('DMG Applications item is not a link to /Applications')
    }

    const guideText = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(guide))
    if (!guideText.includes('DeepSeek Desktop 安装指南')
      || /spctl\s+--master-disable|xattr\s+-cr/iu.test(guideText)) {
      throw new Error('DMG installation guide is invalid or recommends disabling Gatekeeper')
    }

    if (plistValue(app, 'CFBundleIdentifier') !== 'ai.deepseek.harness.desktop') {
      throw new Error('DMG app bundle identifier changed')
    }
    if (plistValue(app, 'CFBundleShortVersionString') !== packageJson.version
      || plistValue(app, 'CFBundleVersion') !== packageJson.version) {
      throw new Error('DMG app bundle version does not match the desktop package version')
    }
    const executable = join(app, 'Contents', 'MacOS', plistValue(app, 'CFBundleExecutable'))
    if (!run('lipo', ['-archs', executable]).trim().split(/\s+/u).includes('arm64')) {
      throw new Error('DMG app executable does not contain arm64')
    }
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    console.log(`Verified ${basename(absoluteDmg)}: app, Applications link, UTF-8 guide, identity ${packageJson.version}, arm64.`)
  } finally {
    if (mounted) run('hdiutil', ['detach', mountPoint])
    rmSync(temp, { recursive: true, force: true })
  }
}

const [dmgPath, ...extra] = process.argv.slice(2)
if (dmgPath === undefined || extra.length > 0) throw new Error('Expected one DMG path')
verifyDmg(dmgPath)
