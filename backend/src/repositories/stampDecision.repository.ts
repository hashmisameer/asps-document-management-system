import type {
  AutoStampMode,
  StampBoxDecision,
  StampDecisionSummary,
  StampOutcome,
} from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.StampDecisions: what stamping on upload decided, every time.
 *
 * One row per decision, never updated. A document uploaded twice has two
 * rows and the latest stands. Written whatever the mode - in report mode the
 * row is the whole point, since nothing else happens - and read back for the
 * checklist and for the trial report.
 */

export interface NewStampDecision {
  documentId: number
  mode: AutoStampMode
  outcome: StampOutcome
  variantKey: string | null
  stampedCount: number
  skippedCount: number
  summary: string
  boxes: readonly StampBoxDecision[]
  decidedBy: number | null
}

interface Row {
  StampDecisionId: number
  DocumentId: number
  Mode: string
  Outcome: string
  VariantKey: string | null
  StampedCount: number
  SkippedCount: number
  Summary: string
  BoxesJson: string
  DecidedBy: number | null
  DecidedAt: Date
}

export interface StampDecisionRecord extends StampDecisionSummary {
  stampDecisionId: number
  documentId: number
  variantKey: string | null
  decidedBy: number | null
}

function toRecord(row: Row): StampDecisionRecord {
  return {
    stampDecisionId: row.StampDecisionId,
    documentId: row.DocumentId,
    mode: row.Mode as AutoStampMode,
    outcome: row.Outcome as StampOutcome,
    variantKey: row.VariantKey,
    stampedCount: row.StampedCount,
    skippedCount: row.SkippedCount,
    summary: row.Summary,
    boxes: JSON.parse(row.BoxesJson) as StampBoxDecision[],
    decidedBy: row.DecidedBy,
    decidedAt: row.DecidedAt.toISOString(),
  }
}

export async function insert(decision: NewStampDecision): Promise<number> {
  const request = await createRequest()
  const result = await request
    .input('documentId', sql.Int, decision.documentId)
    .input('mode', sql.VarChar(10), decision.mode)
    .input('outcome', sql.VarChar(20), decision.outcome)
    .input('variantKey', sql.VarChar(40), decision.variantKey)
    .input('stampedCount', sql.Int, decision.stampedCount)
    .input('skippedCount', sql.Int, decision.skippedCount)
    // Cut rather than refused: the sentence is for reading, and a decision
    // that could not be recorded because its summary ran long would be worse
    // than a summary missing its tail.
    .input('summary', sql.NVarChar(500), decision.summary.slice(0, 500))
    .input('boxesJson', sql.NVarChar(sql.MAX), JSON.stringify(decision.boxes))
    .input('decidedBy', sql.Int, decision.decidedBy).query<{ StampDecisionId: number }>(`
      INSERT INTO dbo.StampDecisions
        (DocumentId, Mode, Outcome, VariantKey, StampedCount, SkippedCount, Summary, BoxesJson, DecidedBy)
      OUTPUT INSERTED.StampDecisionId
      VALUES
        (@documentId, @mode, @outcome, @variantKey, @stampedCount, @skippedCount, @summary, @boxesJson, @decidedBy)`)

  return result.recordset[0]?.StampDecisionId ?? 0
}

/** The decision that stands for a document: the latest one. */
export async function findLatestForDocument(
  documentId: number,
): Promise<StampDecisionRecord | null> {
  const request = await createRequest()
  const result = await request.input('documentId', sql.Int, documentId).query<Row>(`
      SELECT TOP 1 *
      FROM   dbo.StampDecisions
      WHERE  DocumentId = @documentId
      ORDER BY DecidedAt DESC, StampDecisionId DESC`)

  const row = result.recordset[0]
  return row ? toRecord(row) : null
}

/** A decision with the document type it was about - and nothing about the employee. */
export interface StampDecisionReportRow extends StampDecisionRecord {
  documentCode: string
  documentName: string
}

/**
 * Every decision since a moment, newest first, for the trial report.
 *
 * The document TYPE travels with each row and the employee deliberately does
 * not: the report is meant to be pasted into a message, and a list of whose
 * forms were not stamped is not.
 */
export async function listSince(since: Date, limit = 1000): Promise<StampDecisionReportRow[]> {
  const request = await createRequest()
  const result = await request
    .input('since', sql.DateTime2(3), since)
    .input('limit', sql.Int, limit).query<Row & { DocumentCode: string; DocumentName: string }>(`
      SELECT TOP (@limit) s.*, dt.DocumentCode, dt.DocumentName
      FROM   dbo.StampDecisions AS s
      INNER JOIN dbo.EmployeeDocuments AS d ON d.DocumentId = s.DocumentId
      INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
      WHERE  s.DecidedAt >= @since
      ORDER BY s.DecidedAt DESC, s.StampDecisionId DESC`)

  return result.recordset.map((row) => ({
    ...toRecord(row),
    documentCode: row.DocumentCode,
    documentName: row.DocumentName,
  }))
}
