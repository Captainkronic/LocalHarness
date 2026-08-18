import { useMemo, useState, type JSX } from 'react'

import { useStore } from '@renderer/state/store'
import './panels.css'

/**
 * The trip, drawn rather than read out.
 *
 * The Flight Booker workflow is a division of labour: the voice gives the
 * headline and the screen carries everything a headline cannot. Reading ten
 * fares aloud is unbearable, and a table nobody can see is not an answer.
 *
 * Everything here comes from the tool's `structured` result, never from its
 * text. The text is a sentence written for the model to SAY, and coupling a
 * panel to it means any rewording silently breaks the display. The server sends
 * the whole trip state back with every tool call for the same reason — so the
 * screen can never be showing an older world than the voice is describing.
 */

interface Segment {
  from: string
  fromTerminal: string | null
  to: string
  toTerminal: string | null
  depart: string
  arrive: string
  duration: string
  airline: string
  flight: string
  operatedBy: string | null
  aircraft: string | null
  cabin: string | null
  wifi: boolean
  power: boolean
}

interface Layover {
  at: string
  duration: string
  tight: boolean
  long: boolean
  changeAirport: boolean
}

interface Leg {
  from: string
  to: string
  depart: string
  arrive: string
  date: string | null
  dayOffset: number
  duration: string
  stops: number
  via: string[]
  airlines: string[]
  redEye: boolean
  segments: Segment[]
  layovers: Layover[]
}

interface Fare {
  price: number
  currency: string
  brand: string
  shelf: number | null
  carryOn: number
  checked: number
  refundable: boolean
  changeable: boolean
  emissionsKg: number | null
  airline: string
}

interface Itinerary {
  n: number
  key: string
  legs: Leg[]
  fares: Fare[]
  from: number
  currency: string
  stops: number
  airlines: string[]
  alsoOn?: string[]
  badges: string[]
  shortlisted: boolean
}

interface Trip {
  brief: {
    origin?: string
    destination?: string
    date?: string
    returnDate?: string | null
    adults?: number
    cabin?: string
  }
  filterLabels: string[]
  dropped: Record<string, number>
  counts: { fares?: number; itineraries?: number; matched?: number; more?: number }
  notes: string[]
  history: { origin: string; destination: string; date: string; matched: number; cheapest: number | null; currency: string }[]
  environment: string
  itineraries: Itinerary[]
}

/** Narrow the tool's payload, or nothing. A malformed result must render as the
 *  empty state, never as a crashed panel. */
function asTrip(value: unknown): Trip | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.itineraries)) return null
  if (typeof v.brief !== 'object' || v.brief === null) return null
  return v as unknown as Trip
}

/** Badges the card draws as its own furniture rather than as a chip. */
const STRUCTURAL = new Set(['direct'])

/**
 * 2026-10-15 -> Thu 15 Oct.
 *
 * The voice already says it this way, and the two have to agree — hearing
 * "Thursday the fifteenth" while reading 2026-10-15 makes you check whether
 * they are the same date. Falls back to the raw string rather than throwing:
 * an unparseable date is still information.
 */
