# Design + status: same-file value-reference edges

**Status:** SHIPPED (default-on for TS/JS/tsx + Go + Python + Rust + Ruby; `CODEGRAPH_VALUE_REFS=0` disables). The
emitter lives in `TreeSitterExtractor.flushValueRefs` (`src/extraction/tree-sitter.ts`).
**Motivation:** close the impact-analysis hole for *value consumers*. Static
extraction edges calls, imports, and inheritance, but never edges a constant to the
symbols that read it — so changing a config object / lookup table / shared constant
looked like "nothing depends on this." This is the "change this table, break its
readers" class of change (the ReScript-PR false positive that motivated the work).

---

## TL;DR for a new session

We emit a `references` edge (`metadata: { valueRef: true }`) from a reader symbol to
the **file/package-scope `const`/`var` it reads**, same-file only, for TS/JS/tsx + Go + Python + Rust + Ruby. Those edges
flow straight into `getImpactRadius` / `codegraph impact` and the impact trail in
`codegraph_explore` / `codegraph_node` — no agent-behaviour change required.

The win is **impact-radius correctness**, not agent read-reduction (see "Agent A/B").

## Edge semantics

- **Target:** a file-scope `const`/`var` whose name is "distinctive" (≥3 chars and
  contains an uppercase letter or `_`) — dodges the local-shadowing precision trap
  that single-letter / all-lowercase names invite.
- **Reader (source):** any `function` / `method` / `const` / `var` symbol whose body
  references the target name.
- **Same-file only** — resolution is unambiguous without import/scope analysis.
- **Deduped** per `(reader, target)`. **Additive** — adds edges, never nodes.

## Precision guards (in emission order)

1. **`isGeneratedFile(path)`** — skip suffix-recognised generated files (`.pb.ts`,
   `.min.js`, …). Path-only; it cannot catch content-minified bundles.
2. **Shadow prune** — drop a target when its **declarator count exceeds its file-scope node
   count**, i.e. it's also bound in an *inner* (local) scope. A bundled/Emscripten `const
   Module` re-declared as an inner `var Module`, a Go package const shadowed by a local `:=`,
   or a Python module const shadowed by a local `=` all resolve to the inner binding for nested
   readers — a file-scope edge would be a false positive. Inner re-bindings aren't graph nodes,
   so declarators are counted at the syntax level (per-grammar node types: `variable_declarator`
   for TS/JS, `const_spec`/`var_spec`/`short_var_declaration` for Go, `assignment` for Python,
   `const_item`/`static_item`/`let_declaration` for Rust).
   Comparing against file-scope node count (not a flat ">1") keeps **conditional module defs**
   (`try: X=…; except: X=…`), which legitimately bind a name twice at file scope. This catches
   the content-minified bundles guard #1 misses.
3. **Distinctive-name + same-file** as above.

## Validation matrix — TS / JS / Go / Python / Rust / Ruby

Method per repo: index the same tree twice (value-refs on vs `CODEGRAPH_VALUE_REFS=0`),
diff node/edge counts, spot-check precision, and measure `codegraph impact` on a few
file-scope consts. Node count must be **identical** on/off (edges-only feature).

**TypeScript**

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| sindresorhus/ky | small | 54 | 562 (stable) | +29 (0.8%) | all sampled TP | — |
| excalidraw/excalidraw | medium | 645 | 10,301 (stable) | +717 (1.6%) | TP after shadow prune (#895 removed 23 woff2-bundle FPs) | `tablerIconProps` 1→**170** |
| microsoft/vscode | large | 11,548 | 333,999 (stable) | +10,605 (0.69%) | all sampled TP; no param-shadow / bundle FPs in top 200 | `LayoutStateKeys` 1→**85**, `CORE_WEIGHT` 1→52 |

**JavaScript** (same extractor; CommonJS, `var`, IIFE/UMD)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| expressjs/express | small | 147 | 1,082 (stable) | +27 (0.75%) | all sampled TP | — |
| eslint/eslint | medium | 1,420 | 7,167 (stable) | +1,192 (4.2%) | all sampled TP; guard holds; no minified-file FPs | `internalSlotsMap` 1→**32**, `INDEX_MAP` 1→27 |
| webpack/webpack | large | 9,371 | 28,922 (stable) | +3,521 (4.8%) | all sampled TP; guard holds; no minified-file FPs | `LogType` 1→**89**, `LOG_SYMBOL` 1→90, `UsageState` 2→52 |

**Go** (package-level `const`/`var`; required extending the shadow prune — see below)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| gin-gonic/gin | small | 110 | 2,599 (stable) | +166 (1.9%) | all sampled TP; guard holds | `abortIndex` 1→**24**, `jsonContentType` 1→8 |
| gohugoio/hugo | medium | 952 | 19,160 (stable) | +1,616 (2.5%) | all sampled TP; guard holds | `filepathSeparator` 2→**26** |
| prometheus/prometheus | large | 1,329 | 23,322 (stable) | +3,466 (3.3%) | all sampled TP; guard holds | `rdsLabelInstance` 1→**82**, `ec2Label` 1→24 |
| kubernetes/kubernetes | very large | 19,160 | 251,086 (stable) | +20,574 (1.9%) | all sampled TP; guard holds on 250 targets | `KubeletSubsystem` 3→**138**, `LEVEL_0` 1→102 |

**Python** (module-level `NAME = …`; required extending the prune *and* refining its rule — see below)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| psf/requests | small | 49 | 1,299 (stable) | +85 (2.9%) | all sampled TP; guard holds | `ITER_CHUNK_SIZE` 1→4, `DEFAULT_POOLBLOCK` 1→4 |
| sqlalchemy/sqlalchemy | medium | 679 | 59,963 (stable) | +1,929 (0.8%) | all sampled TP; guard holds | `COMPARE_FAILED` 1→**26**, `DB_LINK_PLACEHOLDER` 1→19 |
| django/django | large | 3,005 | 61,748 (stable) | +1,328 (0.7%) | all sampled TP; guard holds | `_trans` 1→**138**, `SEARCH_VAR` 4→8 |

**Rust** (module-level `const`/`static`; declarators added, no rule change needed)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| BurntSushi/ripgrep | small | 107 | 3,731 (stable) | +144 (0.9%) | all sampled TP; guard holds | `SHERLOCK` 7→**113** |
| tokio-rs/tokio | medium | 795 | 13,281 (stable) | +476 (1.1%) | all sampled TP; `#[cfg]`-conditional consts kept | `PERMIT_SHIFT` 1→**97**, `LOCAL_QUEUE_CAPACITY` 2→46 |
| rust-lang/rust-analyzer | large | 1,530 | 38,780 (stable) | +475 (0.25%) | all sampled TP; 0 real shadow leaks | `INLINE_CAP` 2→**183**, `SPAN_PARTS_BIT` 2→18 |

