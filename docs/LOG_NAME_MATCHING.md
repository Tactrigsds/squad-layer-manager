# Matching player names from logs

`Die()`/`Wound()` log lines identify their victim by display name only, with no online ids. Resolving that name
against the RCON roster is `PlayerIds.findByUsernameLoose`, which leans on `StrUtils.normalizeForMatch`. This
documents what those two are actually allowed to assume, because the obvious guesses are wrong in both directions.

## The only real divergence is the clan tag

Measured over ~318MB of production `SquadGame.log` (11 files, 1924 distinct `OnPossess(): PC=` names, 1944 distinct
`Die()`/`Wound(): Player:` names), comparing every victim name against the set of names the server itself reports:

| normalization applied | victim names resolved to exactly one roster name |
| --------------------- | ------------------------------------------------ |
| exact, after trim     | 1792                                             |
| + lowercase           | +0                                               |
| + NFKC                | +0                                               |
| + strip whitespace    | +0                                               |

After trimming, **the log name and the RCON name are byte-identical or they differ by a clan tag.** Nothing else.
Case, internal whitespace, and unicode composition never diverge between the two sources: they are the same string
from the same server. The remaining ~420 victim names are the tag-prefix case, which the reverse-containment pass in
`findByUsernameLoose` handles, plus players who never possessed a pawn in the same log.

So `normalizeForMatch` does not exist to reconcile log-vs-RCON noise. It exists for the _other_ callers, where a
**human types** a name: chat commands (`!warn`, `!flag`, squad lookup) and the teams-panel search box. Case,
whitespace, and composition folding are for them, and are justified on that basis alone.

## Why stripping non-ascii was removed

`normalizeForMatch` used to be `s.replace(/[^\x20-\x7E]|\s/g, '').toLowerCase()`, discarding everything outside
printable ascii. This was actively harmful:

- A fully non-latin name normalized to the **empty string**. Matching here is containment, and the empty string is
  contained in every name, so such a player matched every search and every search matched them. They were
  unaddressable by name from chat commands and unfindable in the teams panel.
- Against the same corpus, stripping **broke 237** victim names that resolve correctly when non-ascii is kept, and
  uniquely resolved only **2** that keeping does not, both of the form `Ω Trouser Trout`.
- Those 2 are not evidence for stripping. They are the tag-prefix case with a non-ascii tag, which the reverse pass
  already handles; they only came out ambiguous here because this analysis matched against a global roster of every
  name ever seen rather than one server's live roster.

There is no case in the corpus where stripping non-ascii is what rescues a match. If you are about to re-add it,
re-run the measurement first (`OnPossess(): PC=` names vs `Die()/Wound(): Player:` names) and put the number here.
