import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_FIELDS,
  extractDates,
  matchCode,
  matchDate,
  matchDigits,
  matchField,
  matchPan,
  matchesDocumentType,
  matchWords,
  normalizeText,
} from '@asps-dms/shared'

/**
 * The comparisons that decide whether a document is refused.
 *
 * Worth pinning hard: a matcher that is too strict blocks a genuine document
 * and sends HR to rescan something that was fine, and one that is too loose
 * files a document against the wrong employee - which is the failure the whole
 * check exists to prevent.
 */

describe('normalizeText', () => {
  it('folds case and punctuation so a form and a record can be compared', () => {
    expect(normalizeText('Sameer  Hashmi,  S/o. Ahmed')).toBe('SAMEER HASHMI S O AHMED')
  })
})

describe('matchWords', () => {
  const text = 'EMPLOYEE NAME: Sameer Hashmi\nDesignation: Site Engineer'

  it('finds a name however the form punctuates or orders it', () => {
    expect(matchWords('Sameer Hashmi', text)).toBe(true)
    expect(matchWords('HASHMI, SAMEER', text)).toBe(true)
    expect(matchWords('sameer hashmi', text)).toBe(true)
  })

  it('fails when any part of the name is absent', () => {
    // The document names a different person. This is the case that must never
    // be waved through: it is somebody else's form.
    expect(matchWords('Sameer Qureshi', text)).toBe(false)
  })

  it('ignores single letters, which would match almost anything', () => {
    expect(matchWords('S Hashmi', text)).toBe(true)
    expect(matchWords('S', text)).toBe(false)
  })

  it('matches a multi-word value such as a designation', () => {
    expect(matchWords('Site Engineer', text)).toBe(true)
    expect(matchWords('Site Supervisor', text)).toBe(false)
  })
})

describe('matchCode', () => {
  it('finds the code however the form spaces it', () => {
    expect(matchCode('EMP007', 'Employee Code: EMP007')).toBe(true)
    expect(matchCode('EMP007', 'Employee Code : EMP 007')).toBe(true)
  })

  it('does not find a different code', () => {
    expect(matchCode('EMP007', 'Employee Code: EMP070')).toBe(false)
  })

  it('does not invent a code across two unrelated words', () => {
    // 'EMP' ending one word and '007' starting the next are not this code, and
    // stripping every space in the document would say they were.
    expect(matchCode('EMP007', 'DEPT EMP GRADE 007X')).toBe(false)
  })
})

describe('matchDigits', () => {
  it('reads a number through the spaces a form prints it with', () => {
    expect(matchDigits('123456789012', 'Aadhaar No. 1234 5678 9012')).toBe(true)
    expect(matchDigits('9876543210', 'Mobile: +91 98765-43210')).toBe(true)
  })

  it('fails on a different number', () => {
    expect(matchDigits('123456789012', 'Aadhaar No. 1234 5678 9013')).toBe(false)
  })

  it('refuses to match on a value too short to mean anything', () => {
    // Four digits appear on every form that carries a year.
    expect(matchDigits('2024', 'Dated 01/04/2024')).toBe(false)
  })

  it('does not join digits across a date separator', () => {
    expect(matchDigits('10042024', 'Dated 10/04/2024')).toBe(false)
  })
})

// asps-dms:allow-secret - the documented placeholder PAN, not anyone's.
describe('the company writes dates DD/MM/YYYY', () => {
  it('reads 01/08/2026 as the 1st of August', () => {
    expect(matchDate('2026-08-01', 'DATE OF JOINING 01/08/2026')).toBe(true)
  })

  it('does NOT also read it as the 8th of January', () => {
    // Both readings were accepted once, which made a service card printed
    // 01/08 match an employee who joined on the 8th of January - the exact
    // mistake this check exists to catch, waved through silently.
    expect(matchDate('2026-01-08', 'DATE OF JOINING 01/08/2026')).toBe(false)
  })

  it('still reads a date that can only be month-first', () => {
    // No 25th month, so 04/25 is unambiguously American and matching it costs
    // nothing.
    expect(matchDate('2024-04-25', 'Dated 04/25/2024')).toBe(true)
  })
})