**Ruby** (`CONST = …`, almost always **inside a class/module** — needed the class-scope extension)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| sinatra/sinatra | small | 96 | 1,800 (stable) | +73 (2.1%) | ~100% TP (flags are valid nested reads) | `HEADER_PARAM` 1→**5** |
| jekyll/jekyll | medium | 218 | 1,906 (stable) | +100 (2.4%) | ~100% TP | `DEFAULT_PRIORITY` 1→3, `LOG_LEVELS` 4→5 |
| rails/rails | large | 1,452 | 61,911 (stable) | +2,255 (1.2%) | ~98% TP (same-file ambiguity 21/1208 targets) | `Post` (Struct const) 75 readers |

Across S/M/L in all six languages: node count never moved, the precision guards held, and
the `impact` OFF column is the bug — a const that 80–140 symbols read reports "1 affected"
without value-refs.

**Go required a code change** (unlike JS/tsx, which the existing guards covered unchanged).
Go puts its constants at package = file scope (good — the target gate fits), but its
declarators are `const_spec`/`var_spec`/`short_var_declaration`, not `variable_declarator`, so
the shadow prune was a no-op for Go and a package `const Timeout` shadowed by a local
`Timeout := …` produced a false positive. Extending the prune's declarator switch to Go's node
types fixed it (one synthetic repro, then clean across gin/hugo/prometheus). This is the
template for the next language: **the shadow prune is per-grammar and must be wired per
language** (see the playbook).

**Python forced a refinement of the prune *rule* — a general improvement.** Python's
declarator is `assignment` (added to the switch). But Python also **conditionally defines
module constants** (`try: HAS_SSL = True; except: HAS_SSL = False`) — a very common idiom that
binds the name twice *at module scope*. The old "bound more than once → drop" rule over-pruned
these (dropping a real const and its readers). The fix distinguishes a conditional module def
from a real shadow by comparing declarator count against the number of **file-scope nodes** the
name has: a conditional def makes them equal (both bindings are file-scope), a local shadow
makes declarators exceed file-scope nodes (the excess is the local). This is strictly more
correct for *all* languages. (It also made the two halves of a conditional def cross-reference
via their own names, so same-name value-ref edges are now suppressed.)

