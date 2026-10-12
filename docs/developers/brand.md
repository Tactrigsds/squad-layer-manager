# Brand

## The mark

A rounded square tile with "SLM" set in it.

The tile is filled with the theme's foreground and the letters with its background, so the mark inverts with the
theme instead of carrying colours of its own.

Geometry, in units of the tile:

| part          | value                                                       |
| ------------- | ----------------------------------------------------------- |
| corner radius | 1/6 of the tile                                             |
| letters       | Roboto Condensed 800, letter-spacing -0.01em, font-size 43% |

The letters are centred vertically in the tile.

Never stretch the tile, outline it, rotate it, or set the letters in another face. Leave clear space of at least 14%
of the tile on all sides, and do not use the tile below 16px.

## Where it appears

- **Nav bar**: the tile, before the nav links.
- **Landing and 403 pages**: the tile above the "Squad Layer Manager" wordmark, letter-spaced 0.14em.
- **Icons**: one rendition per shape and size a platform asks for, kept in `public/` and served from the site root.

| file                    | size       | shape                      | asked for by                                    |
| ----------------------- | ---------- | -------------------------- | ----------------------------------------------- |
| `/favicon.svg`          | any        | rounded tile               | browsers that take an SVG icon                  |
| `/favicon.ico`          | 16, 32, 48 | rounded tile               | the tab strip, bookmarks, the Windows shell     |
| `/icon-192.png`         | 192        | rounded tile               | browsers that ignore an SVG icon                |
| `/icon-512.png`         | 512        | rounded tile               | the manifest                                    |
| `/apple-touch-icon.png` | 180        | full-bleed square          | the iOS home screen                             |
| `/maskable-icon.png`    | 512        | full-bleed, content at 85% | Android adaptive icons                          |
| `/manifest.webmanifest` |            |                            | Android's add-to-home-screen and install prompt |

A platform that masks the icon itself gets a squared-off tile, because iOS composites the transparent pixels of a
corner we rounded onto black, inside the corner it rounds. Android crops a maskable icon to an arbitrary shape and
guarantees only the circle inscribed in the middle 80% of the square. The letters overrun that circle at full size, so
the maskable rendition scales them to 85%.

`/favicon.svg` follows the browser's colour scheme. The rasters cannot, so they use the light tile, which reads
against either tab strip. `src/components/logo-mark.tsx` draws the same paths inline, so the mark in the app follows
the app's theme rather than the browser's.

## The letter outlines

`public/favicon.svg` and `src/components/logo-mark.tsx` hold "SLM" as an outlined path rather than as text, because a
favicon renders where no webfont has loaded. To regenerate it, take the Roboto Condensed 800 TTF served by
`https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@800`, lay the three glyphs out at font-size 43 with
the tracking above, and normalise so the cap-box top is at y=0 and the ink is centred on x=0. Only a change to the
face, the weight or the tracking calls for this. Re-render every raster in `public/` from the new `favicon.svg`
afterwards.
