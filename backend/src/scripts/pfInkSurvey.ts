/**
 * READ-ONLY. How many PF forms arrived already carrying an employee signature?
 *
 * IN THIS ORDER:
 *
 *   1. npm run pf-ink-survey -- --document 6242
 *      One form that is known to carry a signature where the old box was. It
 *      prints every image on each page - its position, the ink inside it, and
 *      how much of each current box it covers - so where the signature REALLY
 *      sits comes from the document, not from any history.
 *
 *   2. npm run pf-ink-survey -- --old-p1 x,y,width,height
 *      The survey, with the old page-1 box set from what step 1 showed.
 *      Add --ids for every group's document ids, --csv for one line per
 *      document (redirect it to a file yourself).
 *
 * Why it exists. The page-1 employee box on Form 2 (the two-page PF form) was
 * moved after it read '33% occupied' on a document whose box sat over an empty
 * PHOTO placeholder. On other forms that reading was a REAL signature already
 * on the upload, and with the box moved the stamp put a second one beside it
 * (document 6242). Image coverage could not tell the two apart - both 33% - and
 * on a digital page the stamping check never measures ink once an image is
 * found. This measures ink, which can: a blank placeholder is white.
 *
 * For every PF_FORM document with a file it reads the ORIGINAL upload - never
 * the signed copy, which carries our own stamps - and measures, on Form 2:
 *
 *   page 1, the employee box where it was BEFORE the move
 *   page 1, the employee box where it is now
 *   page 2, the employee box (never moved)
 *
 * reporting each box's ink, the largest share of it any image covers, and
 * whether DMS has stamped an employee signature on that page. Grouped by ink
 * into blank / unclear / something, with the range of readings in each.
 *
 * WHERE THE OLD BOX COMES FROM: --old-p1, and nowhere else. The template
 * editor replaces a variant's rows, so the old box is not in
 * DocumentTypePlacements and was never in git. SignaturePlacements records
 * every rectangle DMS stamped into - but the PF forms were stamped AFTER the
 * move, so those all carry the new box and there is nothing older to find.
 * The survey lists whatever page-1 rectangles it does find, as information,
 * and never picks one: without --old-p1 it refuses rather than guess.
 *
 * IT WRITES NOTHING. Every statement is a SELECT; files are read, never
 * written; no decision is recorded and no status moves. It does not use the
 * stamping runner, so it does not need PF_FORM in AUTO_STAMP_TYPES. It names
 * no employee - document ids only, which is what the office pastes into a
 * message.
 *
 * Flags:
 *   --ids            list the document ids in every group (by default only the
 *                    groups that carry something, and the doubled ones)
 *   --document <id>  one document in full: every image on each page with its
 *                    position, its ink and how much of each box it covers -
 *                    where a signature sits, and why a box read as it did.
 *                    Needs no --old-p1.
 *   --old-p1 x,y,w,h the old page-1 box, as fractions of the page. Required
 *                    for the survey; taken from step 1
 *   --csv            one line per document instead of the summary
 *   --limit <n>      at most n documents (default: all)
 */
import { SIGNER_ROLES, type NormalizedRect } from '@asps-dms/shared'
import { closePool, createRequest, sql } from '../database/pool.js'
import * as documentTypePlacementRepository from '../repositories/documentTypePlacement.repository.js'
import {
  boxCoverage,
  imagesOnPage,
  inkFraction,
  settingsFromEnv,
  toGrey,
  type PageImage,
} from '../services/boxOccupancy.service.js'
import { openPdf, renderPage } from '../services/pdfRaster.service.js'
import * as storage from '../services/storage.service.js'
import { describeError } from '../utils/errors.js'

function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg?.startsWith('--')) {
      const next = argv[i + 1]
      const value = next && !next.startsWith('--') ? next : 'true'
      flags.set(arg.slice(2), value)
      if (value !== 'true') i += 1
    }
  }
  return flags
}

