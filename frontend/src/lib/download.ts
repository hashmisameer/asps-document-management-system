/**
 * Offering a file the server produced to the person who asked for it.
 *
 * The alternative - an ordinary `<a download>` pointing at the endpoint - is
 * how the document preview and download links work, and it is right for those:
 * the browser streams the file and nothing has to hold it in memory. It is
 * wrong here. A generated form takes long enough that the button has to be able
 * to say it is working, and a failure has to arrive as a message on the screen
 * rather than as an error page saved into the downloads folder.
 */

/** Hands a blob to the browser as a download, and lets go of the object URL. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * The file name the server chose, out of its Content-Disposition header.
 *
 * The server names these files - employee code, name, the day a bulk print was
 * taken - so the browser should not be inventing one. Falls back to the name
 * the caller suggests when the header is missing or unreadable, which is what
 * happens behind a proxy that strips it.
 *
 * Both spellings are read: `filename*=UTF-8''...` first, because a server that
 * sends both means the extended one, then the plain quoted form.
 */
export function fileNameFromDisposition(
  header: string | null | undefined,
  fallback: string,
): string {
  if (!header) return fallback

  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)
  if (extended?.[1]) {
    try {
      return sanitize(decodeURIComponent(extended[1].trim())) || fallback
    } catch {
      // A malformed percent-escape is not worth failing a download over.
    }
  }

  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header)
  const name = plain?.[1] ?? plain?.[2]
  return name ? sanitize(name.trim()) || fallback : fallback
}

/**
 * Anything a name arriving over the wire must not be able to do.
 *
 * A path separator in a downloaded file name is the one that matters: the
 * header is written by this API, but a name that could climb out of the
 * downloads folder should not depend on that staying true.
 */
function sanitize(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/^\.+/, '').trim()
}

/** A file the server generated, with the name the server gave it. */
export interface DownloadedFile {
  blob: Blob
  fileName: string
}

/**
 * A blob response and its Content-Disposition, as something to hand the user.
 *
 * Used by every generated download - the employee forms and the printed chase
 * lists - so the name always comes from the same place and none of them has to
 * remember which header it is in.
 */
export function fileFromResponse(
  response: { data: Blob; headers: Record<string, unknown> },
  fallback: string,
): DownloadedFile {
  const disposition = response.headers['content-disposition']
  return {
    blob: response.data,
    fileName: fileNameFromDisposition(
      typeof disposition === 'string' ? disposition : null,
      fallback,
    ),
  }
}