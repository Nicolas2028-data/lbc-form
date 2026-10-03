// 問診票(初回のお客様。ログイン不要、ja/pt/es)
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, CheckCircle2, ClipboardList, FileSignature, HeartPulse, Leaf, Send, ShieldCheck, UserRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { newRequestId } from '../lib/rpc';
import { DrawPad, type DrawPadHandle } from '../components/DrawPad';
import { Alert } from '../ui';
import { LangSwitch } from './StaffLayout';

const STORE_ID = import.meta.env.VITE_STORE_ID as string;

const HOW = [['instagram', 'how_instagram'], ['google', 'how_google'], ['google_maps', 'how_google_maps'], ['referral', 'how_referral'], ['other', 'how_other_found']] as const;
const SYMPTOMS = [['shoulder_stiff', 'sym_shoulder'], ['lower_back', 'sym_lower_back'], ['neck_stiff', 'sym_neck'], ['headache', 'sym_headache'], ['posture', 'sym_posture'], ['fatigue', 'sym_fatigue'], ['swelling', 'sym_swelling'], ['other', 'sym_other']] as const;
const DURATIONS = [['within_week', 'dur_week'], ['within_month', 'dur_month'], ['over_month', 'dur_over_month'], ['over_half_year', 'dur_half_year'], ['other', 'dur_other']] as const;
const SAFETY = [['pregnant', 'safety_pregnant', 'ph_detail_pregnant'], ['hospital', 'safety_hospital', 'ph_detail_hospital'], ['osteoporosis', 'safety_osteoporosis', null], ['blood_thinner', 'safety_blood_thinner', 'ph_detail_blood_thinner'], ['numbness', 'safety_numbness', 'ph_detail_numbness'], ['recent_injury', 'safety_injury', 'ph_detail_injury'], ['none', 'safety_none', null]] as const;
const GOALS = [['relax', 'goal_relax'], ['pain_relief', 'goal_pain'], ['posture_goal', 'goal_posture'], ['maintenance', 'goal_maintenance']] as const;
const STRENGTHS = [['light', 'strength_light'], ['normal', 'strength_normal'], ['strong', 'strength_strong']] as const;
const DISLIKED = [['strong_pressure', 'dis_pressure'], ['joint_adjustment', 'dis_joint'], ['none', 'dis_none']] as const;

type Errors = Record<string, string>;

const SERVER_ERRORS: Record<string, string> = {
  phone_invalid: 'e_phone', birth_date_invalid: 'e_dob', name_invalid: 'e_sei', consent_required: 'e_consent',
  signature_required: 'e_signature', too_many_submissions: 'err_srv',
};

function Section({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card fade-in">
      <div className="card-head"><span className="icon">{icon}</span><h2>{title}</h2></div>
      <div className="card-body">
        {hint && <p className="muted small">{hint}</p>}
        {children}
      </div>
    </section>
  );
}

