#!/usr/bin/env python3
"""
A bench for the image edit path, so "it doesn't really work" becomes a number.

It talks to ComfyUI directly rather than through comfy-mcp, because the whole
point is to A/B two different graphs against the same sources and seeds. Going
through the MCP server would only let us test the graph it already ships.

Two paths are built here:

  sdedit  what comfy-mcp does today. VAEEncode the source, resample it at
          partial `denoise`. The model has no idea an edit was requested; it
          just sees a noised version of the photo and a prompt. How much
          survives is entirely a function of `denoise`, and the change you asked
          for and the details you wanted kept are traded against each other on
          that one axis.

  klein   what it used to do, and what the official ComfyUI template for this
          exact model does. Generate a FRESH latent, and condition it on the
          source through ReferenceLatent. Preservation comes from the
          conditioning rather than from leftover noise, so there is no tradeoff
          axis to lose on.

Both write into a run directory with a manifest, so a later run is comparable
and a scored result can be traced back to the exact graph that made it.

  python3 scripts/edit-bench.py --path klein --cases taxi-pink --label first-try
"""

import argparse
import json
import os
import random
import shutil
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

COMFY = os.environ.get("COMFY_HOST", "http://127.0.0.1:8188")
COMFY_INPUT = os.path.expanduser(os.environ.get("COMFY_INPUT", "~/ComfyUI-Shared/input"))
RUNS = os.path.expanduser("~/LocalHarness/.edit-bench")

# ---------------------------------------------------------------- models

Z_UNET, Z_CLIP, Z_CLIPTYPE, Z_VAE = (
    "z_image_turbo_bf16.safetensors", "qwen_3_4b.safetensors", "lumina2", "ae.safetensors")
K_UNET, K_CLIP, K_CLIPTYPE, K_VAE = (
    "flux-2-klein-base-4b.safetensors", "qwen_3_4b.safetensors", "flux2", "flux2-vae.safetensors")
KD_UNET = "flux-2-klein-4b.safetensors"  # bf16: MPS cannot run the fp8 build


def build_sdedit(prompt, src_name, steps=8, cfg=1.0, seed=0, denoise=0.6, megapixels=None):
    """comfy-mcp's current edit graph, reproduced exactly.

    `megapixels` is not in the shipped version -- it is the fix under test for
    sources that are not already near the model's native size. Left None it
    reproduces today's behaviour, which feeds the source in at whatever
    resolution it happens to be.
    """
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": Z_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": Z_CLIP, "type": Z_CLIPTYPE}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": Z_VAE}},
        "4": {"class_type": "LoadImage", "inputs": {"image": src_name}},
        "5": {"class_type": "VAEEncode", "inputs": {"pixels": ["4", 0], "vae": ["3", 0]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["2", 0]}},
        "10": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "positive": ["6", 0], "negative": ["8", 0],
            "latent_image": ["5", 0], "seed": seed, "steps": steps, "cfg": cfg,
            "sampler_name": "euler", "scheduler": "simple", "denoise": denoise}},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "SaveImage",
               "inputs": {"images": ["11", 0], "filename_prefix": "bench/sdedit"}},
    }
    if megapixels:
        g["20"] = {"class_type": "ImageScaleToTotalPixels", "inputs": {
            "image": ["4", 0], "upscale_method": "lanczos",
            "megapixels": megapixels, "resolution_steps": 16}}
        g["5"]["inputs"]["pixels"] = ["20", 0]
    return g


