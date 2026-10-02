import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/desktop-release.yml'), 'utf8')
const notes = readFileSync(resolve(repositoryRoot, '.github/release-notes/desktop.md'), 'utf8')

describe('desktop release workflow guardrails', () => {
  it('uses one immutable source tag for builds, tooling and release provenance', () => {
    expect(workflow).toContain('git rev-parse "$RELEASE_TAG^{commit}"')
    expect(workflow).toContain('git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main')
    expect(workflow).toContain('git show "$RELEASE_TAG:apps/desktop/package.json"')
    expect(workflow).toContain('"$RELEASE_TAG" != "v$TAG_VERSION"')
    expect(workflow).toContain('ref: ${{ needs.verify-release-tag.outputs.release_tag }}')
    expect(workflow).not.toContain('Overlay recovery')
    expect(workflow).toContain('RELEASE_TOOLING_COMMIT: ${{ needs.verify-release-tag.outputs.release_commit }}')
    expect(notes).toContain('Application source commit: `{{APPLICATION_SOURCE_COMMIT}}`')
    expect(notes).toContain('Release tooling commit: `{{RELEASE_TOOLING_COMMIT}}`')
  })

  it('verifies both installed and packaged runtime pins before uploading artifacts', () => {
    const installed = workflow.indexOf('Verify installed Electron matches')
    const build = workflow.indexOf('- name: Build macOS distributables')
    const packaged = workflow.indexOf('Verify packaged Electron matches')
    const upload = workflow.indexOf('uses: actions/upload-artifact@v4')
    expect(installed).toBeGreaterThanOrEqual(0)
    expect(build).toBeGreaterThan(installed)
    expect(packaged).toBeGreaterThan(build)
    expect(upload).toBeGreaterThan(packaged)
    expect(workflow).toContain('scripts/verify-electron-runtime.ts "dist/mac-arm64/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop"')
  })

  it('publishes only the validated Mac platform and verifies the DMG contents', () => {
    expect(workflow).toContain('needs: [verify-release-tag, build]')
    expect(workflow).toContain('--platforms mac-arm64')
    expect(workflow).toContain('--mac dmg zip --arm64')
    expect(workflow).toContain('scripts/verify-mac-dmg.ts dist/DeepSeek-Desktop-*-mac-arm64.dmg')
    expect(workflow).not.toContain('desktop-windows-x64')
    expect(workflow).not.toContain('windows-release-build.ts')
    expect(workflow).not.toContain('--clobber')
    expect(notes).toContain('{{ELECTRON_VERSION}}')
    expect(notes).toContain('{{WINDOWS_SIGNING_DETAILS}}')
    expect(notes).toContain('Gatekeeper')
  })

  it('installs release-script dependencies without widening mutation token scope', () => {
    const releaseJob = workflow.slice(workflow.indexOf('\n  release:'))
    expect(releaseJob.indexOf('pnpm install --frozen-lockfile')).toBeLessThan(releaseJob.indexOf('scripts/release-assets.ts sync'))
    expect(releaseJob.match(/GH_TOKEN:/gu)).toHaveLength(1)
    expect(releaseJob.slice(0, releaseJob.lastIndexOf('- name: Create draft'))).not.toContain('GH_TOKEN:')
    expect(workflow).toContain('contents: read')
  })
})
