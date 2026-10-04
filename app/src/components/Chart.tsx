// カルテの部品: メモ(来院ごと・患者全体・注意事項)と写真
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, ImageOff, Loader2, Pencil, Pin, PinOff, Plus, Save, ShieldAlert, Trash2, X } from 'lucide-react';
import {
  addNote, deleteNote, deletePhoto, readDraft, saveDraft, updateNote, uploadPhoto, useChartImage, useChartNotes,
  useChartPhotos, useStaffNames, type ChartNote, type ChartPhoto,
} from '../lib/chart';
import { errorText } from '../lib/data';
import { useStaff } from '../pages/StaffLayout';
import { Alert } from '../ui';

function useInvalidateChart(customerId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['chart-notes', customerId] }),
    qc.invalidateQueries({ queryKey: ['chart-photos', customerId] }),
    qc.invalidateQueries({ queryKey: ['day'] }),
    qc.invalidateQueries({ queryKey: ['visit-list'] }),
  ]);
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** メモの入力欄。書きかけは端末に残る(通信が切れても、画面を閉じても消えない) */
export function NoteEditor({ draftId, initial = '', pinnable, onSave, onCancel, autoFocus }: {
  draftId: string; initial?: string; pinnable?: boolean; autoFocus?: boolean;
  onSave: (body: string, pinned: boolean) => Promise<void>; onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState(() => readDraft(draftId) || initial);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { saveDraft(draftId, body === initial ? '' : body); }, [draftId, body, initial]);

  async function save() {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave(body.trim(), pinned);
      saveDraft(draftId, '');
      setBody('');
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="note-editor">
      <textarea value={body} rows={4} autoFocus={autoFocus} placeholder={t('chart.notePlaceholder')}
                onChange={(e) => setBody(e.target.value)} />
      {error && <Alert kind="error">{error}</Alert>}
      <div className="inline">
        {pinnable && (
          <label className="check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />{t('chart.pinAsAlert')}</label>
        )}
        <span className="spacer" />
        {onCancel && <button type="button" className="btn-ghost btn-sm" onClick={() => { saveDraft(draftId, ''); onCancel(); }}><X size={14} />{t('customer.cancel')}</button>}
        <button type="button" className="btn-primary btn-sm" disabled={busy || !body.trim()} onClick={() => void save()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}{t('customer.save')}
        </button>
      </div>
    </div>
  );
}

function NoteItem({ note, customerId }: { note: ChartNote; customerId: string }) {
  const { t } = useTranslation();
  const names = useStaffNames();
  const invalidate = useInvalidateChart(customerId);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const edited = note.updated_at !== note.created_at && Date.parse(note.updated_at) - Date.parse(note.created_at) > 1000;
  const who = note.created_by ? names.data?.get(note.created_by) : undefined;

  async function run(fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); await invalidate(); } catch (e) { setError(errorText(t, e)); }
  }

  if (editing) {
    return (
      <NoteEditor draftId={`edit:${note.id}`} initial={note.body} autoFocus
                  onCancel={() => setEditing(false)}
                  onSave={async (body) => { await updateNote(note.id, { body }); await invalidate(); setEditing(false); }} />
    );
  }
  return (
    <div className={`note ${note.pinned ? 'note-pinned' : ''}`}>
      <div className="note-body">{note.body}</div>
      <div className="note-meta">
        <span>{fmtTime(note.created_at)}{who ? ` · ${who}` : ''}{edited ? ` · ${t('chart.edited')}` : ''}</span>
        <span className="spacer" />
        {confirmDelete ? (
          <>
            <span className="small">{t('chart.deleteConfirm')}</span>
            <button type="button" className="btn-danger btn-sm" onClick={() => void run(() => deleteNote(note.id))}><Trash2 size={13} />{t('chart.delete')}</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}><X size={13} /></button>
          </>
        ) : (
          <>
            {note.visit_id === null && (
              <button type="button" className="btn-ghost btn-sm" title={note.pinned ? t('chart.unpin') : t('chart.pinAsAlert')}
                      onClick={() => void run(() => updateNote(note.id, { pinned: !note.pinned }))}>
                {note.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
            )}
            <button type="button" className="btn-ghost btn-sm" title={t('customer.edit')} onClick={() => setEditing(true)}><Pencil size={13} /></button>
            <button type="button" className="btn-ghost btn-sm" title={t('chart.delete')} onClick={() => setConfirmDelete(true)}><Trash2 size={13} /></button>
          </>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}

function Thumb({ photo, onOpen }: { photo: ChartPhoto; onOpen: (p: ChartPhoto) => void }) {
  const url = useChartImage(photo.path);
  return (
    <button type="button" className="thumb" onClick={() => onOpen(photo)} title={photo.caption ?? ''}>
      {url.data ? <img src={url.data} alt={photo.caption ?? ''} loading="lazy" /> : url.isError ? <ImageOff size={18} /> : <Loader2 size={18} className="spin" />}
    </button>
  );
}

function Lightbox({ photo, customerId, onClose }: { photo: ChartPhoto; customerId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const url = useChartImage(photo.path);
  const invalidate = useInvalidateChart(customerId);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal onClick={onClose}>
      <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
        {url.data && <img src={url.data} alt={photo.caption ?? ''} />}
        <div className="inline">
          <span className="small muted">{fmtTime(photo.created_at)}{photo.caption ? ` · ${photo.caption}` : ''}</span>
          <span className="spacer" />
          {confirm ? (
            <button type="button" className="btn-danger btn-sm"
                    onClick={() => void deletePhoto(photo.id).then(invalidate).then(onClose).catch((e) => setError(errorText(t, e)))}>
              <Trash2 size={14} />{t('chart.deletePhotoConfirm')}
            </button>
          ) : (
            <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirm(true)}><Trash2 size={14} />{t('chart.delete')}</button>
          )}
          <button type="button" className="btn-sm" onClick={onClose}><X size={14} />{t('chart.close')}</button>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
      </div>
    </div>
  );
}

export function PhotoGrid({ photos, customerId }: { photos: ChartPhoto[]; customerId: string }) {
  const [open, setOpen] = useState<ChartPhoto | null>(null);
  if (!photos.length) return null;
  return (
    <>
      <div className="thumbs">{photos.map((p) => <Thumb key={p.id} photo={p} onOpen={setOpen} />)}</div>
      {open && <Lightbox photo={open} customerId={customerId} onClose={() => setOpen(null)} />}
    </>
  );
}

export function PhotoButton({ customerId, visitId }: { customerId: string; visitId: string | null }) {
  const { t } = useTranslation();
  const staff = useStaff();
  const invalidate = useInvalidateChart(customerId);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState('');

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setError('');
    const list = Array.from(files).slice(0, 10);
    setBusy(list.length);
    for (const file of list) {
      try {
        await uploadPhoto({ store_id: staff.store_id, customer_id: customerId, visit_id: visitId, file });
      } catch (e) {
        setError(e instanceof Error && e.message === 'image_unreadable' ? t('chart.photoUnreadable') : errorText(t, e));
      }
      setBusy((n) => n - 1);
    }
    if (input.current) input.current.value = '';
    await invalidate();
  }

  return (
    <>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
      <button type="button" className="btn-sm" disabled={busy > 0} onClick={() => input.current?.click()}>
        {busy > 0 ? <Loader2 size={14} className="spin" /> : <Camera size={14} />}
        {busy > 0 ? t('chart.uploading', { count: busy }) : t('chart.addPhoto')}
      </button>
      {error && <Alert kind="error">{error}</Alert>}
    </>
  );
}

