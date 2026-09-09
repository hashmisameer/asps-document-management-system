import { useCallback, useRef, useState } from 'react'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { Modal } from '../../components/ui/Modal.js'
import {
  SignaturePad,
  type SignatureMode,
  type SignaturePadHandle,
} from '../../components/ui/SignaturePad.js'
import type { SignatureCapture } from './api.js'

interface SignatureCaptureDialogProps {
  open: boolean
  title: string
  description?: string
  busy?: boolean
  /** A failure from the save, shown in the dialog so the ink is not lost with it. */
  failure?: string | null
  onCancel: () => void
  /** `capture` says which tab it came from, and is what the record stores. */
  onSave: (png: Blob, capture: SignatureCapture) => void
}

/**
 * The dialog someone signs in.
 *
 * It never closes itself. Saving is asynchronous and can fail - a signature too
 * large, a server that is not there - and closing on the click would throw away
 * the ink at exactly the moment it turns out to be needed again. The parent
 * closes it when the save has actually succeeded.
 */
export function SignatureCaptureDialog({
  open,
  title,
  description,
  busy = false,
  failure = null,
  onCancel,
  onSave,
}: SignatureCaptureDialogProps) {
  const pad = useRef<SignaturePadHandle>(null)
  const [hasInk, setHasInk] = useState(false)
  const [empty, setEmpty] = useState(false)
  const [mode, setMode] = useState<SignatureMode>('draw')

  const handleInkChange = useCallback((ink: boolean) => {
    setHasInk(ink)
    if (ink) setEmpty(false)
  }, [])

  const handleModeChange = useCallback((next: SignatureMode) => {
    setMode(next)
    setEmpty(false)
  }, [])

  const handleSave = async () => {
    const png = await pad.current?.toPngBlob()
    if (!png) {
      // Only reachable if every stroke fell outside the visible area, which the
      // pad prevents - but a save that silently does nothing is worse than a
      // message saying there is nothing to save.
      setEmpty(true)
      return
    }
    onSave(png, mode === 'upload' ? 'Uploaded' : 'Drawn')
  }

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          {/* Undo is a stroke at a time, which an uploaded image does not have. */}
          {mode === 'draw' ? (
            <Button variant="ghost" onClick={() => pad.current?.undo()} disabled={busy || !hasInk}>
              Undo
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => {
              pad.current?.clear()
              setEmpty(false)
            }}
            disabled={busy || !hasInk}
          >
            Clear
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSave} busy={busy} busyLabel="Saving..." disabled={!hasInk}>
            Save signature
          </Button>
        </>
      }
    >
      {failure ? (
        <div className="mb-3">
          <Alert title="Could not save the signature">{failure}</Alert>
        </div>
      ) : null}

      {empty ? (
        <div className="mb-3">
          <Alert tone="info">There is nothing on the pad yet. Sign, then save.</Alert>
        </div>
      ) : null}

      <SignaturePad
        ref={pad}
        onInkChange={handleInkChange}
        onModeChange={handleModeChange}
        disabled={busy}
      />

      <p className="mt-2 text-xs text-slate-500">
        {mode === 'draw'
          ? 'Sign with the pen on the tablet, or with the mouse. The signature is cropped to the ink and stored on a transparent background, so only the writing is stamped onto a document.'
          : 'Upload a photograph or scan of the signature. The paper behind it is taken away so only the writing is stamped onto a document - use the slider if too much or too little is removed.'}
      </p>
    </Modal>
  )
}
