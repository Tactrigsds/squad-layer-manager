# Style invalidation

A CSS rule that tests state on an ancestor or a sibling makes Chrome restyle every element that rule could match
whenever that state changes. One such rule with a broad target can make a small DOM change restyle thousands of
elements. `pnpm audit:style` lists the rules in the app's compiled CSS that have this shape.

## How Chrome decides what to restyle

For each pseudo-class and attribute, Chrome builds a set of the elements a change of that state could affect. A rule
adds its target to the set of every state it tests outside the element it styles. When the state flips on an
element, Chrome restyles each element under it (or beside it, for `+` and `~`) that matches anything in the set.

The set records only the targets, not the rest of each rule's selector. `[&:last-child[data-selected=true]_button]`
in `calendar.tsx` therefore adds every `button` to the `:last-child` set. On the settings page, mounting the save
panel beside `<main>` flipped `<main>`'s `:last-child` state, and Chrome restyled 2,042 elements in 13ms. Retargeting
the calendar rule halved that, and the two `.fd-grp` rules in `foundry.css` accounted for the rest.

A rule that tests `:last-child` on the element it styles costs little: a flip restyles that one element. Moving the
state test onto the subject, and passing the result down as an inherited custom property, keeps a flip to the
flipped element's own subtree.

Tailwind emits CSS for every class string in `src/`, so a rule is loaded on every page, whether or not the component
that uses it is mounted.

## What the audit reports

Each finding names the state tested, the target it reaches, and the source files that use the rule.

| Kind                             | Example                          | Triggered by                                                      | Fix                                                                                                       |
| -------------------------------- | -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| structural ancestor              | `.fd-grp > :last-child .fd-btn`  | a sibling mounting or unmounting                                  | Set a custom property on the child itself and let the target inherit it, or give the rule a narrow target |
| positional                       | `tr:nth-child(2n) td`            | inserting or removing any sibling, which shifts every later index | Stripe or number rows from a data attribute set at render                                                 |
| structural subject, no narrowing | `.space-y-4 > :not(:last-child)` | a sibling mounting or unmounting                                  | Info only. Restyled nothing on its own when measured, but adds to a structural-ancestor rule's cost       |
| `:has()` ancestor or parent      | `.group:has([data-x]) *`         | any change inside the `:has()` element                            | Set an attribute on the element at render instead of querying its children                                |
| dynamic ancestor                 | `tr:hover td`                    | hover, focus or another interaction state                         | Style the hovered element itself, or keep the target narrow                                               |
| document-root state              | `html[data-mode] button`         | an attribute or class change on `<html>` or `<body>`              | Avoid broad targets under root state                                                                      |

A class target counts as narrow only when it is a Tailwind variant utility, such as `group-hover:opacity-100`, which
sits only on the elements written to use it. A shared class such as `.fd-btn` counts as broad.

```sh
pnpm audit:style            # medium and high findings
pnpm audit:style --min=0    # every finding
pnpm audit:style --json     # every finding, as JSON
```

## Confirming a finding

The audit reads only the stylesheet. It cannot see how many elements a page renders or how often a state flips.
Confirm a finding before rewriting a shared component:

1. Record a DevTools performance trace of the interaction on a dev instance.
2. Select each `Recalculate Style` event. Its summary lists the number of elements affected.
3. Delete the suspect rule from `document.styleSheets` in the console, wait two frames for the deletion's own
   restyle to finish, then repeat the interaction.

A finding is worth fixing when it restyles hundreds of elements on an interaction a user repeats.
