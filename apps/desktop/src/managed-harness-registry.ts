/**
 * Official release metadata for the managed Harness.
 *
 * The registry URL and package name are fixed here rather than configurable: a
 * deployment that could redirect them to another registry would silently
 * replace the Harness the desktop installs.
 */

import { isManagedHarnessVersionName } from './managed-harness-paths.ts'

/** Official npm registry the managed Harness resolves and downloads from. */
export const HARNESS_REGISTRY = 'https://registry.npmjs.org/'

/** Official package the managed Harness installs. */
export const HARNESS_PACKAGE = '@deepseek-ai/dsh'

/**
 * Distribution tag read for updates. Prerelease channels are deliberately not
 * consulted, so an alpha or nightly build is never offered as an update.
 */
const RELEASE_TAG = 'latest'

/** Default bound on one registry round trip. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Package metadata URL encoding for a scoped name. */
const PACKUMENT_PATH = HARNESS_PACKAGE.replace('/', '%2f')

/** One release the official registry publishes. */
export interface HarnessRelease {
  /** Exact version the release tag names. */
  readonly version: string
  /**
   * Subresource integrity value the registry publishes for this release's
   * tarball. The installer's package manager enforces it on download; the
   * desktop records it so a promoted version is traceable to official metadata.
   */
  readonly integrity?: string
  /** Tarball URL the registry publishes for this release. */
  readonly tarball?: string
}

/** Source of the next Harness version the desktop may install. */
export interface HarnessReleaseSource {
  /**
   * Read the release the official `latest` tag names.
   * @param signal - Abandoning signal for the round trip. Abandoning a lookup
   * writes nothing: the registry answer is metadata this desktop has not acted on
   * yet, so a cancelled lookup leaves no residue to recover.
   * @returns The resolved release metadata.
   * @throws When the registry is unreachable, answers slowly, is abandoned, or
   * publishes a release tag this build cannot use as a directory name.
   */
  latest(signal?: AbortSignal): Promise<HarnessRelease>
}

/** Dependencies one release source needs, injectable for tests. */
export interface HarnessReleaseSourceOptions {
  /** Fetch implementation used for the registry round trip. */
  readonly fetchImpl?: typeof fetch
  /** Bound on one round trip before the lookup is abandoned. */
  readonly timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(container: Record<string, unknown>, field: string): string | undefined {
  const value = container[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Validate one registry packument and read its release tag.
 *
 * Only the fields this build acts on are read; an unexpected document shape is
 * rejected rather than partially trusted.
 * @param packument - Decoded registry response for the Harness package.
 * @returns The release the `latest` tag names.
 * @throws When the tag is absent or names an unusable version.
 */
export function readHarnessRelease(packument: unknown): HarnessRelease {
  if (!isRecord(packument)) throw new Error('Harness registry returned an unexpected document')
  const distTags = packument['dist-tags']
  if (!isRecord(distTags)) throw new Error('Harness registry returned no distribution tags')
  const version = readText(distTags, RELEASE_TAG)
  if (version === undefined) {
    throw new Error(`Harness registry publishes no ${RELEASE_TAG} release tag`)
  }
  if (!isManagedHarnessVersionName(version)) {
    throw new Error(`Harness registry ${RELEASE_TAG} tag is not a usable version: ${version}`)
  }

  const versions = packument.versions
  const published = isRecord(versions) ? versions[version] : undefined
  if (!isRecord(published)) throw new Error('Harness registry publishes no release metadata')
  const dist = published.dist
  if (!isRecord(dist)) throw new Error('Harness registry publishes no distribution metadata')
  const integrity = readText(dist, 'integrity')
  const tarball = readText(dist, 'tarball')
  if (integrity === undefined) throw new Error('Harness registry publishes no release integrity')
  return {
    version,
    integrity,
    ...tarball === undefined ? {} : { tarball },
  }
}

/**
 * Create a release source reading the official registry.
 * @param options - Fetch implementation and round-trip bound.
 * @returns A source resolving the official `latest` release.
 */
export function createHarnessReleaseSource(options: HarnessReleaseSourceOptions = {}): HarnessReleaseSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    async latest(signal) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const response = await fetchImpl(`${HARNESS_REGISTRY}${PACKUMENT_PATH}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
        redirect: 'error',
      })
      if (!response.ok) {
        throw new Error(`Harness registry answered ${String(response.status)} for ${HARNESS_PACKAGE}`)
      }
      return readHarnessRelease(await response.json() as unknown)
    },
  }
}
