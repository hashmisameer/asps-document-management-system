import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  SIGNER_ROLE_LABEL,
  variantLabel,
  type DocumentTypeTemplateSummary,
  type SignerRole,
  type TemplateVariantSummary,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { ApiError } from '../../lib/apiError.js'
import { formatDateTime } from '../../lib/format.js'
import { fetchTemplateSummaries, templateKeys } from './api.js'
import { savedTemplatesNote } from './shapeText.js'

/**
 * Where the signatures and the photograph go on each document type.
 *
 * One row per type, and within it a line per FORM: a type can be two pieces
 * of paper - the PF form is two pages, Form 11 is one - and each has its own
 * template. Set once by an administrator on a real document, and every
 * employee's document of that form will be stamped from it - NEW uploads
 * only, from the next change on; nothing here touches what has already been
 * uploaded or stamped.
 *
 * Each line shows what a stale template looks like: the form's page count
 * and paper size, and when it was set. A form redesigned since will not
 * match them, and will be refused rather than stamped in the wrong place.
 */

function roleSummary(roles: TemplateVariantSummary['roles']): string {
  return (Object.entries(roles) as [SignerRole, number][])
    .map(([role, count]) => `${count} ${SIGNER_ROLE_LABEL[role].toLowerCase()}`)
    .join(', ')
}

function VariantLine({ variant }: { variant: TemplateVariantSummary }) {
  return (
    <li className="py-1">
      <span className="font-medium text-slate-900">{variantLabel(variant.variant)}</span>
      {variant.pageRotation ? (
        <span className="ml-1 text-xs text-status-pending">rotated {variant.pageRotation}</span>
      ) : null}
      <span className="ml-2 text-slate-700">
        {variant.boxes} box{variant.boxes === 1 ? '' : 'es'} on {variant.pages} page
        {variant.pages === 1 ? '' : 's'} - {roleSummary(variant.roles)}
      </span>
      <span className="ml-2 text-xs text-slate-500">
        {variant.sampleEmployeeCode ? (
          <span className="font-mono">from {variant.sampleEmployeeCode}</span>
        ) : variant.sampleDocumentId ? (
          'sample no longer available'
        ) : null}
        {variant.setByName ? ` - set by ${variant.setByName} ${formatDateTime(variant.setAt)}` : null}
      </span>
      {savedTemplatesNote(variant.savedTemplates) ? (
        <span className="block text-xs text-slate-500">
          {savedTemplatesNote(variant.savedTemplates)}
        </span>
      ) : null}
    </li>
  )
}

function TemplateRow({ template }: { template: DocumentTypeTemplateSummary }) {
  return (
    <tr className="align-top">
      <td className="px-4 py-2 font-medium text-slate-900">{template.documentName}</td>
      <td className="px-4 py-2">
        {template.status === 'set' ? (
          <Badge tone="verified">
            {template.variants.length === 1 ? 'Set up' : `${template.variants.length} forms set up`}
          </Badge>
        ) : template.status === 'scanned' ? (
          <Badge tone="neutral">Scanned card - no template</Badge>
        ) : (
          <Badge tone="pending">Not set up</Badge>
        )}
      </td>
      <td className="px-4 py-2 text-sm">
        {template.variants.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {template.variants.map((variant) => (
              <VariantLine key={`${variant.variant.pageCount}-${variant.variant.widthPt}x${variant.variant.heightPt}`} variant={variant} />
            ))}
          </ul>
        ) : (
          <span className="text-slate-400">-</span>
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
  )
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
          A type that comes as more than one form - the two-page PF form and the one-page Form
          11 - has a template for each. Saving a template changes nothing already uploaded.
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
              <th className="px-4 py-2 font-medium">Forms</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {templates.data?.map((template) => (
              <TemplateRow key={template.documentTypeId} template={template} />
            ))}

            {templates.isPending ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <p className="mt-3 text-xs text-slate-500">
        Aadhaar and PAN are scanned cards with no fixed layout, so they have no template; they are
        handled separately. A document whose page count and size match no form here is not
        stamped, and is left for HR to handle.
      </p>
    </main>
  )
}
