import { z } from 'zod'
import { isDateOnly } from '../utils/dateOnly.js'

/** 'YYYY-MM-DD', rejecting impossible calendar dates such as 2026-02-30. */
export const dateOnlySchema = z
  .string()
  .trim()
  .refine(isDateOnly, { message: 'Must be a valid date in YYYY-MM-DD format' })

export const idParamSchema = z.coerce.number().int().positive()

/** Shared list-query envelope: pagination, search and sorting. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  sortBy: z.string().trim().max(50).optional(),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

/**
 * Free-text fields are trimmed and length-capped here so that both the browser
 * and the server reject the same input, and so no value can exceed its NVARCHAR
 * column width and trigger a truncation error deep in the driver.
 */
export const shortText = (max: number) => z.string().trim().max(max)

export const optionalShortText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional()