function niceDate(value: string | null | undefined): string {
  if (!value) return ''
  const d = new Date(`${value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

export function FlightsPanel(): JSX.Element {
  const conversation = useStore((s) => s.conversation)
  const [openKey, setOpenKey] = useState<string | null>(null)

  /* The most recent state from ANY flights tool wins — shortlisting or
     remembering something changes the trip just as much as a search does, and
     the panel would otherwise keep drawing the state as it was two turns ago. */
  const trip = useMemo(() => {
    const messages = conversation?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const call of messages[i].toolCalls ?? []) {
        if (call.status !== 'ok') continue
        const parsed = asTrip(call.structured)
        if (parsed) return parsed
      }
    }
    return null
  }, [conversation])

  if (trip === null) {
    return (
      <p className="pnl-empty">
        No searches yet. Say where you want to go and roughly when — the options land
        here with times, fares and what each one includes while he talks you through
        them.
      </p>
    )
  }

  const { brief, counts } = trip
  const shortlisted = trip.itineraries.filter((i) => i.shortlisted)
  const rest = trip.itineraries.filter((i) => !i.shortlisted)

  return (
    <div className="fl">
      <header className="fl-head">
        <div className="fl-route">
          <span className="fl-code">{brief.origin ?? '—'}</span>
          <span className="fl-arrow" aria-hidden="true">
            →
          </span>
          <span className="fl-code">{brief.destination ?? '—'}</span>
        </div>
        <div className="fl-when">
          {niceDate(brief.date)}
          {brief.returnDate ? ` – ${niceDate(brief.returnDate)}` : ''}
          {brief.adults && brief.adults > 1 ? ` · ${brief.adults} travellers` : ''}
        </div>
        {/* The honest denominator. "8 options" reads as "that is what there is";
            "8 of 33 flights, from 92 fares" says a choice was made on your
            behalf, which is the thing you would want to know. */}
        {counts.itineraries ? (
          <p className="fl-counts tnum">
            showing {trip.itineraries.length} of {counts.matched} flights · {counts.fares} fares
            searched
          </p>
        ) : null}
      </header>

      {/* Said once, at the top, rather than on every card. A price with no
          provenance is worse than no price, but a caveat repeated ten times
          stops being read. */}
      {trip.environment !== 'production' ? (
        <p className="fl-caveat">Test data — indicative prices, not bookable.</p>
      ) : null}

      {trip.filterLabels.length > 0 || Object.keys(trip.dropped).length > 0 ? (
        <section className="fl-filters">
          {trip.filterLabels.map((label) => (
            <span key={label} className="fl-chip">
              {label}
            </span>
          ))}
          {Object.entries(trip.dropped).map(([reason, n]) => (
            <span key={reason} className="fl-chip is-dropped">
              −{n} {reason}
            </span>
          ))}
        </section>
      ) : null}

      {trip.notes.length > 0 ? (
        <section className="fl-notes">
          <h4 className="fl-h">Remembered</h4>
          <ul>
            {trip.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {shortlisted.length > 0 ? (
        <section className="fl-group">
          <h4 className="fl-h">Shortlist</h4>
          {shortlisted.map((it) => (
            <Card
              key={it.key}
              it={it}
              open={openKey === it.key}
              onToggle={() => setOpenKey(openKey === it.key ? null : it.key)}
            />
          ))}
        </section>
      ) : null}

      <section className="fl-group">
        {shortlisted.length > 0 ? <h4 className="fl-h">Everything else</h4> : null}
        {rest.map((it) => (
          <Card
            key={it.key}
            it={it}
            open={openKey === it.key}
            onToggle={() => setOpenKey(openKey === it.key ? null : it.key)}
          />
        ))}
      </section>

      {counts.more ? (
        <p className="fl-more">{counts.more} more flights matched and are not shown.</p>
      ) : null}

      {trip.history.length > 1 ? (
        <section className="fl-history">
          <h4 className="fl-h">Searched so far</h4>
          <ul>
            {trip.history.map((h, i) => (
              <li key={i}>
                <span className="tnum">
                  {h.origin}–{h.destination}
                </span>
                <span className="fl-hist-date">{niceDate(h.date)}</span>
                <span className="fl-hist-price tnum">
                  {h.cheapest === null ? 'nothing' : `from ${Math.round(h.cheapest)} ${h.currency}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function Card({
  it,
  open,
  onToggle
}: {
  it: Itinerary
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const chips = it.badges.filter((b) => !STRUCTURAL.has(b))
  return (
    <article className={`fl-card${it.shortlisted ? ' is-saved' : ''}`}>
      <button className="fl-card-head" onClick={onToggle} aria-expanded={open}>
        <span className="fl-n tnum">{it.n}</span>
        <span className="fl-price tnum">
          {Math.round(it.from)}
          <span className="fl-currency"> {it.currency}</span>
        </span>
        <span className="fl-chevron" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>

      {it.legs.map((leg, i) => (
        <Timeline key={i} leg={leg} />
      ))}

      <div className="fl-airline">
        {it.airlines.join(' / ')}
        {it.alsoOn && it.alsoOn.length > 0 ? (
          <span className="fl-also"> · also on {it.alsoOn.slice(0, 3).join(', ')}</span>
        ) : null}
      </div>

      {chips.length > 0 ? (
        <div className="fl-badges">
          {chips.map((b) => (
            <span
              key={b}
              className={`fl-badge${
                b === 'cheapest' || b === 'fastest' || b === 'best value' ? ' is-good' : ''
              }${b.startsWith('tight') || b.startsWith('airport change') ? ' is-warn' : ''}`}
            >
              {b}
            </span>
          ))}
        </div>
      ) : null}

      {/* The fare ladder, which is the whole reason this panel exists: the
          headline price is almost never the price of the trip you pictured. */}
      <ul className="fl-fares">
        {(open ? it.fares : it.fares.slice(0, 2)).map((f, i) => (
          <li key={i} className="fl-fare">
            <span className="fl-fare-price tnum">{Math.round(f.price)}</span>
            <span className="fl-fare-brand">{f.brand || 'Standard'}</span>
            <span className="fl-fare-inc">
              {f.checked > 0 ? `${f.checked} bag` : f.carryOn > 0 ? 'cabin only' : ''}
              {f.refundable ? ' · refundable' : f.changeable ? ' · changeable' : ''}
            </span>
          </li>
        ))}
        {!open && it.fares.length > 2 ? (
          <li className="fl-fare is-more">+{it.fares.length - 2} more fares</li>
        ) : null}
      </ul>

      {open ? <Detail it={it} /> : null}
    </article>
  )
}

/** Departure and arrival with the journey between them, drawn to scale in
 *  nothing but proportion — a stop is a dot, not a number to read. */
function Timeline({ leg }: { leg: Leg }): JSX.Element {
  return (
    <div className="fl-leg">
      <div className="fl-time-row">
        <span className="fl-time tnum">{leg.depart}</span>
        <span className="fl-track" aria-hidden="true">
          <span className="fl-track-line" />
          {leg.via.map((code) => (
            <span key={code} className="fl-stop" />
          ))}
        </span>
        <span className="fl-time tnum">
          {leg.arrive}
          {/* An overnight arrival is the most missed detail on a fare list and
              the one most likely to ruin a plan. */}
          {leg.dayOffset > 0 ? <sup className="fl-next-day">+{leg.dayOffset}</sup> : null}
        </span>
      </div>
      <div className="fl-leg-meta">
        <span>
          {leg.from}–{leg.to}
        </span>
        <span className="tnum">{leg.duration}</span>
        <span>
          {leg.stops === 0
            ? 'direct'
            : `${leg.stops} stop${leg.stops === 1 ? '' : 's'} via ${leg.via.join(', ')}`}
        </span>
      </div>
    </div>
  )
}

function Detail({ it }: { it: Itinerary }): JSX.Element {
  const emissions = it.fares.find((f) => f.emissionsKg)?.emissionsKg ?? null
  return (
    <div className="fl-detail">
      {it.legs.map((leg, li) => (
        <ol key={li} className="fl-segs">
          {leg.segments.map((seg, si) => (
            <li key={si}>
              <div className="fl-seg">
                <span className="fl-flight tnum">{seg.flight}</span>
                <span className="fl-seg-times tnum">
                  {seg.depart}–{seg.arrive}
                </span>
                <span className="fl-seg-route">
                  {seg.from}
                  {seg.fromTerminal ? ` T${seg.fromTerminal}` : ''} → {seg.to}
                  {seg.toTerminal ? ` T${seg.toTerminal}` : ''}
                </span>
              </div>
              <div className="fl-seg-sub">
                {seg.airline}
                {seg.aircraft ? ` · ${seg.aircraft}` : ''}
                {seg.operatedBy ? ` · operated by ${seg.operatedBy}` : ''}
                {seg.wifi ? ' · wifi' : ''}
                {seg.power ? ' · power' : ''}
              </div>
              {leg.layovers[si] ? (
                <div
                  className={`fl-layover${
                    leg.layovers[si].changeAirport || leg.layovers[si].tight ? ' is-warn' : ''
                  }`}
                >
                  {leg.layovers[si].duration} in {leg.layovers[si].at}
                  {leg.layovers[si].changeAirport
                    ? ' — changes airport'
                    : leg.layovers[si].tight
                      ? ' — tight connection'
                      : ''}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ))}
      {emissions ? <p className="fl-carbon">About {emissions} kg CO₂ per passenger.</p> : null}
    </div>
  )
}

export default FlightsPanel
