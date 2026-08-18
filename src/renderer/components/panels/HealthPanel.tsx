import { useMemo, useState, type JSX } from 'react'

import { useStore } from '@renderer/state/store'
import './panels.css'

/**
 * The case file, and what was actually looked up.
 *
 * Two jobs, and the second is the one that matters. A spoken health
 * conversation is the easiest place in this whole app for a wrong sentence to
 * pass unnoticed — it arrives in a calm voice, in the middle of a friendly
 * exchange, and nothing about hearing it says which parts were fetched from the
 * FDA and which the model supplied itself. So every source the server consulted
 * is listed here with a link. That list is the only way anyone can check.
 *
 * Drawn from the tool's `structured` result, never from its text. The text is
 * written to be spoken and reworded; this is not.
 */

interface Entry {
  text: string
  at: string
}

interface RedFlag {
  flag: string
  action: string
  about?: string
  at?: string
}

interface Source {
  kind: string
  title: string
  url: string
  at: string
}

interface LastLookup {
  kind: string
  query?: string
  name?: string
  found?: boolean
  url?: string
  boxed?: boolean
  sections?: { heading: string; text: string }[]
  topics?: { title: string; url: string; summary: string; also: string[] }[]
  papers?: {
    pmid: string
    title: string
    journal: string
    year: string
    strength: string
    url: string
    abstract: string
  }[]
  drugs?: string[]
  checked?: string[]
  missing?: string[]
  silent?: string[]
  hits?: { drug: string; mentions: string; text: string; url: string }[]
  topic?: string
}

interface Case {
  profile: Entry[]
  symptoms: Entry[]
  medications: Entry[]
  conditions: Entry[]
  allergies: Entry[]
  questions: Entry[]
  redFlags: RedFlag[]
  sources: Source[]
  startedAt: string | null
  last: LastLookup | null
}

function asCase(value: unknown): Case | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.symptoms) || !Array.isArray(v.sources)) return null
  if (!Array.isArray(v.redFlags)) return null
  return v as unknown as Case
}

const LISTS: { key: keyof Case; title: string }[] = [
  { key: 'profile', title: 'About you' },
  { key: 'symptoms', title: 'Reported' },
  { key: 'conditions', title: 'Conditions' },
  { key: 'medications', title: 'Medications' },
  { key: 'allergies', title: 'Allergies' },
  { key: 'questions', title: 'Questions' }
]

