const { Pool } = require('pg');

let pool;
function getPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não está configurada.');
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ sucesso: false, mensagem: 'Método não permitido.' });
  }

  const text = String(req.body?.texto || '').trim();
  const voiceId = Number(req.body?.voz_id);
  const userId = Number(req.body?.usuario_id);
  const requestedLanguage = String(req.body?.idioma || 'pt').trim().toLowerCase();
  const languages = new Set(['ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh']);

  if (!text) return res.status(400).json({ sucesso: false, mensagem: 'Digite o texto para gerar o áudio.' });
  if (text.length > 4000) return res.status(413).json({ sucesso: false, mensagem: 'O texto deve ter no máximo 4.000 caracteres.' });
  if (!languages.has(requestedLanguage)) return res.status(400).json({ sucesso: false, mensagem: 'Idioma não suportado pelo modelo.' });
  if (!process.env.CHATTERBOX_API_URL) {
    return res.status(503).json({ sucesso: false, mensagem: 'Configure CHATTERBOX_API_URL na Vercel para conectar o serviço Chatterbox.' });
  }

  try {
    const db = getPool();
    let voice = null;
    if (Number.isInteger(voiceId) && voiceId > 0) {
      const query = Number.isInteger(userId) && userId > 0
        ? await db.query('SELECT id, idioma, audio_data, audio_mime FROM vozes WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL)', [voiceId, userId])
        : await db.query('SELECT id, idioma, audio_data, audio_mime FROM vozes WHERE id = $1 AND usuario_id IS NULL', [voiceId]);
      voice = query.rows[0];
      if (!voice) return res.status(404).json({ sucesso: false, mensagem: 'Voz não encontrada ou indisponível para este usuário.' });
    }

    const payload = {
      text,
      language: voice?.idioma || requestedLanguage,
      audio_prompt_base64: voice?.audio_data ? voice.audio_data.toString('base64') : null,
      audio_prompt_mime: voice?.audio_mime || null,
    };
    const headers = { 'Content-Type': 'application/json', Accept: 'audio/wav, application/json' };
    if (process.env.CHATTERBOX_API_KEY) headers.Authorization = `Bearer ${process.env.CHATTERBOX_API_KEY}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240000);
    let response;
    try {
      response = await fetch(process.env.CHATTERBOX_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      console.error('Chatterbox service error:', response.status, detail);
      return res.status(502).json({ sucesso: false, mensagem: 'O serviço Chatterbox não conseguiu gerar o áudio. Verifique a configuração do serviço.' });
    }

    let audio;
    let contentType = response.headers.get('content-type') || 'audio/wav';
    if (contentType.includes('application/json')) {
      const result = await response.json();
      if (!result.audio_base64) return res.status(502).json({ sucesso: false, mensagem: 'Resposta inválida do serviço Chatterbox.' });
      audio = Buffer.from(result.audio_base64, 'base64');
      contentType = result.content_type || 'audio/wav';
    } else {
      audio = Buffer.from(await response.arrayBuffer());
    }
    if (!audio.length) return res.status(502).json({ sucesso: false, mensagem: 'O serviço Chatterbox retornou áudio vazio.' });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', audio.length);
    return res.status(200).send(audio);
  } catch (error) {
    console.error('Erro de síntese TTS:', error);
    const timeout = error.name === 'AbortError';
    return res.status(timeout ? 504 : 500).json({
      sucesso: false,
      mensagem: timeout ? 'O serviço de voz demorou demais para responder.' : 'Falha ao gerar áudio. Verifique a conexão com o serviço Chatterbox.',
    });
  }
};