def build_klein(prompt, src_name, steps=20, cfg=5.0, seed=0, megapixels=1.0, denoise=None):
    """True instruction edit: a fresh latent conditioned on the source.

    Node shape follows ComfyUI's own `image_flux2_klein_image_edit_4b_base`
    template, which is written for the exact checkpoint installed here. The one
    thing worth understanding: node 66 is an EMPTY latent, so nothing of the
    original reaches the sampler as pixels. The source arrives only as
    ReferenceLatent conditioning on BOTH the positive and the negative branch,
    which is what lets the model hold the frame while changing one thing in it.

    `denoise` is accepted and ignored, so the runner can call both paths alike.
    """
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": K_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": K_CLIP, "type": K_CLIPTYPE}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": K_VAE}},
        "4": {"class_type": "LoadImage", "inputs": {"image": src_name}},
        # Normalise to the model's native pixel budget. resolution_steps=16 keeps
        # both sides on the latent grid, which is why this cannot introduce a
        # ragged edge the way an arbitrary resize would.
        "5": {"class_type": "ImageScaleToTotalPixels", "inputs": {
            "image": ["4", 0], "upscale_method": "lanczos",
            "megapixels": megapixels, "resolution_steps": 16}},
        "6": {"class_type": "GetImageSize", "inputs": {"image": ["5", 0]}},
        "7": {"class_type": "VAEEncode", "inputs": {"pixels": ["5", 0], "vae": ["3", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "9": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["2", 0]}},
        "10": {"class_type": "ReferenceLatent",
               "inputs": {"conditioning": ["8", 0], "latent": ["7", 0]}},
        "11": {"class_type": "ReferenceLatent",
               "inputs": {"conditioning": ["9", 0], "latent": ["7", 0]}},
        "12": {"class_type": "CFGGuider", "inputs": {
            "model": ["1", 0], "positive": ["10", 0], "negative": ["11", 0], "cfg": cfg}},
        "13": {"class_type": "Flux2Scheduler",
               "inputs": {"steps": steps, "width": ["6", 0], "height": ["6", 1]}},
        "14": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "15": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "16": {"class_type": "EmptyFlux2LatentImage",
               "inputs": {"width": ["6", 0], "height": ["6", 1], "batch_size": 1}},
        "17": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["15", 0], "guider": ["12", 0], "sampler": ["14", 0],
            "sigmas": ["13", 0], "latent_image": ["16", 0]}},
        "18": {"class_type": "VAEDecode", "inputs": {"samples": ["17", 0], "vae": ["3", 0]}},
        "19": {"class_type": "SaveImage",
               "inputs": {"images": ["18", 0], "filename_prefix": "bench/klein"}},
    }


def build_klein_distilled(prompt, src_name, steps=4, cfg=1.0, seed=0, megapixels=1.0,
                          denoise=None):
    """The same reference-latent edit, on the guidance-distilled checkpoint.

    Distillation folds the guidance into the weights, so this runs at cfg 1.0 and
    four steps where the base model needs 5.0 and twenty. That is not a 5x saving
    but roughly a 10x one: ComfyUI skips the unconditional pass entirely when cfg
    is 1.0, so each step costs half as much as well.

    Shape follows ComfyUI's `image_flux2_klein_image_edit_4b_distilled` template.
    The negative branch is ConditioningZeroOut over the SAME encode rather than a
    separate empty one -- pointless arithmetic at cfg 1.0, but CFGGuider requires
    a negative and zeroing the real conditioning is what the template does.
    """
    g = build_klein(prompt, src_name, steps=steps, cfg=cfg, seed=seed,
                    megapixels=megapixels)
    g["1"]["inputs"]["unet_name"] = KD_UNET
    g["9"] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["8", 0]}}
    g["11"]["inputs"]["conditioning"] = ["9", 0]
    g["19"]["inputs"]["filename_prefix"] = "bench/klein-distilled"
    return g


PATHS = {"sdedit": build_sdedit, "klein": build_klein,
         "klein-distilled": build_klein_distilled}

# ---------------------------------------------------------------- cases

G = os.path.expanduser("~/Documents/Gemma")

