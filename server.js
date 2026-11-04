const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Chave Gemini ativa
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6IRvVrF-JMe5yGT5WbQORWpcsqpIV1Q0w-NSpk2KJ2DjQ';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL não configurada.');
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

function bancoIndisponivel(res, mensagem = 'Banco de dados indisponível.') {
  return res.status(500).json({ sucesso: false, mensagem });
}

async function inicializarBanco() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        senha VARCHAR(100) NOT NULL,
        tipo VARCHAR(30) NOT NULL DEFAULT 'comum',
        status VARCHAR(20) NOT NULL DEFAULT 'pendente',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vozes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        descricao VARCHAR(255),
        tipo_locucao VARCHAR(50) DEFAULT 'Padrao',
        arquivo_base64 TEXT,
        audio_data TEXT,
        usuario_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS anuncios (
        id SERIAL PRIMARY KEY,
        produto VARCHAR(200) NOT NULL,
        texto TEXT NOT NULL,
        voz_id INTEGER,
        audio_data TEXT,
        usuario_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`ALTER TABLE vozes ADD COLUMN IF NOT EXISTS arquivo_base64 TEXT;`);
    await pool.query(`ALTER TABLE vozes ADD COLUMN IF NOT EXISTS audio_data TEXT;`);
    await pool.query(`ALTER TABLE vozes ALTER COLUMN audio_data DROP NOT NULL;`);
    await pool.query(`ALTER TABLE anuncios ADD COLUMN IF NOT EXISTS audio_data TEXT;`);
    await pool.query(`ALTER TABLE anuncios ADD COLUMN IF NOT EXISTS voz_id INTEGER;`);

    const checkMaster = await pool.query("SELECT 1 FROM usuarios WHERE LOWER(email) = LOWER('master') LIMIT 1");
    if (checkMaster.rows.length === 0) {
      await pool.query(
        "INSERT INTO usuarios (nome, email, senha, tipo, status) VALUES ('Master', 'master', '1234', 'master', 'aprovado')"
      );
    }
  } catch (err) {
    console.error('Erro ao inicializar tabelas:', err);
  }
}

inicializarBanco();

function normalizarStatus(status) {
  if (!status) return 'pendente';
  const v = String(status).trim().toLowerCase();
  if (['aprovado', 'rejeitado', 'pendente'].includes(v)) return v;
  return 'pendente';
}

app.get('/api/health', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Banco conectado' });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'Falha de conexão com o banco' });
  }
});

app.post('/api/login', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { email, usuario, senha } = req.body || {};
  const emailLogin = String(email || usuario || '').trim();

  try {
    const resultado = await pool.query(
      'SELECT id, nome, email, senha, tipo, status, created_at FROM usuarios WHERE LOWER(email) = LOWER($1) AND senha = $2',
      [emailLogin, String(senha).trim()]
    );

    if (resultado.rows.length === 0) {
      return res.status(401).json({ sucesso: false, mensagem: 'Usuário ou senha incorretos.' });
    }

    const usuarioLogado = resultado.rows[0];
    if (usuarioLogado.status !== 'aprovado' && usuarioLogado.tipo !== 'master') {
      return res.status(403).json({ sucesso: false, mensagem: 'Sua conta ainda está pendente de aprovação.' });
    }

    return res.json({ sucesso: true, usuario: usuarioLogado });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor.' });
  }
});

app.get('/api/usuarios', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const lista = await pool.query('SELECT id, nome, email, tipo, status, created_at FROM usuarios ORDER BY id DESC');
    return res.json({ sucesso: true, usuarios: lista.rows });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar usuários.' });
  }
});

app.post('/api/usuarios', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { nome, email, usuario, senha, tipo } = req.body || {};
  const emailFinal = String(email || usuario || '').trim();

  try {
    const novo = await pool.query(
      `INSERT INTO usuarios (nome, email, senha, tipo, status) VALUES ($1, $2, $3, $4, 'pendente') RETURNING id, nome, email, tipo, status, created_at`,
      [String(nome).trim(), emailFinal, String(senha).trim(), String(tipo || 'comum').trim()]
    );
    return res.status(201).json({ sucesso: true, usuario: novo.rows[0] });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar usuário (E-mail já existe?).' });
  }
});

