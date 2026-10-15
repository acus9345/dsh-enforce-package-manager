import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginEntry, runDsh } from './helpers/dsh.ts'

const plugin = { id: 'enforce-package-manager', entry: pluginEntry }

test('npm install in a pnpm repo is blocked with the pnpm command', async () => {
  const run = await runDsh({
    plugins: [plugin],
    files: { 'package.json': '{"name":"x","packageManager":"pnpm@9.12.0"}', 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', '.git/HEAD': 'ref: refs/heads/main\n' },
    script: [
      { tool: 'bash', input: { description: 'Add zod', command: 'npm install zod --save-dev' } },
      { tool: 'bash', input: { description: 'Python dep', command: 'pip install requests' } },
    ],
  })
  assert.equal(run.exitCode, 0, run.stderr)
  assert.match(run.toolResults[0]!.result, /enforce-package-manager blocked `npm install zod --save-dev`: this project uses pnpm/)
  assert.match(run.toolResults[0]!.result, /pnpm add -D zod/)
  // No Python manager detected: pip is left alone (it may fail, but not because of the guard).
  assert.doesNotMatch(run.toolResults[1]!.result, /enforce-package-manager/)
})

test('pip install in a uv project suggests uv add', async () => {
  const run = await runDsh({
    plugins: [plugin],
    files: { 'pyproject.toml': '[project]\nname = "x"\n', 'uv.lock': 'version = 1\n', '.git/HEAD': 'x' },
    script: [{ tool: 'bash', input: { description: 'Add dep', command: 'cd . && python3 -m pip install httpx' } }],
  })
  assert.match(run.toolResults[0]!.result, /uv add httpx/)
})

test('works when installed with `dsh plugin add`', async () => {
  const run = await runDsh({
    installed: true,
    files: { 'package.json': '{"name":"x"}', 'yarn.lock': '# yarn lockfile v1\n', '.git/HEAD': 'x' },
    script: [{ tool: 'bash', input: { description: 'Add dep', command: 'npm i lodash' } }],
  })
  assert.equal(run.exitCode, 0, run.stderr)
  assert.match(run.toolResults[0]!.result, /yarn add lodash/)
})

test('guards the pwsh tool too (the shell DSH uses on Windows)', async () => {
  const run = await runDsh({
    plugins: [plugin],
    homePatch: '- id: tool-pwsh\n  disabled: false\n- id: tool-bash\n  disabled: true\n',
    files: { 'package.json': '{"name":"x","packageManager":"pnpm@9.12.0"}', '.git/HEAD': 'x' },
    script: [{ tool: 'pwsh', input: { description: 'Add dep', command: 'npm.cmd install zod' } }],
  })
  assert.equal(run.exitCode, 0, run.stderr)
  assert.match(run.toolResults[0]!.result, /pnpm add zod/)
})