CASES = {
    # The historical example: this exact edit was done with Klein and the result
    # is on disk, so a regression here is visible rather than argued about.
    "taxi-pink": dict(
        src=f"{G}/city_nights.png",
        ask="turn all the taxi cabs pink while keeping everything else the same",
        refined=(
            "A cinematic street-level photograph looking down a Manhattan avenue at "
            "sunset. Pedestrians walk toward the camera along the left sidewalk: a bald "
            "man in a navy polo checking his phone in the foreground, a woman in a brown "
            "leather jacket, two women with black backpacks seen from behind. A brightly "
            "lit street food cart with a striped awning stands at the kerb. On the right, "
            "a queue of New York taxi cabs painted HOT PINK, roof signs lit, headlights "
            "on, waiting in traffic. Glass and stone towers rise on both sides, windows "
            "catching warm interior light; a golden-orange sunset glows down the avenue "
            "between them. Wet asphalt, painted lane markings, manhole covers. Shot on "
            "35mm at f/2.8, warm nostalgic palette."),
        check="Every taxi is pink. The crowd, food cart, buildings, street lamps "
              "and sunset sky are unchanged."),
    "cart-remove": dict(
        src=f"{G}/city_nights.png",
        ask="remove the street food cart from the sidewalk",
        refined=(
            "A cinematic street-level photograph looking down a Manhattan avenue at "
            "sunset. Pedestrians walk toward the camera along the left sidewalk: a bald "
            "man in a navy polo checking his phone in the foreground, a woman in a brown "
            "leather jacket, two women with black backpacks seen from behind. The "
            "sidewalk beside them is clear and empty, plain grey paving running to the "
            "storefront windows behind. On the right, a queue of yellow taxi cabs waits "
            "in traffic, headlights on. Glass and stone towers rise on both sides; a "
            "golden-orange sunset glows down the avenue between them. Wet asphalt, "
            "painted lane markings, manhole covers. Shot on 35mm at f/2.8."),
        check="The food cart is gone and the sidewalk behind it is plausible. "
              "The pedestrians, taxis and skyline are unchanged."),
    "dog-to-cat": dict(
        src=f"{G}/candid-heartwarming-close-up-photograph-adorable_00001_.png",
        ask="change the dog to a cat",
        refined=(
            "A candid close-up photograph of a fluffy ginger CAT eating from a bright "
            "green glossy ceramic bowl on a pale hardwood kitchen floor. The cat is bent "
            "to the bowl, tongue out, whiskers catching the light. Soft daylight comes "
            "from a window at frame left; a white kitchen counter and cabinets are "
            "blurred behind. Shallow depth of field at 85mm f/2.8, high-key exposure, "
            "warm neutral palette of golden browns and fresh greens."),
        check="The animal is a cat. The green bowl, floor, framing, lighting and "
              "depth of field are unchanged."),
    "bowl-blue": dict(
        src=f"{G}/candid-heartwarming-close-up-photograph-adorable_00001_.png",
        ask="make the dog bowl blue instead of green",
        refined=(
            "A candid close-up photograph of a golden retriever eating kibble from a "
            "bright BLUE glossy ceramic bowl on a pale hardwood kitchen floor. The dog "
            "is bent to the bowl with its tongue out, floppy ears forward, warm golden "
            "fur catching soft daylight from a window at frame left. A white kitchen "
            "counter and cabinets are blurred behind. Shallow depth of field at 85mm "
            "f/2.8, high-key exposure, warm neutral palette."),
        check="The bowl is blue. The dog is the SAME dog -- same breed, pose, "
              "expression and fur. Everything else unchanged."),
    "night": dict(
        src=f"{G}/cinematic-wide-angle-photograph-family-emperor_00001_.png",
        ask="make it night time under a starry sky",
        refined=(
            "A cinematic wide-angle photograph of two adult emperor penguins huddled "
            "together on a snow mound with a small fluffy grey chick sheltered between "
            "them, at NIGHT under a deep blue-black sky crowded with stars. The larger "
            "adult's orange beak and ear patches catch faint starlight; snow and ice "
            "formations recede into cold blue shadow behind. Moonlit highlights on the "
            "snow, long soft shadows, quiet and still. Shot on 35mm."),
        check="Night sky with stars. The same three penguins in the same poses "
              "and positions, same ice formations."),
    "add-scarf": dict(
        src=f"{G}/cinematic-wide-angle-photograph-family-emperor_00001_.png",
        ask="put a red knitted scarf on the baby penguin",
        refined=(
            "A cinematic wide-angle photograph of two adult emperor penguins huddled "
            "together on a snow mound, with a small fluffy grey chick sheltered between "
            "them wearing a bright RED KNITTED SCARF wound around its neck. Soft "
            "overcast Antarctic light, pale blue sky, snow and ice formations behind. "
            "The adults' orange beaks and ear patches are vivid against the "
            "monochromatic ice. Shot on 35mm, quiet and tender mood."),
        check="The chick wears a red scarf. The adults, ice and sky are otherwise "
              "untouched."),
}

# ---------------------------------------------------------------- comfy client


def png_size(path):
    try:
        with open(path, "rb") as f:
            head = f.read(32)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", head[16:24])
    except OSError:
        pass
    return None


def stage(path):
    os.makedirs(COMFY_INPUT, exist_ok=True)
    name = "bench_%s_%s" % (uuid.uuid4().hex[:8], os.path.basename(path))
    shutil.copyfile(path, os.path.join(COMFY_INPUT, name))
    return name


