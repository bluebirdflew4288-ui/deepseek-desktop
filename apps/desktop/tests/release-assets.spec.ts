import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canReuseDraftRelease,
  canReusePublishedV105Release,
  expectedDesktopAssetNames,
  findReleaseByTag,
  planAssetSync,
  renderDesktopReleaseNotes,
  windowsSigningReleaseNotes,
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

  it('renders truthful signed and unsigned Windows release notes', () => {
    expect(windowsSigningReleaseNotes('unsigned')).toEqual({
      en: 'Unsigned / NotSigned. The Windows x64 installer and application executable are not Authenticode-signed. Windows Defender SmartScreen may display an "Unknown publisher" or "Windows protected your PC" warning. This is a publisher/reputation warning, not a malware detection, and Windows Defender will not necessarily block the application. Download only from this repository\'s official GitHub Release and verify the SHA-256 hashes below.',
      zh: 'Unsigned / NotSigned。Windows x64 安装程序与应用可执行文件当前未使用 Authenticode 代码签名。Windows Defender SmartScreen 可能提示“未知发布者”或“Windows 已保护你的电脑”。这是发布者/信誉警告，不表示 malware detection，也不意味着 Windows Defender 一定会拦截。请仅从本仓库官方 GitHub Release 下载，并使用下方 SHA-256 校验值。',
    })
    expect(windowsSigningReleaseNotes('signed')).toEqual({
      en: 'Authenticode-signed installer and application executable; the trusted certificate chain, exact publisher Subject, and RFC 3161 timestamp were verified before release.',
      zh: '安装程序与应用可执行文件均通过 Authenticode 签名；发布前已验证可信证书链、完整 Publisher Subject 精确匹配和 RFC 3161 时间戳。',
    })
  })

  it('finds an existing draft Release when tag lookup excludes drafts', () => {
    const draft = { id: 397152774, tag_name: 'v1.0.5', draft: true }
    expect(findReleaseByTag([{ tag_name: 'v1.0.4', draft: false }, draft], 'v1.0.5')).toBe(draft)
    expect(findReleaseByTag([], 'v1.0.5')).toBeUndefined()
  })

  it('only reuses drafts with release provenance and matching signing disclosure', () => {
    const draft = {
      tag_name: 'v1.0.5',
      draft: true,
      body: 'Application source commit: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`\nRelease tooling commit: `abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789`\nUnsigned / NotSigned.',
    }
    expect(canReuseDraftRelease(draft, 'Unsigned / NotSigned.')).toBe(true)
    expect(canReuseDraftRelease({ ...draft, draft: false }, 'Unsigned / NotSigned.')).toBe(false)
    expect(canReuseDraftRelease(draft, 'Authenticode-signed')).toBe(false)
    expect(canReuseDraftRelease({ ...draft, body: 'Source commit: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789`' }, 'Unsigned / NotSigned.')).toBe(false)
  })

  it('allows only read-only compatibility for the published v1.0.5 legacy provenance', () => {
    const legacy = {
      draft: false,
      body: 'Source commit: `bb7e18bbe632507e51822f11c2ee77e6297e1199`',
    }
    expect(canReusePublishedV105Release(legacy, 'v1.0.5')).toBe(true)
    expect(canReusePublishedV105Release(legacy, 'v1.0.6')).toBe(false)
    expect(canReusePublishedV105Release({ ...legacy, draft: true }, 'v1.0.5')).toBe(false)
    expect(canReusePublishedV105Release({ ...legacy, body: 'Application source commit: `8cdad7930310893150976929758b29975877fb28`' }, 'v1.0.5')).toBe(false)
  })

  it('renders distinct application-source and release-tooling provenance', () => {
    const notes = renderDesktopReleaseNotes(
      '# {{VERSION}}\nApplication source commit: `{{APPLICATION_SOURCE_COMMIT}}`\nRelease tooling commit: `{{RELEASE_TOOLING_COMMIT}}`\n{{ASSET_HASHES}}\n{{WINDOWS_SIGNING_DETAILS}}\n{{WINDOWS_SIGNING_DETAILS_ZH}}',
      '1.0.6',
      '8cdad7930310893150976929758b29975877fb28',
      'bb7e18bbe632507e51822f11c2ee77e6297e1199',
      '- artifact: SHA-256 `abc`',
      { en: 'unsigned', zh: '未签名' },
    )
    expect(notes).toContain('Application source commit: `8cdad7930310893150976929758b29975877fb28`')
    expect(notes).toContain('Release tooling commit: `bb7e18bbe632507e51822f11c2ee77e6297e1199`')
    expect(notes).toContain('未签名')
    expect(() => renderDesktopReleaseNotes('template', '1.0.6', 'GITHUB_SHA', 'a'.repeat(40), '', { en: '', zh: '' }))
      .toThrow('Invalid application source commit identity')
  })
})