const round = (value: number, places = 4): number => Math.round(value * 10 ** places) / 10 ** places
const rectText = (rect: NormalizedRect): string =>
  `x=${round(rect.x)} y=${round(rect.y)} w=${round(rect.width)} h=${round(rect.height)}`

function readRect(text: string): NormalizedRect {
  const parts = text.split(',').map((part) => Number(part.trim()))
  const [x, y, width, height] = parts
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
    x === undefined || y === undefined || width === undefined || height === undefined ||
    width <= 0 || height <= 0
  ) {
    throw new Error('--old-p1 must be four fractions of the page: x,y,width,height')
  }
  return { x, y, width, height }
}

/* -------------------------------------------------------------------------- */
/* What is read                                                                */
/* -------------------------------------------------------------------------- */

interface PfDocument {
  documentId: number
  originalFilePath: string
  mimeType: string | null
  pageCount: number | null
}

async function pfTypeId(): Promise<number> {
  const result = await (await createRequest()).query<{ DocumentTypeId: number }>(
    "SELECT DocumentTypeId FROM dbo.DocumentTypes WHERE DocumentCode = 'PF_FORM'",
  )
  const id = result.recordset[0]?.DocumentTypeId
  if (!id) throw new Error('There is no PF_FORM document type.')
  return id
}

async function pfDocuments(typeId: number, limit: number | null, only: number | null): Promise<PfDocument[]> {
  const request = (await createRequest())
    .input('typeId', sql.Int, typeId)
    .input('documentId', sql.Int, only)
  const result = await request.query<{
    DocumentId: number
    OriginalFilePath: string
    MimeType: string | null
    PageCount: number | null
  }>(`
      SELECT d.DocumentId, d.OriginalFilePath, d.MimeType, d.PageCount
      FROM   dbo.EmployeeDocuments AS d
      WHERE  d.DocumentTypeId = @typeId
        AND  d.IsActive = 1
        AND  d.OriginalFilePath IS NOT NULL
        AND  (@documentId IS NULL OR d.DocumentId = @documentId)
      ORDER BY d.DocumentId`)
  const rows = result.recordset.map((row) => ({
    documentId: row.DocumentId,
    originalFilePath: row.OriginalFilePath,
    mimeType: row.MimeType,
    pageCount: row.PageCount,
  }))
  return limit === null ? rows : rows.slice(0, limit)
}

interface StampedRect {
  rect: NormalizedRect
  documents: number
  firstAt: Date
  lastAt: Date
}

/** Every distinct page-1 employee rectangle DMS stamped on a two-page PF form. */
async function stampedPageOneRects(typeId: number): Promise<StampedRect[]> {
  const result = await (await createRequest()).input('typeId', sql.Int, typeId).query<{
    X: number
    Y: number
    Width: number
    Height: number
    Documents: number
    FirstAt: Date
    LastAt: Date
  }>(`
      SELECT ROUND(p.X, 4) AS X, ROUND(p.Y, 4) AS Y,
             ROUND(p.Width, 4) AS Width, ROUND(p.Height, 4) AS Height,
             COUNT(DISTINCT p.DocumentId) AS Documents,
             MIN(p.CreatedAt) AS FirstAt, MAX(p.CreatedAt) AS LastAt
      FROM   dbo.SignaturePlacements AS p
      INNER JOIN dbo.EmployeeDocuments AS d ON d.DocumentId = p.DocumentId
      WHERE  d.DocumentTypeId = @typeId
        AND  d.PageCount = 2
        AND  p.PageNumber = 1
        AND  p.SignerRole = 'Employee'
        AND  p.Method = 'Automatic'
        AND  p.DetectionMethod = 'Template'
      GROUP BY ROUND(p.X, 4), ROUND(p.Y, 4), ROUND(p.Width, 4), ROUND(p.Height, 4)
      ORDER BY COUNT(DISTINCT p.DocumentId) DESC`)
  return result.recordset.map((row) => ({
    rect: { x: row.X, y: row.Y, width: row.Width, height: row.Height },
    documents: row.Documents,
    firstAt: row.FirstAt,
    lastAt: row.LastAt,
  }))
}

