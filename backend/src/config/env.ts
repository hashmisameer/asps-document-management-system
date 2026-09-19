import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * Environment configuration.
 *
 * Validated once, at boot. A missing or malformed value stops the process
 * immediately with a readable message rather than surfacing as a confusing
 * runtime failure hours later.
 *
 * Values are NEVER logged. The failure message names the offending variable
 * and the reason, never its contents.
 */

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

dotenv.config({ path: path.join(backendRoot, '.env') })

/** A directory named in full. A relative one would move with the working directory. */
const absoluteDirectory = z
  .string()
  .trim()
  .min(1)
  .refine((value) => path.isAbsolute(value), { message: 'must be an absolute path' })

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),

    DB_HOST: z.string().min(1, 'DB_HOST is required'),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(1433),
    DB_INSTANCE: z.string().min(1).optional(),
    DB_NAME: z.string().min(1, 'DB_NAME is required'),
    DB_USER: z.string().min(1, 'DB_USER is required'),
    DB_PASSWORD: z.string().min(1, 'DB_PASSWORD is required'),
    DB_ENCRYPT: booleanish.default('false'),
    DB_TRUST_SERVER_CERTIFICATE: booleanish.default('true'),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
    DB_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_POOL_MIN: z.coerce.number().int().min(0).max(100).default(0),

    DOCUMENT_STORAGE_PATH: z.string().min(1, 'DOCUMENT_STORAGE_PATH is required'),

    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters; generate one with crypto.randomBytes(64)'),
    SESSION_COOKIE_NAME: z.string().min(1).default('asps_dms_sid'),
    SESSION_IDLE_TTL_MINUTES: z.coerce.number().int().min(5).max(10_080).default(480),
    SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    COOKIE_SECURE: booleanish.default('false'),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    CORS_ORIGIN: z.string().default(''),

    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(25),

    /**
     * How many dates, today included, HR may use as a joining date when
     * adding an employee. Earlier than that only an administrator can; a date
     * in the future nobody can. The rule itself is
     * shared/src/utils/joiningDateRule.ts, and the browser is told this
     * number so it can warn before the server refuses.
     *
     * 7 means today and the six days before it.
     */
    JOINING_DATE_WINDOW_DAYS: z.coerce.number().int().min(1).max(366).default(7),

    /* The identity check: reading an uploaded document and comparing it with
       the employee's record. */
    IDENTITY_CHECK_ENABLED: booleanish.default('true'),
    /* Pages read before the check gives up. A form's details are on its first
       pages, and OCR over a long scan would hold the upload request open for
       minutes. */
    IDENTITY_CHECK_MAX_PAGES: z.coerce.number().int().min(1).max(50).default(5),
    IDENTITY_CHECK_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(90_000),
    /**
     * Logs the opening of what a document was read as, on every check.
     *
     * ON by default now, and safe to leave on, which it was not before. It used
     * to write the whole text of the document; it now writes at most 200
     * characters and only after anything shaped like a PAN or an Aadhaar number
     * has been replaced - see utils/redact.ts, which explains why that order
     * matters and why the masking is not in the logger.
     *
     * It exists because "the name is printed right there on the card" and "OCR
     * returned HHAGWAN 5INGH" look identical from the outside, and only one of
     * them is a bug worth chasing. Without it nobody can tell which.
     */
    IDENTITY_CHECK_LOG_TEXT: booleanish.default('true'),
    /* Where tesseract.js finds eng.traineddata and its WASM core.
       LEAVE THESE UNSET IN DEVELOPMENT and it downloads them from a CDN. On the
       company server, which has no route to the internet, they must be vendored
       locally and these must point at them, or every OCR pass fails. */
    /**
     * The languages OCR reads, as tesseract.js wants them: 'eng+hin'.
     *
     * The company's appointment letter is printed in Hindi, so English alone
     * returns nothing from it. Each language is another model to load and
     * another file to vendor onto the offline server.
     */
    OCR_LANGUAGES: z.string().min(3).default('eng+hin'),
    /**
     * The languages tried FIRST, before falling back to OCR_LANGUAGES.
     *
     * Every language model is another pass over the page: measured on the
     * company's PF form, 'eng' read it in 7 seconds and 'eng+hin' in 15, and
     * both found the same name, code and joining date. Nine of the ten document
     * types are printed in English and were paying the Hindi tax on every
     * upload.
     *
     * A page the fast pass cannot make sense of is read again with the full
     * set, so nothing is lost - the Hindi appointment letter costs the extra
     * pass instead of everything else costing it. Set this equal to
     * OCR_LANGUAGES to switch the two-pass behaviour off.
     */
    OCR_PRIMARY_LANGUAGES: z.string().min(3).default('eng'),
    TESSERACT_LANG_PATH: z.string().min(1).optional(),
    TESSERACT_CORE_PATH: z.string().min(1).optional(),
    TESSERACT_CACHE_PATH: z.string().min(1).optional(),
    /**
     * The daily report email.
     *
     * REPORT_RECIPIENTS is a comma-separated list, because the digest goes to
     * several people at once and a list in configuration is the whole feature:
     * who is chased is an office decision, not a code change.
     *
     * THERE IS NO ON/OFF SWITCH. Sending is on when there is somewhere to send
     * to - a relay in SMTP_HOST and at least one address here - and off when
     * there is not, which is what a fresh checkout has. A separate flag was one
     * more thing to set correctly before the office got its email.
     */
    /**
     * Optional shared code for the registration form.
     *
     * Unset by default: the cap is the control, and an office of five people on
     * their own LAN should not need a code as well. Set it when the network is
     * shared more widely than the team is.
     */
    REGISTRATION_SECRET: z.string().min(8).optional(),

    /**
     * Where the MMC application keeps employee photographs and signatures,
     * named by the eight-digit employee code: 00005696.jpg.
     *
     * Both optional, and unset means the feature is off: nothing is looked
     * for, nothing is logged. Set one without the other and only that image
     * is attached. Absolute paths, because the process's working directory is
     * not something an office server keeps steady. The folders are ANOTHER
     * APPLICATION'S and are only ever opened for reading - see
     * services/mmcImages.service.ts, which is the one module that touches them.
     */
    MMC_PHOTO_DIR: absoluteDirectory.optional(),
    MMC_SIGNATURE_DIR: absoluteDirectory.optional(),
    /**
     * Whether the API watches the MMC folders and takes a photograph or a
     * signature in the moment it appears - for an employee created a minute
     * ago or a year ago - and then runs the stamp decision again on that
     * employee's waiting documents. On by default when a folder is set.
     * Off, and the folders are only looked in when an employee is created
     * and when npm run attach-mmc-images is run by hand.
     */
    MMC_WATCH: booleanish.default('true'),
    /**
     * How often the folders are listed as a net under the watcher, in
     * minutes. A watcher on a network share can miss a file; the sweep does
     * not. 0 switches the sweep off. Runs once at startup either way.
     */
    MMC_SWEEP_MINUTES: z.coerce.number().int().min(0).max(1440).default(10),
    /**
     * Whose name the watcher attaches in, and who signs the HR box when a
     * waiting document's uploader is gone. The first active administrator
     * when unset - the same rule the command-line tools use.
     */
    MMC_WATCH_AS: z.string().trim().min(1).optional(),

    /**
     * Whether a box already has something in it, before a stamp goes there.
     *
     * Two kinds of evidence, and these say where the lines are. Every
     * measurement is logged with its verdict, so these are tuned from real
     * documents - see services/boxOccupancy.service.ts and `stamp-check`.
     *
     *   FULL_PAGE_MIN   an image covering at least this much of the page is a
     *                   scan's background, not a signature
     *   OVERLAP_MIN     an image covering at least this much of the BOX means
     *                   the box is occupied
     *   INK_EMPTY_MAX   on a scanned page, ink at or below this is an empty box
     *   INK_OCCUPIED_MIN  ... and at or above this is an occupied one; between
     *                   the two the box is uncertain and goes to a person
     *   INK_MARGIN      how much darker than the page's own background a pixel
     *                   must be to count as ink, 0-255
     */
    STAMP_FULL_PAGE_MIN: z.coerce.number().min(0.1).max(1).default(0.5),
    STAMP_OVERLAP_MIN: z.coerce.number().min(0.01).max(1).default(0.25),
    STAMP_INK_EMPTY_MAX: z.coerce.number().min(0).max(1).default(0.015),
    STAMP_INK_OCCUPIED_MIN: z.coerce.number().min(0).max(1).default(0.035),
    STAMP_INK_MARGIN: z.coerce.number().int().min(1).max(200).default(40),
    /**
     * Whether an upload that matches its type's template is stamped on the
     * spot, or only judged.
     *
     *   report  decide and record what would be stamped, and stamp nothing.
     *           The default, and what a server runs for a few days after this
     *           ships, so the decisions can be read against real uploads
     *           before any of them is acted on.
     *   stamp   decide, record, and stamp. No screen, no approval: the
     *           signatures are the ones already on file, and a wrong one is a
     *           wrong file in MMC's folder, not a question for HR.
     *
     * Either way every decision is a row in dbo.StampDecisions, and a document
     * with any box left alone is marked for HR to look at.
     */
    AUTO_STAMP: z.enum(['report', 'stamp']).default('report'),
    REPORT_RECIPIENTS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((address) => address.trim())
          .filter((address) => address.length > 0),
      ),
    /**
     * When the daily email goes out, as HH:MM on the server's own clock.
     *
     * The API sends it rather than a scheduled task on the machine: one place
     * to configure it, and nobody has to remember to recreate a Windows task
     * after a rebuild. It fires once a day and skips a day it has already sent,
     * so a restart in the afternoon does not send a second copy.
     */
    REPORT_SEND_TIME: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'REPORT_SEND_TIME must be HH:MM, such as 09:00')
      .default('09:00'),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(25),
    SMTP_SECURE: booleanish.default('false'),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    SMTP_FROM: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_DIR: z.string().default('./logs'),
  })
  .superRefine((v, ctx) => {
    // A named instance is resolved by SQL Server Browser, which makes an
    // explicit port meaningless and the combination ambiguous.
    if (v.DB_INSTANCE && process.env.DB_PORT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DB_INSTANCE'],
        message: 'Set either DB_INSTANCE or DB_PORT, not both',
      })
    }
    // Half-configured is the case worth catching: addresses with no relay, or
    // a relay with nobody to send to, is somebody expecting an email that will
    // never arrive.
    if (v.REPORT_RECIPIENTS.length > 0 && !v.SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'REPORT_RECIPIENTS needs SMTP_HOST; the daily email has nowhere to go without it',
      })
    }
    if (v.NODE_ENV === 'production' && !v.COOKIE_SECURE && v.COOKIE_SAME_SITE === 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SAME_SITE'],
        message: 'COOKIE_SAME_SITE=none requires COOKIE_SECURE=true',
      })
    }
  })

function loadEnv() {
  const parsed = envSchema.safeParse(process.env)

  if (!parsed.success) {
    // Names and reasons only - never the values.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(
      `Invalid backend environment configuration:\n${problems}\n\n` +
        `Copy backend/.env.example to backend/.env and fill in the missing values.`,
    )
  }

  const env = parsed.data

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    backendRoot,
    /** Storage root is always resolved to an absolute path, never used raw. */
    storageRoot: path.resolve(backendRoot, env.DOCUMENT_STORAGE_PATH),
    logDir: path.resolve(backendRoot, env.LOG_DIR),
    maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
    corsOrigins: env.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  }
}

export type AppEnv = ReturnType<typeof loadEnv>

export const env: AppEnv = loadEnv()
