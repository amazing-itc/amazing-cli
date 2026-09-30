import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RunMode } from '../../../core/types.js'

const HARNESS_DIRS = [
  '.cursor/rules',
  '.cursor/agents',
  '.cursor/skills',
  '.claude/rules',
  '.claude/agents',
  '.claude/skills',
  '.codex/agents',
  '.agents/skills',
  '.github/agents',
  '.github/skills',
  '.github/instructions',
]

export function defaultSystemPromptCore(): string {
  return [
    'You are the external-LLM harness (not Cursor, Claude, Codex, or Copilot).',
    'Work only inside the workspace. Prefer tools over guessing.',
    'Use fs to read/write/list/search files. Use shell for commands.',
    'Use session_query to recall earlier harness events after compaction.',
    'Use spill for large artifacts.',
    'Use subagent to isolate parallel research or implementation (max depth 3).',
    'When the task is done, stop calling tools and answer with a concise result.',
  ].join(' ')
}

export function buildSystemPrompt(workspacePath: string, mode?: RunMode): string {
  let core = defaultSystemPromptCore()
  if (mode === 'plan') {
    core = `${core} Return a plan only; do not apply edits.`
  }
  const catalog = workspacePath ? loadHarnessCatalog(workspacePath) : ''
  return catalog ? `${core}\n\nWorkspace harness:\n${catalog}` : core
}

export function loadHarnessCatalog(workspacePath: string, maxFiles = 24): string {
  const lines: string[] = []
  for (const rel of HARNESS_DIRS) {
    const dir = join(workspacePath, rel)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    collect(dir, rel, lines, maxFiles)
    if (lines.length >= maxFiles) break
  }
  return lines.join('\n')
}

function collect(dir: string, prefix: string, sink: string[], maxFiles: number): void {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (sink.length >= maxFiles) return
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (name === 'node_modules') continue
      const skill = join(full, 'SKILL.md')
      if (existsSync(skill)) {
        sink.push(summarize(skill, `${prefix}/${name}/SKILL.md`))
      } else {
        collect(full, `${prefix}/${name}`, sink, maxFiles)
      }
      continue
    }
    if (!/\.(md|mdc|toml)$/i.test(name)) continue
    sink.push(summarize(full, `${prefix}/${name}`))
  }
}

function summarize(file: string, label: string): string {
  try {
    const body = readFileSync(file, 'utf8').split('\n').slice(0, 12).join(' ').replace(/\s+/g, ' ').trim()
    return `- ${label}: ${body.slice(0, 220)}`
  } catch {
    return `- ${label}`
  }
}
