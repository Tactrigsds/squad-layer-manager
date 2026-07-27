# Brand

## The mark

A rounded square tile with "SLM" set in it, and an optional accent underscore beneath the letters.

The tile is filled with the theme's foreground and the letters with its background, so the mark inverts with the
theme rather than carrying colours of its own. Everything is monochrome except the accent.

Geometry, in units of the tile:

| part          | value                                                       |
| ------------- | ----------------------------------------------------------- |
| corner radius | 1/6 of the tile                                             |
| letters       | Roboto Condensed 800, letter-spacing -0.01em, font-size 43% |
| accent        | 47% wide, 7% tall, fully rounded ends, 7% below the letters |

The letters plus the accent are centred vertically as one block, so adding the accent lifts the letters rather
than crowding the bottom edge.

Never stretch the tile, outline it, rotate it, or set the letters in another face. Leave clear space of at least
twice the accent's height on all sides, and do not use the tile below 16px.

## The instance accent

The accent underscore is the instance's `topBarColor` setting, verbatim. It is not decoration: it is what tells
two SLM instances apart in a browser tab, so it also draws the nav bar's bottom border. Any CSS colour works.

When `topBarColor` is null the plain tile is used and the nav bar keeps its default border. The mark has to work
without the accent, so never design a surface that depends on the accent being there.

## Where it appears

- **Nav bar**: the tile, before the nav links.
- **Landing and 403 pages**: the tile above the "Squad Layer Manager" wordmark, letter-spaced 0.14em.
- **Favicons**: `/favicon.svg`, `/favicon.ico` and `/apple-touch-icon.png`.

The favicons are rendered per request from the current settings rather than built into `dist/`, because the
accent follows a setting an admin can change at any time. `/favicon.svg` follows the browser's colour scheme;
the rasters cannot, so they take the light tile, which reads against either tab strip.

## The letter outlines

`src/lib/logo.ts` holds "SLM" as an outlined path rather than as text, because a favicon renders in a context
where no webfont has loaded. To regenerate it, take the Roboto Condensed 800 TTF that
`https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@800` serves, lay the three glyphs out at
font-size 43 with the tracking above, and normalise so the cap-box top sits at y=0 and the ink is centred on
x=0. Only the face, the weight or the tracking changing calls for this.
