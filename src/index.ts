/**
 * dsh-enforce-package-manager: keeps the agent on the project's package manager.
 *
 * Runs on `tools/pre-execute` for shell tools. It detects the JavaScript
 * manager (packageManager field, lockfile, pnpm-workspace.yaml) and Python
 * manager (uv/poetry/pdm/pipenv lockfiles or pyproject sections) for the
 * directory a command runs in, and blocks dependency-changing commands made
 * with a different manager, e.g. `npm install zod` in a pnpm repo or
 * `pip install requests` in a uv project. The denial contains the exact
 * translated command, so the model can rerun it immediately.
 *
 * @module dsh-enforce-package-manager
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { checkArgv, detectJs, detectPy, searchRoot, simpleCommands, type Mismatch, type ProjectManagers } from './detect.ts'
import { resolveConfig } from './shared/live.ts'

export { checkArgv, detectJs, detectPy, searchRoot, simpleCommands } from './detect.ts'
export type { Mismatch, ProjectManagers, JsManager, PyManager } from './detect.ts'

export const name = 'enforce-package-manager'

/** Plugin configuration. */
export interface Config {
  mode: 'deny' | 'ask'
  /** Check JavaScript managers (npm, pnpm, yarn, bun). */
  javascript: boolean
  /** Check Python managers (pip vs uv, poetry, pdm, pipenv). */
  python: boolean
  shellTools: string[]
}

// Every field is `.volatile()` so the settings page on DSH's Plugins page can
// change it live; `apply` reads the current values on each call.
export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['deny', 'ask']).default('deny').volatile(),
  javascript: Schema.boolean().default(true).volatile(),
  python: Schema.boolean().default(true).volatile(),
  shellTools: Schema.array(Schema.string()).default(['bash', 'pwsh']).volatile(),
}) as unknown as Schema<Config>

const WHY: Record<Mismatch['ecosystem'], string> = {
  js: 'Mixing package managers creates a second lockfile, ignores the existing one, and can install different versions.',
  py: 'Plain pip installs into the environment without recording the dependency in pyproject.toml or the lockfile, so the next sync removes it.',
}

/**
 * Render the model-facing reason.
 * @param m - the mismatch.
 * @param evidence - why the project manager was chosen.
 * @returns the denial text.
 */
export function denialText(m: Mismatch, evidence: string): string {
  return `dsh-enforce-package-manager blocked \`${m.command}\`: this project uses ${m.expected}, not ${m.used} (${evidence}). ${WHY[m.ecosystem]} `
    + `Run this instead:\n  ${m.suggestion}`
}

export function apply(ctx: Context, config: Config): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const cfg = resolveConfig(config)
    if (!cfg.shellTools.includes(exec.name)) return next()
    const args = exec.arguments as { command?: unknown; workdir?: unknown } | null
    if (typeof args?.command !== 'string') return next()
    const workspace = exec.agent?.session.header.cwd ?? process.cwd()
    const base = typeof args.workdir === 'string' ? (isAbsolute(args.workdir) ? args.workdir : resolve(workspace, args.workdir)) : workspace
    for (const simple of simpleCommands(args.command)) {
      const dir = simple.cd.reduce((d, c) => resolve(d, c.replaceAll('\\', '/')), base)
      const root = searchRoot(dir, workspace)
      const managers: ProjectManagers = {
        ...(cfg.javascript ? { js: detectJs(dir, root) } : {}),
        ...(cfg.python ? { py: detectPy(dir, root) } : {}),
      }
      const mismatch = checkArgv(simple.argv, managers, simple.text)
      if (mismatch === undefined) continue
      const evidence = (mismatch.ecosystem === 'js' ? managers.js : managers.py)!.evidence.replace(`${workspace}/`, '').replace(workspace, '.')
      const text = denialText(mismatch, evidence)
      if (cfg.mode === 'ask') {
        return { kind: 'ask', reason: text, displayReason: { en: `This project uses ${mismatch.expected}; suggested: ${mismatch.suggestion}` } }
      }
      return { kind: 'deny', reason: text }
    }
    return next()
  })
}
