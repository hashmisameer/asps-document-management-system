import type { RequestHandler } from 'express'
import multer from 'multer'
import { env } from '../config/env.js'
import { BadRequestError, PayloadTooLargeError } from '../utils/errors.js'

/**
 * Multipart handling for a single document.
 *
 * In memory rather than to a temporary file, deliberately. The file has to be
 * read end to end anyway - to sniff its type and hash it - and a temporary file
 * would put an unencrypted copy of an employee's document in the system temp
 * folder, where nothing in this application is responsible for cleaning it up.
 * At a 25 MB ceiling and a handful of concurrent users on a LAN, holding it in
 * memory is the smaller risk.
 *
 * Nothing here decides whether the file is ACCEPTABLE: that is
 * fileValidation.service.ts, which reads the content rather than trusting the
 * name or the Content-Type the browser attached.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.maxUploadBytes,
    files: 1,
    // Metadata only - isExistingRecord, landingStatus, notes.
    fields: 10,
    fieldSize: 1024,
  },
})

const single = upload.single('file')

/**
 * Runs multer and turns its errors into the application's own.
 *
 * Wrapped here rather than handled in errorHandler so that the error handler
 * has no reason to know multer exists, and so the message names the field the
 * form actually has to send.
 */
export const uploadSingleDocument: RequestHandler = (req, res, next) => {
  single(req, res, (error: unknown) => {
    if (!error) {
      next()
      return
    }

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(
          new PayloadTooLargeError(
            `That file is larger than the ${env.MAX_UPLOAD_MB} MB limit.`,
          ),
        )
        return
      }
      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        next(new BadRequestError("Send the document in a form field named 'file'."))
        return
      }
      next(new BadRequestError('That upload could not be read.', { cause: error }))
      return
    }

    next(error)
  })
}
