/**
 * The company mark, drawn rather than loaded.
 *
 * An inline SVG on purpose: it is a few hundred bytes, needs no request, scales
 * to any size without a second file, and follows the theme colour instead of
 * being a fixed-colour bitmap that looks wrong the day anybody changes it.
 *
 * THIS IS A STAND-IN, not the company's artwork. Nobody has supplied a logo
 * file, and a placeholder that says so is better than one that quietly passes
 * for the real thing on a printed document. Replace the paths below - or swap
 * the whole component for an <img> - when the real mark arrives; nothing else
 * has to change, because every screen draws it through here.
 *
 * The shape is the two letters of the company's initials as interlocking
 * chevrons, which is legible at sixteen pixels and does not rely on colour to
 * be recognisable.
 */
export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      role="img"
      aria-label="ASPS International LLP"
      fill="none"
    >
      <rect width="40" height="40" rx="9" className="fill-brand-700" />

      {/* Two chevrons, one rising and one falling, sharing a centre. */}
      <path
        d="M11 27.5 19.2 12.5a1 1 0 0 1 1.75 0l2.6 4.75"
        stroke="white"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M29 12.5 20.8 27.5a1 1 0 0 1-1.75 0l-2.6-4.75"
        stroke="white"
        strokeOpacity="0.75"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * A faint version of the mark, for the page behind the content.
 *
 * Faint, not invisible. A background on a screen people read all day has one
 * job - to stop a large empty area looking broken - and the moment it competes
 * with a document reference or a red overdue badge it has made the screen
 * worse. It was set so low that on an office monitor it read as nothing at all,
 * which is the same as not having it; twice that is still well under the
 * contrast of any text on the page.
 *
 * Drawn once, fixed, behind everything, and it never intercepts a click.
 */
export function BrandBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Centred on the viewport, and fixed - so it stays put while the page
          scrolls rather than sliding about behind the content.

          The cards and tables are opaque white and sit on top of it, so what is
          actually seen is the mark showing through the gaps between them and
          around the edges of the page. */}
      <BrandMark
        className="absolute top-1/2 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2 -translate-y-1/2 opacity-[0.07]"
      />
    </div>
  )
}
