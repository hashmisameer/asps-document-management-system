import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Document, Page } from 'react-pdf'
import {
  PHOTO_DOCUMENT_CODE,
  SIGNER_ROLES,
  normalizeRotation,
  toVariant,
  variantKey,
  variantLabel,
  type PageRotation,
  type SignerRole,
  type TemplateVariant,
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
import { fetchShapes, fetchTemplate, saveTemplate, templateKeys } from './api.js'
import { describeShape, sampleIsCovered } from './shapeText.js'
import {
  ALL_SHAPES,
  defaultShapeKey,
  filterSamples,
  shapeOptions,
  shapesSummary,
} from './sampleFilter.js'

/**
 * Drawing a document type's template on a real document of that type.
 *
 * The same boxes, the same drag and the same resize as signing a document -
 * PlacementBox and placementModel are the signing screen's own - over a
 * sample the administrator picks from the documents already uploaded for the
 * type. What is saved goes against the TYPE. The sample is only looked at:
 * its own placements are not read, and nothing about it is written.
 *
 * ONE TEMPLATE PER SHAPE. A type can be two pieces of paper - the PF form is
 * two pages, Form 11 is one - and the variant is what the sample PDF is: its
 * page count and the SHAPE of its first page, which way up and what
 * proportions, to one per cent. Not its size: the office's forms come out at
 * twenty sizes for one document, all A4-shaped, and one template covers them
 * all. The editor works out the shape from the sample, loads that shape's
 * boxes, and saves to that shape. Unsaved boxes are kept PER SHAPE for the
 * session, so switching the sample from the two-page form to the one-page
 * form and back loses nothing and carries nothing over.
 *
 * The editor also says how much of the type the sample's shape covers - 118
 * of 121 stored Appointment Letters - and warns when it is only a few, which
 * is usually the wrong sample. That comes from measuring the stored files,
 * asked for once and never waited on.
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
  /** The first page of the current sample - what the variant is keyed on. */
  const [firstPage, setFirstPage] = useState<SamplePage | null>(null)
  /** The page on screen, for drawing. */
  const [currentPage, setCurrentPage] = useState<SamplePage | null>(null)
  const [rendered, setRendered] = useState<RenderedSize | null>(null)
  /** Unsaved boxes, per variant, for the session. */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftPlacement[]>>(() => new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [savedVariant, setSavedVariant] = useState<string | null>(null)

  const types = useQuery({ queryKey: documentTypeKeys.all, queryFn: () => listDocumentTypes() })
  const type = types.data?.find((t) => t.documentTypeId === documentTypeId)

  // The documents this template could be drawn on: received ones of the
  // type. A hundred, so a shape only a few documents have still has a sample
  // in the list once it is filtered down to that shape.
  const sampleParams = { documentTypeId, state: 'received' as const, pageSize: 100 }
  const samples = useQuery({
    queryKey: documentListKeys.list(sampleParams),
    queryFn: () => listDocuments(sampleParams),
    enabled: Number.isFinite(documentTypeId),
  })

  const existing = useQuery({
    queryKey: templateKeys.forType(documentTypeId),
    queryFn: () => fetchTemplate(documentTypeId),
    enabled: Number.isFinite(documentTypeId),
  })

  // The shapes of every stored document of the type. Measured on the server
  // from the files, slowly the first time, so it arrives after the page and
  // the page does not wait for it.
  const shapes = useQuery({
    queryKey: templateKeys.shapes(documentTypeId),
    queryFn: () => fetchShapes(documentTypeId),
    enabled: Number.isFinite(documentTypeId),
    staleTime: 5 * 60 * 1000,
  })

  // Which shape's samples are listed. Chosen in the URL, so it survives a
  // reload; when nobody has chosen, the largest shape with no template - the
  // most documents waiting. NOT remembered across a save: the shape just
  // saved now has a template, and the filter moving on to the next one that
  // has none is the point. Staying put was what made a finished shape look
  // like the next job.
  const shapeParam = search.get('shape')
  const shapeKey = shapeParam ?? defaultShapeKey(shapes.data)
  const shapeFilterOptions = shapeOptions(shapes.data)
  const filteredSamples = filterSamples(samples.data?.items ?? [], shapes.data, shapeKey)

  // The sample on screen: the one chosen, if it is in the filtered list, else
  // the first of that list. A sample outside the chosen shape is not offered.
  const sampleParam = Number(search.get('sample'))
  const chosenSample =
    Number.isFinite(sampleParam) && sampleParam > 0 ? sampleParam : null
  const sampleId =
    chosenSample !== null && filteredSamples.some((item) => item.documentId === chosenSample)
      ? chosenSample
      : (filteredSamples[0]?.documentId ?? null)

  // Which form the sample is, once pdf.js has told us how many pages it has
  // and how big the first one is.
  const variant: TemplateVariant | null =
    firstPage && pageCount > 0 ? toVariant(pageCount, firstPage.widthPt, firstPage.heightPt) : null
  const key = variant ? variantKey(variant) : null

  /** The variants already saved for this type, by key. */
  const savedVariants = useMemo(() => {
    const keys = new Set<string>()
    for (const box of existing.data ?? []) keys.add(variantKey(box.variant))
    return keys
  }, [existing.data])

  // The boxes on screen: this variant's unsaved drafts if there are any, else
  // this variant's saved boxes, else nothing. Never another variant's.
  const placements: DraftPlacement[] = useMemo(() => {
    if (!key) return []
    const draft = drafts.get(key)
    if (draft) return draft
    return (existing.data ?? [])
      .filter((box) => variantKey(box.variant) === key)
      .map((box) => ({
        key: `saved-${box.documentTypePlacementId}`,
        pageNumber: box.pageNumber,
        pageRotation: normalizeRotation(box.pageRotation),
        signerRole: box.signerRole,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      }))
  }, [key, drafts, existing.data])

  const update = (next: DraftPlacement[]) => {
    if (!key) return
    setDrafts((current) => new Map(current).set(key, next))
    setSavedVariant(null)
  }

  const save = useMutation({
    mutationFn: () => {
      if (!variant || !firstPage) throw new Error('The sample has not loaded yet.')
      return saveTemplate(documentTypeId, {
        sampleDocumentId: sampleId,
        samplePageCount: variant.pageCount,
        sampleWidthPt: variant.widthPt,
        sampleHeightPt: variant.heightPt,
        placements: placements.map((box) => ({
          pageNumber: box.pageNumber,
          x: box.rect.x,
          y: box.rect.y,
          width: box.rect.width,
          height: box.rect.height,
          pageRotation: box.pageRotation,
          signerRole: box.signerRole,
          // Every box in one save is on one sample, so the first page's size
          // is every page's size for the forms this office prints.
          pageWidthPt: firstPage.widthPt,
          pageHeightPt: firstPage.heightPt,
        })),
      })
    },
    onSuccess: async (saved) => {
      setFailure(null)
      setSavedVariant(variantLabel(saved.variant))
      // This variant's drafts are now its saved boxes; the others stay.
      if (key) {
        setDrafts((current) => {
          const next = new Map(current)
          next.delete(key)
          return next
        })
      }
      // The shape just saved is done. Forget the chosen shape and sample so
      // the filter falls back to the next shape without a template once the
      // measurements come back - which they do now, because the templates
      // are part of what the shapes answer says.
      setSearch({})
      await queryClient.invalidateQueries({ queryKey: templateKeys.all })
    },
    onError: (error: unknown) => {
      setSavedVariant(null)
      setFailure(error instanceof ApiError ? error.message : 'The template could not be saved.')
    },
  })

  const takesPhoto = type?.documentCode === PHOTO_DOCUMENT_CODE

  const addBox = (signerRole: SignerRole) => {
    if (!currentPage || !key) return
    const box = newPlacement(placements, pageNumber, currentPage.rotation, signerRole)
    update([...placements, box])
    setSelected(box.key)
  }

  const removeBox = (boxKey: string) => {
    update(placements.filter((box) => box.key !== boxKey))
    if (selected === boxKey) setSelected(null)
  }

  const chooseShape = (nextKey: string) => {
    // A new shape means a new sample: the first in that shape.
    setSearch({ shape: nextKey })
    setPageNumber(1)
    setPageCount(0)
    setFirstPage(null)
    setCurrentPage(null)
    setRendered(null)
    setSelected(null)
    setSavedVariant(null)
  }

  const chooseSample = (documentId: string) => {
    setSearch(shapeKey ? { shape: shapeKey, sample: documentId } : { sample: documentId })
    setPageNumber(1)
    setPageCount(0)
    setFirstPage(null)
    setCurrentPage(null)
    setRendered(null)
    setSelected(null)
    setSavedVariant(null)
  }

  const onPage = placements.filter((box) => box.pageNumber === pageNumber)
  const error = [types.error, samples.error, existing.error].find((e) => e instanceof ApiError) as
    | ApiError
    | undefined
  const willReplace = key !== null && savedVariants.has(key)
  const hasDraft = key !== null && drafts.has(key)
  const shape = variant ? describeShape(variant, shapes.data, type?.documentName ?? 'document') : null
  const summary = shapesSummary(shapes.data, type?.documentName ?? 'document')

  return (
    <main>
      <Link to="/settings/placements" className="text-sm text-slate-600 hover:text-slate-900">
        &larr; Signature and photo placement
      </Link>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Template for {type?.documentName ?? 'document'}
            {shape ? (
              <span className="ml-2 text-base font-normal text-slate-600">- {shape.label}</span>
            ) : null}
          </h1>
          {/* What this template will cover: every stored document of the type
              that is this shape. Said in numbers, so 'A4 portrait' is not an
              abstraction - it is 118 of the 121 letters on file. */}
          {shape?.coverage ? (
            <p className="mt-1 text-sm text-slate-600">
              {shape.coverage}
              {shape.group?.hasTemplate ? ' A template is saved for this shape.' : ''}
            </p>
          ) : shapes.isLoading && variant ? (
            <p className="mt-1 text-sm text-slate-500">Measuring the stored documents...</p>
          ) : null}
          <p className="mt-1 text-sm text-slate-600">
            Drag each box to where it goes on the form. Saved against the type, for this form;
            nothing already uploaded is changed.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={!currentPage} onClick={() => addBox(SIGNER_ROLES.EMPLOYEE)}>
            Add employee box
          </Button>
          <Button variant="secondary" disabled={!currentPage} onClick={() => addBox(SIGNER_ROLES.AUTHORISER)}>
            Add HR box
          </Button>
          {takesPhoto ? (
            <Button variant="secondary" disabled={!currentPage} onClick={() => addBox(SIGNER_ROLES.PHOTO)}>
              Add photo box
            </Button>
          ) : null}
          <Button
            busy={save.isPending}
            busyLabel="Saving..."
            disabled={save.isPending || !variant}
            onClick={() => save.mutate()}
          >
            {variant
              ? placements.length > 0
                ? `Save ${variant.pageCount}-page form template`
                : `Save (removes the ${variant.pageCount}-page form template)`
              : 'Save template'}
          </Button>
        </div>
      </div>

      {/* Said before the save, not after: a save that replaces an existing
          template for the same form is the one way two different forms with
          the same page count and size can be confused. */}
      {willReplace && hasDraft ? (
        <div className="mt-3">
          <Alert tone="info" title={`This replaces the existing ${shape?.label ?? ''} template`}>
            A template for this shape of {type?.documentName ?? 'document'} is already saved.
            Saving writes these boxes over it. If this is a different form that happens to be
            the same shape, the two cannot be told apart by their pages.
          </Alert>
        </div>
      ) : null}

      {/* A sample that is a shape hardly anything else is, is usually the wrong
          sample - and a template drawn on it stamps almost nothing. Said
          before the save, not after. */}
      {shape?.warning ? (
        <div className="mt-3">
          <Alert tone="warning" title="This is a rare shape for this document">
            {shape.warning}
          </Alert>
        </div>
      ) : null}

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

      {savedVariant ? (
        <div className="mt-3">
          <Alert tone="info" title={`Template saved: ${savedVariant}`}>
            Every {type?.documentName ?? 'document'} uploaded from now on that is {savedVariant}{' '}
            - whatever its exact size - will use these boxes. Other shapes of this type are not
            affected.
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

      {/* How the type stands: shapes, which have a template, and how much of
          the type the templates reach. The line an administrator reads to
          know whether they are finished. */}
      {summary ? <p className="mt-4 text-sm text-slate-700">{summary}</p> : null}

      <section className="mt-2 flex flex-wrap items-end gap-4">
        {shapeFilterOptions.length > 0 ? (
          <div className="min-w-72">
            <Select
              label="Shape"
              value={shapeKey ?? ALL_SHAPES}
              options={shapeFilterOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(event) => chooseShape(event.target.value)}
            />
          </div>
        ) : null}

        <div className="min-w-72">
          <Select
            label="Sample document"
            value={sampleId ? String(sampleId) : ''}
            options={filteredSamples.map((item) => {
              // Within one shape every sample is that shape; across all of
              // them, say which ones a template drawn on THIS sample covers.
              const covered =
                shapeKey === ALL_SHAPES ? sampleIsCovered(shapes.data, variant, item.documentId) : null
              const mark = covered === null ? '' : covered ? ' - same shape' : ' - different shape'
              return {
                value: String(item.documentId),
                label: `${item.employeeCode} - ${item.employeeName}${mark}`,
              }
            })}
            onChange={(event) => chooseSample(event.target.value)}
          />
          {shapes.data && filteredSamples.length === 0 && (samples.data?.items.length ?? 0) > 0 ? (
            <p className="mt-1 text-xs text-slate-500">
              None of the first {samples.data?.items.length} received documents is this shape.
            </p>
          ) : null}
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

        {variant ? (
          <span className="text-xs text-slate-500">
            {variantLabel(variant)}
            {savedVariants.has(key ?? '') ? ' - template saved' : ' - no template yet'}
            {hasDraft ? ' - unsaved changes' : ''}
            {firstPage?.rotation ? ` - rotated ${firstPage.rotation}; check this is the right sample` : ''}
          </span>
        ) : null}
      </section>

      {sampleId ? (
        <div className="mt-3 inline-block rounded-card border border-slate-200 bg-white p-3 shadow-sm">
          <div className="relative inline-block">
            <Document
              key={sampleId}
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
                  const size: SamplePage = {
                    rotation,
                    widthPt: sideways ? page.originalHeight : page.originalWidth,
                    heightPt: sideways ? page.originalWidth : page.originalHeight,
                  }
                  setCurrentPage(size)
                  if (page.pageNumber === 1) setFirstPage(size)
                  setRendered({ width: page.width, height: page.height })
                }}
              />
            </Document>

            {rendered && key
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