app.patch('/api/usuarios/:id/status', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const atualizacao = await pool.query(
      'UPDATE usuarios SET status = $1 WHERE id = $2 RETURNING id, nome, email, tipo, status',
      [normalizarStatus(req.body.status), req.params.id]
    );
    return res.json({ sucesso: true, usuario: atualizacao.rows[0] });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao atualizar status.' });
  }
});

app.delete('/api/usuarios/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('DELETE FROM anuncios WHERE usuario_id = $1', [req.params.id]);
    await pool.query('DELETE FROM vozes WHERE usuario_id = $1', [req.params.id]);
    await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    return res.json({ sucesso: true });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao remover usuário.' });
  }
});

// --- ROTAS DE VOZES ---
app.get('/api/vozes', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const lista = await pool.query(`
      SELECT id, nome, descricao, tipo_locucao, 
             COALESCE(arquivo_base64, audio_data) AS arquivo_base64, 
             created_at 
      FROM vozes 
      ORDER BY id DESC
    `);
    return res.json({ sucesso: true, vozes: lista.rows });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar vozes.' });
  }
});

app.post('/api/clonar-voz', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { nome, tipo_locucao, arquivo_base64, usuario_id } = req.body || {};

  if (!nome) {
    return res.status(400).json({ sucesso: false, mensagem: 'Nome da voz é obrigatório.' });
  }

  try {
    let idUsuarioValido = null;
    if (usuario_id && !isNaN(Number(usuario_id))) {
      const checaUser = await pool.query('SELECT id FROM usuarios WHERE id = $1', [Number(usuario_id)]);
      if (checaUser.rows.length > 0) idUsuarioValido = checaUser.rows[0].id;
    }

    const audioConteudo = arquivo_base64 || '';

    const novaVoz = await pool.query(
      `INSERT INTO vozes (nome, tipo_locucao, arquivo_base64, audio_data, usuario_id) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, tipo_locucao, created_at`,
      [
        String(nome).trim(),
        String(tipo_locucao || 'varejo').trim(),
        audioConteudo,
        audioConteudo,
        idUsuarioValido
      ]
    );
    return res.status(201).json({ sucesso: true, voz: novaVoz.rows[0] });
  } catch (error) {
    console.error('Erro ao salvar voz no Neon:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar voz: ' + error.message });
  }
});

app.delete('/api/vozes/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('UPDATE anuncios SET voz_id = NULL WHERE voz_id = $1', [req.params.id]);
    await pool.query('DELETE FROM vozes WHERE id = $1', [req.params.id]);
    return res.json({ sucesso: true });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao remover voz.' });
  }
});

