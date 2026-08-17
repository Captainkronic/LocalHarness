/**
 * The skills catalogue.
 *
 * Skills sit in the sidebar next to the MCP servers on purpose: both are
 * capability the model can reach for, and putting them together makes the cost
 * difference legible. An MCP server's schemas are re-sent on every message —
 * comfy-image alone is 3,007 tokens — while a skill contributes only its name
 * and description, a few dozen tokens for the whole list. The body is fetched
 * only when the model calls `use_skill`.
 *
 * That asymmetry is the reason to prefer a skill when either would do, so the
 * panel states the standing cost plainly rather than hiding it.
 */

import { useMemo, useState, type JSX } from 'react'

import { useStore } from '@renderer/state/store'
import { formatTokens } from '@renderer/lib/format'
import './workflow.css'

export function SkillsPanel(): JSX.Element | null {
  const skills = useStore((s) => s.skills)
  const setSkillEnabled = useStore((s) => s.setSkillEnabled)
  const refreshSkills = useStore((s) => s.refreshSkills)

  const [open, setOpen] = useState<string | null>(null)
  const [body, setBody] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const totals = useMemo(() => {
    const on = skills.filter((s) => s.enabled)
    return {
      on: on.length,
      tokens: on.reduce((n, s) => n + s.catalogTokens, 0)
    }
  }, [skills])

  const expand = async (path: string): Promise<void> => {
    setOpen((prev) => (prev === path ? null : path))
    if (body[path] !== undefined) return
    const text = await window.harness.invoke('skills:read', path).catch(() => null)
    setBody((prev) => ({ ...prev, [path]: text ?? 'Could not read this SKILL.md.' }))
  }

  return (
    <section className="mcp" aria-label="Skills">
      <div className="mcp-head">
        <span className="section-label">Skills</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          title="Re-scan the skill folders"
          onClick={() => {
            setBusy(true)
            void refreshSkills().finally(() => setBusy(false))
          }}
        >
          {busy ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      {skills.length === 0 ? (
        <p className="mcp-empty">
          No skills found. A skill is a folder containing a SKILL.md with
          <code> name</code> and <code> description</code> frontmatter, in
          <code> ~/.claude/skills</code> or any workspace root&apos;s
          <code> .agents/skills</code>.
        </p>
      ) : (
        <ul className="mcp-list scroll-y">
          {skills.map((s) => {
            const isOpen = open === s.path
            return (
              <li key={s.path} className={s.enabled ? 'mcp-item is-on' : 'mcp-item'}>
                <div className="mcp-row">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={s.enabled}
                    aria-label={`${s.name}: ${s.enabled ? 'enabled' : 'disabled'}`}
                    className={s.enabled ? 'sw is-on' : 'sw'}
                    onClick={() => void setSkillEnabled(s.path, !s.enabled)}
                  >
                    <span className="sw-knob" />
                  </button>

                  <button
                    type="button"
                    className="mcp-name"
                    title={`${s.description}\n\n${s.source}\n${s.bodyChars.toLocaleString()} characters, read only when invoked`}
                    onClick={() => void expand(s.path)}
                    aria-expanded={isOpen}
                  >
                    <span className="mcp-label">{s.name}</span>
                  </button>

                  <span className="mcp-meta">
                    <span className="mcp-cost tnum" title="Tokens this adds to every message">
                      {s.catalogTokens}
                    </span>
                  </span>
                </div>

                {isOpen ? (
                  <div className="skill-body">
                    <p className="skill-desc">{s.description}</p>
                    <pre className="skill-md">{body[s.path] ?? 'Reading…'}</pre>
                    <div className="skill-actions">
                      <span className="skill-src" title={s.path}>
                        {s.source}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void window.harness.invoke('skills:reveal', s.path)}
                      >
                        Reveal
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {skills.length > 0 ? (
        <div className="mcp-foot">
          <span className="section-label">Skill payload</span>
          {/* The MCP panel's own footer classes, so the two line up instead of
              inventing a second layout that turned out to be no layout at all. */}
          <span
            className="mcp-foot-nums"
            title="Only each skill's name and description are sent every message. The body is read only when the model invokes it."
          >
            <span className="mcp-foot-tokens tnum">{formatTokens(totals.tokens)} tok</span>
            <span className="mcp-foot-sep">·</span>
            <span className="tnum">
              {totals.on} of {skills.length} on
            </span>
          </span>
        </div>
      ) : null}
    </section>
  )
}

export default SkillsPanel
