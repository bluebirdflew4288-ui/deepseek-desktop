import { describe, expect, it, vi } from 'vitest'
import { harnessHostEnvironment, prepareHarnessHost } from '../src/harness-host-environment.ts'
import { managedProcessEnvironment, managedSearchPath, parentBoundEnvironment } from '../src/managed-harness-process.ts'
import type { HostSupervisor } from '../src/host-supervisor.ts'

describe('daily Harness environment ownership', () => {
  it('keeps development order, discards unrelated discovery, and restores product ownership last', () => {
    const base = {
      PATH: '/usr/bin:/bin', HOME: '/local-user/test', HTTPS_PROXY: 'https://proxy.invalid', LANG: 'zh_CN.UTF-8',
      NODE_OPTIONS: '--require /bad.cjs', NODE_PATH: '/bad', NODE_REPL_EXTERNAL_MODULE: '/bad',
      NODE_COMPILE_CACHE: '/bad', OPENSSL_CONF: '/bad', LD_PRELOAD: '/bad', BASH_ENV: '/bad',
      DSH_HOME: '/untrusted', DSH_DESKTOP_API_TOKEN: 'wrong', ELECTRON_RUN_AS_NODE: '0',
      NODE_EXTRA_CA_CERTS: '/trusted/ca.pem',
      NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    }
    const discovered = {
      PATH: '/local-user/test/.pyenv/shims:/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin/:.:',
      JAVA_HOME: '/jdk', ANDROID_HOME: '/android', GOPATH: '/go',
      NODE_OPTIONS: '--inspect', NODE_PATH: '/other', DSH_HOME: '/shell', ELECTRON_RUN_AS_NODE: '0',
      HTTPS_PROXY: 'https://shell.invalid', SECRET: 'never-import', LANG: 'wrong',
    }
    const before = { ...process.env }
    const env = harnessHostEnvironment(base, discovered, '/desktop/bin', {
      DSH_HOME: '/owned', DSH_DESKTOP_API_TOKEN: 'owned', ELECTRON_RUN_AS_NODE: '1',
    }, 'darwin')
    expect(env.PATH).toBe('/local-user/test/.pyenv/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/local-user/test/.local/bin:/desktop/bin')
    expect(env.JAVA_HOME).toBe('/jdk')
    expect(env.ANDROID_HOME).toBe('/android')
    expect(env.GOPATH).toBe('/go')
    expect(env.DSH_HOME).toBe('/owned')
    expect(env.DSH_DESKTOP_API_TOKEN).toBe('owned')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.HTTPS_PROXY).toBe(base.HTTPS_PROXY)
    expect(env.LANG).toBe(base.LANG)
    expect(env.NODE_EXTRA_CA_CERTS).toBe(base.NODE_EXTRA_CA_CERTS)
    expect(env.NODE_USE_SYSTEM_CA).toBe('1')
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_COMPILE_CACHE', 'OPENSSL_CONF', 'LD_PRELOAD', 'BASH_ENV', 'SECRET']) expect(env[key]).toBeUndefined()
    expect(parentBoundEnvironment(env).NODE_OPTIONS).toMatch(/^--import=data:text\/javascript,/u)
    expect(process.env).toEqual(before)
    expect(base.NODE_OPTIONS).toBe('--require /bad.cjs')
  })

  it('collapses Windows environment aliases and appends missing OS directories', () => {
    const env = harnessHostEnvironment({ Path: 'C:\\Dev;C:\\Windows\\System32', SystemRoot: 'C:\\Windows', node_options: '--bad', node_tls_reject_unauthorized: '0', electron_run_as_node: '0', dsh_home: 'bad' },
      {}, 'C:\\Desktop\\bin', { DSH_HOME: 'C:\\owned', ELECTRON_RUN_AS_NODE: '1' }, 'win32')
    expect(env.PATH).toBe('C:\\Dev;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Desktop\\bin')
    expect(env.Path).toBeUndefined()
    expect(env.node_options).toBeUndefined()
    expect(env.node_tls_reject_unauthorized).toBeUndefined()
    expect(env.electron_run_as_node).toBeUndefined()
    expect(env.dsh_home).toBeUndefined()
    expect(harnessHostEnvironment({ PATHEXT: '.EXE', Path: 'C:\\Dev' }, {}, 'C:\\Desktop\\bin', {}, 'win32').PATHEXT).toBe('.EXE;.CMD')
    expect(harnessHostEnvironment({ PATH: 'C:\\Dev;c:\\dev\\' }, {}, 'C:\\Desktop\\bin', {}, 'win32').PATH?.match(/Dev/gu)).toHaveLength(1)
  })

  it('allows source development without a packaged fallback directory', () => {
    const env = harnessHostEnvironment({ PATH: '/developer/bin:/usr/bin' }, {}, '', {}, 'darwin')
    expect(env.PATH).toBe('/developer/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('adds the fallback global command directory after user and system paths on each platform', () => {
    expect(harnessHostEnvironment({ HOME: '/user', PATH: '/tools' }, {}, '/fallback', {}, 'linux').PATH)
      .toBe('/tools:/usr/bin:/bin:/usr/sbin:/sbin:/user/.local/bin:/fallback')
    expect(harnessHostEnvironment({ APPDATA: 'C:\\User\\AppData\\Roaming' }, {}, 'C:\\fallback', {}, 'win32').PATH?.split(';').slice(-2))
      .toEqual(['C:\\User\\AppData\\Roaming\\npm', 'C:\\fallback'])
    expect(harnessHostEnvironment({ USERPROFILE: 'C:\\User' }, {}, 'C:\\fallback', {}, 'win32').PATH?.split(';').slice(-2))
      .toEqual(['C:\\User\\.local', 'C:\\fallback'])
    expect(harnessHostEnvironment({ HOME: '/user' }, {}, '', {}, 'linux').PATH).not.toContain('.local')
  })

  it('leaves maintenance independent of discovered PATH and SDK paths', () => {
    harnessHostEnvironment(process.env, { PATH: '/user/tools', JAVA_HOME: '/jdk' }, '/desktop/bin', {})
    const maintenance = managedProcessEnvironment()
    expect(maintenance.PATH).toBe(managedSearchPath())
    expect(maintenance.NODE_OPTIONS).toBeUndefined()
    expect(maintenance.JAVA_HOME).toBeUndefined()
    expect(maintenance.npm_config_registry).toBeUndefined()
    expect(maintenance.HTTPS_PROXY).toBeUndefined()
  })

  it('prevents a late Host spawn after quit during discovery', async () => {
    let ready!: () => void
    const promise = new Promise<void>((resolve) => { ready = resolve })
    const startHost = vi.fn(async () => ({ origin: 'http://127.0.0.1:1' }))
    const supervisor: HostSupervisor = {
      start: startHost,
      shutdown: vi.fn(async () => undefined), onUnexpectedExit: () => () => undefined,
    }
    const host = prepareHarnessHost(supervisor, promise)
    const start = host.start()
    await host.shutdown()
    ready()
    await expect(start).rejects.toThrow('cancelled')
    expect(startHost).not.toHaveBeenCalled()
  })
})