// --- ROTEIRO COM GEMINI (COM FALLBACK AUTOMÁTICO) ---
app.post('/api/gerar-roteiro-ia', async (req, res) => {
  const { produto, valorOriginal, valorPromocional, oferta } = req.body || {};

  if (!produto) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe o nome do produto.' });
  }

  const promptText = `Você é um locutor profissional de rádio de supermercado e varejo.
Crie um texto de chamada promocional curto, impactante e vendedor (máximo 40 palavras).
Dados da oferta:
- Produto: ${produto}
- De: R$ ${valorOriginal || 'Preço normal'}
- Por: R$ ${valorPromocional || 'Super promoção'}
- Oferta/Destaque: ${oferta || 'Imperdível'}

Regra: Retorne exclusivamente o texto da locução, pronto para narrar. Sem aspas nem explicações.`;

  const modelos = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let roteiroFinal = null;

  for (const modelo of modelos) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`;
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }]
        })
      });

      const data = await geminiRes.json();
      if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        roteiroFinal = data.candidates[0].content.parts[0].text.trim();
        break;
      }
    } catch (err) {
      // Tenta o próximo modelo
    }
  }

  if (roteiroFinal) {
    return res.json({ sucesso: true, roteiro: roteiroFinal });
  }

  const fallbackText = `Atenção clientes! Hoje temos ${produto} por apenas R$ ${valorPromocional || valorOriginal}! ${oferta || 'Aproveite já essa super oferta'} na nossa loja!`;
  return res.json({ sucesso: true, roteiro: fallbackText });
});

// --- NARRAÇÃO COM CLONAGEM GRATUITA (LÊ O TEXTO COM O TIMBRE DO ÁUDIO SALVO) ---
app.post('/api/gerar-locucao', async (req, res) => {
  const { texto, voz_id } = req.body || {};
  if (!texto) return res.status(400).json({ sucesso: false, mensagem: 'Texto é obrigatório para narrar.' });

  try {
    let audioReferencia = null;

    // 1. Busca a amostra gravada no banco Neon
    if (voz_id && pool) {
      const vozEncontrada = await pool.query(
        'SELECT COALESCE(arquivo_base64, audio_data) AS audio FROM vozes WHERE id = $1',
        [Number(voz_id)]
      );
      if (vozEncontrada.rows.length > 0 && vozEncontrada.rows[0].audio) {
        audioReferencia = vozEncontrada.rows[0].audio;
      }
    }

    // 2. Se houver áudio de referência, tenta clonar via microserviço gratuito XTTS
    if (audioReferencia) {
      try {
        const hfRes = await fetch("https://fabrice-tiercelin-multi-language-text-to-speech.hf.space/run/predict", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: [
              texto,            // Texto a ser lido
              "Portuguese",     // Idioma
              audioReferencia   // Áudio do seu locutor gravado no banco
            ]
          })
        });

        const hfData = await hfRes.json();
        if (hfData?.data?.[0]?.name || hfData?.data?.[0]) {
          const resultadoAudio = hfData.data[0];
          const audioUrl = typeof resultadoAudio === 'string' ? resultadoAudio : resultadoAudio.name;
          
          if (audioUrl && audioUrl.startsWith('data:audio')) {
            return res.json({ sucesso: true, audio_data: audioUrl });
          } else if (audioUrl) {
            const fetchAudio = await fetch(audioUrl);
            const arrayBuffer = await fetchAudio.arrayBuffer();
            const clonedBase64 = `data:audio/wav;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
            return res.json({ sucesso: true, audio_data: clonedBase64 });
          }
        }
      } catch (errClone) {
        console.warn('Falha no clone online, utilizando sintetizador direto:', errClone.message);
      }
    }

    // 3. Fallback: síntese em português do Brasil garantida
    const encodedText = encodeURIComponent(texto.substring(0, 250));
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=pt-BR&client=tw-ob`;
    const response = await fetch(googleTtsUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      const audioBase64 = `data:audio/mpeg;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
      return res.json({
        sucesso: true,
        audio_data: audioBase64
      });
    }

    throw new Error('Não foi possível narrar o texto.');
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro na narração: ' + error.message });
  }
});

// --- ANÚNCIOS ---
app.get('/api/anuncios', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const lista = await pool.query(`
      SELECT a.*, v.nome AS voz_nome, u.nome AS usuario_nome
      FROM anuncios a
      LEFT JOIN vozes v ON v.id = a.voz_id
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      ORDER BY a.id DESC
    `);
    return res.json({ sucesso: true, anuncios: lista.rows });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar anúncios.' });
  }
});

app.post('/api/anuncios', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { produto, texto, voz_id, usuario_id, audio_data } = req.body || {};

  if (!produto || !texto) {
    return res.status(400).json({ sucesso: false, mensagem: 'Produto e texto são obrigatórios.' });
  }

  try {
    let idUsuarioValido = null;
    if (usuario_id && !isNaN(Number(usuario_id))) {
      const checaUser = await pool.query('SELECT id FROM usuarios WHERE id = $1', [Number(usuario_id)]);
      if (checaUser.rows.length > 0) idUsuarioValido = checaUser.rows[0].id;
    }

    let idVozValida = null;
    if (voz_id && !isNaN(Number(voz_id))) {
      const checaVoz = await pool.query('SELECT id FROM vozes WHERE id = $1', [Number(voz_id)]);
      if (checaVoz.rows.length > 0) idVozValida = checaVoz.rows[0].id;
    }

    const item = await pool.query(
      `INSERT INTO anuncios (produto, texto, voz_id, usuario_id, audio_data) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        String(produto).trim(),
        String(texto).trim(),
        idVozValida,
        idUsuarioValido,
        audio_data || null
      ]
    );
    return res.status(201).json({ sucesso: true, anuncio: item.rows[0] });
  } catch (error) {
    console.error('Erro ao salvar anúncio:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao salvar anúncio no banco.' });
  }
});

app.delete('/api/anuncios/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('DELETE FROM anuncios WHERE id = $1', [req.params.id]);
    return res.json({ sucesso: true });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao remover anúncio.' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
