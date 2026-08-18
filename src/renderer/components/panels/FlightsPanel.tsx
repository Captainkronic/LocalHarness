import { useMemo, type JSX } from 'react'

import { useStore } from '@renderer/state/store'
import './panels.css'

/**
 * Flight options, drawn rather than read out.
 *
 * The point of the Flight Booker workflow is that the voice gives the headline
 * and the screen carries the list — reading ten fares aloud is unbearable, and
 * a table nobody can see is not an answer.
 *
 * This draws from the tool call's `structured` result, never from its text. The
 * text is a sentence written for the model to say; coupling a panel to it would
 * mean any rewording silently breaks the display.
 */

interface Leg {
  from: string
  to: string
  depart: string
  arrive: string
  dayOffset: number
  duration: string
  stops: number
  via: string[]
  airlines: string[]
}

interface Offer {
  price: number
  currency: string
  seats: number | null
  legs: Leg[]
}

interface Search {
  origin: string
  destination: string
  date: string
  returnDate: string | null
  currency: string
  environment: string
  offers: Offer[]
}

/** Narrow the tool's structured payload, or nothing. A malformed result must
 *  render as "no flights yet", never as a crashed panel. */
function asSearch(value: unknown): Search | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.offers)) return null
  if (typeof v.origin !== 'string' || typeof v.destination !== 'string') return null
  return v as unknown as Search
}

export function FlightsPanel(): JSX.Element {
  const conversation = useStore((s) => s.conversation)

  /* The most recent search wins. Someone comparing dates runs several in a
     turn, and the one they just asked about is the one they are looking at. */
  const search = useMemo(() => {
    const messages = conversation?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const call of messages[i].toolCalls ?? []) {
        if (!call.name.endsWith('search_flights')) continue
        if (call.status !== 'ok') continue
        const parsed = asSearch(call.structured)
        if (parsed) return parsed
      }
    }
    return null
  }, [conversation])

  if (search === null) {
    return (
      <p className="pnl-empty">
        No searches yet. Say where you want to go and roughly when — the options land
        here with times and prices while he talks you through them.
      </p>
    )
  }

  if (search.offers.length === 0) {
    return (
      <p className="pnl-empty">
        Nothing found for {search.origin} to {search.destination} on {search.date}. Try a
        nearby date, or a different airport for the same city.
      </p>
    )
  }

  const cheapest = Math.min(...search.offers.map((o) => o.price))

  return (
    <div className="fl-list">
      <header className="fl-head">
        <span className="fl-route">
          {search.origin} → {search.destination}
        </span>
        <span className="fl-when">
          {search.date}
          {search.returnDate ? ` – ${search.returnDate}` : ''}
        </span>
      </header>

      {/* Said once, at the top, rather than on every card. A price with no
          provenance is worse than no price, but a caveat repeated ten times
          stops being read. */}
      {search.environment !== 'production' ? (
        <p className="fl-caveat">Test data — indicative prices, not bookable.</p>
      ) : null}

      {search.offers.map((offer, i) => (
        <article
          key={i}
          className={`fl-card${offer.price === cheapest ? ' is-cheapest' : ''}`}
        >
          <div className="fl-price-row">
            <span className="fl-price tnum">
              {Math.round(offer.price)}
              <span className="fl-currency"> {offer.currency}</span>
            </span>
            {offer.price === cheapest ? <span className="fl-tag">cheapest</span> : null}
            {typeof offer.seats === 'number' && offer.seats <= 4 ? (
              <span className="fl-seats">
                {offer.seats} seat{offer.seats === 1 ? '' : 's'} left
              </span>
            ) : null}
          </div>

          {offer.legs.map((leg, j) => (
            <div key={j} className="fl-leg">
              <span className="fl-times tnum">
                {leg.depart}
                <span className="fl-arrow"> → </span>
                {leg.arrive}
                {/* An overnight arrival is the single most missed detail on a
                    fare list, and the one most likely to ruin a trip. */}
                {leg.dayOffset > 0 ? <sup className="fl-next-day">+{leg.dayOffset}</sup> : null}
              </span>
              <span className="fl-airports">
                {leg.from}–{leg.to}
              </span>
              <span className="fl-meta">
                {leg.duration} ·{' '}
                {leg.stops === 0
                  ? 'direct'
                  : `${leg.stops} stop${leg.stops === 1 ? '' : 's'}${
                      leg.via.length > 0 ? ` via ${leg.via.join(', ')}` : ''
                    }`}
              </span>
              <span className="fl-airline">{leg.airlines.join(' / ')}</span>
            </div>
          ))}
        </article>
      ))}
    </div>
  )
}

export default FlightsPanel
