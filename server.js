const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
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

// Converte áudio PCM cru em WAV executável pelo navegador
function pcmToWavBase64(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  pcmBuffer.copy(buffer, 44);
  return `data:audio/wav;base64,${buffer.toString('base64')}`;
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

// --- ROTEIRO COM GEMINI (COM FALLBACK CONTRA ALTA DEMANDA) ---
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

// --- NARRAÇÃO: LÊ O TEXTO GERADO EM VOZ ALTA COM A VOZ SELECIONADA ---
app.post('/api/gerar-locucao', async (req, res) => {
  const { texto, voz_id, tipo_voz } = req.body || {};
  if (!texto) return res.status(400).json({ sucesso: false, mensagem: 'Texto é obrigatório para narrar.' });

  try {
    let geminiVoiceName = 'Puck'; // Padrão: Varejo enérgico
    let estiloPrompt = 'com tom alegre, enérgico e vendedor de rádio de ofertas';

    // 1. Identifica se a voz veio do seletor direto
    if (tipo_voz) {
      const v = String(tipo_voz).toLowerCase();
      if (v === 'fenrir' || v === 'grave') {
        geminiVoiceName = 'Fenrir';
        estiloPrompt = 'com voz masculina grave, potente, firme e promocional impactante';
      } else if (v === 'aoede' || v === 'feminina') {
        geminiVoiceName = 'Aoede';
        estiloPrompt = 'com voz feminina brasileira expressiva, clara, elegante e comercial';
      } else if (v === 'charon' || v === 'institucional') {
        geminiVoiceName = 'Charon';
        estiloPrompt = 'com voz masculina institucional, clara e profissional';
      } else {
        geminiVoiceName = 'Puck';
        estiloPrompt = 'com voz de locutor jovem, dinâmico e animado de varejo';
      }
    } 
    // 2. Se for uma voz cadastrada no Neon, lê o estilo cadastrado dela
    else if (voz_id && pool) {
      const vozEncontrada = await pool.query(
        'SELECT nome, tipo_locucao FROM vozes WHERE id = $1',
        [Number(voz_id)]
      );
      if (vozEncontrada.rows.length > 0) {
        const estilo = String(vozEncontrada.rows[0].tipo_locucao || '').toLowerCase();
        if (estilo.includes('grave') || estilo.includes('forte') || estilo.includes('fenrir')) {
          geminiVoiceName = 'Fenrir';
          estiloPrompt = 'com voz masculina grave, potente e promocional';
        } else if (estilo.includes('feminina') || estilo.includes('suave') || estilo.includes('aoede')) {
          geminiVoiceName = 'Aoede';
          estiloPrompt = 'com voz feminina brasileira expressiva e comercial';
        } else if (estilo.includes('institucional') || estilo.includes('charon')) {
          geminiVoiceName = 'Charon';
          estiloPrompt = 'com voz institucional séria e profissional';
        } else {
          geminiVoiceName = 'Puck';
          estiloPrompt = 'com voz de locutor alegre e dinâmico de loja';
        }
      }
    }

    let audioGerado = null;
    const modelosAudio = ['gemini-2.5-flash', 'gemini-2.0-flash'];

    // O Gemini lê o texto exato com o timbre da voz escolhida
    for (const mod of modelosAudio) {
      try {
        const urlAudio = `https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${GEMINI_API_KEY}`;
        const payloadAudio = {
          contents: [{
            parts: [{ text: `Leia em voz alta em português do Brasil ${estiloPrompt} o seguinte anúncio: "${texto}"` }]
          }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: geminiVoiceName }
              }
            }
          }
        };

        const resAudio = await fetch(urlAudio, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadAudio)
        });

        const dataAudio = await resAudio.json();
        const rawAudioBase64 = dataAudio?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

        if (rawAudioBase64) {
          const pcmBuffer = Buffer.from(rawAudioBase64, 'base64');
          audioGerado = pcmToWavBase64(pcmBuffer, 24000, 1, 16);
          break; // Sucesso na síntese
        }
      } catch (errAudio) {
        console.warn(`Erro no modelo de áudio ${mod}:`, errAudio.message);
      }
    }

    if (audioGerado) {
      return res.json({
        sucesso: true,
        audio_data: audioGerado,
        voz_utilizada: geminiVoiceName
      });
    }

    // Fallback leve para garantir que o texto seja falado mesmo se a cota do áudio do Gemini oscilar
    const encodedText = encodeURIComponent(texto.substring(0, 200));
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=pt-BR&client=tw-ob`;
    const response = await fetch(googleTtsUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      const audioFallback = `data:audio/mpeg;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
      return res.json({
        sucesso: true,
        audio_data: audioFallback,
        voz_utilizada: 'Fallback Padrão'
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
