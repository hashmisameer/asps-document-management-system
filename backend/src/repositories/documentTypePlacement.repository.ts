import {
  IDENTITY_CARD_DOCUMENT_CODES,
  type DocumentTypePlacement,
  type DocumentTypeTemplateSummary,
  type SignerRole,
} from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.DocumentTypePlacements: where the boxes go on every document of a type.
 *
 * The template, as distinct from dbo.SignaturePlacements, which is the record
 * of what was actually stamped on each document. Nothing here reads or writes
 * that table, a document row, or a stored file.
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
    samplePageCount: row.SamplePageCount,
    sampleDocumentId: row.SampleDocumentId,
    createdByName: row.CreatedByName,
    createdAt: row.CreatedAt.toISOString(),
  }
}

const SELECT = `
      SELECT tp.DocumentTypePlacementId, tp.DocumentTypeId, tp.SignerRole, tp.PageNumber,
             tp.X, tp.Y, tp.Width, tp.Height, tp.PageRotation,
             tp.PageWidthPt, tp.PageHeightPt, tp.SamplePageCount, tp.SampleDocumentId,
             u.FullName AS CreatedByName, tp.CreatedAt
      FROM   dbo.DocumentTypePlacements AS tp
      LEFT JOIN dbo.Users AS u ON u.UserId = tp.CreatedBy`

