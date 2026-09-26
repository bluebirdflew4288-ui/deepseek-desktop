/** Prepare and publish an immutable, explicitly named desktop release asset set. */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export type DesktopReleasePlatform = 'mac-arm64' | 'win-x64'

export interface DesktopPlatformManifest {
  readonly schemaVersion: 1
  readonly platform: DesktopReleasePlatform
  readonly version: string
  readonly assets: readonly string[]
}

export interface ReleaseAsset {
  readonly name: string
  readonly path: string
  readonly sha256: string
  readonly platform: DesktopReleasePlatform
}

export interface RemoteReleaseAsset {
  readonly name: string
}

export interface AssetSyncPlan {
  readonly upload: readonly ReleaseAsset[]
  readonly unchanged: readonly ReleaseAsset[]
}

export type WindowsReleaseMode = 'signed' | 'unsigned'

export interface WindowsSigningManifest {
  readonly schemaVersion: 1
  readonly platform: 'win-x64'
  readonly version: string
  readonly mode: WindowsReleaseMode
  readonly authenticode: 'Valid' | 'NotSigned'
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const LEGACY_V105_TOOLING_COMMIT = 'bb7e18bbe632507e51822f11c2ee77e6297e1199'

export function expectedDesktopAssetNames(platform: DesktopReleasePlatform, version: string): readonly string[] {
  if (!SEMVER.test(version)) throw new Error(`Invalid desktop release version: ${version}`)
  const base = `DeepSeek-Desktop-${version}`
  return platform === 'mac-arm64'
    ? [`${base}-mac-arm64.dmg`, `${base}-mac-arm64.zip`]
    : [`${base}-win-x64.exe`, `${base}-win-x64.zip`]
}

export function planAssetSync(
  expected: readonly ReleaseAsset[],
  remoteAssets: readonly RemoteReleaseAsset[],
  remoteHashes: ReadonlyMap<string, string>,
  isDraft: boolean,
): AssetSyncPlan {
  const remoteNames = new Set<string>()
  for (const asset of remoteAssets) {
    if (remoteNames.has(asset.name)) throw new Error(`GitHub Release contains duplicate asset name: ${asset.name}`)
    remoteNames.add(asset.name)
  }
  const upload: ReleaseAsset[] = []
  const unchanged: ReleaseAsset[] = []
  for (const asset of expected) {
    if (!remoteNames.has(asset.name)) {
      if (!isDraft) throw new Error(`Published Release is missing immutable asset: ${asset.name}`)
      upload.push(asset)
      continue
    }
    const remoteHash = remoteHashes.get(asset.name)
    if (remoteHash === undefined) throw new Error(`Could not verify existing Release asset: ${asset.name}`)
    if (remoteHash.toLowerCase() !== asset.sha256.toLowerCase()) {
      throw new Error(`Refusing to overwrite Release asset with a different SHA-256: ${asset.name}`)
    }
    unchanged.push(asset)
  }
  return { upload, unchanged }
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function windowsSigningReleaseNotes(mode: WindowsReleaseMode): { readonly en: string; readonly zh: string } {
  if (mode === 'signed') {
    return {
      en: 'Authenticode-signed installer and application executable; the trusted certificate chain, exact publisher Subject, and RFC 3161 timestamp were verified before release.',
      zh: '安装程序与应用可执行文件均通过 Authenticode 签名；发布前已验证可信证书链、完整 Publisher Subject 精确匹配和 RFC 3161 时间戳。',
    }
  }
  return {
    en: 'Unsigned / NotSigned. The Windows x64 installer and application executable are not Authenticode-signed. Windows Defender SmartScreen may display an "Unknown publisher" or "Windows protected your PC" warning. This is a publisher/reputation warning, not a malware detection, and Windows Defender will not necessarily block the application. Download only from this repository\'s official GitHub Release and verify the SHA-256 hashes below.',
    zh: 'Unsigned / NotSigned。Windows x64 安装程序与应用可执行文件当前未使用 Authenticode 代码签名。Windows Defender SmartScreen 可能提示“未知发布者”或“Windows 已保护你的电脑”。这是发布者/信誉警告，不表示 malware detection，也不意味着 Windows Defender 一定会拦截。请仅从本仓库官方 GitHub Release 下载，并使用下方 SHA-256 校验值。',
  }
}

function readWindowsSigningManifest(root: string, version: string): WindowsSigningManifest {
  const path = join(root, 'win', 'windows-signing-manifest.json')
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error('Windows signing manifest is missing')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowsSigningManifest>
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'win-x64' || manifest.version !== version
    || (manifest.mode !== 'signed' && manifest.mode !== 'unsigned')
    || (manifest.authenticode !== 'Valid' && manifest.authenticode !== 'NotSigned')
    || (manifest.mode === 'signed' && manifest.authenticode !== 'Valid')
    || (manifest.mode === 'unsigned' && manifest.authenticode !== 'NotSigned')) {
    throw new Error('Invalid Windows signing manifest')
  }
  return manifest as WindowsSigningManifest
}

export function writePlatformManifest(
  platform: DesktopReleasePlatform,
  version: string,
  distDirectory: string,
  outputPath: string,
): DesktopPlatformManifest {
  const assets = expectedDesktopAssetNames(platform, version)
  for (const name of assets) {
    const path = join(distDirectory, name)
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      throw new Error(`Required ${platform} release artifact is missing or empty: ${name}`)
    }
  }
  const manifest: DesktopPlatformManifest = { schemaVersion: 1, platform, version, assets }
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
  return manifest
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (key === undefined || !key.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('Expected --name value arguments')
    }
    parsed.set(key.slice(2), value)
  }
  return parsed
}

