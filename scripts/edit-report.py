#!/usr/bin/env python3
"""
Turn bench runs into one page you can actually judge.

Scoring image edits means holding the source and the result side by side and
asking two separate questions -- did the thing I asked for happen, and did
everything else survive. A directory of PNGs cannot be judged that way, so this
lays every run out as source-next-to-result rows, grouped by case, with the
prompt that produced each one underneath.

Thumbnails are downscaled with sips and inlined, because the page has to be
readable somewhere other than this machine.

  python3 scripts/edit-report.py --out ~/Desktop/edit-review.html
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
THUMB_PX = 420


def thumb(path, px=THUMB_PX):
    """A small JPEG data URI. sips ships with macOS, so no Pillow dependency."""
    if not os.path.isfile(path):
        return None
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "t.jpg")
        r = subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "72",
             "-Z", str(px), path, "--out", out],
            capture_output=True)
        if r.returncode != 0 or not os.path.isfile(out):
            return None
        with open(out, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()


def mini_markdown(text):
    """Just enough markdown for a findings note: headings, bold, code, bullets.

    Not a parser. A real one would be a dependency, and this renders exactly one
    file that is written alongside it -- if something here does not survive the
    round trip, the fix is to write plainer markdown.
    """
    out, in_list = [], False
    for raw in text.split("\n"):
        line = html.escape(raw.rstrip())
        line = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", line)
        line = re.sub(r"`(.+?)`", r"<code>\1</code>", line)
        if line.startswith("## "):
            if in_list: out.append("</ul>"); in_list = False
            out.append("<h2>%s</h2>" % line[3:])
        elif line.startswith("# "):
            continue          # the page has its own title
        elif line.startswith("- "):
            if not in_list: out.append("<ul>"); in_list = True
            out.append("<li>%s</li>" % line[2:])
        elif line.strip() == "":
            if in_list: out.append("</ul>"); in_list = False
        else:
            if in_list: out.append("</ul>"); in_list = False
            out.append("<p>%s</p>" % line)
    if in_list: out.append("</ul>")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.expanduser("~/Desktop/edit-review.html"))
    ap.add_argument("--runs", default=RUNS)
    # A findings file rendered above the grid, so the page can be read by
    # someone who was not here when the runs happened. Deliberately a path
    # rather than a string: the narrative belongs in a file under review, not
    # inlined in a command line.
    ap.add_argument("--intro", default=None,
                    help="path to a small markdown file to render above the grid")
    args = ap.parse_args()

    runs = []
    for mf in sorted(glob.glob(os.path.join(args.runs, "*", "manifest.json"))):
        with open(mf) as f:
            m = json.load(f)
        m["label"] = os.path.basename(os.path.dirname(mf))
        runs.append(m)

    # Group by case so the same edit across paths sits together -- that
    # adjacency is the whole point; a per-run layout hides the comparison.
    by_case = {}
    for run in runs:
        for name, c in run.get("cases", {}).items():
            by_case.setdefault(name, []).append((run, c))

    srcs = {}
    parts = []
    for case in sorted(by_case):
        entries = by_case[case]
        ask = next((c["ask"] for _r, c in entries if "ask" in c), case)
        check = next((c.get("check", "") for _r, c in entries if c.get("check")), "")
        src_path = next((c["source"] for _r, c in entries if c.get("source")), None)
        if src_path and src_path not in srcs:
            srcs[src_path] = thumb(src_path)

        parts.append(f'<section><h2>{html.escape(case)}</h2>')
        parts.append(f'<p class="ask">&ldquo;{html.escape(ask)}&rdquo;</p>')
        if check:
            parts.append(f'<p class="check"><b>Pass means:</b> {html.escape(check)}</p>')
        parts.append('<div class="grid">')
        if src_path and srcs.get(src_path):
            parts.append(
                f'<figure class="src"><img src="{srcs[src_path]}" alt="source">'
                f'<figcaption><b>source</b><br>{html.escape(os.path.basename(src_path))}'
                f'</figcaption></figure>')
        for run, c in entries:
            if c.get("error"):
                parts.append(
                    f'<figure class="err"><div class="failbox">FAILED</div>'
                    f'<figcaption><b>{html.escape(run["label"])}</b><br>'
                    f'{html.escape(c["error"][:300])}</figcaption></figure>')
                continue
            t = thumb(c["output"])
            if not t:
                continue
            kw = ", ".join(f"{k}={v}" for k, v in sorted(run.get("kwargs", {}).items()))
            secs = c.get("seconds")
            parts.append(
                f'<figure><img src="{t}" alt="{html.escape(run["label"])}">'
                f'<figcaption><b>{html.escape(run["label"])}</b><br>'
                f'<span class="meta">{html.escape(run.get("path", ""))} &middot; '
                f'{html.escape(kw)}<br>prompt: {html.escape(run.get("prompt", "?"))}'
                f'{f" &middot; {secs:.0f}s" if secs else ""}</span></figcaption></figure>')
        parts.append('</div></section>')

    intro_html = ""
    if args.intro and os.path.isfile(args.intro):
        intro_html = '<div class="intro">%s</div>' % mini_markdown(open(args.intro).read())

    body = "\n".join(parts) or "<p>No runs found.</p>"
    doc = f"""<title>Image edit bench</title>
