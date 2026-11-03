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

let schemaReady;
async function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS vozes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(120) NOT NULL,
        idioma VARCHAR(10) NOT NULL DEFAULT 'pt',
        audio_data BYTEA NOT NULL,
        audio_mime VARCHAR(100) NOT NULL DEFAULT 'audio/wav',
        usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.query(`ALTER TABLE anuncios ADD COLUMN IF NOT EXISTS voz_id INTEGER REFERENCES vozes(id) ON DELETE SET NULL`);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function sendError(res, error) {
  console.error('API de vozes:', error);
  res.status(500).json({ sucesso: false, mensagem: error.message || 'Erro ao processar voz.' });
}

module.exports = async (req, res) => {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ sucesso: false, mensagem: 'Método não permitido.' });
  }

  try {
    const db = getPool();
    await ensureSchema(db);

    if (req.method === 'GET') {
      const userId = Number(req.query.usuario_id);
      const result = Number.isInteger(userId) && userId > 0
        ? await db.query('SELECT id, nome, idioma, usuario_id, created_at FROM vozes WHERE usuario_id = $1 OR usuario_id IS NULL ORDER BY id DESC', [userId])
        : await db.query('SELECT id, nome, idioma, usuario_id, created_at FROM vozes ORDER BY id DESC');
      return res.status(200).json({ sucesso: true, vozes: result.rows });
    }

    if (req.method === 'POST') {
      const { nome, idioma = 'pt', audio_base64: audioBase64, audio_mime: audioMime = 'audio/wav', usuario_id: userId } = req.body || {};
      if (!String(nome || '').trim() || !audioBase64) {
        return res.status(400).json({ sucesso: false, mensagem: 'Informe o nome e o áudio de referência.' });
      }
      if (!/^audio\/(wav|x-wav|mpeg|mp4|ogg|aac|webm)$/i.test(audioMime)) {
        return res.status(400).json({ sucesso: false, mensagem: 'Formato não aceito. Envie WAV, MP3, M4A, OGG ou WebM.' });
      }
      const encoded = String(audioBase64).replace(/^data:[^;]+;base64,/, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        return res.status(400).json({ sucesso: false, mensagem: 'O arquivo de áudio não está em Base64 válido.' });
      }
      const audio = Buffer.from(encoded, 'base64');
      if (!audio.length || audio.length > 3 * 1024 * 1024) {
        return res.status(413).json({ sucesso: false, mensagem: 'O áudio deve ter no máximo 3 MB.' });
      }
      const ownerId = Number(userId);
      const result = await db.query(
        'INSERT INTO vozes (nome, idioma, audio_data, audio_mime, usuario_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, idioma, usuario_id, created_at',
        [String(nome).trim().slice(0, 120), String(idioma).toLowerCase().slice(0, 10), audio, audioMime, Number.isInteger(ownerId) && ownerId > 0 ? ownerId : null]
      );
      return res.status(201).json({ sucesso: true, voz: result.rows[0] });
    }

    const { id, usuario_id: userId } = req.body || {};
    const voiceId = Number(id);
    if (!Number.isInteger(voiceId) || voiceId <= 0) {
      return res.status(400).json({ sucesso: false, mensagem: 'ID de voz inválido.' });
    }
    const existing = await db.query('SELECT id, usuario_id FROM vozes WHERE id = $1', [voiceId]);
    if (!existing.rows.length) return res.status(404).json({ sucesso: false, mensagem: 'Voz não encontrada.' });
    const ownerId = Number(userId);
    if (existing.rows[0].usuario_id !== null && existing.rows[0].usuario_id !== ownerId) {
      return res.status(403).json({ sucesso: false, mensagem: 'Você não pode remover esta voz.' });
    }
    await db.query('DELETE FROM vozes WHERE id = $1', [voiceId]);
    return res.status(200).json({ sucesso: true });
  } catch (error) {
    return sendError(res, error);
  }
};
