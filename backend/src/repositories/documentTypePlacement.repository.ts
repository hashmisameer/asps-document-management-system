import {
  IDENTITY_CARD_DOCUMENT_CODES,
  sameVariant,
  variantKey,
  type DocumentTypePlacement,
  type DocumentTypeTemplateSummary,
  type SignerRole,
  type TemplateVariant,
  type TemplateVariantSummary,
} from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.DocumentTypePlacements: where the boxes go on every document of a type.
 *
 * The template, as distinct from dbo.SignaturePlacements, which is the record
 * of what was actually stamped on each document. Nothing here reads or writes
 * that table, a document row, or a stored file.
 *
 * A type holds one template PER VARIANT - the sample's page count and
 * first-page size - because one checklist entry can be two pieces of paper.
 * Every row carries its variant, and a save replaces one variant's rows and
 * leaves the others alone.
 */

interface Row {
  DocumentTypePlacementId: number
  DocumentTypeId: number
  SignerRole: string
  PageNumber: number
  X: number
  Y: number
  Width: number
  Height: number
  PageRotation: number
  PageWidthPt: number
  PageHeightPt: number
  SamplePageCount: number
  SampleWidthPt: number
  SampleHeightPt: number
  SampleDocumentId: number | null
  CreatedByName: string | null
  CreatedAt: Date
}

function toRecord(row: Row): DocumentTypePlacement {
  return {
    documentTypePlacementId: row.DocumentTypePlacementId,
    documentTypeId: row.DocumentTypeId,
    signerRole: row.SignerRole as SignerRole,
    pageNumber: row.PageNumber,
    x: row.X,
    y: row.Y,
    width: row.Width,
    height: row.Height,
    pageRotation: row.PageRotation,
    pageWidthPt: row.PageWidthPt,
    pageHeightPt: row.PageHeightPt,
    variant: {
      pageCount: row.SamplePageCount,
      widthPt: row.SampleWidthPt,
      heightPt: row.SampleHeightPt,
    },
    sampleDocumentId: row.SampleDocumentId,
    createdByName: row.CreatedByName,
    createdAt: row.CreatedAt.toISOString(),
  }
}

const SELECT = `
      SELECT tp.DocumentTypePlacementId, tp.DocumentTypeId, tp.SignerRole, tp.PageNumber,
             tp.X, tp.Y, tp.Width, tp.Height, tp.PageRotation,
             tp.PageWidthPt, tp.PageHeightPt,
             tp.SamplePageCount, tp.SampleWidthPt, tp.SampleHeightPt, tp.SampleDocumentId,
             u.FullName AS CreatedByName, tp.CreatedAt
      FROM   dbo.DocumentTypePlacements AS tp
      LEFT JOIN dbo.Users AS u ON u.UserId = tp.CreatedBy`

/** Every box of every variant of a type, in page order within each variant. */
export async function listForType(documentTypeId: number): Promise<DocumentTypePlacement[]> {
  const request = await createRequest()
  const result = await request.input('documentTypeId', sql.Int, documentTypeId).query<Row>(`
      ${SELECT}
      WHERE  tp.DocumentTypeId = @documentTypeId
      ORDER BY tp.SamplePageCount, tp.SampleWidthPt, tp.SampleHeightPt,
               tp.PageNumber, tp.DocumentTypePlacementId`)
  return result.recordset.map(toRecord)
}

function bindVariant(request: sql.Request, variant: TemplateVariant): sql.Request {
  return request
    .input('samplePageCount', sql.Int, variant.pageCount)
    .input('sampleWidthPt', sql.Int, variant.widthPt)
    .input('sampleHeightPt', sql.Int, variant.heightPt)
}

/**
 * The saved variants of a type that are the same SHAPE as this one.
 *
 * Matched in code, not in SQL: a shape is a proportion within a tolerance,
 * and the rows only record the sample's exact size. Templates saved when the
 * key was the exact size are read the same way, so a template drawn on
 * 595x842 covers every A4-shaped page without being touched.
 *
 * Usually one or none. More than one means two templates saved under the old
 * exact-size key have become one shape - a save replaces them all, which is
 * the right thing: they were always one form.
 */
async function sameShapeVariants(
  documentTypeId: number,
  variant: TemplateVariant,
): Promise<TemplateVariant[]> {
  const rows = await listForType(documentTypeId)
  const seen = new Map<string, TemplateVariant>()
  for (const row of rows) {
    if (sameVariant(row.variant, variant)) {
      seen.set(
        `${row.variant.pageCount}-${row.variant.widthPt}-${row.variant.heightPt}`,
        row.variant,
      )
    }
  }
  return Array.from(seen.values())
}