<style>
  :root {{ --bg:#faf9f7; --fg:#1c1b19; --dim:#6b6862; --line:#e2ded8; --card:#fff; --accent:#b07ad4; }}
  :root:not([data-theme="light"]) {{ }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{ --bg:#16151a; --fg:#eceaf0; --dim:#9a95a5; --line:#2e2b36; --card:#1e1d24; }}
  }}
  :root[data-theme="dark"] {{ --bg:#16151a; --fg:#eceaf0; --dim:#9a95a5; --line:#2e2b36; --card:#1e1d24; }}
  body {{ background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         margin:0; padding:32px; }}
  h1 {{ font-size:26px; margin:0 0 4px; }}
  .sub {{ color:var(--dim); margin:0 0 32px; }}
  section {{ margin:0 0 44px; padding:0 0 32px; border-bottom:1px solid var(--line); }}
  h2 {{ font-size:19px; margin:0 0 6px; }}
  .ask {{ font-size:17px; margin:0 0 6px; color:var(--accent); }}
  .check {{ color:var(--dim); margin:0 0 18px; font-size:13.5px; max-width:70ch; }}
  .grid {{ display:flex; flex-wrap:wrap; gap:18px; }}
  figure {{ margin:0; width:{THUMB_PX//2 + 40}px; background:var(--card);
            border:1px solid var(--line); border-radius:10px; overflow:hidden; }}
  figure.src {{ outline:2px solid var(--accent); }}
  img {{ width:100%; display:block; }}
  figcaption {{ padding:9px 11px; font-size:12.5px; }}
  .meta {{ color:var(--dim); }}
  .failbox {{ aspect-ratio:1; display:grid; place-items:center; color:#c0392b; font-weight:600; }}
  .intro {{ max-width:74ch; margin:0 0 40px; }}
  .intro h2 {{ font-size:17px; margin:26px 0 8px; }}
  .intro p {{ margin:0 0 12px; }}
  .intro li {{ margin:0 0 6px; }}
  .intro code {{ background:var(--card); border:1px solid var(--line); border-radius:4px;
                 padding:1px 5px; font-size:13px; }}
  .intro strong {{ color:var(--fg); }}
</style>
<h1>Image edit bench</h1>
<p class="sub">Source is outlined. Two questions per row: did the asked-for change happen,
and did everything else survive.</p>
{intro_html}
{body}
"""
    with open(args.out, "w") as f:
        f.write(doc)
    kb = os.path.getsize(args.out) // 1024
    print(f"{args.out}  ({kb}KB, {len(runs)} runs, {len(by_case)} cases)")


if __name__ == "__main__":
    main()