describe('a code printed with leading zeros', () => {
  it('matches the same number without them', () => {
    // Service cards carry '00006016' where the office says '6016'.
    expect(matchCode('6016', 'Employee Code No. 00006016')).toBe(true)
    expect(matchCode('00006016', 'Employee Code No. 6016')).toBe(true)
  })

  it('does not treat two different codes as one', () => {
    expect(matchCode('6016', 'Employee Code No. 60160')).toBe(false)
    expect(matchCode('EMP007', 'Code EMP7')).toBe(false)
  })
})

describe('matchDate, as a scanner reads a printed form', () => {
  // A form prints each part of a date in its own box, and OCR reads the boxes
  // as separate tokens. These are the readings that made the identity check
  // refuse service cards that were perfectly correct.
  it('matches a date spaced around its separators', () => {
    expect(matchDate('2026-04-01', 'Date of Joining: 01 - 04 - 2026')).toBe(true)
  })

  it('matches a date whose digits are spaced apart, box by box', () => {
    expect(matchDate('2026-04-01', 'Date of Joining: 0 1 / 0 4 / 2 0 2 6')).toBe(true)
  })

  it('still matches the ordinary printings', () => {
    for (const text of [
      'DOJ 01/04/2026',
      'Date of Joining 1 April 2026',
      'Joining Date: April 1, 2026',
      'Date of Joining 2026-04-01',
      'DATE OF JOINING 01 APR 2026',
    ]) {
      expect(matchDate('2026-04-01', text), text).toBe(true)
    }
  })

  it('does not invent a date by running two separate numbers together', () => {
    // Closing the gaps must not turn neighbouring numbers into a date that is
    // not on the page: a false match passes a document that should have been
    // refused, which is worse than a refusal somebody can override.
    expect(matchDate('2026-04-01', 'Ref 1 Page 04 of 2026 copies')).toBe(false)
    expect(matchDate('2026-04-01', 'Invoice 3390 4 2026')).toBe(false)
  })
})

describe('matchPan', () => {
  it('matches the PAN exactly, in any case', () => {
    // asps-dms:allow-secret
    expect(matchPan('ABCDE1234F', 'PAN: abcde1234f')).toBe(true)
  })

  it('fails on a PAN that differs by one character', () => {
    // asps-dms:allow-secret
    expect(matchPan('ABCDE1234F', 'PAN: ABCDE1234G')).toBe(false)
  })
})

describe('extractDates', () => {
  it('reads the forms an Indian office actually writes', () => {
    expect(extractDates('Date of joining 01/04/2024')).toContain('2024-04-01')
    expect(extractDates('Joined 1 April 2024')).toContain('2024-04-01')
    expect(extractDates('Joined April 1, 2024')).toContain('2024-04-01')
    expect(extractDates('Joined 2024-04-01')).toContain('2024-04-01')
    expect(extractDates('Joined 01.04.24')).toContain('2024-04-01')
    expect(extractDates('Joined 1ST APRIL 2024')).toContain('2024-04-01')
  })

  it('reads an ambiguous numeric date as DAY first, and only that way', () => {
    // Changed on 2026-08-31, having seen a real service card. 04/03/2024 is the
    // 4th of March on the company's forms. Offering the 3rd of April as well
    // looked generous but made the check accept a document belonging to a
    // different employee - and a false match is silent, where a refusal can be
    // overridden by a person who can see the page.
    const dates = extractDates('Dated 04/03/2024')
    expect(dates).toContain('2024-03-04')
    expect(dates).not.toContain('2024-04-03')
  })

  it('ignores a date that is not a real day', () => {
    expect(extractDates('Dated 31/02/2024').size).toBe(0)
  })

  it('turns a two-digit year into the century it means', () => {
    expect(extractDates('DOB 15/08/98')).toContain('1998-08-15')
  })
})

describe('matchDate', () => {
  it('matches the same day written differently', () => {
    expect(matchDate('2024-04-01', 'Date of Joining: 01-04-2024')).toBe(true)
  })

  it('fails on a different day', () => {
    expect(matchDate('2024-04-01', 'Date of Joining: 02-04-2024')).toBe(false)
  })
})

describe('matchField', () => {
  it('applies the comparison the field calls for', () => {
    expect(matchField(DOCUMENT_FIELDS.EMPLOYEE_NAME, 'Sameer Hashmi', 'SAMEER HASHMI')).toBe(true)
    expect(matchField(DOCUMENT_FIELDS.JOINING_DATE, '2024-04-01', 'DOJ 01/04/2024')).toBe(true)
    expect(matchField(DOCUMENT_FIELDS.EMPLOYEE_CODE, 'EMP007', 'Code EMP 007')).toBe(true)
    // asps-dms:allow-secret - the documented placeholder PAN, not anyone's.
    expect(matchField(DOCUMENT_FIELDS.PAN_NUMBER, 'ABCDE1234F', 'PAN ABCDE1234F')).toBe(true)
    expect(matchField(DOCUMENT_FIELDS.UAN_NUMBER, '100200300400', 'UAN 1002 0030 0400')).toBe(true)
  })
})

