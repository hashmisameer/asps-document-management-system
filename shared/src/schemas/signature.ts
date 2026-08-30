import { z } from 'zod'
import { MIN_PLACEMENT_SIZE } from '../utils/coordinates.js'

/**
 * A single signature placement submitted by HR from the editor.
 *
 * Coordinates are normalized 0..1 in displayed page space with a top-left
 * origin - see utils/coordinates.ts for the full contract. The server
 * re-validates these bounds before writing; a placement that would fall off the
 * page is rejected rather than silently clamped.
 */
export const placementSchema = z
  .object({
    pageNumber: z.number().int().min(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(MIN_PLACEMENT_SIZE).max(1),
    height: z.number().min(MIN_PLACEMENT_SIZE).max(1),
    pageRotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    method: z.enum(['Automatic', 'Manual', 'Adjusted']),
    detectionMethod: z.enum(['OCR', 'CV', 'Combined', 'Manual']),
    confidence: z.number().min(0).max(1).nullable().default(null),
  })
  .refine((v) => v.x + v.width <= 1.0001, {
    message: 'Placement extends beyond the right edge of the page',
    path: ['width'],
  })
  .refine((v) => v.y + v.height <= 1.0001, {
    message: 'Placement extends beyond the bottom edge of the page',
    path: ['height'],
  })

export type PlacementInput = z.infer<typeof placementSchema>

/**
 * Full replacement of a document's placements.
 *
 * PUT rather than PATCH, deliberately: the processed PDF is always regenerated
 * from the ORIGINAL against this complete set (Sections 34 and 64), so partial
 * updates would have no coherent meaning and would risk stacked signatures.
 *
 * An empty array is valid and means "remove all placements", which reverts the
 * document to needing review.
 */
export const savePlacementsSchema = z.object({
  placements: z.array(placementSchema).max(50),
})

export type SavePlacementsInput = z.infer<typeof savePlacementsSchema>

export const skipSignatureSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

export const signatureReviewQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  onlyUnreviewed: z.coerce.boolean().default(true),
})