function required(args: ReadonlyMap<string, string>, name: string): string {
  const value = args.get(name)
  if (value === undefined || value.trim() === '') throw new Error(`Missing --${name}`)
  return value
}

function runGh(args: readonly string[]): string {
  const result = spawnSync('gh', [...args], { encoding: 'utf8', windowsHide: true })
  if (result.error !== undefined || result.status !== 0) {
    // Do not include process arguments or environment in errors; the release
    // workflow may carry a scoped GitHub token in GH_TOKEN.
    throw new Error(`GitHub CLI operation failed (exit ${String(result.status)})`)
  }
  return result.stdout
}

export function findReleaseByTag(
  releases: readonly Record<string, unknown>[],
  tag: string,
): Record<string, unknown> | undefined {
  return releases.find(release => release.tag_name === tag)
}

export function canReuseDraftRelease(
  release: Record<string, unknown>,
  expectedSigningDetails: string,
): boolean {
  return release.draft === true
    && typeof release.body === 'string'
    && /Application source commit: `(?:[0-9a-f]{40}|[0-9a-f]{64})`/iu.test(release.body)
    && /Release tooling commit: `(?:[0-9a-f]{40}|[0-9a-f]{64})`/iu.test(release.body)
    && release.body.includes(expectedSigningDetails)
}

/** Allow read-only verification of v1.0.5 without rewriting its published legacy notes. */
export function canReusePublishedV105Release(release: Record<string, unknown>, tag: string): boolean {
  return tag === 'v1.0.5'
    && release.draft === false
    && typeof release.body === 'string'
    && release.body.includes(`Source commit: \`${LEGACY_V105_TOOLING_COMMIT}\``)
}

