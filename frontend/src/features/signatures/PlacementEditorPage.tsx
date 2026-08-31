import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Document, Page, pdfjs } from 'react-pdf'
import {
  PERMISSIONS,
  SIGNER_ROLES,
  SIGNER_ROLE_LABEL,
  normalizeRotation,
  toRenderedRect,
  type PageRotation,
  type SignerRole,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { useAuth } from '../auth/useAuth.js'
import { documentFileUrl, fetchDocument } from '../documents/api.js'
import { employeeKeys } from '../employees/api.js'
import { ApiError } from '../../lib/apiError.js'
import {
  fetchMySignature,
  fetchPlacements,
  fetchSignature,
  savePlacements,
  signatureKeys,
} from './api.js'
import {
  moveRect,
  newPlacement,
  resizeRect,
  type DraftPlacement,
} from './placementModel.js'

/**
 * Positioning signatures on a document.
 *
 * The page is rendered by pdf.js at whatever size the layout gives it, and the
 * boxes are drawn over it. Nothing on screen is ever stored: a placement is
 * kept normalized to the displayed page, so the same record means the same spot
 * on a laptop, at 150% zoom, and in the 300 DPI raster the stamper works from
 * (docs/coordinate-system.md).
 *
 * Saving replaces the whole set. The signed PDF is rebuilt from the ORIGINAL
 * against exactly what is sent, so there is no partial update and no way to
 * stack one signing on top of another.
 */

// The worker is resolved through the bundler rather than fetched from a CDN:
// the company server has no route to the internet, and a viewer that silently
// fails to start there would be found on deployment day.
//
// frontend/package.json pins pdfjs-dist to the EXACT version react-pdf depends
// on, and it has to stay that way. pdf.js refuses to run when the API and the
// worker differ even in a patch version - 'The API version X does not match the
// Worker version Y' - and because the backend also uses pdfjs-dist, npm hoists
// its copy to the root, where this specifier would otherwise resolve. The
// symptom is not an obvious version error on screen: the page simply says the
// file cannot be displayed, as though the PDF were at fault.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

/** The rendered page box, in CSS pixels. Null until pdf.js has laid a page out. */
interface RenderedSize {
  width: number
  height: number
}

export function PlacementEditorPage() {
  const { documentId: documentIdParam } = useParams()
  const documentId = Number(documentIdParam)
  const { can, user } = useAuth()
  const queryClient = useQueryClient()

  const [pageNumber, setPageNumber] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [rotation, setRotation] = useState<PageRotation>(0)
  const [rendered, setRendered] = useState<RenderedSize | null>(null)
  const [drafts, setDrafts] = useState<DraftPlacement[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const document = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => fetchDocument(documentId),
    enabled: Number.isFinite(documentId),
  })

  const existing = useQuery({
    queryKey: signatureKeys.placements(documentId),
    queryFn: () => fetchPlacements(documentId),
    enabled: Number.isFinite(documentId),
  })

  const employeeId = document.data?.employeeId
  const employeeSignature = useQuery({
    queryKey: signatureKeys.employee(employeeId ?? 0),
    queryFn: () => fetchSignature(employeeId as number),
    enabled: typeof employeeId === 'number',
  })

  const mySignature = useQuery({ queryKey: signatureKeys.mine, queryFn: fetchMySignature })

  // Loaded once into editable state. After that the server's copy is history:
  // re-seeding on every refetch would throw away work in progress.
  const placements: DraftPlacement[] = useMemo(() => {
    if (drafts !== null) return drafts
    if (!existing.data) return []
    return existing.data.map((placement) => ({
      key: `saved-${placement.signaturePlacementId}`,
      pageNumber: placement.pageNumber,
      pageRotation: normalizeRotation(placement.pageRotation),
      signerRole: placement.signerRole,
      rect: {
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
      },
    }))
  }, [drafts, existing.data])

  const update = useCallback(
    (next: DraftPlacement[]) => {
      setDrafts(next)
      setSaved(false)
    },
    [setDrafts],
  )

  const save = useMutation({
    mutationFn: () =>
      savePlacements(documentId, {
        placements: placements.map((placement) => ({
          pageNumber: placement.pageNumber,
          x: placement.rect.x,
          y: placement.rect.y,
          width: placement.rect.width,
          height: placement.rect.height,
          pageRotation: placement.pageRotation,
          // Everything drawn here was put there by a person. Detection is
          // advisory and does not run in this editor, so claiming otherwise
          // would misreport how the signature came to be where it is.
          method: 'Manual',
          detectionMethod: 'Manual',
          signerRole: placement.signerRole,
          confidence: null,
        })),
      }),
    onSuccess: async () => {
      setFailure(null)
      setSaved(true)
      await queryClient.invalidateQueries({ queryKey: signatureKeys.placements(documentId) })
      await queryClient.invalidateQueries({ queryKey: employeeKeys.all })
    },
    onError: (error: unknown) => {
      setSaved(false)
      setFailure(error instanceof ApiError ? error.message : 'Those placements could not be saved.')
    },
  })

  const canPlace = can(PERMISSIONS.SIGNATURE_PLACE)

  const addBox = (signerRole: SignerRole) => {
    const placement = newPlacement(placements, pageNumber, rotation, signerRole)
    update([...placements, placement])
    setSelected(placement.key)
  }

  const removeBox = (key: string) => {
    update(placements.filter((placement) => placement.key !== key))
    if (selected === key) setSelected(null)
  }

  const onPage = placements.filter((placement) => placement.pageNumber === pageNumber)

  if (!Number.isFinite(documentId)) {
    return <Alert title="Not found">That document does not exist.</Alert>
  }

  return (
    <main>
      <Link to="/employees" className="text-sm text-slate-600 hover:text-slate-900">
        Back to employees
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {document.data ? `Sign ${document.data.documentName}` : 'Sign document'}
          </h1>
          {document.data ? (
            <p className="mt-0.5 text-sm text-slate-600">
              {document.data.employeeName} ({document.data.employeeCode})
            </p>
          ) : null}
        </div>

        {canPlace ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => addBox(SIGNER_ROLES.EMPLOYEE)}>
              Add employee box
            </Button>
            <Button variant="secondary" onClick={() => addBox(SIGNER_ROLES.AUTHORISER)}>
              Add my box
            </Button>
            <Button
              busy={save.isPending}
              busyLabel="Saving..."
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              Save and stamp
            </Button>
          </div>
        ) : null}
      </div>

      {/* Said before the work, not after a failed save: a box for a signature
          that does not exist cannot be stamped, and finding that out at the end
          means doing the positioning twice. */}
      {employeeSignature.data && !employeeSignature.data.hasSignature ? (
        <div className="mt-3">
          <Alert title="This employee has no signature on file">
            Capture it on their record first, or their box will have nothing to stamp.
          </Alert>
        </div>
      ) : null}

      {mySignature.data && !mySignature.data.hasSignature ? (
        <div className="mt-3">
          <Alert title="You have no signature on file">
            <Link to="/my-signature" className="font-medium text-brand-700 hover:text-brand-800">
              Draw yours
            </Link>{' '}
            before adding an authoriser box.
          </Alert>
        </div>
      ) : null}

      {failure ? (
        <div className="mt-3">
          <Alert title="Those placements were not saved">{failure}</Alert>
        </div>
      ) : null}

      {saved ? (
        <p className="mt-3 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          Saved. The signed copy has been regenerated from the original.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-slate-600">
        <Button
          variant="ghost"
          disabled={pageNumber <= 1}
          onClick={() => {
            setPageNumber((page) => Math.max(1, page - 1))
            setSelected(null)
          }}
        >
          Previous
        </Button>
        <span>
          Page {pageNumber}
          {pageCount ? ` of ${pageCount}` : ''}
        </span>
        <Button
          variant="ghost"
          disabled={pageCount > 0 && pageNumber >= pageCount}
          onClick={() => {
            setPageNumber((page) => (pageCount ? Math.min(pageCount, page + 1) : page + 1))
            setSelected(null)
          }}
        >
          Next
        </Button>
        <span className="text-xs text-slate-500">
          {onPage.length} box{onPage.length === 1 ? '' : 'es'} on this page, {placements.length} in
          all
        </span>
      </div>

      <div className="mt-3 inline-block rounded-card border border-slate-200 bg-white p-3 shadow-sm">
        <div className="relative inline-block">
          <Document
            file={documentFileUrl.preview(documentId)}
            onLoadSuccess={(pdf) => setPageCount(pdf.numPages)}
            loading={<p className="p-8 text-sm text-slate-500">Loading document...</p>}
            error={
              <p className="p-8 text-sm text-status-rejected">
                This file could not be displayed. Only PDFs can be signed here.
              </p>
            }
          >
            <Page
              pageNumber={pageNumber}
              width={720}
              renderAnnotationLayer={false}
              renderTextLayer={false}
              onLoadSuccess={(page) => {
                // The page's own /Rotate travels with every placement made on
                // it. Without it the transform is not invertible, and the
                // stamper refuses a placement whose rotation no longer matches.
                setRotation(normalizeRotation(page.rotate))
                setRendered({ width: page.width, height: page.height })
              }}
            />
          </Document>

          {rendered
            ? onPage.map((placement) => (
                <PlacementBox
                  key={placement.key}
                  placement={placement}
                  rendered={rendered}
                  selected={selected === placement.key}
                  readOnly={!canPlace}
                  ownName={user?.fullName ?? 'you'}
                  onSelect={() => setSelected(placement.key)}
                  onChange={(rect) =>
                    update(
                      placements.map((entry) =>
                        entry.key === placement.key ? { ...entry, rect } : entry,
                      ),
                    )
                  }
                  onRemove={() => removeBox(placement.key)}
                />
              ))
            : null}
        </div>
      </div>
    </main>
  )
}

