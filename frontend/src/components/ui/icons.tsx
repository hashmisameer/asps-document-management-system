/**
 * The icons used on action buttons.
 *
 * Drawn here rather than pulled from an icon package: there are seven of them,
 * they are a line each, and a dependency for that is a dependency to vendor
 * onto a server with no route to the internet.
 *
 * Every one is `aria-hidden`. The name lives on the button, so an icon
 * announcing itself as well would have a screen reader read the action twice.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" {...stroke}>
      {children}
    </svg>
  )
}

/** An eye. */
export function EyeIcon() {
  return (
    <Icon>
      <path d="M1.8 10S4.9 4.6 10 4.6 18.2 10 18.2 10 15.1 15.4 10 15.4 1.8 10 1.8 10Z" />
      <circle cx="10" cy="10" r="2.4" />
    </Icon>
  )
}

/** An arrow into a tray. */
export function DownloadIcon() {
  return (
    <Icon>
      <path d="M10 3v8.5" />
      <path d="m6.4 8.4 3.6 3.6 3.6-3.6" />
      <path d="M3.5 14.5v1.2a1.3 1.3 0 0 0 1.3 1.3h10.4a1.3 1.3 0 0 0 1.3-1.3v-1.2" />
    </Icon>
  )
}

/** A circling arrow. */
export function ReplaceIcon() {
  return (
    <Icon>
      <path d="M16.3 8.6A6.4 6.4 0 0 0 5.2 5.9L3.4 7.6" />
      <path d="M3.7 4.2v3.6h3.6" />
      <path d="M3.7 11.4a6.4 6.4 0 0 0 11.1 2.7l1.8-1.7" />
      <path d="M16.3 15.8v-3.6h-3.6" />
    </Icon>
  )
}

/** A waste bin. */
export function TrashIcon() {
  return (
    <Icon>
      <path d="M3.8 5.6h12.4" />
      <path d="M8.2 5.6V4.2a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.4" />
      <path d="M5.4 5.6l.7 10a1.2 1.2 0 0 0 1.2 1.1h5.4a1.2 1.2 0 0 0 1.2-1.1l.7-10" />
      <path d="M8.6 8.6v5M11.4 8.6v5" />
    </Icon>
  )
}

/** A pen over a line: signing. */
export function SignIcon() {
  return (
    <Icon>
      <path d="M3 16.4h14" />
      <path d="M5.6 13.4 13 6a1.7 1.7 0 0 1 2.4 2.4l-7.4 7.4-3 .6.6-3Z" />
    </Icon>
  )
}

/** A tick: already signed. */
export function SignedIcon() {
  return (
    <Icon>
      <path d="M4 10.6l3.6 3.5L16 5.8" />
    </Icon>
  )
}

/** An arrow up out of a tray: uploading. */
export function UploadIcon() {
  return (
    <Icon>
      <path d="M10 12.5V4" />
      <path d="m6.4 7.6 3.6-3.6 3.6 3.6" />
      <path d="M3.5 14.5v1.2a1.3 1.3 0 0 0 1.3 1.3h10.4a1.3 1.3 0 0 0 1.3-1.3v-1.2" />
    </Icon>
  )
}

/** A printer: paper going in at the top, a sheet coming out. */
export function PrintIcon() {
  return (
    <Icon>
      <path d="M6 7.4V3.4h8v4" />
      <path d="M6 13.4H4.6A1.6 1.6 0 0 1 3 11.8V9a1.6 1.6 0 0 1 1.6-1.6h10.8A1.6 1.6 0 0 1 17 9v2.8a1.6 1.6 0 0 1-1.6 1.6H14" />
      <path d="M6 11.6h8v5H6z" />
    </Icon>
  )
}