/** Render Release Notes with source provenance resolved from the immutable tag and actual tooling ref. */
export function renderDesktopReleaseNotes(
  template: string,
  version: string,
  applicationSourceCommit: string,
  releaseToolingCommit: string,
  assetHashes: string,
  windowsSigningDetails: { readonly en: string; readonly zh: string },
): string {
  for (const [label, commit] of [
    ['application source', applicationSourceCommit],
    ['release tooling', releaseToolingCommit],
  ] as const) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(commit)) {
      throw new Error(`Invalid ${label} commit identity`)
    }
  }
  return template
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{APPLICATION_SOURCE_COMMIT}}', applicationSourceCommit)
    .replaceAll('{{RELEASE_TOOLING_COMMIT}}', releaseToolingCommit)
    .replaceAll('{{ASSET_HASHES}}', assetHashes)
    .replaceAll('{{WINDOWS_SIGNING_DETAILS}}', windowsSigningDetails.en)
    .replaceAll('{{WINDOWS_SIGNING_DETAILS_ZH}}', windowsSigningDetails.zh)
}

function releaseJson(repo: string, tag: string): Record<string, unknown> | undefined {
  const result = spawnSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    if (`${result.stderr ?? ''} ${result.stdout ?? ''}`.includes('404')) {
      // GitHub's tag lookup does not return draft Releases. Search the full
      // authenticated Release list so a failed retry reuses the existing
      // immutable draft instead of attempting a duplicate create.
      const list = spawnSync('gh', ['api', `repos/${repo}/releases?per_page=100`], { encoding: 'utf8', windowsHide: true })
      if (list.status !== 0) throw new Error(`Could not inspect GitHub Release list (exit ${String(list.status)})`)
      return findReleaseByTag(JSON.parse(list.stdout) as Record<string, unknown>[], tag)
    }
    throw new Error(`Could not inspect GitHub Release (exit ${String(result.status)})`)
  }
  return JSON.parse(result.stdout) as Record<string, unknown>
}

function releaseAssets(repo: string, id: number): RemoteReleaseAsset[] {
  return JSON.parse(runGh(['api', `repos/${repo}/releases/${id}/assets`])) as RemoteReleaseAsset[]
}