/** The pages on which DMS has stamped an employee signature, per document. */
async function stampedEmployeePages(typeId: number): Promise<Map<number, Set<number>>> {
  const result = await (await createRequest()).input('typeId', sql.Int, typeId).query<{
    DocumentId: number
    PageNumber: number
  }>(`
      SELECT DISTINCT p.DocumentId, p.PageNumber
      FROM   dbo.SignaturePlacements AS p
      INNER JOIN dbo.EmployeeDocuments AS d ON d.DocumentId = p.DocumentId
      WHERE  d.DocumentTypeId = @typeId AND p.SignerRole = 'Employee' AND d.IsActive = 1`)
  const pages = new Map<number, Set<number>>()
  for (const row of result.recordset) {
    const set = pages.get(row.DocumentId) ?? new Set<number>()
    set.add(row.PageNumber)
    pages.set(row.DocumentId, set)
  }
  return pages
}

/* -------------------------------------------------------------------------- */
/* What is measured                                                            */
/* -------------------------------------------------------------------------- */

type Reading = 'blank' | 'unclear' | 'something'

interface BoxReading {
  ink: number
  /** The largest share of the box any one image covers, 0 to 1. */
  imageCoverage: number
  images: number
  reading: Reading
}

interface DocumentReading {
  documentId: number
  pageKinds: [string, string]
  oldP1: BoxReading
  nowP1: BoxReading
  p2: BoxReading
  stampedP1: boolean
  stampedP2: boolean
}

const settings = settingsFromEnv()

function readingOf(inkPercent: number): Reading {
  const fraction = inkPercent / 100
  if (fraction <= settings.inkEmptyMax) return 'blank'
  if (fraction >= settings.inkOccupiedMin) return 'something'
  return 'unclear'
}

function measure(
  box: NormalizedRect,
  grey: Awaited<ReturnType<typeof toGrey>>,
  images: readonly PageImage[],
): BoxReading {
  const ink = inkFraction(grey, box, settings).percent
  const covering = images.map((image) => boxCoverage(box, image.rect)).filter((c) => c > 0)
  return {
    ink,
    imageCoverage: covering.length === 0 ? 0 : Math.max(...covering),
    images: covering.length,
    reading: readingOf(ink),
  }
}

interface PageRead {
  kind: string
  images: PageImage[]
  grey: Awaited<ReturnType<typeof toGrey>>
}

async function readPages(file: Buffer): Promise<[PageRead, PageRead]> {
  const pdf = await openPdf(file)
  try {
    const pages: PageRead[] = []
    for (const pageNumber of [1, 2]) {
      const page = await pdf.getPage(pageNumber)
      const all = await imagesOnPage(page)
      const background = all.filter((image) => image.pageFraction >= settings.fullPageMin)
      pages.push({
        kind: background.length > 0 ? 'scanned' : 'digital',
        // As the stamping check sees them: a scan's full-page background is not a mark.
        images: all.filter((image) => image.pageFraction < settings.fullPageMin),
        grey: await toGrey(await renderPage(page)),
      })
    }
    return pages as [PageRead, PageRead]
  } finally {
    await pdf.destroy()
  }
}

/* -------------------------------------------------------------------------- */
/* What is printed                                                             */
/* -------------------------------------------------------------------------- */

function stats(values: readonly number[]): string {
  if (values.length === 0) return ''
  const sorted = [...values].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  return `ink ${(sorted[0] ?? 0).toFixed(2)}-${(sorted.at(-1) ?? 0).toFixed(2)}%, median ${median.toFixed(2)}%`
}