function Q({ label, required, error, children }: { label: string; required?: boolean; error?: string; children: ReactNode }) {
  const { t } = useTranslation('q');
  return (
    <div className="field" data-error={error ? '1' : undefined}>
      <span>{label} <span className={`badge ${required ? 'badge-danger' : ''}`} style={{ height: 20, fontSize: '0.7rem' }}>{required ? t('req') : t('opt')}</span></span>
      {children}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

function Choices({ name, options, value, onChange, multi, cols }: {
  name: string; options: readonly (readonly [string, string, ...unknown[]])[]; value: string | string[];
  onChange: (v: string) => void; multi?: boolean; cols?: 'compact';
}) {
  const { t } = useTranslation('q');
  const on = (v: string) => (multi ? (value as string[]).includes(v) : value === v);
  return (
    <div className={`choice-grid ${cols ?? ''}`}>
      {options.map(([v, key]) => (
        <label key={v} className={`choice ${on(v) ? 'on' : ''}`}>
          <input type={multi ? 'checkbox' : 'radio'} name={name} checked={on(v)} onChange={() => onChange(v)} />
          {multi && <span className={`tick ${on(v) ? 'on' : ''}`}>{on(v) ? '✓' : ''}</span>}
          <span className="choice-label">{t(key)}</span>
        </label>
      ))}
    </div>
  );
}

const toggle = (arr: string[], v: string, exclusive = 'none') => {
  if (v === exclusive) return arr.includes(v) ? [] : [v];
  const next = arr.filter((x) => x !== exclusive);
  return next.includes(v) ? next.filter((x) => x !== v) : [...next, v];
};

export default function Questionnaire() {
  const { t, i18n } = useTranslation('q');
  const [done, setDone] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const lang = (['ja', 'pt', 'es'].includes(i18n.language) ? i18n.language : 'ja') as 'ja' | 'pt' | 'es';

  return (
    <main className="q-wrap">
      <header className="q-top">
        <span className="brand"><span className="brand-mark"><Leaf size={18} /></span><span>LBC Care</span></span>
        <LangSwitch />
      </header>
      <div className="q-hero">
        <span className="q-hero-icon"><ClipboardList size={26} /></span>
        <h1>{t('heroTitle')}</h1>
      </div>
      {done ? (
        <section className="card card-pad fade-in q-done">
          <CheckCircle2 size={56} color="var(--accent)" />
          <h1>{t('s_title')}</h1>
          <p className="muted">{t('s_msg')}</p>
          <button type="button" onClick={() => { setDone(false); setFormKey((k) => k + 1); window.scrollTo(0, 0); }}>{t('s_back')}</button>
        </section>
      ) : (
        <QuestionnaireForm key={formKey} lang={lang} onDone={() => { setDone(true); window.scrollTo(0, 0); }} />
      )}
    </main>
  );
}

function QuestionnaireForm({ lang, onDone }: { lang: 'ja' | 'pt' | 'es'; onDone: () => void }) {
  const { t } = useTranslation('q');
  const [requestId] = useState(newRequestId);
  const body = useRef<DrawPadHandle>(null);
  const sig = useRef<DrawPadHandle>(null);
  const [sigEmpty, setSigEmpty] = useState(true);

  const [f, setF] = useState({
    sei: '', mei: '', seiKana: '', meiKana: '', phone: '', dob: '', email: '',
    howFound: '', referrerName: '', howFoundOther: '',
    mainSymptom: [] as string[], mainSymptomOther: '', duration: '', durationOther: '', pain: 5,
    safety: [] as string[], safetyDetail: {} as Record<string, string>, safetyNote: '',
    goal: '', strength: '', disliked: [] as string[], photo: '', face: '', consent: false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const painLabels = t('pain_labels').split(',');

  function validate(): Errors {
    const e: Errors = {};
    if (!f.sei.trim()) e.sei = t('e_sei');
    if (!f.mei.trim()) e.mei = t('e_mei');
    if (lang === 'ja' && !f.seiKana.trim()) e.seiKana = t('e_seiKana');
    if (lang === 'ja' && !f.meiKana.trim()) e.meiKana = t('e_meiKana');
    if (!/^0\d{9,10}$/.test(f.phone.replace(/\D/g, ''))) e.phone = t('e_phone');
    if (!f.dob) e.dob = t('e_dob');
    if (!f.howFound) e.howFound = t('e_howFound');
    if (!f.mainSymptom.length) e.mainSymptom = t('e_mainSymptom');
    if (!f.duration) e.duration = t('e_symptomDuration');
    if (!f.safety.length) e.safety = t('e_safety');
    if (!f.goal) e.goal = t('e_treatmentGoal');
    if (!f.strength) e.strength = t('e_treatmentStrength');
    if (!f.disliked.length) e.disliked = t('e_disliked');
    if (!f.photo) e.photo = t('e_photoConsent');
    if (f.photo === 'yes' && !f.face) e.face = t('e_facePreference');
    if (!f.consent) e.consent = t('e_consent');
    if (sigEmpty) e.signature = t('e_signature');
    return e;
  }

  // 画像のアップロード(再送で「すでにある」と言われたら成功扱い)
  async function upload(path: string, blob: Blob) {
    for (let i = 0; i < 3; i++) {
      const { error } = await supabase.storage.from('questionnaire').upload(path, blob, { contentType: 'image/png', upsert: false });
      if (!error || /exists|duplicate/i.test(error.message)) return;
      if (i === 2) throw error;
      await new Promise((r) => setTimeout(r, 600 * 2 ** i));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setServerError('');
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) {
      requestAnimationFrame(() => document.querySelector('[data-error="1"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      return;
    }
    setBusy(true);
    try {
      const images: Record<string, string> = {};
      const sigBlob = await sig.current!.toBlob();
      if (!sigBlob) throw new Error('signature');
      images.signature = `q/${requestId}/signature.png`;
      await upload(images.signature, sigBlob);
      if (body.current && !body.current.isEmpty()) {
        const b = await body.current.toBlob();
        if (b) { images.body = `q/${requestId}/body.png`; await upload(images.body, b); }
      }
      const payload = {
        request_id: requestId, store_id: STORE_ID, lang,
        name: `${f.sei.trim()} ${f.mei.trim()}`,
        furigana: [f.seiKana.trim(), f.meiKana.trim()].filter(Boolean).join(' '),
        phone: f.phone, birth_date: f.dob, email: f.email, how_found: f.howFound,
        image_paths: images,
        answers: {
          main_symptom: f.mainSymptom, main_symptom_other: f.mainSymptom.includes('other') ? f.mainSymptomOther : '',
          symptom_duration: f.duration, symptom_duration_other: f.duration === 'other' ? f.durationOther : '',
          pain_level: f.pain, safety: f.safety,
          safety_detail: Object.fromEntries(Object.entries(f.safetyDetail).filter(([k, v]) => f.safety.includes(k) && v.trim())),
          safety_note: f.safetyNote, treatment_goal: f.goal, treatment_strength: f.strength, disliked: f.disliked,
          photo_consent: f.photo, face_preference: f.photo === 'yes' ? f.face : null, consent_agreed: f.consent,
          referrer_name: f.howFound === 'referral' ? f.referrerName : '', how_found_other: f.howFound === 'other' ? f.howFoundOther : '',
          consent_date: new Date().toISOString().slice(0, 10),
        },
      };
      let lastErr: unknown = null;
      for (let i = 0; i < 3; i++) {
        const { error } = await supabase.rpc('submit_questionnaire', { p: payload });
        if (!error) { onDone(); return; }
        if (error.code === 'P0001') {
          const key = SERVER_ERRORS[error.message] ?? 'err_srv';
          setServerError(t(key));
          return;
        }
        lastErr = error;
        await new Promise((r) => setTimeout(r, 600 * 2 ** i));
      }
      throw lastErr;
    } catch {
      setServerError(t('err_net'));   // 入力内容はそのまま残るので、もう一度送信できる
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="q-form" noValidate>
      <Section icon={<UserRound size={18} />} title={t('t_basic')}>
        <Q label={t('lbl_nameGroup')} required error={errors.sei || errors.mei}>
          <div className="grid-2 tight">
            <input placeholder={t('ph_sei')} aria-label={t('lbl_sei')} value={f.sei} onChange={(e) => set('sei', e.target.value)} autoComplete="family-name" />
            <input placeholder={t('ph_mei')} aria-label={t('lbl_mei')} value={f.mei} onChange={(e) => set('mei', e.target.value)} autoComplete="given-name" />
          </div>
        </Q>
        <Q label={t('lbl_furiganaGroup')} required={lang === 'ja'} error={errors.seiKana || errors.meiKana}>
          <div className="grid-2 tight">
            <input placeholder={t('ph_seiKana')} aria-label={t('lbl_seiKana')} value={f.seiKana} onChange={(e) => set('seiKana', e.target.value)} />
            <input placeholder={t('ph_meiKana')} aria-label={t('lbl_meiKana')} value={f.meiKana} onChange={(e) => set('meiKana', e.target.value)} />
          </div>
        </Q>
        <Q label={t('lbl_phone')} required error={errors.phone}>
          <input type="tel" inputMode="numeric" placeholder={t('ph_phone')} value={f.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" />
        </Q>
        <Q label={t('lbl_dob')} required error={errors.dob}>
          <input type="date" value={f.dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => set('dob', e.target.value)} />
        </Q>
        <Q label={t('lbl_email')}>
          <input type="email" placeholder={t('ph_email')} value={f.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" />
        </Q>
        <Q label={t('lbl_howFound')} required error={errors.howFound}>
          <Choices name="howFound" options={HOW} value={f.howFound} onChange={(v) => set('howFound', v)} cols="compact" />
          {f.howFound === 'referral' && <input placeholder={t('ph_referrer')} value={f.referrerName} maxLength={60} onChange={(e) => set('referrerName', e.target.value)} />}
          {f.howFound === 'other' && <input placeholder={t('ph_howFound_other')} value={f.howFoundOther} maxLength={200} onChange={(e) => set('howFoundOther', e.target.value)} />}
        </Q>
      </Section>

      <Section icon={<HeartPulse size={18} />} title={t('t_s2')}>
        <Q label={t('lbl_bodyMap')}>
          <DrawPad ref={body} background="/body-diagram.png" aspect={1536 / 1024} clearLabel={t('q_clear')} hint={t('q_drawHint')} />
        </Q>
        <Q label={t('lbl_mainSymptom')} required error={errors.mainSymptom}>
          <Choices name="mainSymptom" options={SYMPTOMS} value={f.mainSymptom} multi cols="compact"
                   onChange={(v) => set('mainSymptom', f.mainSymptom.includes(v) ? f.mainSymptom.filter((x) => x !== v) : [...f.mainSymptom, v])} />
          {f.mainSymptom.includes('other') && <input placeholder={t('ph_mainSymptom_other')} value={f.mainSymptomOther} maxLength={300} onChange={(e) => set('mainSymptomOther', e.target.value)} />}
        </Q>
        <Q label={t('lbl_symptomDuration')} required error={errors.duration}>
          <Choices name="duration" options={DURATIONS} value={f.duration} onChange={(v) => set('duration', v)} cols="compact" />
          {f.duration === 'other' && <input placeholder={t('ph_dur_other')} value={f.durationOther} maxLength={200} onChange={(e) => set('durationOther', e.target.value)} />}
        </Q>
        <Q label={t('lbl_painLevel')} required>
          <div className="pain">
            <div className="pain-value"><strong>{f.pain}</strong><span>{painLabels[f.pain] || ''}</span></div>
            <input type="range" min={0} max={10} step={1} value={f.pain} onChange={(e) => set('pain', Number(e.target.value))}
                   style={{ ['--p' as string]: `${f.pain * 10}%` }} />
            <div className="pain-scale"><span>{t('pain_min_label')}</span><span>{t('pain_max_label')}</span></div>
          </div>
        </Q>
      </Section>

      <Section icon={<ShieldCheck size={18} />} title={t('t_s3')} hint={t('s3_hint')}>
        <Q label={t('t_s3')} required error={errors.safety}>
          <div style={{ display: 'grid', gap: 10 }}>
            {SAFETY.map(([v, key, ph]) => (
              <div key={v} style={{ display: 'grid', gap: 8 }}>
                <label className={`choice ${f.safety.includes(v) ? 'on' : ''}`}>
                  <input type="checkbox" checked={f.safety.includes(v)} onChange={() => set('safety', toggle(f.safety, v))} />
                  <span className={`tick ${f.safety.includes(v) ? 'on' : ''}`}>{f.safety.includes(v) ? '✓' : ''}</span>
                  <span className="choice-label">{t(key)}</span>
                </label>
                {ph && f.safety.includes(v) && (
                  <input placeholder={t(ph)} value={f.safetyDetail[v] ?? ''} maxLength={300}
                         onChange={(e) => set('safetyDetail', { ...f.safetyDetail, [v]: e.target.value })} />
                )}
              </div>
            ))}
          </div>
        </Q>
        <Q label={t('lbl_safetyNote')}>
          <textarea value={f.safetyNote} maxLength={500} onChange={(e) => set('safetyNote', e.target.value)} />
        </Q>
      </Section>

      <Section icon={<ClipboardList size={18} />} title={t('t_s4')}>
        <Q label={t('lbl_treatmentGoal')} required error={errors.goal}>
          <Choices name="goal" options={GOALS} value={f.goal} onChange={(v) => set('goal', v)} />
        </Q>
        <Q label={t('lbl_treatmentStrength')} required error={errors.strength}>
          <Choices name="strength" options={STRENGTHS} value={f.strength} onChange={(v) => set('strength', v)} cols="compact" />
        </Q>
        <Q label={t('lbl_disliked')} required error={errors.disliked}>
          <Choices name="disliked" options={DISLIKED} value={f.disliked} multi onChange={(v) => set('disliked', toggle(f.disliked, v))} />
        </Q>
      </Section>

      <Section icon={<Camera size={18} />} title={t('t_s_photo')}>
        <Q label={t('t_photo_q')} required error={errors.photo}>
          <Choices name="photo" options={[['yes', 'lbl_photo_yes'], ['no', 'lbl_photo_no']]} value={f.photo} onChange={(v) => set('photo', v)} />
        </Q>
        {f.photo === 'yes' && (
          <Q label={t('lbl_face_q')} required error={errors.face}>
            <Choices name="face" options={[['face_ok', 'lbl_face_ok'], ['no_face', 'lbl_face_no']]} value={f.face} onChange={(v) => set('face', v)} />
          </Q>
        )}
      </Section>

      <Section icon={<FileSignature size={18} />} title={t('t_s5')}>
        <ol className="consent-list">
          <li>
            {t('consent_1')}
            <details><summary>{t('consent_1_expand')}</summary><div className="muted small" dangerouslySetInnerHTML={{ __html: t('consent_1_body') }} /></details>
          </li>
          <li>{t('consent_2')}</li><li>{t('consent_3')}</li><li>{t('consent_4')}</li><li>{t('consent_5')}</li>
        </ol>
        <p className="muted small">{t('consent_disclaimer')}</p>
        <div data-error={errors.consent ? '1' : undefined}>
          <label className={`choice ${f.consent ? 'on' : ''}`}>
            <input type="checkbox" checked={f.consent} onChange={(e) => set('consent', e.target.checked)} />
            <span className={`tick ${f.consent ? 'on' : ''}`}>{f.consent ? '✓' : ''}</span>
            <span className="choice-label">{t('lbl_consentAgree')}</span>
          </label>
          {errors.consent && <span className="error small">{errors.consent}</span>}
        </div>
        <Q label={t('lbl_signature')} required error={errors.signature}>
          <DrawPad ref={sig} aspect={3} color="#111827" lineWidth={3} clearLabel={t('sig_clear')} hint={t('sig_hint')} onChange={setSigEmpty} />
        </Q>
        <p className="muted small">{t('lbl_date')} {new Date().toLocaleDateString(lang === 'ja' ? 'ja-JP' : lang === 'pt' ? 'pt-BR' : 'es')}</p>
      </Section>

      {serverError && <Alert kind="error">{serverError}</Alert>}
      {Object.keys(errors).length > 0 && <Alert kind="error">{Object.values(errors)[0]}</Alert>}

      <button className="btn-primary btn-lg btn-block" disabled={busy}>
        <Send size={18} />{busy ? t('t_submitting') : t('l_submit')}
      </button>
    </form>
  );
}