**Rust needed only declarators — the rule was already right.** Rust's are `const_item` /
`static_item` (module consts) and `let_declaration` (the local that shadows). Adding them to
the switch fixed the expected shadow FP (a `const TIMEOUT` shadowed by a local `let TIMEOUT`).
Rust also has the conditional-def pattern — `#[cfg(unix)] const SEP = …; #[cfg(windows)] const
SEP = …` — and the Python-era file-scope-count rule already keeps those correctly (validated on
tokio's `io/interest.rs` cfg-gated flags). One nice property fell out: consts written inside a
config macro (`cfg_aio! { … }`) live in an unparsed token tree, so the prune's syntax walk
doesn't even see them.

**Ruby is the class-scope case — and required three changes.** Ruby keeps almost all constants
*inside* a class/module (jekyll's `lib/`: 0 top-level vs 58 class-internal), so the original
file-scope-only target gate covered ~nothing. Three Ruby-specific fixes: (1) the extractor now
creates nodes for constant assignments (`CONST = …` has a `constant`-typed LHS, not
`identifier`, so they were never extracted at all) — including class-internal ones; (2) the
value-ref target gate accepts `class:`/`module:` parents, not just `file:`; (3) the reader-scan
matches `constant` nodes, since in Ruby both a constant's definition and its references are
`constant`-typed. **Effectively Ruby-only:** Rust impl consts are parented to `file:` already
(so the gate change doesn't touch them — ripgrep stayed at 144 edges), and TS/Python class
members aren't `constant`/`variable` kind.

The interesting precision question — *which* class does a class-scope target belong to — turns
out to favor a **file-wide** target map (a name maps to one target per file), because Ruby's
constant lookup is **lexical + ancestor**: a method in a nested class legitimately reads an
enclosing class's constant (verified on jekyll's `ERBRenderer→ThemeBuilder::SCAFFOLD_DIRECTORIES`
and sinatra's `AcceptEntry→Request::HEADER_PARAM`). Strict same-class matching would wrongly drop
those. The only real false positive is the same constant name defined in *sibling* (un-nested)
classes in one file — 21 of 1,208 targets (1.7%) on rails, and most of those resolve fine too;
referencing a sibling class's bare constant is a NameError in real Ruby, so valid code rarely
hits it. Net precision ~98–100%.

**`tsx` is covered by the TS rows** — excalidraw is a React/.tsx codebase, so the headline
`tablerIconProps` (1→170) and most of its targets live in `.tsx` files. The one
tsx-specific path — a const read *only* inside JSX (`<Foo x={CONST}/>`) — relies on the
reader-scan descending into the JSX subtree; it's locked by a unit test
(`value-reference-edges.test.ts`), so no separate tsx repo sweep is needed.

**Svelte / Vue / Astro are covered for free** — their extractors re-parse the `<script>` /
frontmatter block as `typescript` / `javascript`, which are in `VALUE_REF_LANGS`, so a `const`
in a `.svelte`/`.vue`/`.astro` script edges its readers without any extra work (verified on a
synthetic `.svelte`). No separate matrix row. See the playbook's coverage tracker (§2b) for the
full status against the README's language list.

**JavaScript note — CommonJS `require` bindings are targets, and that's correct.** JS edge
growth (~4–5%) runs higher than TS (~0.7–1.6%) because `var x = require('…')` bindings and
module-level `var` state pass the distinctive-name gate and are read by same-file functions.
These are *not* noise: changing such a binding (swap the dependency, reassign the state)
genuinely affects its readers, so it's a legitimate impact target. Where it overlaps an
existing `calls` edge, `getImpactRadius` dedups by node — no double-counting. (TS `import`s
dodge this entirely: they're `import`-kind nodes, not `const`/`var`, so never targets.)

## Agent A/B — what it does and doesn't buy (excalidraw, sonnet/high, 12 runs)

- **Impact API (the win):** `impact` ON vs OFF — `tablerIconProps` 1→170,
  `COLOR_PALETTE` 15→26, `CaptureUpdateAction` 61→86. This is what `codegraph impact`
  and CodeGraph Pro's verdict engine consume via `getImpactRadius`.
- **Agent read-displacement: none — and that's expected.** On an indexed repo the agent
  answers impact questions in one codegraph call (0 Read / 0 Grep in *both* arms), and it
  reaches for `codegraph_search` / `callers`, **not** `impact`/`explore`, so it often
  doesn't query the value-ref edges at all. ON was never worse than OFF. **Do not claim
  value-refs reduces agent reads** — the win is blast-radius correctness, not fewer turns.
  (This is the "adapt the tool to the agent" wall: edges only help if the agent calls the
  edge-traversing tool.)

## Known limitations (intentional)

- **Parameter-only shadowing** is not guarded. The shadow prune counts
  `variable_declarator`s, so a file-scope const shadowed *only* by a function parameter of
  the same name would slip through. Not observed in S/M/L TS validation, and guarding it
  would over-prune legitimate consts whose name coincides with a parameter elsewhere in
  the file — so it's left unguarded until a real repo surfaces it.
- **Same-file only.** Cross-file value consumers (a const imported and read elsewhere) are
  not edged; that needs import/scope resolution and is out of scope.
- **Reactive/computed reads** (a value read only through a framework getter) have no static
  identifier to match and aren't covered.

## Extending to another language

The step-by-step runbook — wiring checklist, validation scripts, FP hunts, per-language
declarator types, and traps — is in
[`value-reference-edges-playbook.md`](./value-reference-edges-playbook.md). Point a fresh
session at it and say "Start on language X." In short: decide whether the language's
constants are file/module-scope (fits) or class-scope (bigger change); confirm the declarator
node type for the shadow prune; sweep small/medium/large public OSS repos; fix FP clusters;
add a matrix row here + a test.