/**
 * One draggable box.
 *
 * Pointer events rather than mouse events, and the pointer is captured on the
 * box, so a drag that outruns the cursor does not simply stop when it leaves
 * the element.
 */
function PlacementBox({
  placement,
  rendered,
  selected,
  readOnly,
  ownName,
  onSelect,
  onChange,
  onRemove,
}: {
  placement: DraftPlacement
  rendered: RenderedSize
  selected: boolean
  readOnly: boolean
  ownName: string
  onSelect: () => void
  onChange: (rect: DraftPlacement['rect']) => void
  onRemove: () => void
}) {
  const drag = useRef<{ x: number; y: number; mode: 'move' | 'resize' } | null>(null)
  const pixels = toRenderedRect(placement.rect, rendered)

  const begin = (mode: 'move' | 'resize') => (event: ReactPointerEvent<HTMLElement>) => {
    if (readOnly) return
    event.preventDefault()
    event.stopPropagation()
    onSelect()
    drag.current = { x: event.clientX, y: event.clientY, mode }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current) return
    const deltaX = event.clientX - current.x
    const deltaY = event.clientY - current.y
    drag.current = { ...current, x: event.clientX, y: event.clientY }
    onChange(
      current.mode === 'move'
        ? moveRect(placement.rect, deltaX, deltaY, rendered)
        : resizeRect(placement.rect, deltaX, deltaY, rendered),
    )
  }

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current) event.currentTarget.releasePointerCapture(event.pointerId)
    drag.current = null
  }

  const isAuthoriser = placement.signerRole === SIGNER_ROLES.AUTHORISER

  return (
    <div
      role="presentation"
      onPointerDown={begin('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      style={{
        left: `${pixels.x}px`,
        top: `${pixels.y}px`,
        width: `${pixels.width}px`,
        height: `${pixels.height}px`,
      }}
      className={`absolute flex items-center justify-center rounded border-2 text-xs ${
        readOnly ? '' : 'cursor-move'
      } ${
        isAuthoriser
          ? 'border-status-review bg-status-review/10 text-status-review'
          : 'border-brand-600 bg-brand-600/10 text-brand-800'
      } ${selected ? 'ring-2 ring-offset-1 ring-brand-600' : ''}`}
    >
      <span className="pointer-events-none select-none px-1 text-center font-medium">
        {isAuthoriser ? `${SIGNER_ROLE_LABEL[placement.signerRole]} - ${ownName}` : SIGNER_ROLE_LABEL[placement.signerRole]}
      </span>

      {!readOnly && selected ? (
        <>
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onRemove}
            className="absolute -right-2 -top-2 h-5 w-5 rounded-full bg-status-rejected text-xs font-bold text-white"
            aria-label="Remove this box"
          >
            x
          </button>
          <span
            role="presentation"
            onPointerDown={begin('resize')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            aria-label="Resize this box"
            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-brand-700"
          />
        </>
      ) : null}
    </div>
  )
}