/** Whether a type already has a template for this shape - what a save would replace. */
export async function variantExists(
  documentTypeId: number,
  variant: TemplateVariant,
): Promise<boolean> {
  return (await sameShapeVariants(documentTypeId, variant)).length > 0
}

export interface TemplateBox {
  signerRole: SignerRole
  pageNumber: number
  x: number
  y: number
  width: number
  height: number
  pageRotation: number
  pageWidthPt: number
  pageHeightPt: number
}

/**
 * Replaces ONE SHAPE of a type's template with exactly this set.
 *
 * Delete-then-insert in one transaction, as a document's placements are: a
 * template is one thing, and a failure cannot leave a shape with half of one.
 * Every saved variant of the same shape goes - found in code, deleted by its
 * exact sample key - and the other shapes of the type are not touched. An
 * empty set removes the shape.
 */
export async function replaceForVariant(
  documentTypeId: number,
  variant: TemplateVariant,
  boxes: readonly TemplateBox[],
  sampleDocumentId: number | null,
  createdBy: number,
): Promise<void> {
  const replaced = await sameShapeVariants(documentTypeId, variant)

  const request = bindVariant(await createRequest(), variant)
  request
    .input('documentTypeId', sql.Int, documentTypeId)
    .input('sampleDocumentId', sql.Int, sampleDocumentId)
    .input('createdBy', sql.Int, createdBy)

  // The saved variants this shape replaces, each by its own exact key. Names
  // only in the SQL; every value is bound.
  const deletePredicates = replaced.map((old, index) => {
    request
      .input(`oldPages${index}`, sql.Int, old.pageCount)
      .input(`oldW${index}`, sql.Int, old.widthPt)
      .input(`oldH${index}`, sql.Int, old.heightPt)
    return `(SamplePageCount = @oldPages${index} AND SampleWidthPt = @oldW${index} AND SampleHeightPt = @oldH${index})`
  })
  const DELETE_CLAUSE =
    deletePredicates.length > 0
      ? `DELETE FROM dbo.DocumentTypePlacements
         WHERE DocumentTypeId = @documentTypeId AND (${deletePredicates.join(' OR ')});`
      : ''

  const tuples = boxes.map((box, index) => {
    request
      .input(`role${index}`, sql.VarChar(20), box.signerRole)
      .input(`page${index}`, sql.Int, box.pageNumber)
      .input(`x${index}`, sql.Float, box.x)
      .input(`y${index}`, sql.Float, box.y)
      .input(`w${index}`, sql.Float, box.width)
      .input(`h${index}`, sql.Float, box.height)
      .input(`rot${index}`, sql.Int, box.pageRotation)
      .input(`pw${index}`, sql.Float, box.pageWidthPt)
      .input(`ph${index}`, sql.Float, box.pageHeightPt)
    return (
      `(@documentTypeId, @role${index}, @page${index}, @x${index}, @y${index}, @w${index}, @h${index}, ` +
      `@rot${index}, @pw${index}, @ph${index}, @samplePageCount, @sampleWidthPt, @sampleHeightPt, ` +
      `@sampleDocumentId, @createdBy)`
    )
  })

  // Parameter NAMES only; every value is bound.
  const VALUES_CLAUSE =
    tuples.length > 0
      ? `INSERT INTO dbo.DocumentTypePlacements
             (DocumentTypeId, SignerRole, PageNumber, X, Y, Width, Height, PageRotation,
              PageWidthPt, PageHeightPt, SamplePageCount, SampleWidthPt, SampleHeightPt,
              SampleDocumentId, CreatedBy)
         VALUES ${tuples.join(', ')};`
      : ''

  await request.query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;

      ${DELETE_CLAUSE}

      ${VALUES_CLAUSE}

      COMMIT TRANSACTION;`)
}

interface SummaryRow {
  DocumentTypeId: number
  DocumentName: string
  DocumentCode: string
  SamplePageCount: number | null
  SampleWidthPt: number | null
  SampleHeightPt: number | null
  Boxes: number | null
  EmployeeBoxes: number | null
  AuthoriserBoxes: number | null
  PhotoBoxes: number | null
  Pages: number | null
  PageRotation: number | null
  SampleDocumentId: number | null
  SampleEmployeeCode: string | null
  SetByName: string | null
  SetAt: Date | null
}

/**
 * Every active type with each of its variants at a glance.
 *
 * One row per (type, variant), and one row for a type with none: the list is
 * the whole checklist, and a type with nothing set up is the one the
 * administrator is looking for. Folded into one summary per type here.
 */
export async function summaries(): Promise<DocumentTypeTemplateSummary[]> {
  const request = await createRequest()
  const result = await request.query<SummaryRow>(`
      WITH agg AS (
          SELECT tp.DocumentTypeId, tp.SamplePageCount, tp.SampleWidthPt, tp.SampleHeightPt,
                 COUNT(*) AS Boxes,
                 SUM(CASE WHEN tp.SignerRole = 'Employee'   THEN 1 ELSE 0 END) AS EmployeeBoxes,
                 SUM(CASE WHEN tp.SignerRole = 'Authoriser' THEN 1 ELSE 0 END) AS AuthoriserBoxes,
                 SUM(CASE WHEN tp.SignerRole = 'Photo'      THEN 1 ELSE 0 END) AS PhotoBoxes,
                 COUNT(DISTINCT tp.PageNumber) AS Pages,
                 MIN(tp.PageRotation)     AS PageRotation,
                 MIN(tp.SampleDocumentId) AS SampleDocumentId,
                 MIN(tp.CreatedBy)        AS SetBy,
                 MAX(tp.CreatedAt)        AS SetAt
          FROM   dbo.DocumentTypePlacements AS tp
          GROUP BY tp.DocumentTypeId, tp.SamplePageCount, tp.SampleWidthPt, tp.SampleHeightPt
      )
      SELECT dt.DocumentTypeId, dt.DocumentName, dt.DocumentCode,
             agg.SamplePageCount, agg.SampleWidthPt, agg.SampleHeightPt,
             agg.Boxes, agg.EmployeeBoxes, agg.AuthoriserBoxes, agg.PhotoBoxes, agg.Pages,
             agg.PageRotation, agg.SampleDocumentId,
             e.EmployeeCode AS SampleEmployeeCode,
             u.FullName     AS SetByName,
             agg.SetAt
      FROM   dbo.DocumentTypes AS dt
      LEFT JOIN agg ON agg.DocumentTypeId = dt.DocumentTypeId
      LEFT JOIN dbo.EmployeeDocuments AS d ON d.DocumentId = agg.SampleDocumentId
      LEFT JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
      LEFT JOIN dbo.Users AS u ON u.UserId = agg.SetBy
      WHERE  dt.IsActive = 1
      ORDER BY dt.SortOrder, agg.SamplePageCount, agg.SampleWidthPt, agg.SampleHeightPt`)

  const scanned = new Set<string>(IDENTITY_CARD_DOCUMENT_CODES)
  const byType = new Map<number, DocumentTypeTemplateSummary>()

  for (const row of result.recordset) {
    let summary = byType.get(row.DocumentTypeId)
    if (!summary) {
      summary = {
        documentTypeId: row.DocumentTypeId,
        documentName: row.DocumentName,
        documentCode: row.DocumentCode,
        status: scanned.has(row.DocumentCode) ? 'scanned' : 'unset',
        variants: [],
      }
      byType.set(row.DocumentTypeId, summary)
    }
    if (row.SamplePageCount === null || row.SampleWidthPt === null || row.SampleHeightPt === null) {
      continue
    }
    const variant: TemplateVariantSummary = {
      variant: {
        pageCount: row.SamplePageCount,
        widthPt: row.SampleWidthPt,
        heightPt: row.SampleHeightPt,
      },
      pageRotation: row.PageRotation ?? 0,
      boxes: row.Boxes ?? 0,
      roles: {
        ...(row.EmployeeBoxes ? { Employee: row.EmployeeBoxes } : {}),
        ...(row.AuthoriserBoxes ? { Authoriser: row.AuthoriserBoxes } : {}),
        ...(row.PhotoBoxes ? { Photo: row.PhotoBoxes } : {}),
      },
      pages: row.Pages ?? 0,
      sampleDocumentId: row.SampleDocumentId,
      sampleEmployeeCode: row.SampleEmployeeCode,
      setByName: row.SetByName,
      setAt: row.SetAt ? row.SetAt.toISOString() : null,
    }
    summary.variants.push(variant)
    if (summary.status === 'unset') summary.status = 'set'
  }

  // A defensive de-duplication: the GROUP BY makes variants distinct already,
  // and the key is what the screen and the stamper compare on.
  for (const summary of byType.values()) {
    const seen = new Set<string>()
    summary.variants = summary.variants.filter((v) => {
      const key = variantKey(v.variant)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  return [...byType.values()]
}
