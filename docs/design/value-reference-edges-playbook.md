# Playbook: extend value-reference edges to a new language

**Purpose.** This is the operational runbook for adding + validating value-reference-edge
coverage for one more language. Point a fresh session at this file and say **"Start on
language X"** — it has everything: how the feature works, where the code is, the exact
validation recipe (with scripts), the per-language checklist, and the traps already hit.

Design rationale + the validation matrix already done live in the companion doc:
[`value-reference-edges.md`](./value-reference-edges.md). This file is the *how-to*.

---

## 0. "Start on language X" — do this in order

1. Read §1 (how it works) and §2 (current state) so you know the mechanism and what's done.
2. Do the **per-language wiring check** (§5 step A–C) — this is where languages differ and
   where most of the real work/decisions are. Do NOT skip: a wrong declarator node type or a
   class-scope-vs-file-scope mismatch makes the feature silently emit nothing (or wrong edges).
3. Run the **validation sweep** (§4) on small/medium/large **public OSS** repos for that
   language. Hunt FPs. **Fix FP clusters; record singletons.** (See §3 for what a real FP
   looks like vs an acceptable one.)
4. Add a **row to the matrix** in `value-reference-edges.md` and a **test case** in
   `__tests__/value-reference-edges.test.ts`.
5. Commit on a branch, open a PR. (§6 has the git workflow + how the prior PRs were done.)

Scope rule (hard): **never eval on the maintainer's own repos** — clone a real public OSS
repo for the language. (Memory: `agent-eval-targets-public-oss-only`.)

---

## 1. How value-reference edges work

**What:** a `references` edge with `metadata: { valueRef: true }` from a *reader symbol* to
the **file-scope `const`/`var` it reads**, same-file only. It exists so impact analysis
catches "change this constant / config object / lookup table → affect its readers" — a class
of change calls/imports/inheritance edges never captured (a const's consumers used to look
like "nothing depends on this").

**Where it flows:** straight into `getImpactRadius` → `codegraph impact` and the impact trail
in `codegraph_explore` / `codegraph_node`. No agent-behaviour change required. **The win is
impact-radius correctness** (a const 90 symbols read going from "1 affected" to "90"), *not*
agent read-reduction (see §4.3).

**Code — all in `src/extraction/tree-sitter.ts`:**

| Symbol | Role |
|---|---|
| `VALUE_REF_LANGS` (static Set) | languages the feature runs for. Currently `typescript`, `javascript`, `tsx`, `go`, `python`, `rust`, `ruby`. **Add the new language here.** |
| `valueRefsEnabled` | `process.env.CODEGRAPH_VALUE_REFS !== '0'` — default ON, env opts out. |
| `MAX_VALUE_REF_NODES` (20_000) | per-scope traversal cap (and the shadow-scan cap). |
| `captureValueRefScope(kind, name, id, node)` | called from `createNode` on every node. Records **targets** (file-scope `const`/`var`) and **reader scopes** (`function`/`method`/`const`/`var`). |
| `flushValueRefs()` | called once at end of `extract()`. Prunes shadowed targets, then for each reader scope walks its subtree for identifiers matching a target name and emits the edges. |

**The two gates inside `captureValueRefScope`** (what you may need to adjust per language):

- **Target gate:** `kind ∈ {constant, variable}` **and** `name.length >= 3` **and**
  `/[A-Z_]/.test(name)` (distinctive name — dodges single-letter / all-lowercase shadowing)
  **and** the node's parent id starts with `file:`, `class:`, or `module:` (file/class/module scope).
- **Reader gate:** `kind ∈ {function, method, constant, variable}`.

**The emit loop in `flushValueRefs`:** same-file only (targets + scopes are per-file, reset
each flush); deduped per `(reader, target)`; skips `isGeneratedFile(path)`; **prunes shadowed
targets** (see §3).

---

## 2. Current state (what's shipped + validated)

