import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/desktop-release.yml'), 'utf8')
const notes = readFileSync(resolve(repositoryRoot, '.github/release-notes/desktop.md'), 'utf8')

describe('desktop release workflow guardrails', () => {
  it('checks the exact tag and main ancestry before native builds', () => {
    expect(workflow).toContain('verify-release-tag:')
    expect(workflow).toContain('git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main')
    expect(workflow).toContain("process.env.RELEASE_TAG !== 'v'+version")
    expect(workflow).toContain('needs: verify-release-tag')
  })

  it('maps Windows certificate secrets to only the signing build step', () => {
    const signingStart = workflow.indexOf('- name: Build and verify Windows x64 distributables (signed or unsigned)')
    const signingEnd = workflow.indexOf('- name: Write Windows x64 artifact manifest', signingStart)
    expect(signingStart).toBeGreaterThanOrEqual(0)
    expect(signingEnd).toBeGreaterThan(signingStart)
    const signingStep = workflow.slice(signingStart, signingEnd)
    expect(signingStep).toContain('secrets.WINDOWS_CERTIFICATE_PFX_BASE64')
    expect(signingStep).toContain('secrets.WINDOWS_CERTIFICATE_PASSWORD')
    expect(workflow.match(/secrets\.WINDOWS_CERTIFICATE_PFX_BASE64/gu)).toHaveLength(1)
    expect(workflow.match(/secrets\.WINDOWS_CERTIFICATE_PASSWORD/gu)).toHaveLength(1)
    expect(signingStep).toContain('scripts/windows-release-build.ts')
    expect(workflow).toContain('apps/desktop/windows-signing-manifest.json')
  })

  it('keeps release notes status-driven instead of hard-coding a Windows signature claim', () => {
    expect(notes).toContain('{{WINDOWS_SIGNING_DETAILS}}')
    expect(notes).toContain('{{WINDOWS_SIGNING_DETAILS_ZH}}')
    expect(notes).not.toContain('Windows x64: Authenticode-signed')
  })

  it('publishes only after verified Windows and explicit four-asset manifest verification', () => {
    expect(workflow).toContain('needs: [verify-release-tag, build]')
    expect(workflow).toContain('desktop-macos-arm64')
    expect(workflow).toContain('desktop-windows-x64')
    expect(workflow).toContain('scripts/release-assets.ts sync')
    expect(workflow).not.toContain('--clobber')
  })

  it('installs tsx dependencies before the release synchronizer without widening token scope', () => {
    const releaseJob = workflow.slice(workflow.indexOf('\n  release:'))
    const dependencySetup = releaseJob.indexOf('uses: pnpm/action-setup@v4')
    const frozenInstall = releaseJob.indexOf('pnpm install --frozen-lockfile')
    const synchronize = releaseJob.indexOf('scripts/release-assets.ts sync')
    expect(dependencySetup).toBeGreaterThanOrEqual(0)
    expect(frozenInstall).toBeGreaterThan(dependencySetup)
    expect(synchronize).toBeGreaterThan(frozenInstall)
    expect(releaseJob.match(/GH_TOKEN:/gu)).toHaveLength(1)
    const tokenStep = releaseJob.slice(releaseJob.lastIndexOf('- name: Create draft'))
    expect(tokenStep).toContain('GH_TOKEN: ${{ github.token }}')
    expect(releaseJob.slice(0, releaseJob.lastIndexOf('- name: Create draft'))).not.toContain('GH_TOKEN:')
  })
})
