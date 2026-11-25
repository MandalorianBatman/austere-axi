## Use for
Root-cause analysis of one effect: what was seen, and the causes found, grouped by category. It shows what was investigated, not only the conclusion.

## Not for
- A chain of events in time: Timeline or Sequence.
- A decision with branches: Flowchart.
- A list of fixes: write a list. The effect is a symptom, never a remedy.

## Limits
- 18 causes at most. `check` warns above that.
- Advice, not checked: 6 categories or fewer, 3 causes or fewer on a bone. The page reports more; the drawing stays but gets crowded.
- `Fishbone(effect, causes)`. `effect` is the observed symptom (one short sentence).
- `FishCause(text, category, root?)`. Bones appear in the order the categories first show up, alternating above and below the spine.
- One cause may have `root`: the confirmed root cause. Its bone and the effect box are tinted. If two are confirmed, draw two diagrams.

## Usual errors
- Categories copied from a template (the 6 Ms) with nothing under them. Name categories from the real investigation.
- A cause that repeats its category ("Deploy: deployment issue").
- An effect worded as a fix ("Add an alert").
- A category with one vague cause. Delete the bone until there is a finding.
