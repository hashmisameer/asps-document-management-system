import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Document, Page } from 'react-pdf'
import {
  PHOTO_DOCUMENT_CODE,
  SIGNER_ROLES,
  normalizeRotation,
  type PageRotation,
  type SignerRole,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { Select } from '../../components/ui/Select.js'
import { ApiError } from '../../lib/apiError.js'
import { documentFileUrl } from '../documents/api.js'
import { documentListKeys, listDocuments } from '../documents/listApi.js'
import { documentTypeKeys, listDocumentTypes } from '../employees/api.js'
import { PlacementBox, type RenderedSize } from '../signatures/PlacementEditorPage.js'
import { newPlacement, type DraftPlacement } from '../signatures/placementModel.js'
import { fetchTemplate, saveTemplate, templateKeys } from './api.js'

/**
 * Drawing a document type's template on a real document of that type.
 *
 * The same boxes, the same drag and the same resize as signing a document -
 * PlacementBox and placementModel are the signing screen's own - over a
 * sample the administrator picks from the documents already uploaded for the
 * type. What is saved goes against the TYPE. The sample is only looked at:
 * its own placements are not read, and nothing about it is written.
 *
 * The sample's page size, rotation and page count are saved with the boxes,
 * because the coordinates are fractions of that page and a document that does
 * not match it is not one the boxes were drawn for.
 */

/** The page as pdf.js reports it, in points and unrotated. */
interface SamplePage {
  rotation: PageRotation
  widthPt: number
  heightPt: number
}

export function TemplateEditorPage() {
  const { documentTypeId: param } = useParams()
  const documentTypeId = Number(param)
  const [search, setSearch] = useSearchParams()
  const queryClient = useQueryClient()

  const [pageNumber, setPageNumber] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [samplePage, setSamplePage] = useState<SamplePage | null>(null)
  const [rendered, setRendered] = useState<RenderedSize | null>(null)
  const [drafts, setDrafts] = useState<DraftPlacement[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const types = useQuery({ queryKey: documentTypeKeys.all, queryFn: () => listDocumentTypes() })
  const type = types.data?.find((t) => t.documentTypeId === documentTypeId)

  // The documents this template could be drawn on: received ones of the
  // type, by employee code. Ten is plenty; the point is one real page, not a
  // choice.
  const sampleParams = { documentTypeId, state: 'received' as const, pageSize: 10 }
  const samples = useQuery({
    queryKey: documentListKeys.list(sampleParams),
    queryFn: () => listDocuments(sampleParams),
    enabled: Number.isFinite(documentTypeId),
  })

  const sampleParam = Number(search.get('sample'))
  const sampleId =
    Number.isFinite(sampleParam) && sampleParam > 0 ? sampleParam : samples.data?.items[0]?.documentId ?? null

  const existing = useQuery({
    queryKey: templateKeys.forType(documentTypeId),
    queryFn: () => fetchTemplate(documentTypeId),
    enabled: Number.isFinite(documentTypeId),
  })

  // Loaded once into editable state, from the TEMPLATE - never from whatever
  // happened to be stamped on the sample.
  const placements: DraftPlacement[] = useMemo(() => {
    if (drafts !== null) return drafts
    if (!existing.data) return []
    return existing.data.map((box) => ({
      key: `saved-${box.documentTypePlacementId}`,
      pageNumber: box.pageNumber,
      pageRotation: normalizeRotation(box.pageRotation),
      signerRole: box.signerRole,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    }))
  }, [drafts, existing.data])

  const update = (next: DraftPlacement[]) => {
    setDrafts(next)
    setSaved(false)
  }

  const save = useMutation({
    mutationFn: () => {
      if (!samplePage) throw new Error('The sample page has not loaded yet.')
      return saveTemplate(documentTypeId, {
        sampleDocumentId: sampleId,
        samplePageCount: pageCount,
        placements: placements.map((box) => ({
          pageNumber: box.pageNumber,
          x: box.rect.x,
          y: box.rect.y,
          width: box.rect.width,
          height: box.rect.height,
          pageRotation: box.pageRotation,
          signerRole: box.signerRole,
          pageWidthPt: samplePage.widthPt,
          pageHeightPt: samplePage.heightPt,
        })),
      })
    },
    onSuccess: async () => {
      setFailure(null)
      setSaved(true)
      setDrafts(null)
      await queryClient.invalidateQueries({ queryKey: templateKeys.all })
    },
    onError: (error: unknown) => {
      setSaved(false)
      setFailure(error instanceof ApiError ? error.message : 'The template could not be saved.')
    },
  })

  const takesPhoto = type?.documentCode === PHOTO_DOCUMENT_CODE

  const addBox = (signerRole: SignerRole) => {
    if (!samplePage) return
    const box = newPlacement(placements, pageNumber, samplePage.rotation, signerRole)
    update([...placements, box])
    setSelected(box.key)
  }

  const removeBox = (key: string) => {
    update(placements.filter((box) => box.key !== key))
    if (selected === key) setSelected(null)
  }

  const onPage = placements.filter((box) => box.pageNumber === pageNumber)
  const error = [types.error, samples.error, existing.error].find((e) => e instanceof ApiError) as
    | ApiError
    | undefined

  return (
    <main>
      <Link to="/settings/placements" className="text-sm text-slate-600 hover:text-slate-900">
        &larr; Signature and photo placement
      </Link>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Template for {type?.documentName ?? 'document'}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Drag each box to where it goes on the form. Saved against the type; nothing already
            uploaded is changed.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={!samplePage} onClick={() => addBox(SIGNER_ROLES.EMPLOYEE)}>
            Add employee box
          </Button>
          <Button variant="secondary" disabled={!samplePage} onClick={() => addBox(SIGNER_ROLES.AUTHORISER)}>
            Add HR box
          </Button>
          {takesPhoto ? (
            <Button variant="secondary" disabled={!samplePage} onClick={() => addBox(SIGNER_ROLES.PHOTO)}>
              Add photo box
            </Button>
          ) : null}
          <Button
            busy={save.isPending}
            busyLabel="Saving..."
            disabled={save.isPending || !samplePage}
            onClick={() => save.mutate()}
          >
            {placements.length > 0 ? 'Save template' : 'Save (removes the template)'}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-3">
          <Alert title="Something could not be loaded" referenceId={error.referenceId}>
            {error.message}
          </Alert>
        </div>
      ) : null}

      {failure ? (
        <div className="mt-3">
          <Alert title="The template was not saved">{failure}</Alert>
        </div>
      ) : null}

      {saved ? (
        <div className="mt-3">
          <Alert tone="info" title="Template saved">
            Every {type?.documentName ?? 'document'} uploaded from now on will use these boxes.
          </Alert>
        </div>
      ) : null}

      {samples.data && samples.data.items.length === 0 ? (
        <div className="mt-3">
          <Alert tone="info" title={`No ${type?.documentName ?? 'document'} has been uploaded yet`}>
            The template is drawn on a real document of the type. Upload one for any employee
            first, then come back here.
          </Alert>
        </div>
      ) : null}

      <section className="mt-4 flex flex-wrap items-end gap-4">
        <div className="min-w-72">
          <Select
            label="Sample document"
            value={sampleId ? String(sampleId) : ''}
            options={(samples.data?.items ?? []).map((item) => ({
              value: String(item.documentId),
              label: `${item.employeeCode} - ${item.employeeName}`,
            }))}
            onChange={(event) => {
              setSearch({ sample: event.target.value })
              setPageNumber(1)
              setSamplePage(null)
            }}
          />
        </div>

        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Button variant="secondary" disabled={pageNumber <= 1} onClick={() => setPageNumber((p) => p - 1)}>
            Previous
          </Button>
          <span>
            Page {pageNumber}
            {pageCount ? ` of ${pageCount}` : ''}
          </span>
          <Button
            variant="secondary"
            disabled={pageCount > 0 && pageNumber >= pageCount}
            onClick={() => setPageNumber((p) => (pageCount ? Math.min(pageCount, p + 1) : p + 1))}
          >
            Next
          </Button>
        </div>

        {samplePage ? (
          <span className="text-xs text-slate-500">
            {Math.round(samplePage.widthPt)} x {Math.round(samplePage.heightPt)} pt
            {samplePage.rotation ? `, rotated ${samplePage.rotation}` : ''}
            {samplePage.rotation ? ' - unusual; check this is the right sample' : ''}
          </span>
        ) : null}
      </section>

      {sampleId ? (
        <div className="mt-3 inline-block rounded-card border border-slate-200 bg-white p-3 shadow-sm">
          <div className="relative inline-block">
            <Document
              file={documentFileUrl.preview(sampleId)}
              onLoadSuccess={(pdf) => setPageCount(pdf.numPages)}
              loading={<p className="p-8 text-sm text-slate-500">Loading document...</p>}
              error={
                <p className="p-8 text-sm text-status-rejected">
                  This file could not be displayed. Pick another sample.
                </p>
              }
            >
              <Page
                pageNumber={pageNumber}
                width={720}
                renderAnnotationLayer={false}
                renderTextLayer={false}
                onLoadSuccess={(page) => {
                  // The page's own size, unrotated, in points: what the boxes
                  // are fractions of. pdf.js reports the rotated size, so a
                  // page shown on its side is turned back for the record.
                  const rotation = normalizeRotation(page.rotate)
                  const sideways = rotation === 90 || rotation === 270
                  setSamplePage({
                    rotation,
                    widthPt: sideways ? page.originalHeight : page.originalWidth,
                    heightPt: sideways ? page.originalWidth : page.originalHeight,
                  })
                  setRendered({ width: page.width, height: page.height })
                }}
              />
            </Document>

            {rendered
              ? onPage.map((box) => (
                  <PlacementBox
                    key={box.key}
                    placement={box}
                    rendered={rendered}
                    selected={selected === box.key}
                    readOnly={false}
                    ownName="HR"
                    onSelect={() => setSelected(box.key)}
                    onChange={(rect) =>
                      update(placements.map((entry) => (entry.key === box.key ? { ...entry, rect } : entry)))
                    }
                    onRemove={() => removeBox(box.key)}
                  />
                ))
              : null}
          </div>
        </div>
      ) : null}
    </main>
  )
}