/** 1 回の来院のカルテ(メモと写真)。記録画面と患者詳細の両方で使う */
export function VisitChart({ customerId, visitId, notes, photos, startOpen = false }: {
  customerId: string; visitId: string; notes: ChartNote[]; photos: ChartPhoto[]; startOpen?: boolean;
}) {
  const { t } = useTranslation();
  const staff = useStaff();
  const invalidate = useInvalidateChart(customerId);
  const mine = notes.filter((n) => n.visit_id === visitId).slice().reverse();
  const pics = photos.filter((p) => p.visit_id === visitId);
  const [adding, setAdding] = useState(startOpen || !!readDraft(`visit:${visitId}`));

  return (
    <div className="visit-chart">
      {mine.map((n) => <NoteItem key={n.id} note={n} customerId={customerId} />)}
      <PhotoGrid photos={pics} customerId={customerId} />
      {adding ? (
        <NoteEditor draftId={`visit:${visitId}`} autoFocus={!startOpen}
                    onCancel={startOpen ? undefined : () => setAdding(false)}
                    onSave={async (body) => {
                      await addNote({ store_id: staff.store_id, customer_id: customerId, visit_id: visitId, body });
                      await invalidate();
                      if (!startOpen) setAdding(false);
                    }} />
      ) : (
        <div className="inline">
          <button type="button" className="btn-sm" onClick={() => setAdding(true)}><Plus size={14} />{t('chart.addNote')}</button>
          <PhotoButton customerId={customerId} visitId={visitId} />
        </div>
      )}
      {adding && <div className="inline"><PhotoButton customerId={customerId} visitId={visitId} /></div>}
    </div>
  );
}

/** 注意事項(ピン留めしたメモ)。記録画面の上に常に出す */
export function PinnedAlerts({ customerId }: { customerId: string }) {
  const notes = useChartNotes(customerId);
  const pinned = (notes.data ?? []).filter((n) => n.pinned && n.visit_id === null);
  if (!pinned.length) return null;
  return (
    <div className="pinned-alerts">
      {pinned.map((n) => (
        <div key={n.id} className="alert alert-warn"><ShieldAlert size={18} /><div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div></div>
      ))}
    </div>
  );
}

/** 患者全体のメモ(来院に付かないもの。注意事項はピン留め) */
export function GeneralNotes({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const staff = useStaff();
  const invalidate = useInvalidateChart(customerId);
  const notes = useChartNotes(customerId);
  const [adding, setAdding] = useState(() => !!readDraft(`customer:${customerId}`));
  const general = (notes.data ?? []).filter((n) => n.visit_id === null)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at));
  return (
    <div className="visit-chart">
      {general.length === 0 && !adding && <p className="muted small" style={{ margin: 0 }}>{t('chart.noGeneral')}</p>}
      {general.map((n) => <NoteItem key={n.id} note={n} customerId={customerId} />)}
      {adding ? (
        <NoteEditor draftId={`customer:${customerId}`} pinnable autoFocus onCancel={() => setAdding(false)}
                    onSave={async (body, pinned) => {
                      await addNote({ store_id: staff.store_id, customer_id: customerId, visit_id: null, body, pinned });
                      await invalidate();
                      setAdding(false);
                    }} />
      ) : (
        <div className="inline">
          <button type="button" className="btn-sm" onClick={() => setAdding(true)}><Plus size={14} />{t('chart.addNote')}</button>
        </div>
      )}
    </div>
  );
}

export { useChartNotes, useChartPhotos };
