/** Runnable keyless task composition under the same Electron Node/environment used by a Host. */
import { Context } from '../../../../vendor/cordis/lib/index.js'
import LocalSubprocessRuntime from '../../../../packages/subprocess/subprocess-local/lib/index.js'
import { LocalBashExecutor } from '../../../../packages/shell/bash-local/lib/index.js'
import { createServer } from 'node:http'

const ctx = new Context()
console.log(`host-electron-runtime:${Boolean(process.versions.electron)}`)
console.log(`host-node-mode:${process.env.ELECTRON_RUN_AS_NODE ?? 'unset'}`)
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(LocalBashExecutor, { cwd: process.cwd() })
const server = createServer((_request, response) => { response.end('fixture') })
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
console.log(`dsh web: http://127.0.0.1:${server.address().port}`)
try {
  const result = await ctx.shell.run(ctx.shell.resolve({
    command: 'node -p "Boolean(process.versions.electron)"; node -p "process.env.ELECTRON_RUN_AS_NODE || \'task-unset\'"; npm --version; npx --version; git --version; npm config get registry',
  }))
  console.log(`task-transcript:${JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout.text.trim().split(/\r?\n/u) })}`)
} finally {
  process.on('SIGTERM', async () => { await ctx.fiber.dispose(); server.close() })
}
