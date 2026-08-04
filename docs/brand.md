# Brand

## The mark

A rounded square tile with "SLM" set in it, and an optional accent underscore beneath the letters.

The tile is filled with the theme's foreground and the letters with its background, so the mark inverts with the
theme instead of carrying colours of its own. Everything is monochrome except the accent.

Geometry, in units of the tile:

| part          | value                                                       |
| ------------- | ----------------------------------------------------------- |
| corner radius | 1/6 of the tile                                             |
| letters       | Roboto Condensed 800, letter-spacing -0.01em, font-size 43% |
| accent        | 47% wide, 7% tall, fully rounded ends, 7% below the letters |

The letters and the accent are centred vertically as one block, so adding the accent lifts the letters instead of
crowding the bottom edge.

Never stretch the tile, outline it, rotate it, or set the letters in another face. Leave clear space of at least
twice the accent's height on all sides, and do not use the tile below 16px.

## The instance accent

The accent underscore is the instance's `topBarColor` setting, verbatim. It is what tells two SLM instances apart in
a browser tab, so it also draws the nav bar's bottom border. Any CSS colour works.

When `topBarColor` is null the plain tile is used and the nav bar keeps its default border. The mark has to work
without the accent, so never design a surface that depends on the accent being there.

## Where it appears

- **Nav bar**: the tile, before the nav links.
- **Landing and 403 pages**: the tile above the "Squad Layer Manager" wordmark, letter-spaced 0.14em.
- **Icons**: one rendition per shape and size a platform asks for.

| path                    | size       | shape                      | asked for by                                    |
| ----------------------- | ---------- | -------------------------- | ----------------------------------------------- |
| `/favicon.svg`          | any        | rounded tile               | browsers that take an SVG icon                  |
| `/favicon.ico`          | 16, 32, 48 | rounded tile               | the tab strip, bookmarks, the Windows shell     |
| `/icon-192.png`         | 192        | rounded tile               | browsers that ignore an SVG icon                |
| `/icon-512.png`         | 512        | rounded tile               | the manifest                                    |
| `/apple-touch-icon.png` | 180        | full-bleed square          | the iOS home screen                             |
| `/maskable-icon.png`    | 512        | full-bleed, content at 85% | Android adaptive icons                          |
| `/manifest.webmanifest` |            |                            | Android's add-to-home-screen and install prompt |

A platform that masks the icon itself gets the tile squared off, because iOS composites the transparent pixels of a
corner we rounded onto black, inside the corner it rounds. Android crops a maskable icon to an arbitrary shape and
guarantees only the circle inscribed in the middle 80% of the square, which the letters and the accent overrun at
full size, so that rendition scales them to 85%.

All of them are rendered from the current settings rather than built into `dist/`, because the accent follows a
setting an admin can change at any time. `/favicon.svg` follows the browser's colour scheme. The rasters cannot, so
they use the light tile, which reads against either tab strip.

## The letter outlines

`src/lib/logo.ts` holds "SLM" as an outlined path rather than as text, because a favicon renders where no webfont
has loaded. To regenerate it, take the Roboto Condensed 800 TTF served by
`https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@800`, lay the three glyphs out at font-size 43 with
the tracking above, and normalise so the cap-box top sits at y=0 and the ink is centred on x=0. Only a change to the
face, the weight or the tracking calls for this.