function printBox(
  title: string,
  readings: DocumentReading[],
  pick: (r: DocumentReading) => BoxReading,
  stamped: ((r: DocumentReading) => boolean) | null,
  listIds: boolean,
): void {
  console.log(`\n${title}`)
  for (const group of ['blank', 'unclear', 'something'] as const) {
    const inGroup = readings.filter((r) => pick(r).reading === group)
    const withImage = inGroup.filter((r) => pick(r).imageCoverage > 0)
    const line =
      `  ${group.padEnd(10)} ${String(inGroup.length).padStart(5)}` +
      (inGroup.length > 0 ? `   ${stats(inGroup.map((r) => pick(r).ink))}` : '') +
      (inGroup.length > 0 ? `;  an image on the box in ${withImage.length}` : '')
    console.log(line)
    if (inGroup.length > 0 && (listIds || group === 'something')) {
      console.log(`             ${inGroup.map((r) => r.documentId).join(' ')}`)
    }
    if (stamped && group === 'something') {
      // Something on the upload AND a DMS employee signature on the same page:
      // the documents that may now carry two.
      const doubled = inGroup.filter(stamped)
      console.log(
        `             of which also carry a DMS employee signature on this page ` +
          `(stamped, or placed by hand): ${doubled.length}`,
      )
      if (doubled.length > 0) console.log(`             ${doubled.map((r) => r.documentId).join(' ')}`)
    }
  }
}