function downloadedHash(repo: string, tag: string, name: string, directory: string): string {
  const result = spawnSync('gh', ['release', 'download', tag, '--repo', repo, '--dir', directory, '--pattern', name], {
    encoding: 'utf8', windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) throw new Error(`Could not download existing Release asset: ${name}`)
  const path = join(directory, name)
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Existing Release asset download is missing: ${name}`)
  return hashFile(path)
}

function readExpectedAssets(root: string, tag: string): ReleaseAsset[] {
  const version = tag.slice(1)
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(tag)) {
    throw new Error(`Invalid desktop release tag: ${tag}`)
  }
  const assets: ReleaseAsset[] = []
  for (const [platform, directory] of [['mac-arm64', 'mac'], ['win-x64', 'win']] as const) {
    const platformRoot = join(root, directory)
    const manifestPath = join(platformRoot, 'release-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DesktopPlatformManifest
    if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.version !== version) {
      throw new Error(`Invalid ${platform} release manifest`)
    }
    const expected = expectedDesktopAssetNames(platform, version)
    if (JSON.stringify(manifest.assets) !== JSON.stringify(expected)) throw new Error(`Unexpected ${platform} release manifest asset list`)
    for (const name of expected) {
      const path = join(platformRoot, 'dist', name)
      if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
        throw new Error(`Required release artifact is missing or empty: ${name}`)
      }
      assets.push({ name, path, sha256: hashFile(path), platform })
    }
  }
  return assets
}

async function syncRelease(args: ReadonlyMap<string, string>): Promise<void> {
  const tag = required(args, 'tag')
  const repo = required(args, 'repo')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error('Invalid GitHub repository identity')
  const root = resolve(required(args, 'artifacts-root'))
  const notesTemplate = resolve(required(args, 'notes-template'))
  const expected = readExpectedAssets(root, tag)
  const version = tag.slice(1)
  const windowsSigningManifest = readWindowsSigningManifest(root, version)
  const applicationSourceCommit = required(args, 'application-source-commit')
  const releaseToolingCommit = required(args, 'release-tooling-commit')
  const hashes = expected.map(asset => `- ${asset.name}: SHA-256 \`${asset.sha256}\``).join('\n')
  const notes = renderDesktopReleaseNotes(
    readFileSync(notesTemplate, 'utf8'),
    version,
    applicationSourceCommit,
    releaseToolingCommit,
    hashes,
    windowsSigningReleaseNotes(windowsSigningManifest.mode),
  )

  const expectedSigningDetails = windowsSigningReleaseNotes(windowsSigningManifest.mode).en
  let release = releaseJson(repo, tag)
  if (release === undefined) {
    runGh(['release', 'create', tag, '--repo', repo, '--draft', '--title', `DeepSeek Desktop ${tag}`, '--notes', notes])
    release = releaseJson(repo, tag)
    if (release === undefined) throw new Error('Draft GitHub Release was not created')
  }
  const id = release.id
  if (typeof id !== 'number' || typeof release.draft !== 'boolean') throw new Error('GitHub Release response is incomplete')
  const isDraft = release.draft
  const hasExpectedProvenance = typeof release.body === 'string'
    && release.body.includes(`Application source commit: \`${applicationSourceCommit}\``)
    && release.body.includes(`Release tooling commit: \`${releaseToolingCommit}\``)
  if (!hasExpectedProvenance
    && !canReuseDraftRelease(release, expectedSigningDetails)
    && !canReusePublishedV105Release(release, tag)) {
    throw new Error('Existing Release commit provenance differs from this tag run')
  }
  const currentAssets = releaseAssets(repo, id)
  const temp = mkdtempSync(join(tmpdir(), 'deepseek-desktop-release-'))
  const existingDir = join(temp, 'existing')
  const verifiedDir = join(temp, 'verified')
  mkdirSync(existingDir)
  mkdirSync(verifiedDir)
  try {
    const remoteHashes = new Map<string, string>()
    for (const asset of expected) {
      if (currentAssets.some(existing => existing.name === asset.name)) {
        remoteHashes.set(asset.name, downloadedHash(repo, tag, asset.name, existingDir))
      }
    }
    const plan = planAssetSync(expected, currentAssets, remoteHashes, isDraft)
    for (const asset of plan.upload) {
      // No --clobber: duplicate names or a concurrent upload fail closed.
      runGh(['release', 'upload', tag, asset.path, '--repo', repo])
    }

    const verifiedAssets = releaseAssets(repo, id)
    for (const asset of expected) {
      if (!verifiedAssets.some(existing => existing.name === asset.name)) {
        throw new Error(`Release asset is absent after upload: ${asset.name}`)
      }
      const actual = downloadedHash(repo, tag, asset.name, verifiedDir)
      if (actual !== asset.sha256) throw new Error(`Release asset SHA-256 verification failed: ${asset.name}`)
    }
    if (isDraft) {
      runGh(['api', '-X', 'PATCH', `repos/${repo}/releases/${id}`, '-f', `body=${notes}`, '-F', 'draft=false'])
      release = releaseJson(repo, tag)
      if (release?.draft !== false) throw new Error('GitHub Release did not leave draft state after verification')
    }
    console.log(`Verified immutable desktop Release ${tag}: ${expected.length} assets; macOS arm64 and Windows x64.`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (command === 'write-platform-manifest') {
    const platform = required(args, 'platform') as DesktopReleasePlatform
    if (platform !== 'mac-arm64' && platform !== 'win-x64') throw new Error('Unsupported desktop release platform')
    const tag = required(args, 'tag')
    if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(tag)) throw new Error(`Invalid desktop release tag: ${tag}`)
    const version = tag.slice(1)
    const manifest = writePlatformManifest(platform, version, resolve(required(args, 'dist')), resolve(required(args, 'output')))
    console.log(`Release manifest verified: ${manifest.platform} ${manifest.version}`)
    return
  }
  if (command === 'sync') {
    void syncRelease(args).catch((error) => {
      console.error(error instanceof Error ? error.message : 'Desktop Release synchronization failed')
      process.exitCode = 1
    })
    return
  }
  throw new Error('Expected write-platform-manifest or sync')
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) main()
