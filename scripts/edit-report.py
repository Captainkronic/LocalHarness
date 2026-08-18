#!/usr/bin/env python3
"""
Turn bench runs into a contact sheet you can actually judge.

Scoring an image edit means holding the source and the result side by side and
asking two SEPARATE questions -- did the thing I asked for happen, and did
everything else survive. A folder of PNGs cannot be judged that way, and a
single "is it good" score hides the interesting failure, which is when one
answer is yes and the other is no.

So: one strip per request, source plate first, and two verdict chips under every
attempt. The chips are the point -- they let the whole page be scanned for the
pattern without reading a word of it.

Verdicts come from a scores file, not from the bench. Nothing here can tell
whether an edit worked; a person (or a vision model) has to look. Runs with no
score render without chips rather than with invented ones.

  python3 scripts/edit-report.py --intro notes.md --scores scores.json \
      --out ~/Desktop/edit-review.html
"""

import argparse
import base64
import glob
import html
import json
import os
import re
import subprocess
import tempfile

RUNS = os.path.expanduser("~/LocalHarness/.edit-bench")
THUMB_PX = 560


def thumb(path, px=THUMB_PX):
    """A small JPEG data URI. sips ships with macOS, so no Pillow dependency."""
    if not os.path.isfile(path):
        return None
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "t.jpg")
        r = subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "68",
             "-Z", str(px), path, "--out", out],
            capture_output=True)
        if r.returncode != 0 or not os.path.isfile(out):
            return None
        with open(out, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()


def mini_markdown(text):
    """Just enough markdown for a findings note: headings, bold, code, bullets.

    Not a parser. It renders exactly one file, written alongside it -- if
    something does not survive the round trip, the fix is plainer markdown.
    """
    out, in_list = [], False
    for raw in text.split("\n"):
        line = html.escape(raw.rstrip())
        line = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", line)
        line = re.sub(r"`(.+?)`", r"<code>\1</code>", line)
        if line.startswith("## "):
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append("<h2>%s</h2>" % line[3:])
        elif line.startswith("# "):
            continue
        elif line.startswith("- "):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append("<li>%s</li>" % line[2:])
        elif line.strip() == "":
            if in_list:
                out.append("</ul>")
                in_list = False
        else:
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append("<p>%s</p>" % line)
    if in_list:
        out.append("</ul>")
    return "\n".join(out)


def chip(kind, ok, label):
    """A verdict as shape AND colour, never colour alone."""
    mark = "yes" if ok else "no"
    return ('<span class="chip chip-%s"><span class="chip-k">%s</span>'
            '<span class="chip-v">%s</span></span>' % (kind if ok else "no", label, mark))


def plate(src, title, sub, verdict=None, note=None, is_source=False, failed=None):
    cls = "plate plate-source" if is_source else "plate"
    if failed:
        img = '<div class="failbox">did not render</div>'
    else:
        img = '<img src="%s" alt="%s" loading="lazy">' % (src, html.escape(title))
    chips = ""
    if verdict:
        chips = '<div class="chips">%s%s</div>' % (
            chip("held", verdict.get("changed"), "change"),
            chip("held", verdict.get("kept"), "kept the rest"))
    note_html = '<p class="note">%s</p>' % html.escape(note) if note else ""
    return ('<figure class="%s">%s<figcaption>'
            '<p class="plate-title">%s</p><p class="plate-sub">%s</p>%s%s'
            '</figcaption></figure>' % (cls, img, html.escape(title), sub, chips, note_html))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.expanduser("~/Desktop/edit-review.html"))
    ap.add_argument("--runs", default=RUNS)
    ap.add_argument("--intro", default=None)
    ap.add_argument("--scores", default=None,
                    help='JSON: {"<case>": {"<run>": {"changed":bool,"kept":bool,'
                         '"note":str}}}')
    ap.add_argument("--order", default=None,
                    help="comma-separated run labels, to fix the reading order")
    args = ap.parse_args()

    scores = {}
    if args.scores and os.path.isfile(args.scores):
        with open(args.scores) as f:
            scores = json.load(f)

    runs = []
    for mf in sorted(glob.glob(os.path.join(args.runs, "*", "manifest.json"))):
        with open(mf) as f:
            m = json.load(f)
        m["label"] = os.path.basename(os.path.dirname(mf))
        runs.append(m)

    order = args.order.split(",") if args.order else None

    def rank(label):
        if order and label in order:
            return order.index(label)
        return 999

    by_case = {}
    for run in runs:
        for name, c in run.get("cases", {}).items():
            by_case.setdefault(name, []).append((run, c))

    srcs = {}
    parts = []
    case_order = sorted(by_case, key=lambda c: (0 if c == "taxi-pink" else 1, c))
    for case in case_order:
        entries = sorted(by_case[case], key=lambda rc: rank(rc[0]["label"]))
        ask = next((c["ask"] for _r, c in entries if "ask" in c), case)
        src_path = next((c["source"] for _r, c in entries if c.get("source")), None)
        if src_path and src_path not in srcs:
            srcs[src_path] = thumb(src_path)

        parts.append('<section class="case">')
        parts.append('<h2 class="eyebrow">%s</h2>' % html.escape(case))
        parts.append('<p class="ask">&ldquo;%s&rdquo;</p>' % html.escape(ask))
        parts.append('<div class="strip"><div class="strip-inner">')
        if src_path and srcs.get(src_path):
            parts.append(plate(srcs[src_path], "source",
                               '<span class="mono">%s</span>'
                               % html.escape(os.path.basename(src_path)),
                               is_source=True))
        for run, c in entries:
            label = run["label"]
            v = scores.get(case, {}).get(label)
            kw = ", ".join("%s=%s" % (k, val)
                           for k, val in sorted(run.get("kwargs", {}).items()))
            secs = c.get("seconds")
            sub = ('<span class="mono">%s</span>%s%s' % (
                html.escape(run.get("path", "")),
                ' &middot; <span class="mono">%s</span>' % html.escape(kw) if kw else "",
                ' &middot; <span class="mono">%ds</span>' % secs if secs else ""))
            parts.append(plate(thumb(c["output"]) if c.get("output") else None,
                               label, sub, verdict=v,
                               note=(v or {}).get("note"),
                               failed=c.get("error")))
        parts.append('</div></div></section>')

    intro_html = ""
    if args.intro and os.path.isfile(args.intro):
        with open(args.intro) as f:
            intro_html = '<div class="intro">%s</div>' % mini_markdown(f.read())

    body = "\n".join(parts) or "<p>No runs found.</p>"
    doc = """<title>The Edit That Wasn't</title>
<style>
  /* Light is the base set; the two blocks below only redefine tokens, so a
     colour is never defined solely behind a media query or a [data-theme]. */
  :root {
    --ground:#f5f4f7; --plate:#ffffff; --ink:#1a1821; --ink-dim:#6b6579;
    --rule:#e2dfe8; --accent:#8b5cb8; --held:#2c7a58; --lost:#b03f3a;
    --shadow:0 1px 2px rgba(26,24,33,.06), 0 8px 24px rgba(26,24,33,.05);
    --serif:"Iowan Old Style","Charter","Palatino Linotype",Palatino,Georgia,serif;
    --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground:#141317; --plate:#1c1a21; --ink:#ecebf0; --ink-dim:#9a94a6;
      --rule:#2b2833; --accent:#c08ee0; --held:#5cbd92; --lost:#e07670;
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
    }
  }
  :root[data-theme="dark"] {
    --ground:#141317; --plate:#1c1a21; --ink:#ecebf0; --ink-dim:#9a94a6;
    --rule:#2b2833; --accent:#c08ee0; --held:#5cbd92; --lost:#e07670;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
  }

  body { background:var(--ground); color:var(--ink); font-family:var(--sans);
         font-size:16px; line-height:1.6; margin:0; padding:48px 32px 96px; }
  .wrap { max-width:1180px; margin:0 auto; display:flex; flex-direction:column; gap:8px; }

  header { display:flex; flex-direction:column; gap:10px; margin-bottom:8px; }
  h1 { font-family:var(--serif); font-size:40px; line-height:1.12; font-weight:600;
       margin:0; letter-spacing:-.015em; text-wrap:balance; }
  .standfirst { font-family:var(--serif); font-size:19px; color:var(--ink-dim);
                margin:0; max-width:62ch; text-wrap:balance; }

  .intro { max-width:66ch; font-family:var(--serif); font-size:17px;
           display:flex; flex-direction:column; gap:2px; margin:24px 0 8px; }
  .intro h2 { font-family:var(--sans); font-size:12px; font-weight:600;
              letter-spacing:.09em; text-transform:uppercase; color:var(--accent);
              margin:30px 0 4px; }
  .intro p { margin:0 0 12px; }
  .intro ul { margin:0 0 12px; padding-left:20px; }
  .intro li { margin:0 0 5px; }
  .intro code, code { font-family:var(--mono); font-size:.86em;
        background:var(--plate); border:1px solid var(--rule);
        border-radius:4px; padding:1px 5px; }

  .case { border-top:1px solid var(--rule); padding-top:26px; margin-top:34px;
          display:flex; flex-direction:column; gap:4px; }
  .eyebrow { font-size:11.5px; font-weight:600; letter-spacing:.1em;
             text-transform:uppercase; color:var(--ink-dim); margin:0;
             font-family:var(--mono); }
  .ask { font-family:var(--serif); font-size:24px; line-height:1.3; margin:0 0 20px;
         color:var(--ink); max-width:34ch; text-wrap:balance; }

  /* Wide by nature: the strip scrolls inside itself so the page never does. */
  .strip { overflow-x:auto; margin:0 -32px; padding:4px 32px 10px; }
  .strip-inner { display:flex; gap:20px; align-items:flex-start; width:max-content; }

  .plate { margin:0; width:272px; background:var(--plate); border:1px solid var(--rule);
           border-radius:3px; overflow:hidden; box-shadow:var(--shadow);
           display:flex; flex-direction:column; }
  /* The source is the thing everything else is measured against, so it is the
     one plate that gets the accent. */
  .plate-source { border-color:var(--accent); box-shadow:none; }
  .plate-source .plate-title { color:var(--accent); }
  .plate img { width:100%; display:block; aspect-ratio:1; object-fit:cover; }
  figcaption { padding:11px 13px 13px; display:flex; flex-direction:column; gap:5px; }
  .plate-title { margin:0; font-size:13.5px; font-weight:600; font-family:var(--mono); }
  .plate-sub { margin:0; font-size:11.5px; color:var(--ink-dim); line-height:1.45; }
  .mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }
  .note { margin:2px 0 0; font-size:12px; color:var(--ink-dim); line-height:1.45;
          font-family:var(--serif); }

  .chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:3px; }
  .chip { display:inline-flex; align-items:baseline; gap:5px; font-size:11px;
          border-radius:3px; padding:2px 7px; border:1px solid; line-height:1.5; }
  .chip-k { color:var(--ink-dim); }
  .chip-held { border-color:color-mix(in srgb, var(--held) 42%, transparent);
               background:color-mix(in srgb, var(--held) 11%, transparent); }
  .chip-held .chip-v { color:var(--held); font-weight:600; }
  .chip-no { border-color:color-mix(in srgb, var(--lost) 42%, transparent);
             background:color-mix(in srgb, var(--lost) 11%, transparent); }
  .chip-no .chip-v { color:var(--lost); font-weight:600; }

  .failbox { aspect-ratio:1; display:grid; place-items:center; color:var(--lost);
             font-size:13px; font-family:var(--mono);
             background:color-mix(in srgb, var(--lost) 7%, transparent); }

  @media (max-width:700px) {
    body { padding:32px 20px 72px; }
    h1 { font-size:31px; }
    .strip { margin:0 -20px; padding-left:20px; padding-right:20px; }
  }
</style>
<div class="wrap">
<header>
  <h1>The edit that wasn't</h1>
  <p class="standfirst">Same photograph, same instruction, same seed &mdash; through
  every renderer the Edit workflow has had. Two questions per frame: did the change
  happen, and did everything else survive.</p>
</header>
__INTRO__
__BODY__
</div>
"""
    doc = doc.replace("__INTRO__", intro_html).replace("__BODY__", body)
    with open(args.out, "w") as f:
        f.write(doc)
    print("%s  (%dKB, %d runs, %d cases)"
          % (args.out, os.path.getsize(args.out) // 1024, len(runs), len(by_case)))


if __name__ == "__main__":
    main()
