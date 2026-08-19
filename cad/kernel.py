#!/usr/bin/env python3
"""
kernel.py — run one approved build123d script and report what it made.

Read on stdin as JSON, write to stdout as JSON. One script, one process,
one answer, then it dies. That is deliberate: a fresh interpreter per run
means nothing a script does can survive into the next one.

    echo '{"code": "...", "out": "/tmp/x", "stem": "part"}' | python3 kernel.py

WHAT THIS IS AND IS NOT

It is NOT the security boundary. That is `gateScript` in cadscript.js,
which runs first and refuses anything that mentions the filesystem, the
network, the standard library or a dunder. By the time a script gets here
it has already been read and approved.

This is the SECOND fence, and it exists because one fence is never
enough. The gate is a static check on text, and static checks on text are
beatable in ways nobody has thought of yet. So the script also runs:

  · with a restricted __builtins__ — no open, no eval, no __import__
  · with a cwd it was given and a stripped environment
  · with a wall-clock timeout enforced by the caller
  · with the export done by THIS file, not by the script

That last one matters more than it looks. The obvious way to get a file
out of a generated script is to let it call export_stl and to string-
replace the path afterwards. That is fragile — quoting, Windows escapes,
a model that writes the path twice — and it is also the one thing that
gives generated code a legitimate reason to touch the disk. Taking the
export away removes both problems at once: the script's only job is to
leave a solid in `result_part`, and everything after that is ours.

WHAT IT REPORTS

Measured, not claimed: volume, bounding box, centre of mass, and whether
the solid is topologically valid. That is the whole reason to have a
kernel — it gives a right answer rather than a plausible one — so the
numbers come out of OCCT and go straight back to the shop, which checks
them against what was asked for.
"""

import json
import math
import os
import sys
import traceback

# --------------------------------------------------------------------
# the restricted environment
# --------------------------------------------------------------------
# Everything a shape calculation needs and nothing that reaches outside
# the process. Notably absent: open, eval, exec, compile, __import__,
# input, getattr, globals, vars, dir, help, exit.
SAFE_BUILTINS = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "divmod": divmod, "enumerate": enumerate, "filter": filter, "float": float,
    "frozenset": frozenset, "int": int, "isinstance": isinstance, "len": len,
    "list": list, "map": map, "max": max, "min": min, "pow": pow, "print": print,
    "range": range, "reversed": reversed, "round": round, "set": set,
    "slice": slice, "sorted": sorted, "str": str, "sum": sum, "tuple": tuple,
    "zip": zip, "True": True, "False": False, "None": None,
    # exceptions a script may legitimately raise or catch
    "Exception": Exception, "ValueError": ValueError, "TypeError": TypeError,
    "ZeroDivisionError": ZeroDivisionError, "IndexError": IndexError,
    "KeyError": KeyError, "ArithmeticError": ArithmeticError,
}


# Every script starts `from build123d import *`, and an import statement
# compiles down to a call to `__import__`. So it has to be present — and
# `__import__` is also the single widest escape hatch in the language,
# because `__import__("os").system(...)` needs nothing else at all.
#
# Handing over the real one would undo the whole restricted namespace. So
# this is a stand-in that knows exactly three modules and raises on
# everything else: the legal import works, and the escape does not.
ALLOWED_IMPORTS = {"build123d", "math", "numpy"}


def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in ALLOWED_IMPORTS:
        raise ImportError(
            f"'{name}' is not available — a CAD script may import only "
            "build123d, math and numpy"
        )
    return __import__(name, globals, locals, fromlist, level)


def build_namespace():
    """The globals the script runs in: build123d, math, numpy, nothing else."""
    import build123d

    ns = {"__builtins__": {**SAFE_BUILTINS, "__import__": guarded_import},
          "__name__": "cad_script"}

    # `from build123d import *` is what every script starts with, so the
    # names have to be present for that to resolve — but the module object
    # is placed too, because some scripts qualify.
    ns["build123d"] = build123d
    for name in dir(build123d):
        if not name.startswith("_"):
            ns[name] = getattr(build123d, name)

    ns["math"] = math
    try:
        import numpy
        ns["numpy"] = numpy
        ns["np"] = numpy
    except ImportError:
        pass  # numpy is convenient, not required

    return ns


# --------------------------------------------------------------------
# measuring what came out
# --------------------------------------------------------------------
def measure(part):
    """Everything the shop needs to know, taken from the kernel itself.

    Wrapped individually because a malformed solid can throw on one
    property and answer another perfectly well, and a partial measurement
    is far more useful than an exception.
    """
    m = {}

    try:
        m["volume"] = float(part.volume)
    except Exception:
        m["volume"] = 0.0

    try:
        m["area"] = float(part.area)
    except Exception:
        m["area"] = 0.0

    try:
        bb = part.bounding_box()
        m["size"] = [float(bb.size.X), float(bb.size.Y), float(bb.size.Z)]
        m["min"] = [float(bb.min.X), float(bb.min.Y), float(bb.min.Z)]
        m["max"] = [float(bb.max.X), float(bb.max.Y), float(bb.max.Z)]
    except Exception:
        m["size"] = [0.0, 0.0, 0.0]
        m["min"] = m["max"] = [0.0, 0.0, 0.0]

    try:
        c = part.center()
        m["centre"] = [float(c.X), float(c.Y), float(c.Z)]
    except Exception:
        m["centre"] = [0.0, 0.0, 0.0]

    # Counts are how you tell a real part from a sketch somebody forgot to
    # extrude, and they cost nothing to collect.
    for attr in ("solids", "faces", "edges", "vertices"):
        try:
            m[attr] = len(getattr(part, attr)())
        except Exception:
            m[attr] = 0

    try:
        m["valid"] = bool(part.is_valid())
    except Exception:
        m["valid"] = None      # unknown is not the same as invalid

    return m