async function detail(
  document: PfDocument,
  boxes: { oldP1: NormalizedRect | null; nowP1: NormalizedRect; p2: NormalizedRect },
) {
  const file = await storage.readStoredFile(document.originalFilePath)
  const pages = await readPages(file)
  console.log(`#${document.documentId}  ${document.pageCount} page(s)  ${document.mimeType ?? '?'}  (the ORIGINAL upload)`)
  const show = (label: string, page: PageRead, box: NormalizedRect) => {
    const r = measure(box, page.grey, page.images)
    const ink = inkFraction(page.grey, box, settings)
    console.log(
      `  ${label}: ${rectText(box)}\n` +
        `    ink ${r.ink.toFixed(2)}% (background ${ink.background}, cut-off ${ink.cutoff}) -> ${r.reading}\n` +
        `    largest image coverage ${(r.imageCoverage * 100).toFixed(1)}% of the box ` +
        `(stamping refuses at ${(settings.overlapMin * 100).toFixed(0)}% on a digital page; it never measures ink there)`,
    )
  }
  for (const [index, page] of pages.entries()) {
    console.log(`\n page ${index + 1}: ${page.kind}, ${page.images.length} image(s)`)
    for (const image of page.images) {
      const covers = [
        index === 0 && boxes.oldP1
          ? ` old p1 box ${(boxCoverage(boxes.oldP1, image.rect) * 100).toFixed(1)}%`
          : '',
        index === 0 ? ` p1 box now ${(boxCoverage(boxes.nowP1, image.rect) * 100).toFixed(1)}%` : '',
        index === 1 ? ` p2 box ${(boxCoverage(boxes.p2, image.rect) * 100).toFixed(1)}%` : '',
      ].join('')
      // The ink inside the image itself: a blank placeholder is white, a
      // signature is not - which is what coverage alone cannot say.
      const ownInk = inkFraction(page.grey, image.rect, settings).percent
      console.log(
        `    ${image.kind} at ${rectText(image.rect)}\n` +
          `      ink inside it ${ownInk.toFixed(2)}%; covers${covers}` +
          (index === 0
            ? `\n      as --old-p1: ${[image.rect.x, image.rect.y, image.rect.width, image.rect.height].map((n) => round(n)).join(',')}`
            : ''),
      )
    }
    if (index === 0) {
      if (boxes.oldP1) show('old p1 box', page, boxes.oldP1)
      show('p1 box now', page, boxes.nowP1)
    } else {
      show('p2 box', page, boxes.p2)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * pdf.js reports every font it cannot find through console.log - hundreds of
 * lines across a few hundred forms, burying the answer. They say nothing
 * about a box's ink, so they are dropped here, in this command only.
 */
function quietPdfjs(): void {
  const log = console.log.bind(console)
  console.log = (...args: unknown[]) => {
    const first = args[0]
    if (typeof first === 'string' && first.startsWith('Warning: ')) return
    log(...args)
  }
}

async function main(): Promise<void> {
  quietPdfjs()
  const flags = readFlags(process.argv.slice(2))
  const limitText = flags.get('limit')
  const limit = limitText ? Number(limitText) : null
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a whole number')
  const onlyText = flags.get('document')
  const only = onlyText ? Number(onlyText) : null
  if (only !== null && !Number.isInteger(only)) throw new Error('--document must be a document id')
  const csv = flags.has('csv')
  const say = (line: string) => {
    if (!csv) console.log(line)
  }

  const typeId = await pfTypeId()
  const template = (await documentTypePlacementRepository.listForType(typeId)).filter(
    (row) => row.variant.pageCount === 2 && row.signerRole === SIGNER_ROLES.EMPLOYEE,
  )
  const nowRow = template.find((row) => row.pageNumber === 1)
  const p2Row = template.find((row) => row.pageNumber === 2)
  if (!nowRow || !p2Row) throw new Error('The two-page PF template has no employee box on page 1 and page 2.')
  const nowP1 = { x: nowRow.x, y: nowRow.y, width: nowRow.width, height: nowRow.height }
  const p2 = { x: p2Row.x, y: p2Row.y, width: p2Row.width, height: p2Row.height }

  // The old box comes from --old-p1 and nowhere else. The stamped rectangles
  // are listed as information only: the PF forms were stamped after the move,
  // so they carry the new box, and anything else found there is not known to
  // be the old one. Choosing one would be a guess presented as a finding.
  const stampedRects = await stampedPageOneRects(typeId)
  const same = (a: NormalizedRect, b: NormalizedRect) =>
    Math.abs(a.x - b.x) < 0.0005 && Math.abs(a.y - b.y) < 0.0005 &&
    Math.abs(a.width - b.width) < 0.0005 && Math.abs(a.height - b.height) < 0.0005
  const oldFlag = flags.get('old-p1')
  const oldP1 = oldFlag ? readRect(oldFlag) : null

  say('PF_FORM ink survey - READ-ONLY. Reads each ORIGINAL upload; writes nothing.\n')
  say('Page-1 employee rectangles DMS has stamped on two-page PF forms (newest write per document),')
  say('for information - none is taken as the old box:')
  if (stampedRects.length === 0) say('  none')
  for (const s of stampedRects) {
    say(
      `  ${rectText(s.rect)}  ${String(s.documents).padStart(5)} document(s), ` +
        `${s.firstAt.toISOString()} to ${s.lastAt.toISOString()}` +
        `${same(s.rect, nowP1) ? '  <- the template now' : ''}`,
    )
  }
  const earlier = stampedRects.filter((s) => !same(s.rect, nowP1))
  say(
    earlier.length === 0
      ? '  No earlier rectangle found: every one is the template as it is now.'
      : `  ${earlier.length} rectangle(s) other than the current box - not known to be the old box.`,
  )

  if (only === null && !oldP1) {
    throw new Error(
      'The old page-1 box is not taken from the history (see above). Run --document on a form ' +
        'known to carry a signature there, then run the survey with --old-p1 x,y,width,height ' +
        'set from what it shows.',
    )
  }

  say(`\nBoxes measured (Form 2):`)
  say(
    oldP1
      ? `  page 1, old employee box:  ${rectText(oldP1)}  (from --old-p1)`
      : '  page 1, old employee box:  not given (--old-p1); not measured',
  )
  say(`  page 1, employee box now:  ${rectText(nowP1)}`)
  say(`  page 2, employee box:      ${rectText(p2)}`)
  say(
    `Groups: blank <= ${(settings.inkEmptyMax * 100).toFixed(1)}% ink, something >= ` +
      `${(settings.inkOccupiedMin * 100).toFixed(1)}%, unclear between (STAMP_INK_EMPTY_MAX / _OCCUPIED_MIN).`,
  )

  const documents = await pfDocuments(typeId, limit, only)
  if (only !== null) {
    const document = documents[0]
    if (!document) throw new Error(`#${only} is not a PF_FORM document with a file.`)
    console.log('')
    await detail(document, { oldP1, nowP1, p2 })
    return
  }
  // Checked above; restated for the reader and the compiler.
  if (!oldP1) return

  const stamped = await stampedEmployeePages(typeId)
  const readings: DocumentReading[] = []
  let onePage = 0
  let notPdf = 0
  const unreadable: number[] = []

  for (const [index, document] of documents.entries()) {
    if ((document.mimeType ?? 'application/pdf') !== 'application/pdf') {
      notPdf += 1
      continue
    }
    if (document.pageCount !== 2) {
      onePage += 1
      continue
    }
    try {
      const file = await storage.readStoredFile(document.originalFilePath)
      const [one, two] = await readPages(file)
      const pages = stamped.get(document.documentId) ?? new Set<number>()
      readings.push({
        documentId: document.documentId,
        pageKinds: [one.kind, two.kind],
        oldP1: measure(oldP1, one.grey, one.images),
        nowP1: measure(nowP1, one.grey, one.images),
        p2: measure(p2, two.grey, two.images),
        stampedP1: pages.has(1),
        stampedP2: pages.has(2),
      })
    } catch (error) {
      unreadable.push(document.documentId)
      if (!csv) console.error(`  #${document.documentId} could not be read: ${describeError(error)}`)
    }
    if (!csv && (index + 1) % 100 === 0) console.error(`  ... ${index + 1} of ${documents.length}`)
  }

  if (csv) {
    console.log(
      'documentId,page1Kind,page2Kind,oldP1Ink,oldP1ImageCoverage,nowP1Ink,nowP1ImageCoverage,' +
        'p2Ink,p2ImageCoverage,dmsEmployeeOnP1,dmsEmployeeOnP2',
    )
    for (const r of readings) {
      console.log(
        [
          r.documentId,
          r.pageKinds[0],
          r.pageKinds[1],
          r.oldP1.ink.toFixed(2),
          r.oldP1.imageCoverage.toFixed(3),
          r.nowP1.ink.toFixed(2),
          r.nowP1.imageCoverage.toFixed(3),
          r.p2.ink.toFixed(2),
          r.p2.imageCoverage.toFixed(3),
          r.stampedP1 ? 1 : 0,
          r.stampedP2 ? 1 : 0,
        ].join(','),
      )
    }
    return
  }

  const listIds = flags.has('ids')
  console.log(
    `\n${documents.length} PF_FORM document(s) with a file: ${readings.length} two-page measured, ` +
      `${onePage} one-page (Form 11) not measured, ${notPdf} not a PDF, ${unreadable.length} unreadable` +
      (unreadable.length > 0 ? ` (${unreadable.join(' ')})` : ''),
  )
  const scanned = readings.filter((r) => r.pageKinds.includes('scanned')).length
  if (scanned > 0) console.log(`  ${scanned} of them have a scanned page: ink there includes the scan itself.`)

  printBox('PAGE 1 - the OLD employee box (before the move)', readings, (r) => r.oldP1, (r) => r.stampedP1, listIds)
  printBox('PAGE 1 - the employee box NOW', readings, (r) => r.nowP1, null, listIds)
  printBox('PAGE 2 - the employee box (never moved)', readings, (r) => r.p2, (r) => r.stampedP2, listIds)

  console.log('\nBOTH: what the original carries at the old page-1 box and the page-2 box')
  const combos = new Map<string, number[]>()
  for (const r of readings) {
    const key = `page 1 ${r.oldP1.reading.padEnd(9)} / page 2 ${r.p2.reading}`
    combos.set(key, [...(combos.get(key) ?? []), r.documentId])
  }
  for (const [key, ids] of [...combos.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${key.padEnd(42)} ${String(ids.length).padStart(5)}`)
  }
}

main()
  .catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : describeError(error)}`)
    process.exitCode = 1
  })
  .finally(() => closePool())
