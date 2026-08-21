Build me a 3D mini golf game that plays in the browser. The workspace is yours; `index.html` in the workspace root is the entry point.

**three.js is already vendored** — do not download anything. `vendor/three.module.js` and `vendor/three.core.min.js` are in the workspace (r178, ES modules; the first imports the second, keep them side by side). Load it with an import map:

```html
<script type="importmap">{"imports":{"three":"./vendor/three.module.js"}}</script>
<script type="module" src="./game.js"></script>
```

Serve the folder with `serve_dir` and open the http:// URL. A module import will not load from file://.

**What the game is.** One playable hole to start: a green with walls you bounce off, a cup with a flag, a ball you putt. Aim and power come from the player dragging on the canvas — click on or behind the ball, drag back, release to hit, with a visible aim line and power indicator. Arrow-key aim plus hold-space-to-charge as a second scheme is fine but the mouse is the main one. Ball rolls with friction, bounces off walls, drops in the cup when it arrives slowly enough, and the stroke count goes up on every shot. Show strokes and par. When the ball drops, say so and offer the next hole.

Once that hole plays properly, add two or three more with different shapes — a dogleg, a slope, an obstacle in the middle — and a scorecard across them.

**A test hook, so the game can be play-tested automatically.** This is not optional and it is not decoration; an automated play-test drives the game through it after every round of work, and what it reports is what you will be asked to fix next. Expose exactly this on `window`:

```js
window.__golf = {
  // Live values, read every frame by the tester. Distances in world units.
  state: () => ({
    ball: { x, y, z, vx, vz },   // vx/vz are the current velocity components
    cup:  { x, z },              // the cup on the CURRENT hole
    strokes,                     // strokes on the current hole, integer
    holed,                       // true once the ball is in the cup
    hole,                        // 1-based hole number
    par
  }),
  // Hit the ball. angleDeg is measured so that atan2(cup.x - ball.x, cup.z - ball.z)
  // in degrees aims straight at the cup. power is 0..1, 1 being the hardest
  // legal shot. Must behave exactly as a player's drag of the same strength.
  putt: (angleDeg, power) => {},
  reset: () => {}
}
```

Keep `putt()` and the mouse drag going through the same code path — a hook that bypasses the real shot logic tests nothing.

**Order of work.** Get a rendering page with a ball, a green and a cup on screen and check it in the browser before you touch physics. Then putting, then the cup, then a second hole, then looks. A first version on disk beats a better one you are still reasoning about — and if a putt feels wrong, it is faster to change a number and look again than to derive the right one.

No CDN, no build step, no npm. Plain ES modules and the vendored three.js.