export async function listForType(documentTypeId: number): Promise<DocumentTypePlacement[]> {
  const request = await createRequest()
  const result = await request.input('documentTypeId', sql.Int, documentTypeId).query<Row>(`
      ${SELECT}
      WHERE  tp.DocumentTypeId = @documentTypeId
      ORDER BY tp.PageNumber, tp.DocumentTypePlacementId`)
  return result.recordset.map(toRecord)
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
 * Replaces a type's template with exactly this set.
 *
 * Delete-then-insert in one transaction, as a document's placements are: a
 * template is one thing, and a failure cannot leave a type with half of one.
 * An empty set removes the template.
 */
export async function replaceForType(
  documentTypeId: number,
  boxes: readonly TemplateBox[],
  sample: { documentId: number | null; pageCount: number },
  createdBy: number,
): Promise<void> {
  const request = await createRequest()
  request
    .input('documentTypeId', sql.Int, documentTypeId)
    .input('sampleDocumentId', sql.Int, sample.documentId)
    .input('samplePageCount', sql.Int, sample.pageCount)
    .input('createdBy', sql.Int, createdBy)

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
      `@rot${index}, @pw${index}, @ph${index}, @samplePageCount, @sampleDocumentId, @createdBy)`
    )
  })

  // Parameter NAMES only; every value is bound.
  const VALUES_CLAUSE =
    tuples.length > 0
      ? `INSERT INTO dbo.DocumentTypePlacements
             (DocumentTypeId, SignerRole, PageNumber, X, Y, Width, Height, PageRotation,
              PageWidthPt, PageHeightPt, SamplePageCount, SampleDocumentId, CreatedBy)
         VALUES ${tuples.join(', ')};`
      : ''

  await request.query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;

      DELETE FROM dbo.DocumentTypePlacements WHERE DocumentTypeId = @documentTypeId;

      ${VALUES_CLAUSE}

      COMMIT TRANSACTION;`)
}

interface SummaryRow {
  DocumentTypeId: number
  DocumentName: string
  DocumentCode: string
  Boxes: number
  EmployeeBoxes: number
  AuthoriserBoxes: number
  PhotoBoxes: number
  Pages: number
  PageWidthPt: number | null
  PageHeightPt: number | null
  PageRotation: number | null
  SamplePageCount: number | null
  SampleDocumentId: number | null
  SampleEmployeeCode: string | null
  SetByName: string | null
  SetAt: Date | null
}

/**
 * Every active type with its template at a glance.
 *
 * One row per type, template or not: the list is the whole checklist, and a
 * type with nothing set up is the one the administrator is looking for. The
 * sample's page size is read from the first box, which is the same for every
 * box of one template.
 */
export async function summaries(): Promise<DocumentTypeTemplateSummary[]> {
  const request = await createRequest()
  const result = await request.query<SummaryRow>(`
      WITH agg AS (
          SELECT tp.DocumentTypeId,
                 COUNT(*) AS Boxes,
                 SUM(CASE WHEN tp.SignerRole = 'Employee'   THEN 1 ELSE 0 END) AS EmployeeBoxes,
                 SUM(CASE WHEN tp.SignerRole = 'Authoriser' THEN 1 ELSE 0 END) AS AuthoriserBoxes,
                 SUM(CASE WHEN tp.SignerRole = 'Photo'      THEN 1 ELSE 0 END) AS PhotoBoxes,
                 COUNT(DISTINCT tp.PageNumber) AS Pages,
                 MIN(tp.PageWidthPt)      AS PageWidthPt,
                 MIN(tp.PageHeightPt)     AS PageHeightPt,
                 MIN(tp.PageRotation)     AS PageRotation,
                 MIN(tp.SamplePageCount)  AS SamplePageCount,
                 MIN(tp.SampleDocumentId) AS SampleDocumentId,
                 MIN(tp.CreatedBy)        AS SetBy,
                 MAX(tp.CreatedAt)        AS SetAt
          FROM   dbo.DocumentTypePlacements AS tp
          GROUP BY tp.DocumentTypeId
      )
      SELECT dt.DocumentTypeId, dt.DocumentName, dt.DocumentCode,
             ISNULL(agg.Boxes, 0)           AS Boxes,
             ISNULL(agg.EmployeeBoxes, 0)   AS EmployeeBoxes,
             ISNULL(agg.AuthoriserBoxes, 0) AS AuthoriserBoxes,
             ISNULL(agg.PhotoBoxes, 0)      AS PhotoBoxes,
             ISNULL(agg.Pages, 0)           AS Pages,
             agg.PageWidthPt, agg.PageHeightPt, agg.PageRotation,
             agg.SamplePageCount, agg.SampleDocumentId,
             e.EmployeeCode AS SampleEmployeeCode,
             u.FullName     AS SetByName,
             agg.SetAt
      FROM   dbo.DocumentTypes AS dt
      LEFT JOIN agg ON agg.DocumentTypeId = dt.DocumentTypeId
      LEFT JOIN dbo.EmployeeDocuments AS d ON d.DocumentId = agg.SampleDocumentId
      LEFT JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
      LEFT JOIN dbo.Users AS u ON u.UserId = agg.SetBy
      WHERE  dt.IsActive = 1
      ORDER BY dt.SortOrder`)

  const scanned = new Set<string>(IDENTITY_CARD_DOCUMENT_CODES)

  return result.recordset.map((row) => ({
    documentTypeId: row.DocumentTypeId,
    documentName: row.DocumentName,
    documentCode: row.DocumentCode,
    status: scanned.has(row.DocumentCode) ? 'scanned' : row.Boxes > 0 ? 'set' : 'unset',
    boxes: row.Boxes,
    roles: {
      ...(row.EmployeeBoxes ? { Employee: row.EmployeeBoxes } : {}),
      ...(row.AuthoriserBoxes ? { Authoriser: row.AuthoriserBoxes } : {}),
      ...(row.PhotoBoxes ? { Photo: row.PhotoBoxes } : {}),
    },
    pages: row.Pages,
    pageWidthPt: row.PageWidthPt,
    pageHeightPt: row.PageHeightPt,
    pageRotation: row.PageRotation,
    samplePageCount: row.SamplePageCount,
    sampleDocumentId: row.SampleDocumentId,
    sampleEmployeeCode: row.SampleEmployeeCode,
    setByName: row.SetByName,
    setAt: row.SetAt ? row.SetAt.toISOString() : null,
  }))
}
