#!/usr/bin/env python3
"""
Check comfy-mcp's workflow graphs against ComfyUI's live schema.

This exists because of a specific bug. When the Klein edit path was removed,
`EDIT_PHASES` kept naming its nodes -- "Applying reference latent", "Preparing
canvas" -- for a graph that no longer contained them, so the progress bar
narrated a workflow that was not running and nobody noticed, because a wrong
label still looks like a label.

Node ids are the weak joint here: the graph is a dict keyed by id, the phase map
is a second dict keyed by the same ids, and nothing connects them. So the last
check below is the important one -- every phase must name a node that is
actually in its graph.

The rest is ordinary schema checking against a running ComfyUI: unknown node
types, missing required inputs, combo values that are not on the menu, and links
pointing at nodes that do not exist.

  python3 scripts/edit-graph-check.py
"""

import importlib.util
import json
import os
import sys
import urllib.request

SERVER = os.path.expanduser("~/.config/comfy-mcp/server.py")
COMFY = os.environ.get("COMFY_HOST", "http://127.0.0.1:8188")
# Placeholders the checker supplies itself; a staged input only exists during a
# real render, so flagging it would make every clean run look dirty.
PLACEHOLDERS = {"image"}


def load_server():
    spec = importlib.util.spec_from_file_location("srv", SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["srv"] = mod
    spec.loader.exec_module(mod)
    return mod


def validate(info, name, g):
    bad = []
    for nid, node in g.items():
        ct = node["class_type"]
        if ct not in info:
            bad.append("%s: unknown node type %s" % (nid, ct))
            continue
        req = info[ct]["input"].get("required", {})
        opt = info[ct]["input"].get("optional", {})
        for k in req:
            if k not in node["inputs"]:
                bad.append("%s %s: missing required input %r" % (nid, ct, k))
        for k, v in node["inputs"].items():
            if k not in req and k not in opt:
                bad.append("%s %s: unknown input %r" % (nid, ct, k))
                continue
            spec = req.get(k) or opt.get(k)
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                if v[0] not in g:
                    bad.append("%s %s.%s links to missing node %s" % (nid, ct, k, v[0]))
            elif spec and isinstance(spec[0], list) and isinstance(v, str):
                if v not in spec[0] and k not in PLACEHOLDERS:
                    bad.append("%s %s.%s=%r is not installed" % (nid, ct, k, v))
    mark = "\033[32mvalid\033[0m" if not bad else "\033[31m%d problem(s)\033[0m" % len(bad)
    print("  %-26s %2d nodes  %s" % (name, len(g), mark))
    for b in bad:
        print("      %s" % b)
    return not bad


def main():
    m = load_server()
    try:
        info = json.load(urllib.request.urlopen("%s/object_info" % COMFY, timeout=30))
    except Exception as e:
        sys.exit("ComfyUI not reachable at %s (%s). Start it and try again." % (COMFY, e))

    print("\n\033[1mcomfy-mcp graphs\033[0m vs the running ComfyUI\n")
    ok = True
    for model in m.edit_model_choices():
        g = m.build_edit_workflow(model, "prompt", "image", 1024, 1024,
                                  m.MODELS[model]["steps"], m.MODELS[model]["cfg"], 1)
        ok &= validate(info, "edit: %s" % model, g)
    for model in m.available_models("generate"):
        g = m.build_workflow(model, "prompt", "", 1024, 1024,
                             m.MODELS[model]["steps"], m.MODELS[model]["cfg"], 1)
        ok &= validate(info, "generate: %s" % model, g)

    print("\n\033[1mphase maps\033[0m -- every phase must name a node in its own graph\n")
    for label, model, phases in [
        ("reference", "klein-edit", m.EDIT_PHASES_REFERENCE),
        ("sdedit", "z-image", m.EDIT_PHASES_SDEDIT),
    ]:
        if model not in m.MODELS:
            continue
        g = m.build_edit_workflow(model, "p", "image", 1024, 1024, 4, 1.0, 1)
        stale = sorted(k for k in phases if k not in g)
        missing = sorted(k for k in g if k not in phases)
        mark = "\033[32mok\033[0m" if not stale else "\033[31mstale ids %s\033[0m" % stale
        print("  %-26s %s%s" % (label, mark,
              "" if not missing else "  \033[2m(unlabelled: %s)\033[0m" % ",".join(missing)))
        ok &= not stale

    print()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
