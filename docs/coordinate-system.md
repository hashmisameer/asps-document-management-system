# Signature coordinate system

The single most failure-prone part of this application. A subtle error here
places a signature in the wrong spot on a real employee document, and it would
not be visible from the editor preview.

Implementation: `shared/src/utils/coordinates.ts`
Tests: `backend/tests/unit/coordinates.test.ts` (16 tests, passing)
Drawing: `backend/src/services/signatureStamp.service.ts` (`toDrawParams`)

## The stored form

A placement is stored as `{ x, y, width, height }` **normalized to 0..1 in
displayed page space**: the page exactly as HR sees it in the editor, with a
**top-left origin**, x to the right and y downwards. The page's `/Rotate` value
is stored alongside as `pageRotation`.

**No pixel, DPI, zoom or render-scale value is ever stored.** That is what makes
a placement reproducible across a 96 DPI laptop screen, a 150% zoom, and the
300 DPI raster used for OCR - all of which show the same page at different
sizes.

`dbo.SignaturePlacements` enforces the bounds in the database as well
(`CK_SigPlace_Bounds`), so a placement can never be stored partly off the page,
whatever the calling code does.

## The two conversions

```
editor pixels  <->  normalized        fromRenderedRect / toRenderedRect
normalized      ->  PDF user space    toPdfUserSpace
```

PDF user space has a **bottom-left origin**, is measured in points, and is
relative to the **unrotated** MediaBox. That is the space `pdf-lib` draws into.
`toPdfUserSpace` performs both the Y-axis flip and the un-rotation in one step.

## Rotation

At `/Rotate` 90 or 270 the page is presented with its axes swapped, so the
displayed page is `height x width`. A 10% square anchored at the **displayed
top-left corner** lands here, on a 600 x 800 page:

| Rotation | PDF rect | Which corner of the unrotated page |
|---|---|---|
| 0 | `x=0, y=720, w=60, h=80` | top-left |
| 90 | `x=0, y=0, w=60, h=80` | bottom-left |
| 180 | `x=540, y=0, w=60, h=80` | bottom-right |
| 270 | `x=540, y=720, w=60, h=80` | top-right |

These are asserted as absolute values in the test suite, not merely
round-tripped. A round-trip test alone would happily confirm a transform that is
self-consistent but wrong; pinning known corners to known corners is what
actually catches an inverted axis.

The round-trip is tested too, across A4, Letter, Legal and a landscape page, at
all four rotations, to 9 decimal places.

## Drawing

`toPdfUserSpace` answers *where on the unrotated page a placement lands*. Drawing
it needs one more step, and it lives in
`backend/src/services/signatureStamp.service.ts` as `toDrawParams`:

- A page with `/Rotate` 90 is turned clockwise by the viewer, and content drawn
  into it turns with it - so an image drawn without compensation appears on its
  side. It is drawn pre-rotated counter-clockwise by the same angle.
- `pdf-lib` rotates about `(x, y)` rather than about the rect's centre, so the
  anchor is a different corner of the target rect at each rotation, and the
  image's own width and height are swapped at 90 and 270.

That maths deliberately does **not** live in the shared module: it encodes
pdf-lib's anchor-and-rotate semantics, which the browser editor has no use for
and must not start depending on. The shared module holds the *contract*; this
holds one library's way of honouring it. Its four rotations are pinned to
absolute values in `backend/tests/unit/signatureStamp.test.ts`, the same way the
table above is.

A placement whose recorded `pageRotation` no longer matches the page's own is
**refused rather than drawn**. The coordinates describe the page as HR saw it; if
it has since been rotated, they describe somewhere else.

## Rules

1. **Never store pixels.** If a pixel value is being persisted, something has
   gone wrong.
2. **Always carry `pageRotation` with the placement.** Without it the transform
   is not invertible.
3. **The editor and the stamper share this module.** They must never grow their
   own copy of the maths - that is precisely how the preview and the output
   drift apart.
4. **Clamp on drag, validate on save.** `clampToPage` keeps the UI sane;
   `placementSchema` and the CHECK constraint reject anything out of bounds
   rather than silently correcting it server-side.
