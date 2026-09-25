/** Conservative Windows recovery: never terminate a process from a stale PID. */
import { join } from 'node:path'
import { managedProcessEnvironment, runManagedProcess, type ManagedProcessRunner } from './managed-harness-process.ts'

/**
 * Wait for parent-bound processes to exit before modifying managed program files.
 * @param root - Managed directory whose command-line references block recovery.
 * @param run - Bounded process runner.
 * @throws If Windows cannot enumerate processes or a process still uses the directory.
 */
export async function assertWindowsRuntimeIdle(root: string, run: ManagedProcessRunner = runManagedProcess): Promise<void> {
  const script = "$ErrorActionPreference='Stop'; $busy=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($env:DSH_RECOVERY_ROOT,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 }); if($busy.Count -gt 0){exit 2}"
  const deadline = Date.now() + 10_000
  for (;;) {
    const result = await run({
      command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      env: managedProcessEnvironment({ DSH_RECOVERY_ROOT: root }), timeoutMs: 10_000,
    })
    if (result.outputTruncated || (result.exitCode !== 0 && result.exitCode !== 2)) {
      throw new Error('cannot verify Windows managed processes; recovery deferred')
    }
    if (result.exitCode === 0) return
    if (Date.now() >= deadline) throw new Error('a process still uses managed Harness files; recovery deferred')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
