import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expectedDesktopAssetNames,
  planAssetSync,
  writePlatformManifest,
  type ReleaseAsset,
} from '../scripts/release-assets.ts'

const tempRoots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-release-assets-test-'))
  tempRoots.push(root)
  return root
}

describe('desktop release asset manifests', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('declares only the macOS arm64 and Windows x64 distributables', () => {
    expect(expectedDesktopAssetNames('mac-arm64', '1.0.5')).toEqual([
      'DeepSeek-Desktop-1.0.5-mac-arm64.dmg',
      'DeepSeek-Desktop-1.0.5-mac-arm64.zip',
    ])
    expect(expectedDesktopAssetNames('win-x64', '1.0.5')).toEqual([
      'DeepSeek-Desktop-1.0.5-win-x64.exe',
      'DeepSeek-Desktop-1.0.5-win-x64.zip',
    ])
  })

  it('writes a manifest only when every explicit asset exists and is nonempty', () => {
    const root = tempRoot()
    const dist = join(root, 'dist')
    mkdirSync(dist)
    const names = expectedDesktopAssetNames('mac-arm64', '1.0.5')
    for (const name of names) writeFileSync(join(dist, name), name)
    const output = join(root, 'manifest.json')

    expect(writePlatformManifest('mac-arm64', '1.0.5', dist, output)).toEqual({
      schemaVersion: 1,
      platform: 'mac-arm64',
      version: '1.0.5',
      assets: names,
    })
    expect(() => writePlatformManifest('win-x64', '1.0.5', dist, output)).toThrow('Required win-x64 release artifact')
  })

  it('uploads only missing assets on drafts and skips matching hashes', () => {
    const assets: ReleaseAsset[] = [
      { name: 'a.dmg', path: 'a.dmg', sha256: 'aaa', platform: 'mac-arm64' },
      { name: 'b.exe', path: 'b.exe', sha256: 'bbb', platform: 'win-x64' },
    ]
    expect(planAssetSync(assets, [{ name: 'a.dmg' }], new Map([['a.dmg', 'aaa']]), true)).toEqual({
      upload: [assets[1]!],
      unchanged: [assets[0]!],
    })
    expect(planAssetSync([assets[0]!], [{ name: 'a.dmg' }], new Map([['a.dmg', 'aaa']]), false)).toEqual({
      upload: [],
      unchanged: [assets[0]!],
    })
  })

  it('refuses different hashes, unverified existing assets, duplicates, and missing published assets', () => {
    const asset: ReleaseAsset = { name: 'a.dmg', path: 'a.dmg', sha256: 'a'.repeat(64), platform: 'mac-arm64' }
    expect(() => planAssetSync([asset], [{ name: asset.name }], new Map([[asset.name, 'different']]), true))
      .toThrow('Refusing to overwrite')
    expect(() => planAssetSync([asset], [{ name: asset.name }], new Map(), true)).toThrow('Could not verify existing')
    expect(() => planAssetSync([asset], [{ name: asset.name }, { name: asset.name }], new Map(), true))
      .toThrow('duplicate asset name')
    expect(() => planAssetSync([asset], [], new Map(), false)).toThrow('Published Release is missing')
  })
})