def export(part, out_dir, stem):
    """Write the files. WE do this — the script is never allowed to.

    STEP is the one that matters and the one the primitive path could
    never produce: it is real B-rep, it opens in Fusion or SolidWorks as
    editable geometry with faces and edges, and it is the difference
    between this being a CAD tool and a mesh generator. STL is for the
    slicer, and is a tessellation of the same thing.
    """
    from build123d import export_stl, export_step

    os.makedirs(out_dir, exist_ok=True)
    files = {}

    step_path = os.path.join(out_dir, stem + ".step")
    try:
        export_step(part, step_path)
        if os.path.exists(step_path):
            files["step"] = step_path
    except Exception as e:
        files["step_error"] = str(e)[:200]

    stl_path = os.path.join(out_dir, stem + ".stl")
    try:
        export_stl(part, stl_path, tolerance=0.05, angular_tolerance=0.2)
        if os.path.exists(stl_path):
            files["stl"] = stl_path
    except Exception as e:
        files["stl_error"] = str(e)[:200]

    return files


def triangles(part):
    """The mesh, as flat vertex triples, so the app can draw it.

    Handed over as plain lists rather than a file because the renderer
    wants geometry in memory and reading an STL back to draw something we
    already have in the kernel is a silly round trip.
    """
    try:
        verts, faces = part.tessellate(tolerance=0.15, angular_tolerance=0.3)
        pts = []
        for f in faces:
            for i in f:
                v = verts[i]
                pts.extend([round(float(v.X), 4), round(float(v.Y), 4), round(float(v.Z), 4)])
        return pts
    except Exception:
        return []


# --------------------------------------------------------------------
# the run
# --------------------------------------------------------------------
def run(job):
    code = job.get("code") or ""
    out_dir = job.get("out") or "."
    stem = "".join(c for c in str(job.get("stem") or "part") if c.isalnum() or c in "-_")[:48] or "part"
    want_mesh = bool(job.get("mesh", True))

    if not code.strip():
        return {"ok": False, "stage": "input", "error": "no script given"}

    # A last belt-and-braces text check. cadscript.js has already refused
    # anything like this; if one ever gets here the gate has a hole in it
    # and this is the line that says so out loud rather than executing it.
    for bad in ("__", "import os", "import sys", "subprocess", "open(", "eval(", "exec("):
        if bad in code:
            return {"ok": False, "stage": "refused",
                    "error": f"the script contains {bad!r}, which the gate should have caught — not running it"}

    try:
        ns = build_namespace()
    except ImportError as e:
        return {"ok": False, "stage": "kernel",
                "error": f"build123d is not installed in this interpreter: {e}"}

    # Run it. Anything the script raises is caught and handed back as a
    # traceback, because that traceback is the correction signal — it is
    # the most precise statement of what is wrong with the geometry that
    # anything in this system produces.
    try:
        compiled = compile(code, "<cad_script>", "exec")
        exec(compiled, ns)                        # noqa: S102 — the whole point
    except SyntaxError as e:
        return {"ok": False, "stage": "syntax",
                "error": f"{e.__class__.__name__}: {e.msg} (line {e.lineno})",
                "traceback": traceback.format_exc(limit=3)[-1500:]}
    except Exception as e:
        return {"ok": False, "stage": "execute",
                "error": f"{e.__class__.__name__}: {e}"[:400],
                "traceback": traceback.format_exc(limit=6)[-1800:]}

    part = ns.get("result_part")
    if part is None:
        return {"ok": False, "stage": "result",
                "error": "the script ran but never assigned result_part"}

    # A sketch or a wire is not a part, and saying so precisely saves a
    # whole retry spent guessing.
    if not hasattr(part, "bounding_box"):
        return {"ok": False, "stage": "result",
                "error": f"result_part is a {type(part).__name__}, which is not a solid — "
                         "extrude, revolve or loft it into a Part first"}

    try:
        m = measure(part)
    except Exception as e:
        return {"ok": False, "stage": "measure", "error": str(e)[:300]}

    files = export(part, out_dir, stem)

    return {
        "ok": True,
        "metrics": m,
        "files": files,
        "mesh": triangles(part) if want_mesh else [],
    }


def main():
    try:
        job = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "stage": "input", "error": f"bad job: {e}"}))
        return 1

    try:
        result = run(job)
    except Exception as e:                                    # noqa: BLE001
        result = {"ok": False, "stage": "kernel", "error": str(e)[:300],
                  "traceback": traceback.format_exc(limit=4)[-1200:]}

    # stdout is the channel; anything the script printed went there too,
    # so the result is written as one line and the caller takes the last.
    sys.stdout.write("\n" + json.dumps(result) + "\n")
    sys.stdout.flush()
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