def post(workflow, client_id):
    body = json.dumps({"prompt": workflow, "client_id": client_id}).encode()
    req = urllib.request.Request(f"{COMFY}/prompt", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise RuntimeError("ComfyUI rejected the graph: %s" % detail[:2000]) from None


def wait(prompt_id, timeout=1800):
    """Poll history. Deliberately not the websocket: this runs unattended for
    hours and a dropped socket would strand a run that actually completed."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f"{COMFY}/history/{prompt_id}", timeout=20) as r:
                hist = json.load(r)
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2)
            continue
        entry = hist.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") == "error" or status.get("completed") is False:
                msgs = status.get("messages", [])
                raise RuntimeError("render failed: %s" % json.dumps(msgs)[:1500])
            outs = []
            for node in entry.get("outputs", {}).values():
                for img in node.get("images", []):
                    outs.append(img)
            if outs:
                return outs, time.time() - t0
        time.sleep(2)
    raise RuntimeError("timed out after %ds" % timeout)


def fetch(img, dest):
    q = urllib.parse.urlencode({"filename": img["filename"],
                                "subfolder": img.get("subfolder", ""),
                                "type": img.get("type", "output")})
    with urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=60) as r:
        data = r.read()
    with open(dest, "wb") as f:
        f.write(data)
    return len(data)


# ---------------------------------------------------------------- runner


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", default="klein", choices=sorted(PATHS))
    ap.add_argument("--cases", default="all")
    ap.add_argument("--label", default="run")
    ap.add_argument("--steps", type=int, default=None)
    ap.add_argument("--cfg", type=float, default=None)
    ap.add_argument("--denoise", type=float, default=0.6)
    ap.add_argument("--megapixels", type=float, default=None)
    ap.add_argument("--seed", type=int, default=77777)
    # Which text reaches the renderer. "raw" is the user's own words; "refined"
    # is the finished-image description LocalHarness' stage 1 is supposed to
    # produce. Testing both is the only way to tell a bad graph from a bad prompt.
    ap.add_argument("--prompt", default="raw", choices=["raw", "refined"])
    args = ap.parse_args()

    names = sorted(CASES) if args.cases == "all" else args.cases.split(",")
    for n in names:
        if n not in CASES:
            sys.exit("unknown case %r; have: %s" % (n, ", ".join(sorted(CASES))))

    out_dir = os.path.join(RUNS, f"{args.label}")
    os.makedirs(out_dir, exist_ok=True)
    client_id = uuid.uuid4().hex

    kwargs = {}
    if args.steps is not None:
        kwargs["steps"] = args.steps
    if args.cfg is not None:
        kwargs["cfg"] = args.cfg
    if args.megapixels is not None:
        kwargs["megapixels"] = args.megapixels
    if args.path == "sdedit":
        kwargs["denoise"] = args.denoise

    print(f"\n\033[1m{args.path}\033[0m -> {out_dir}")
    print(f"  {', '.join(f'{k}={v}' for k, v in sorted(kwargs.items())) or 'defaults'}"
          f", seed={args.seed}, prompt={args.prompt}\n")

    manifest = {"path": args.path, "seed": args.seed, "prompt": args.prompt, "kwargs": kwargs,
                "started": time.strftime("%Y-%m-%d %H:%M:%S"), "cases": {}}

    for name in names:
        case = CASES[name]
        src = case["src"]
        if not os.path.isfile(src):
            print(f"  {name:14s} \033[31mmissing source\033[0m {src}")
            continue
        dims = png_size(src)
        staged = stage(src)
        text = case["ask"] if args.prompt == "raw" else case["refined"]
        wf = PATHS[args.path](text, staged, seed=args.seed, **kwargs)
        print(f"  {name:14s} {dims[0]}x{dims[1]}  rendering...", end="", flush=True)
        try:
            res = post(wf, client_id)
            imgs, secs = wait(res["prompt_id"])
        except Exception as e:
            print(f" \033[31mFAILED\033[0m {e}")
            manifest["cases"][name] = {"error": str(e), "ask": case["ask"]}
            continue
        dest = os.path.join(out_dir, f"{name}.png")
        size = fetch(imgs[0], dest)
        print(f" \033[32mdone\033[0m {secs:5.0f}s  {size // 1024}KB")
        manifest["cases"][name] = {
            "ask": case["ask"], "check": case["check"], "source": src,
            "sent": text, "output": dest, "seconds": round(secs, 1),
        }
        with open(os.path.join(out_dir, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=2)

    print()


if __name__ == "__main__":
    main()