- **Default ON** for TS/JS/tsx + Go + Python + Rust + Ruby (`CODEGRAPH_VALUE_REFS=0` disables). Shipped in **PR #895**
  (flip-on + the shadow prune); Go added in a later PR (the shadow-prune declarator switch +
  `VALUE_REF_LANGS`).
- **Validated S/M/L** in **TS, JS, tsx, Go, Python, Rust, and Ruby** — see the matrix in the
  design doc. All clean: node count identical on/off, precision guards held, impact win
  reproduced. Go required extending the shadow prune (per-grammar declarators) — the worked
  example of "step B is load-bearing."
- **Tests:** `__tests__/value-reference-edges.test.ts` — same-file readers edged; surfaced in
  impact radius; shadowed const NOT edged (verified to fail without the guard); JSX-only read
  edged (tsx); `CODEGRAPH_VALUE_REFS=0` emits nothing.
- **Memory:** `value-reference-edges-default-on` (the A/B finding + shadow guard rationale).

---

## 2b. Coverage vs the README (languages + frameworks)

Tracked against the README's **Supported Languages** table (24 rows) and **Framework-aware
Routes** list. Value-refs is **language-level**, so frameworks are *not* a separate axis (see
the bottom of this section).

**✅ Done — validated S/M/L (7 + 3 inherited):**

| Language | How |
|---|---|
| TypeScript, JavaScript, tsx | file-scope `const`/`var`; the original languages |
| Python | module-level `NAME =` |
| Go | package `const`/`var` |
| Rust | module + impl `const`/`static` |
| Ruby | class/module `CONST` (the class-scope extension) |
| **Svelte, Vue, Astro** | **inherited for free** — their extractors re-parse the `<script>`/frontmatter block as `typescript`/`javascript`, which are in `VALUE_REF_LANGS` (verified: a `.svelte` `const` edges its readers). No separate work; no separate matrix row needed. |

**🔜 Remaining — likely the easy path** (constants are file/module-scope, or top-level; do §5: add
to `VALUE_REF_LANGS`, verify the declarator node type + extractor kind, sweep). Classify each
*before* building — several are mixed file+class scope:

| Language | Constant forms | Note |
|---|---|---|
| C | file-scope `const` / `static const` | `init_declarator` in a `declaration`; `#define` macros aren't value nodes |
| Kotlin | top-level `const val`/`val` (file-scope) + `companion`/`object` (class-scope) | top-level is easy; companion needs the class-scope gate (present) |
| Swift | top-level `let` (file) + `static let` in a type (class) | README notes Swift stored properties aren't extracted as own nodes — check |
| Dart | top-level `const`/`final` (file) + `static const` (class) | mixed |
| Lua / Luau | file/chunk `local X =` + globals; no `const` keyword | distinctive-name gate (needs `[A-Z_]`) catches fewer — Lua casing varies |
| R | file-scope `X <- …` / `X = …` | |

**🧱 Remaining — needs the Ruby treatment** (constants live almost entirely **inside a
class/type**; the class-scope *gate* exists now, but first confirm the extractor emits them as
`constant`/`variable` nodes — Ruby's weren't extracted at all, and Java/C# fields may come out as
`field`/`property` kind):

| Language | Constant forms |
|---|---|
| Java | `static final` fields in a class |
| C# | `const` / `static readonly` in a class |
| Scala | `val` / `final val` in an `object`/`class` |
| PHP | class `const` + top-level `const` + `define()` |
| C++ | file-scope + class `static const`/`constexpr` (mixed) |
| Pascal / Delphi | `const` sections at unit (file) or class scope (mixed) |
| Objective-C | `static const` / `extern const` / `#define` (file-ish; macros unparsed; already "partial support") |

**🚫 N/A:** Liquid (template language — no value constants to track).

**Frameworks — not a value-refs axis.** The README's framework list (Django, Flask, Express,
NestJS, Rails, Spring, Gin, Laravel, …) is a *separate* feature: **route-node extraction**.
Value-refs is framework-agnostic — it covers constants in any framework's code through the
underlying language support, with **nothing to do per framework**. The validation sweeps already
ran on framework repos (Rails → Ruby, Django → Python, gin → Go, express/eslint/webpack → JS,
jekyll/sinatra → Ruby), so framework code is exercised; there's no separate framework matrix.