export function HealthPanel(): JSX.Element {
  const conversation = useStore((s) => s.conversation)
  const [openSection, setOpenSection] = useState<string | null>(null)

  const file = useMemo(() => {
    const messages = conversation?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const call of messages[i].toolCalls ?? []) {
        if (call.status !== 'ok') continue
        const parsed = asCase(call.structured)
        if (parsed) return parsed
      }
    }
    return null
  }, [conversation])

  if (file === null) {
    return (
      <p className="pnl-empty">
        Nothing yet. Describe what is going on — what you say is kept here as a case
        file, and everything looked up is listed with a link so you can check it.
      </p>
    )
  }

  const populated = LISTS.filter((l) => (file[l.key] as Entry[]).length > 0)

  return (
    <div className="hl">
      {/* Never collapsed, never below the fold, never styled like a chip. If
          the screen says one thing louder than everything else, it is this. */}
      {file.redFlags.length > 0 ? (
        <section className="hl-flags" role="alert">
          {file.redFlags.map((f) => (
            <div key={f.flag} className="hl-flag">
              <strong>{f.flag}</strong>
              <span>{f.action}</span>
              {f.about ? <em>you said: “{f.about}”</em> : null}
            </div>
          ))}
        </section>
      ) : null}

      {populated.length === 0 ? (
        <p className="pnl-empty">The case file is empty so far.</p>
      ) : (
        populated.map((list) => (
          <section key={String(list.key)} className="hl-group">
            <h4 className="hl-h">{list.title}</h4>
            <ul className="hl-items">
              {(file[list.key] as Entry[]).map((e) => (
                <li key={e.text}>{e.text}</li>
              ))}
            </ul>
          </section>
        ))
      )}

      {file.last ? <Lookup last={file.last} open={openSection} onOpen={setOpenSection} /> : null}

      {file.sources.length > 0 ? (
        <section className="hl-group">
          <h4 className="hl-h">Consulted</h4>
          <ul className="hl-sources">
            {[...file.sources].reverse().map((s) => (
              <li key={s.url + s.at}>
                <span className="hl-kind">{s.kind}</span>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

/** The most recent lookup, rendered as what it is rather than as a blob. */
function Lookup({
  last,
  open,
  onOpen
}: {
  last: LastLookup
  open: string | null
  onOpen: (v: string | null) => void
}): JSX.Element | null {
  if (last.kind === 'drug' && last.found) {
    return (
      <section className="hl-group">
        <h4 className="hl-h">{last.name}</h4>
        {/* A boxed warning is the strongest thing the FDA can put on a label.
            It gets to look like one. */}
        {last.boxed ? <p className="hl-boxed">Carries a boxed warning</p> : null}
        <div className="hl-sections">
          {(last.sections ?? []).map((s) => (
            <div key={s.heading}>
              <button
                className="hl-sec-head"
                onClick={() => onOpen(open === s.heading ? null : s.heading)}
                aria-expanded={open === s.heading}
              >
                <span>{s.heading}</span>
                <span aria-hidden="true">{open === s.heading ? '−' : '+'}</span>
              </button>
              {open === s.heading ? <p className="hl-sec-body">{s.text}</p> : null}
            </div>
          ))}
        </div>
        {last.url ? (
          <a className="hl-link" href={last.url} target="_blank" rel="noreferrer">
            Full label on DailyMed
          </a>
        ) : null}
      </section>
    )
  }

  if (last.kind === 'interactions') {
    return (
      <section className="hl-group">
        <h4 className="hl-h">Interactions</h4>
        <p className="hl-note">
          Checked: {(last.checked ?? []).join(', ') || 'none'}
          {last.missing && last.missing.length > 0 ? ` · no US label for ${last.missing.join(', ')}` : ''}
        </p>
        {/* A one-sided check looks identical to a clean one unless it says so. */}
        {last.silent && last.silent.length > 0 ? (
          <p className="hl-note is-caveat">
            {last.silent.join(', ')} has no interactions section on its label, so this
            was only checked one way round.
          </p>
        ) : null}
        {(last.hits ?? []).length === 0 ? (
          <p className="hl-note">
            Neither label names the other — which is not the same as safe together. A
            pharmacist can check it properly in a minute.
          </p>
        ) : (
          <ul className="hl-hits">
            {(last.hits ?? []).map((h, i) => (
              <li key={i}>
                <span className="hl-hit-head">
                  {h.drug} on {h.mentions}
                </span>
                <span className="hl-hit-body">{h.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  if (last.kind === 'research' && (last.papers ?? []).length > 0) {
    return (
      <section className="hl-group">
        <h4 className="hl-h">Evidence on “{last.query}”</h4>
        <ul className="hl-papers">
          {(last.papers ?? []).map((p) => (
            <li key={p.pmid}>
              {/* What KIND of evidence, before the title. One small study and a
                  meta-analysis are not the same claim, and that difference is
                  invisible to anyone who is not used to reading these. */}
              <span className={`hl-strength${/meta|random/i.test(p.strength) ? ' is-strong' : ''}`}>
                {p.strength}
              </span>
              <a href={p.url} target="_blank" rel="noreferrer">
                {p.title}
              </a>
              <span className="hl-cite">
                {p.journal} {p.year}
              </span>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  if (last.kind === 'topic' && (last.topics ?? []).length > 0) {
    return (
      <section className="hl-group">
        <h4 className="hl-h">{last.topics?.[0].title}</h4>
        <p className="hl-summary">{last.topics?.[0].summary}</p>
        <a className="hl-link" href={last.topics?.[0].url} target="_blank" rel="noreferrer">
          Read it on MedlinePlus
        </a>
      </section>
    )
  }

  return null
}

export default HealthPanel
