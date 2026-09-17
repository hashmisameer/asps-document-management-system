import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SIGNER_ROLE_LABEL, type DocumentTypeTemplateSummary, type SignerRole } from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { ApiError } from '../../lib/apiError.js'
import { formatDateTime } from '../../lib/format.js'
import { fetchTemplateSummaries, templateKeys } from './api.js'

/**
 * Where the signatures and the photograph go on each document type.
 *
 * One row per type. Set once by an administrator on a real document of the
 * type, and every employee's document of that type will be stamped from it -
 * NEW uploads only, from the next change on; nothing here touches what has
 * already been uploaded or stamped.
 *
 * The row shows what a stale template looks like: the sample's page size and
 * page count, and when it was set. A form redesigned since will not match
 * them, and will be refused rather than stamped in the wrong place.
 */

/** Points to a paper size the office knows. A4 is 595 x 842; anything else is shown in points. */
function paperSize(widthPt: number | null, heightPt: number | null): string {
  if (widthPt === null || heightPt === null) return '-'
  const near = (a: number, b: number) => Math.abs(a - b) < 3
  if (near(widthPt, 595) && near(heightPt, 842)) return 'A4 portrait'
  if (near(widthPt, 842) && near(heightPt, 595)) return 'A4 landscape'
  if (near(widthPt, 612) && near(heightPt, 792)) return 'Letter portrait'
  return `${Math.round(widthPt)} x ${Math.round(heightPt)} pt`
}

function roleSummary(roles: DocumentTypeTemplateSummary['roles']): string {
  return (Object.entries(roles) as [SignerRole, number][])
    .map(([role, count]) => `${count} ${SIGNER_ROLE_LABEL[role].toLowerCase()}`)
    .join(', ')
}

export function TemplatesPage() {
  const templates = useQuery({ queryKey: templateKeys.summaries, queryFn: fetchTemplateSummaries })
  const error = templates.error instanceof ApiError ? templates.error : null

  return (
    <main>
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Signature and photo placement</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Where the employee&rsquo;s signature, the HR signature and the photograph go on each
          document type. Set once, on a real document of the type, and used for every employee.
          Saving a template changes nothing already uploaded.
        </p>
      </header>

      {error ? (
        <div className="mt-4">
          <Alert title="The templates could not be loaded" referenceId={error.referenceId}>
            {error.message}
          </Alert>
        </div>
      ) : null}

      <section className="mt-4 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-2 font-medium">Document</th>
              <th className="px-4 py-2 font-medium">Template</th>
              <th className="px-4 py-2 font-medium">Boxes</th>
              <th className="px-4 py-2 font-medium">Sample</th>
              <th className="px-4 py-2 font-medium">Set by</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {templates.data?.map((template) => (
              <tr key={template.documentTypeId}>
                <td className="px-4 py-2 font-medium text-slate-900">{template.documentName}</td>
                <td className="px-4 py-2">
                  {template.status === 'set' ? (
                    <Badge tone="verified">Set up</Badge>
                  ) : template.status === 'scanned' ? (
                    <Badge tone="neutral">Scanned card - no template</Badge>
                  ) : (
                    <Badge tone="pending">Not set up</Badge>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-700">
                  {template.status === 'set'
                    ? `${template.boxes} on ${template.pages} page${template.pages === 1 ? '' : 's'} - ${roleSummary(template.roles)}`
                    : '-'}
                </td>
                <td className="px-4 py-2 text-slate-700">
                  {template.status === 'set' ? (
                    <>
                      {paperSize(template.pageWidthPt, template.pageHeightPt)}
                      {template.pageRotation ? `, rotated ${template.pageRotation}` : ''}
                      {template.samplePageCount
                        ? `, ${template.samplePageCount} page${template.samplePageCount === 1 ? '' : 's'}`
                        : ''}
                      {template.sampleEmployeeCode ? (
                        <span className="ml-1 font-mono text-xs text-slate-500">
                          ({template.sampleEmployeeCode})
                        </span>
                      ) : template.sampleDocumentId ? (
                        <span className="ml-1 text-xs text-slate-400">(sample no longer available)</span>
                      ) : null}
                    </>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="px-4 py-2 text-slate-700">
                  {template.setByName ? (
                    <>
                      {template.setByName}
                      <span className="ml-1 text-xs text-slate-500">{formatDateTime(template.setAt)}</span>
                    </>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {template.status === 'scanned' ? null : (
                    <Link
                      to={`/settings/placements/${template.documentTypeId}`}
                      className="text-sm font-medium text-brand-700 hover:text-brand-800"
                    >
                      {template.status === 'set' ? 'Change' : 'Set up'}
                    </Link>
                  )}
                </td>
              </tr>
            ))}

            {templates.isPending ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <p className="mt-3 text-xs text-slate-500">
        Aadhaar and PAN are scanned cards with no fixed layout, so they have no template; they are
        handled separately.
      </p>
    </main>
  )
}
