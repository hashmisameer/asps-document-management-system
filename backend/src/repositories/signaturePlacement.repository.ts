import type {
  DetectionMethod,
  PlacementMethod,
  SignaturePlacement,
  SignerRole,
} from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.SignaturePlacements access.
 *
 * Coordinates are normalized 0..1 in displayed page space with a top-left
 * origin, and PageRotation travels with them - see docs/coordinate-system.md.
 * No pixel, DPI or zoom value is ever written here, which is what makes a
 * placement mean the same thing on a laptop screen and in the stamped output.
 */

interface PlacementRow {
  SignaturePlacementId: number
  DocumentId: number
  EmployeeId: number
  PageNumber: number
  X: number
  Y: number
  Width: number
  Height: number
  PageRotation: number
  Method: string
  DetectionMethod: string
  Confidence: number | null
  SignerRole: string
  SignerUserId: number | null
  SignerName: string | null
  IsApplied: boolean
  CreatedAt: Date
  UpdatedAt: Date
}

function toRecord(row: PlacementRow): SignaturePlacement {
  return {
    signaturePlacementId: row.SignaturePlacementId,
    documentId: row.DocumentId,
    employeeId: row.EmployeeId,
    pageNumber: row.PageNumber,
    x: row.X,
    y: row.Y,
    width: row.Width,
    height: row.Height,
    pageRotation: row.PageRotation,
    method: row.Method as PlacementMethod,
    detectionMethod: row.DetectionMethod as DetectionMethod,
    confidence: row.Confidence,
    signerRole: row.SignerRole as SignerRole,
    signerUserId: row.SignerUserId,
    signerName: row.SignerName,
    isApplied: row.IsApplied,
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  }
}

export async function listForDocument(documentId: number): Promise<SignaturePlacement[]> {
  const request = await createRequest()
  const result = await request.input('documentId', sql.Int, documentId).query<PlacementRow>(`
      SELECT sp.SignaturePlacementId, sp.DocumentId, sp.EmployeeId, sp.PageNumber,
             sp.X, sp.Y, sp.Width, sp.Height, sp.PageRotation, sp.Method,
             sp.DetectionMethod, sp.Confidence, sp.SignerRole, sp.SignerUserId,
             u.FullName AS SignerName,
             sp.IsApplied, sp.CreatedAt, sp.UpdatedAt
      FROM   dbo.SignaturePlacements AS sp
      LEFT JOIN dbo.Users AS u ON u.UserId = sp.SignerUserId
      WHERE  sp.DocumentId = @documentId
      ORDER BY sp.PageNumber, sp.SignaturePlacementId`)

  return result.recordset.map(toRecord)
}

export interface PlacementRecord {
  pageNumber: number
  x: number
  y: number
  width: number
  height: number
  pageRotation: number
  method: PlacementMethod
  detectionMethod: DetectionMethod
  confidence: number | null
  signerRole: SignerRole
  /** Set for an 'Authoriser' box and null for an 'Employee' one - the database
      enforces both halves of that with CK_SigPlace_SignerUser. */
  signerUserId: number | null
}

/**
 * Replaces a document's placements with exactly this set.
 *
 * Delete-then-insert rather than a merge, because the processed PDF is always
 * regenerated from the original against the COMPLETE set (Sections 34 and 64).
 * A partial update would have no coherent meaning: the output is a function of
 * all the placements together, not of the last one edited.
 *
 * An empty set is valid and means "remove them all", which is how a placement
 * is undone.
 */
export async function replaceForDocument(
  documentId: number,
  employeeId: number,
  placements: readonly PlacementRecord[],
  createdBy: number,
): Promise<void> {
  const request = await createRequest()
  request
    .input('documentId', sql.Int, documentId)
    .input('employeeId', sql.Int, employeeId)
    .input('createdBy', sql.Int, createdBy)

  const tuples = placements.map((placement, index) => {
    request
      .input(`page${index}`, sql.Int, placement.pageNumber)
      .input(`x${index}`, sql.Float, placement.x)
      .input(`y${index}`, sql.Float, placement.y)
      .input(`w${index}`, sql.Float, placement.width)
      .input(`h${index}`, sql.Float, placement.height)
      .input(`rot${index}`, sql.Int, placement.pageRotation)
      .input(`method${index}`, sql.VarChar(20), placement.method)
      .input(`detect${index}`, sql.VarChar(20), placement.detectionMethod)
      .input(`conf${index}`, sql.Float, placement.confidence)
      .input(`role${index}`, sql.VarChar(20), placement.signerRole)
      .input(`signer${index}`, sql.Int, placement.signerUserId)

    return (
      `(@documentId, @employeeId, @page${index}, @x${index}, @y${index}, @w${index}, ` +
      `@h${index}, @rot${index}, @method${index}, @detect${index}, @conf${index}, ` +
      `@role${index}, @signer${index}, @createdBy)`
    )
  })

  // Parameter NAMES only; every value is bound. The delete and the insert are
  // one transaction so a failure cannot leave the document with no placements
  // after HR asked for different ones.
  const VALUES_CLAUSE =
    tuples.length > 0
      ? `INSERT INTO dbo.SignaturePlacements
             (DocumentId, EmployeeId, PageNumber, X, Y, Width, Height, PageRotation,
              Method, DetectionMethod, Confidence, SignerRole, SignerUserId, CreatedBy)
         VALUES ${tuples.join(', ')};`
      : ''

  await request.query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;

      DELETE FROM dbo.SignaturePlacements WHERE DocumentId = @documentId;

      ${VALUES_CLAUSE}

      COMMIT TRANSACTION;`)
}

/** Marks the document's placements as drawn into the processed file. */
export async function markApplied(documentId: number): Promise<void> {
  const request = await createRequest()
  await request.input('documentId', sql.Int, documentId).query(`
      UPDATE dbo.SignaturePlacements
      SET    IsApplied = 1, UpdatedAt = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId`)
}