---

## 3. Precision guards + what counts as a false positive

Guards run in `flushValueRefs`, in order:

1. **`isGeneratedFile(path)`** (`src/extraction/generated-detection.ts`) — skips
   *suffix-recognised* generated files (`.pb.ts`, `.min.js`, …). **Path-only** — cannot catch
   content-minified bundles.
2. **Shadow prune** — drop a target when its **declarator count exceeds its file-scope node
   count** (so it's also bound in an inner/local scope). Rationale: a bundled/Emscripten `const
   Module` re-declared as an inner `var Module`, a Go package const shadowed by a local `:=`, or
   a Python module const shadowed by a local `=` resolves to the *inner* binding for nested
   readers, so a file-scope edge is wrong. Inner re-bindings aren't graph nodes, so declarators
   are counted at the **syntax-tree** level. *This is the per-language-sensitive guard:* the
   declarator node types differ per grammar (§5 step B), and comparing against file-scope node
   count (not a flat `>1`) is what keeps **conditional module defs** (`try: X=…; except: X=…`).
3. **Distinctive-name + same-file** (the target gate).

**What a real FP looks like** (fix it): a reader edged to a file-scope const it does **not**
actually read — almost always **intra-file shadowing** (the name is re-bound in an inner
scope) concentrated in **bundled/minified/generated** files. On excalidraw this was 23 edges
in one Emscripten blob.

**What is NOT an FP** (leave it):
- **CommonJS `var x = require('…')` bindings** (JS) — correct same-file reads; changing the
  binding *does* affect its readers; dedups against `calls` edges in impact. Not noise.
- **Module-level mutable `var` state** read by many same-file functions — the intended case.
- A higher edge share in a language (JS ~4–5% vs TS ~0.7–1.6%) is fine if precision holds.

**Known limitations (intentional, documented):** parameter-only shadowing is *not* guarded
(the prune counts declarators, not params — guarding it would over-prune legit consts whose
name coincides with a param); same-file only (no cross-file consumers); reactive/computed
reads with no static identifier aren't covered.

---

## 4. Validation recipe

### 4.1 Deterministic probe (the core — finds FPs)

Index the same repo twice (on vs `CODEGRAPH_VALUE_REFS=0`); node count **must be identical**
(edges-only feature). Build first: `npm run build`. Save this as `probe.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail
SRC="$1"; NAME="$2"; WORK="${WORK:-/tmp/cg-vr}"
CG="$(pwd)/dist/bin/codegraph.js"
export CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1 CODEGRAPH_NO_DAEMON=1
ON="$WORK/$NAME-on"; OFF="$WORK/$NAME-off"
rm -rf "$ON" "$OFF"; mkdir -p "$WORK"
rsync -a --exclude='.git' "$SRC/" "$ON/"; rsync -a --exclude='.git' "$SRC/" "$OFF/"
node "$CG" init "$ON"  2>&1 | grep -E "nodes,|Indexed"
CODEGRAPH_VALUE_REFS=0 node "$CG" init "$OFF" 2>&1 | grep -E "nodes,|Indexed"
OND="$ON/.codegraph/codegraph.db"; OFD="$OFF/.codegraph/codegraph.db"
echo "nodes on/off: $(sqlite3 "$OND" 'select count(*) from nodes') / $(sqlite3 "$OFD" 'select count(*) from nodes')  (MUST MATCH)"
# PRECISE filter — do NOT use LIKE '%valueRef%' (it matches filenames like
# textModelValueReference.ts; see §7). Always: kind='references' AND the exact key.
F="kind='references' and metadata like '%\"valueRef\":true%'"
echo "value-ref edges: $(sqlite3 "$OND" "select count(*) from edges where $F")"
echo "=== top targets by same-file reader count ==="
sqlite3 -column "$OND" "select t.name, count(*) r, replace(t.file_path,'$ON/','') f from edges e join nodes t on e.target=t.id where e.$F group by e.target order by r desc limit 15;"
```

Run: `WORK=/tmp/cg-vr bash probe.sh /path/to/cloned-repo reponame`.

### 4.2 FP hunts (run against the ON db `$OND`, with `F` from above)

```bash
# (a) bundled/minified files among targets — the #1 FP source (the woff2 case):
sqlite3 "$OND" "select distinct t.file_path from edges e join nodes t on e.target=t.id where e.$F;" \
 | while read -r f; do [ -f "$f" ] || continue; \
     m=$(awk '{if(length>x)x=length}END{print x+0}' "$f"); [ "$m" -gt 300 ] && echo "MINIFIED? $m $f"; done
# (b) guard invariant — no surviving target re-declared in its file (adjust regex per language):
sqlite3 "$OND" "select distinct t.name, t.file_path from edges e join nodes t on e.target=t.id where e.$F limit 80;" \
 | while IFS='|' read -r n f; do [ -f "$f" ] || continue; \
     c=$(grep -cE "(const|let|var)[[:space:]]+$n\b" "$f"); [ "${c:-0}" -gt 1 ] && echo "LEAK $n x$c $f"; done
# (c) precision sample — eyeball reader->target pairs across the tree:
sqlite3 -column "$OND" "select s.name,'->',t.name from edges e join nodes s on e.source=s.id join nodes t on e.target=t.id where e.$F order by e.id desc limit 12;"
```

For each FP suspect, open the file and confirm whether the reader truly reads that file-scope
target. Cluster of FPs in one file → fix (extend a guard). One-off → record it, don't chase.

### 4.3 Impact-API delta (the headline) + agent A/B

Headline metric — value-refs turns a blind impact into a real one:

```bash
for s in SOME_CONST ANOTHER_CONST; do
  printf "%-20s ON %s OFF %s\n" "$s" \
    "$(node dist/bin/codegraph.js impact "$s" --path "$ON"  2>/dev/null | grep -oE '— [0-9]+ affected' | head -1)" \
    "$(node dist/bin/codegraph.js impact "$s" --path "$OFF" 2>/dev/null | grep -oE '— [0-9]+ affected' | head -1)"
done
```
Pick targets from the probe's "top targets" list. Expect ON ≫ OFF (e.g. 1 → 90).

**Agent A/B** (optional per language — the finding below is size/language-independent, so the
deterministic probe + impact delta usually suffice). If you run it: two **fresh on/off
indexes**, pre-warm a `--no-watch` daemon per index, `claude -p` with **`--model sonnet
--effort high`**, ≥2 runs/arm. The pattern in `scripts/agent-eval/ab-new-vs-baseline.sh` is
the template **but it switches builds + re-indexes (no flag), which wipes a flag-specific
index — don't use it as-is for a flag A/B.** (Memories: `agent-eval-nested-attach`,
`agent-eval-targets-public-oss-only`.)

**The established A/B finding (don't re-derive):** across 12 runs on excalidraw both arms did
0 Read / 0 Grep — the agent answers impact questions in one call and reaches for
`codegraph_search`/`callers`, *not* `impact`/`explore`, so it often doesn't query the
value-ref edges at all. ON was never worse than OFF. **So: value-refs does NOT reduce agent
reads — the win is blast-radius correctness** (impact API / CodeGraph Pro's verdict engine).

---

## 5. Per-language checklist (the actual work)

### A. Where do "constants worth tracking" live? (decide FIRST)

The target gate now accepts **`file:`, `class:`, and `module:`** parents. Before anything:

- If the language puts shareable constants at **file/module scope** (TS/JS, Python module
  consts, Go package vars, Rust module/impl `const`/`static`) → fits as-is; proceed.
- If constants live **inside a class/module** (Ruby — done) → the `class:`/`module:` gate now
  covers them, BUT two things may need fixing first: (1) the extractor must actually *extract*
  the class-internal constant as a node (the dispatch at the `variableTypes` branch skips
  class-internal assignments — Ruby needed an exception for `constant`-LHS assignments); (2) the
  reader-scan must match however the grammar represents a constant *reference* (Ruby uses
  `constant` nodes, not `identifier`). See the Ruby block in the design doc.
- **Class-scope precision** uses a **file-wide** target map (one target per name per file), NOT
  strict same-class matching — because lexical-scope languages (Ruby) let a nested class read an
  enclosing class's constant, and strict matching would drop those valid reads. The only real FP
  is the same constant name in *sibling* classes in one file (~1.7% of Ruby targets on rails);
  valid code rarely hits it (a bare sibling-class constant is a NameError in Ruby).
- **Still untested:** Java `static final`, C# `const`, Swift `static let`. The gate covers them
  now, but confirm the extractor emits them as `constant`/`variable` nodes with a `class:`/
  `struct:` parent (Swift stored properties, for one, aren't extracted as their own nodes) — and
  if the parent kind is `struct:`/`interface:` rather than `class:`/`module:`, widen the gate.

### B. Confirm the declarator node type (for the shadow prune)

The shadow prune (in `flushValueRefs`) counts declarator names via a `switch (n.type)` over
declarator node types — a file only has its own grammar's nodes, so it's safe to list all
languages' types in one switch. **Add the new grammar's declarator types there**, with the
right way to pull the bound name(s). **Verify against the actual grammar** (don't trust this
table — confirm by parsing a sample). **This step is load-bearing:** if you skip it, the prune
silently does nothing for the new language and intra-file shadowing produces false positives
(this is exactly what happened on the first Go pass — see §5-Go below).

| Language | declarator node(s) | name extraction | status |
|---|---|---|---|
| TS/JS/tsx | `variable_declarator` | `namedChild(0)` | done |
| Go | `const_spec`, `var_spec`, `short_var_declaration` | spec → `namedChild(0)`; short-var → identifiers in the `left` field | **done** |
| Python | `assignment` | `left` field: identifier, or iterate a `pattern_list`/`tuple_pattern` | **done** |
| Rust | `const_item`, `static_item`, `let_declaration` | const/static → `name` field; let → `pattern` field | **done** |
| Ruby | `assignment` (LHS is a `constant` node) | already in the switch; Ruby can't local-shadow a constant, so the prune is effectively a no-op for it | **done** (class-scope) |
| Ruby | `assignment` with constant LHS (`CONST`) | LHS | to verify |
| C/C++ | `init_declarator` in a file-scope `declaration` | declarator id | to verify |

**The prune rule is `declarators > file-scope-node-count`, NOT `> 1`.** A name can be bound
twice *at file scope* legitimately — a **conditional module def** (`try: X = a; except: X = b`,
or `if cond: X = a else: X = b`). Those make N file-scope nodes AND N declarators, so they're
kept; a real local shadow makes declarators exceed file-scope nodes. Python forced this
refinement (try/except const defs are everywhere); it's strictly more correct for all
languages. `fileScopeValueCounts` (incremented in `captureValueRefScope`) tracks the file-scope
node count per name. Also: same-name value-ref edges are suppressed (`refName !== scope.name`),
since the two halves of a conditional def would otherwise cross-reference.

**Go was the worked example of "step B matters":** the first pass added `go` to
`VALUE_REF_LANGS` only, and a synthetic probe immediately showed a false positive —
`func withShadow() { TimeoutSeconds := 5; return TimeoutSeconds }` got edged to the package
`const TimeoutSeconds`, because the prune scanned `variable_declarator` (which Go doesn't
have). Fix: add Go's `const_spec`/`var_spec`/`short_var_declaration` to the switch. Note the
**precision-first tradeoff** this inherits from TS/JS — a shadowed target is dropped for the
*whole file*, so a legit reader elsewhere in that file loses its edge too. On the Go sweep
(gin/hugo/prometheus) this over-pruning was negligible (guard invariant clean, no LEAKs), so
it wasn't worth per-reader analysis — but re-check it per language.

### C. Confirm what kind the extractor assigns

`captureValueRefScope` keys off `kind ∈ {constant, variable}` for targets. Index a sample file
and check `select kind,name from nodes where file_path like '%sample%'` — confirm module-level
constants come out as `constant`/`variable` (not `field`, `property`, `import`, etc.). If they
come out as something else, adjust the target gate.

### D. Wire + sweep

1. Add the language string to `VALUE_REF_LANGS`.
2. `npm run build`.
3. Run §4.1 probe on **small / medium / large** public OSS repos (≥3 sizes). Prefer repos
   with real config/constant/lookup-table modules (where the feature shines).
4. Run §4.2 FP hunts on each. Fix FP clusters (extend a guard); record singletons.
5. Run §4.3 impact delta on a few targets.
6. Add a **matrix row** to `value-reference-edges.md` (per language) and a **test** to
   `__tests__/value-reference-edges.test.ts` (positive read + a shadow/negative case).
7. `npx vitest run __tests__/value-reference-edges.test.ts` and the full suite.

**Pass bar:** node count identical on/off at every size; precision samples clean (FP clusters
fixed); impact delta shows the blind→real radius win; full test suite green.

---

## 6. Git / PR workflow (how the prior ones were done)

- Branch off `main` (e.g. `feat/value-refs-<lang>`). This validation work has lived on
  `feat/value-refs-validation`; a new language can extend it or take its own branch.
- A pure-validation change is **docs (+ a test)**; a precision fix is a focused **code** PR
  (like #895). Keep code fixes separate from the doc/matrix update when practical.
- Commit-message trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- PR body trailer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Merge is the **maintainer's call** — don't self-merge unless told. Branch protection needs
  `gh pr merge --squash --admin` when authorised (memory: `gh-merge-needs-admin`).
- CHANGELOG: user-facing entries under `## [Unreleased]`; don't pre-create a version block.

---

## 7. Traps already hit (save yourself the time)

- **Probe false-match:** `metadata LIKE '%valueRef%'` matches *filenames* in other edges'
  metadata (e.g. an `interface-impl` `calls` edge whose `registeredAt` is
  `…/textModelValueReference.ts`). **Always** filter `kind='references' AND metadata LIKE
  '%"valueRef":true%'`. This created a phantom "method target" FP on vscode that was pure
  query noise.
- **`searchNodes` returns `SearchResult[]`** (`.node` wraps the `Node`) — in tests use
  `.map(r => r.node)`. `getImpactRadius().nodes` is a **`Map`** — iterate `.values()`.
- **`CodeGraph.initSync(dir, opts)` ignores `opts`** — it takes only the path; the default
  config indexes `.ts`/`.tsx`/`.js`. Don't rely on a passed `include`.
- **Node count must be identical on/off.** If it isn't, value-refs is (wrongly) creating nodes
  — investigate before anything else.
- **Big repos:** indexing vscode (11.5k files) took ~2m and a ~1GB DB per arm; clean up
  `/tmp` after (each on/off pair is hundreds of MB to >2GB).
- **require-bindings (CommonJS) are not FPs** — see §3. Don't "fix" them.
- **Don't over-engineer a guard for a gap that doesn't manifest** (e.g. param-only shadow):
  evidence-driven only. The maintainer steered toward minimal, surgical fixes.

---

## 8. Reference

- Code: `src/extraction/tree-sitter.ts` (`VALUE_REF_LANGS`, `captureValueRefScope`,
  `flushValueRefs`), `src/extraction/generated-detection.ts` (`isGeneratedFile`).
- Design + matrix: `docs/design/value-reference-edges.md`.
- Tests: `__tests__/value-reference-edges.test.ts`.
- PRs: **#895** (default-on + shadow prune), **#897** (TS/JS/tsx validation).
- Memories: `value-reference-edges-default-on`, `agent-eval-targets-public-oss-only`,
  `agent-eval-nested-attach`, `gh-merge-needs-admin`, `impact-coverage-findings`.