describe('matchesDocumentType', () => {
  // The check the field comparisons cannot make. An employee's name and code
  // are printed on every document they own, so an Aadhaar card filed against
  // the PAN Card row passes every field check there is.
  const AADHAAR = ['AADHAAR', 'AADHAR', 'UNIQUE IDENTIFICATION AUTHORITY', 'UIDAI']
  const PAN = ['INCOME TAX DEPARTMENT', 'PERMANENT ACCOUNT NUMBER']

  it('recognises a document by any one of its phrases', () => {
    expect(matchesDocumentType('GOVERNMENT OF INDIA\nAADHAAR\n1234 5678 9012', AADHAAR)).toBe(true)
    expect(matchesDocumentType('UNIQUE IDENTIFICATION AUTHORITY OF INDIA', AADHAAR)).toBe(true)
  })

  it('refuses a document filed as the wrong type', () => {
    const panCard = 'INCOME TAX DEPARTMENT\nPERMANENT ACCOUNT NUMBER\nPFCPS3190K'
    expect(matchesDocumentType(panCard, AADHAAR)).toBe(false)
    expect(matchesDocumentType(panCard, PAN)).toBe(true)
  })

  it('ignores punctuation and spacing on both sides', () => {
    // A real service card was read as 'FORM -V'; the keyword is 'FORM V'.
    expect(matchesDocumentType('FORM -V   SERVICE CARD', ['FORM V'])).toBe(true)
    expect(matchesDocumentType('BIO — DATA FORM', ['BIO DATA'])).toBe(true)
  })

  it('survives OCR losing a character, because there is more than one phrase', () => {
    // The same card came back as 'SERVICE CAR'.
    expect(matchesDocumentType('FORM -V SERVICE CAR', ['SERVICE CARD', 'FORM V'])).toBe(true)
  })

  it('accepts anything when no keywords are configured', () => {
    // Not recognised is not the same as recognised and wrong. A type with no
    // reliable wording opts out rather than refusing everything.
    expect(matchesDocumentType('anything at all', [])).toBe(true)
  })

  it('refuses when nothing could be read', () => {
    expect(matchesDocumentType('', AADHAAR)).toBe(false)
    expect(matchesDocumentType('   \n  ', AADHAAR)).toBe(false)
  })
})

describe('recognising the forms as they are actually printed', () => {
  const ESIC = [
    'EMPLOYEES STATE INSURANCE CORPORATION',
    'EMPLOYEES STATE INSURANCE',
    'ESIC',
    'कर्मचारी राज्य बीमा',
  ]
  const APPOINTMENT = ['APPOINTMENT LETTER', 'नियुक्ति पत्र', 'नियुक्ति']

  it("reads an apostrophe as part of a word, not a break", () => {
    // ESIC is Employee's State Insurance Corporation. Treating the apostrophe
    // as a separator made 'EMPLOYEE S' and the keyword 'EMPLOYEES' two
    // different things, and the form went unrecognised.
    expect(matchesDocumentType("Employee's State Insurance Corporation", ESIC)).toBe(true)
    expect(matchesDocumentType('Employee’s State Insurance', ESIC)).toBe(true)
  })

  it('recognises a form printed in Hindi', () => {
    // The company's appointment letter carries no English at all, so the type
    // could never be matched on 'APPOINTMENT LETTER'.
    expect(matchesDocumentType('नियुक्ति पत्र\nदिनांक 01/08/2026', APPOINTMENT)).toBe(true)
    expect(matchesDocumentType('नियुक्तिपत्र', APPOINTMENT)).toBe(true)
    expect(matchesDocumentType('कर्मचारी राज्य बीमा निगम', ESIC)).toBe(true)
  })

  it('still refuses a Hindi form filed as the wrong type', () => {
    // Being lenient about script must not become lenient about which document
    // it is: that is the whole point of the check.
    expect(matchesDocumentType('कर्मचारी राज्य बीमा', APPOINTMENT)).toBe(false)
  })
})
