/**
 * The little status box a driven run paints into the corner of the window.
 *
 * Test instrumentation only — it is injected through LH_SHOT_DRIVE, which only
 * scripts/shoot.mjs ever sets, so it cannot appear in a normal launch.
 *
 * It exists because a single screenshot at the end of an eight-minute agentic
 * turn tells you nothing about WHEN it went wrong. This accumulates one line
 * per poll, so the final frame carries the whole timeline — that is how the
 * Watch-mode composer bug was caught, from a log that stopped dead at
 * "[1s] new conversation".
 *
 * Deliberately small. It sits over the conversation list, and Adam has to be
 * able to use the app around it while a run is going.
 *
 * Usage inside a drive snippet:
 *   const say = (${OVERLAY})();
 *   say('prompt sent');
 */
export const OVERLAY = `() => {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed', 'right:8px', 'bottom:8px', 'z-index:99999',
    'background:#000c', 'color:#7fd97f',
    'font:10px/1.35 ui-monospace,monospace',
    'padding:5px 7px', 'border:1px solid #2a5a3a', 'border-radius:4px',
    'max-width:290px', 'max-height:150px', 'overflow:auto',
    'white-space:pre-wrap', 'opacity:0.82', 'pointer-events:none'
  ].join(';');
  document.body.appendChild(el);
  const t0 = Date.now();
  return (m) => {
    const s = String(Math.round((Date.now() - t0) / 1000)).padStart(3);
    el.textContent += s + 's ' + m + '\\n';
    el.scrollTop = el.scrollHeight;
  };
}`
