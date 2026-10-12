import { useState } from 'react';

type Lang = 'ja' | 'es' | 'pt';

const content: Record<Lang, { title: string; body: string }> = {
  ja: {
    title: 'プライバシーポリシー',
    body: `
<h2>1. 個人情報の取り扱いについて</h2>
<p>LBC整体院（以下「当院」）は、お客様の個人情報を以下のとおり適切に管理・利用します。</p>

<h2>2. 取得する情報</h2>
<p>当院は、施術に必要な以下の情報を取得します：</p>
<ul>
  <li>氏名・フリガナ・生年月日・電話番号・メールアドレス</li>
  <li><strong>要配慮個人情報</strong>：既往歴、病歴、身体の状態（妊娠・骨粗しょう症・服薬状況等）、症状・痛みレベル、施術内容</li>
  <li>署名（施術同意）</li>
</ul>

<h2>3. 利用目的</h2>
<p>取得した個人情報は、以下の目的にのみ使用します：</p>
<ul>
  <li>施術内容の決定および安全な施術の提供</li>
  <li>施術記録の管理</li>
  <li>お客様へのご連絡</li>
</ul>

<h2>4. 第三者提供</h2>
<p>法令に基づく場合を除き、お客様の同意なく個人情報を第三者に提供することはありません。</p>

<h2>5. データの保管</h2>
<p>個人情報はSupabase（東京リージョン、日本国内）のデータベースに暗号化して保存します。施術写真はGoogle Drive（アクセス制限あり）に保存します。</p>

<h2>6. 情報漏洩時の対応</h2>
<p>万が一個人情報の漏洩が発生した場合、速やかにお客様へご連絡するとともに、再発防止策を講じます。</p>

<h2>7. 個人情報の開示・訂正・削除</h2>
<p>ご自身の個人情報の開示・訂正・削除をご希望の場合は、以下の連絡先までお問い合わせください。</p>

<h2>8. 管理者</h2>
<p>LBC整体院<br/>所在地：三重県四日市市<br/>お問い合わせは受付スタッフまでお申し付けください。</p>

<h2>9. 改定</h2>
<p>本ポリシーは、法令改定や運用変更に伴い予告なく改定することがあります。最新版を本ページにてご確認ください。</p>
    `,
  },
  es: {
    title: 'Política de Privacidad',
    body: `
<h2>1. Manejo de Información Personal</h2>
<p>LBC Care (en adelante "la clínica") gestiona la información personal de los clientes de la siguiente manera:</p>

<h2>2. Información Recopilada</h2>
<p>Recopilamos la siguiente información necesaria para el tratamiento:</p>
<ul>
  <li>Nombre, furigana, fecha de nacimiento, teléfono, correo electrónico</li>
  <li><strong>Información sensible</strong>: historial médico, enfermedades, estado físico (embarazo, osteoporosis, medicamentos, etc.), síntomas, nivel de dolor, contenido del tratamiento</li>
  <li>Firma (consentimiento de tratamiento)</li>
</ul>

<h2>3. Finalidad del Uso</h2>
<ul>
  <li>Determinar y brindar tratamientos seguros</li>
  <li>Gestión de registros de tratamiento</li>
  <li>Comunicación con el cliente</li>
</ul>

<h2>4. Terceros</h2>
<p>No compartiremos información personal con terceros sin el consentimiento del cliente, excepto cuando lo exija la ley.</p>

<h2>5. Almacenamiento de Datos</h2>
<p>Los datos se almacenan en Supabase (región Tokio, Japón) de forma cifrada. Las fotos de tratamiento se guardan en Google Drive con acceso restringido.</p>

<h2>6. Respuesta ante Filtraciones</h2>
<p>En caso de fuga de información, notificaremos a los afectados de inmediato y tomaremos medidas preventivas.</p>

<h2>7. Acceso y Corrección</h2>
<p>Para solicitar acceso, corrección o eliminación de su información, comuníquese con el personal de recepción.</p>

<h2>8. Responsable</h2>
<p>LBC Care<br/>Yokkaichi, Mie, Japón<br/>Consulte al personal de recepción para cualquier duda.</p>
    `,
  },
  pt: {
    title: 'Política de Privacidade',
    body: `
<h2>1. Tratamento de Informações Pessoais</h2>
<p>LBC Care (doravante "a clínica") gerencia as informações pessoais dos clientes da seguinte forma:</p>

<h2>2. Informações Coletadas</h2>
<p>Coletamos as seguintes informações necessárias para o tratamento:</p>
<ul>
  <li>Nome, furigana, data de nascimento, telefone, e-mail</li>
  <li><strong>Informações sensíveis</strong>: histórico médico, doenças, estado físico (gravidez, osteoporose, medicamentos, etc.), sintomas, nível de dor, conteúdo do tratamento</li>
  <li>Assinatura (consentimento de tratamento)</li>
</ul>

<h2>3. Finalidade do Uso</h2>
<ul>
  <li>Determinar e oferecer tratamentos seguros</li>
  <li>Gerenciamento de registros de tratamento</li>
  <li>Comunicação com o cliente</li>
</ul>

<h2>4. Terceiros</h2>
<p>Não compartilharemos informações pessoais com terceiros sem o consentimento do cliente, exceto quando exigido por lei.</p>

<h2>5. Armazenamento de Dados</h2>
<p>Os dados são armazenados de forma criptografada no Supabase (região Tóquio, Japão). As fotos de tratamento são salvas no Google Drive com acesso restrito.</p>

<h2>6. Resposta a Vazamentos</h2>
<p>Em caso de vazamento de informações, notificaremos os afetados imediatamente e tomaremos medidas preventivas.</p>

<h2>7. Acesso e Correção</h2>
<p>Para solicitar acesso, correção ou exclusão das suas informações, entre em contato com o pessoal da recepção.</p>

<h2>8. Responsável</h2>
<p>LBC Care<br/>Yokkaichi, Mie, Japão<br/>Consulte o pessoal da recepção para qualquer dúvida.</p>
    `,
  },
};

export default function Privacy() {
  const [lang, setLang] = useState<Lang>('ja');
  const { title, body } = content[lang];

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1rem', fontFamily: 'inherit' }}>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        {(['ja', 'es', 'pt'] as Lang[]).map((l) => (
          <button
            key={l}
            onClick={() => setLang(l)}
            style={{
              padding: '0.25rem 0.75rem',
              borderRadius: 6,
              border: '1px solid #2d6a4f',
              background: lang === l ? '#2d6a4f' : 'transparent',
              color: lang === l ? '#fff' : '#2d6a4f',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {l === 'ja' ? '日本語' : l === 'es' ? 'Español' : 'Português'}
          </button>
        ))}
      </div>
      <h1 style={{ color: '#1e5c42', marginBottom: '1.5rem' }}>{title}</h1>
      <div
        style={{ lineHeight: 1.8, color: '#374151' }}
        dangerouslySetInnerHTML={{ __html: body }}
      />
      <p style={{ marginTop: '2rem', color: '#6b7280', fontSize: '0.85rem' }}>
        最終更新 / Last updated: 2026-10-12
      </p>
    </div>
  );
}
