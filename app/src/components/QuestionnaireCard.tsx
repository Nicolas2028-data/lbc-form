// スタッフ用: 患者の問診票を表示(選択肢は問診票と同じ文言で、スタッフの表示言語に合わせる)
import { useTranslation } from 'react-i18next';
import { ClipboardList, ImageOff } from 'lucide-react';
import { useQuestionnaires, useSignedImage, errorText, type QuestionnaireRow } from '../lib/data';
import { Card, ErrorBox, Loading } from '../ui';
import { tokyoDate } from '../lib/booking';

const LABEL: Record<string, Record<string, string>> = {
  main_symptom: { shoulder_stiff: 'sym_shoulder', lower_back: 'sym_lower_back', neck_stiff: 'sym_neck', headache: 'sym_headache', posture: 'sym_posture', fatigue: 'sym_fatigue', swelling: 'sym_swelling', other: 'sym_other' },
  symptom_duration: { within_week: 'dur_week', within_month: 'dur_month', over_month: 'dur_over_month', over_half_year: 'dur_half_year', other: 'dur_other' },
  safety: { pregnant: 'safety_pregnant', hospital: 'safety_hospital', osteoporosis: 'safety_osteoporosis', blood_thinner: 'safety_blood_thinner', numbness: 'safety_numbness', recent_injury: 'safety_injury', none: 'safety_none' },
  treatment_goal: { relax: 'goal_relax', pain_relief: 'goal_pain', posture_goal: 'goal_posture', maintenance: 'goal_maintenance' },
  treatment_strength: { light: 'strength_light', normal: 'strength_normal', strong: 'strength_strong' },
  disliked: { strong_pressure: 'dis_pressure', joint_adjustment: 'dis_joint', none: 'dis_none' },
  photo_consent: { yes: 'lbl_photo_yes', no: 'lbl_photo_no' },
  face_preference: { face_ok: 'lbl_face_ok', no_face: 'lbl_face_no' },
};

function Img({ path, alt }: { path?: string; alt: string }) {
  const url = useSignedImage(path);
  if (!path) return null;
  if (url.isPending) return <div className="skeleton" style={{ height: 120 }} />;
  if (url.isError) return <div className="empty"><ImageOff size={20} /></div>;
  return <img src={url.data} alt={alt} style={{ width: '100%', maxHeight: 280, objectFit: 'contain', borderRadius: 12, border: '1px solid var(--border)', background: '#fff' }} />;
}

/** 問診の回答を「項目名・内容」の行にする(画面・印刷・Excel で共通)。t は 'q' の翻訳 */
export function questionnaireRows(q: QuestionnaireRow, t: (k: string) => string): [string, string][] {
  const a = q.answers as Record<string, string | string[] | number | boolean | Record<string, string> | null>;
  const show = (field: string) => {
    const v = a[field];
    const map = LABEL[field];
    if (Array.isArray(v)) return v.map((x) => (map?.[x] ? t(map[x]) : x)).join('、');
    if (typeof v === 'string' && map?.[v]) return t(map[v]);
    return v == null || v === '' ? '—' : String(v);
  };
  const detail = (a.safety_detail ?? {}) as Record<string, string>;
  const rows: [string, string][] = [
    [t('lbl_mainSymptom'), show('main_symptom') + (a.main_symptom_other ? `(${a.main_symptom_other})` : '')],
    [t('lbl_symptomDuration'), show('symptom_duration') + (a.symptom_duration_other ? `(${a.symptom_duration_other})` : '')],
    [t('lbl_painLevel'), `${a.pain_level} / 10`],
    [t('t_s3'), show('safety') + Object.entries(detail).map(([k, v]) => `\n・${t(LABEL.safety[k] ?? k)}: ${v}`).join('')],
    [t('lbl_safetyNote'), show('safety_note')],
    [t('lbl_treatmentGoal'), show('treatment_goal')],
    [t('lbl_treatmentStrength'), show('treatment_strength')],
    [t('lbl_disliked'), show('disliked')],
    [t('t_s_photo'), show('photo_consent') + (a.face_preference ? ` / ${show('face_preference')}` : '')],
  ];
  if (a.referrer_name) rows.push([t('how_referral'), String(a.referrer_name)]);
  return rows;
}

function One({ q }: { q: QuestionnaireRow }) {
  const { t } = useTranslation('q');
  const { t: tStaff } = useTranslation();
  const rows = questionnaireRows(q, t);
  return (
    <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="inline">
        <span className="badge">{tokyoDate(q.submitted_at)}</span><span className="badge">{q.lang.toUpperCase()}</span>
        {q.matched_existing && <span className="badge badge-warn">{tStaff('customer.matchedExisting')}</span>}
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 34%) 1fr', gap: '10px 18px', margin: 0 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className="label">{k}</dt><dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="grid-2">
        <Img path={q.image_paths.body} alt={t('lbl_bodyMap')} />
        <Img path={q.image_paths.signature} alt={t('lbl_signature')} />
      </div>
    </div>
  );
}

export function QuestionnaireCard({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const qs = useQuestionnaires(customerId);
  return (
    <Card title={t('customer.questionnaire')} icon={<ClipboardList size={18} />} pad={false}>
      {qs.isPending ? <Loading /> : qs.isError ? (
        <div className="card-body"><ErrorBox text={errorText(t, qs.error)} onRetry={() => void qs.refetch()} /></div>
      ) : qs.data.length === 0 ? <div className="empty">{t('customer.noQuestionnaire')}</div> : qs.data.map((q) => <One key={q.id} q={q} />)}
    </Card>
  );
}
