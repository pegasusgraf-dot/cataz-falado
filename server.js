// Criar tabela de histórico de áudios/anúncios automaticamente se não existir
async function inicializarBanco() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(100) UNIQUE NOT NULL,
                senha VARCHAR(100) NOT NULL,
                tipo VARCHAR(20) DEFAULT 'comum',
                status VARCHAR(20) DEFAULT 'aprovado',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        await pool.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'aprovado';");

        // Tabela para salvar o histórico de anúncios/áudios gerados
        await pool.query(`
            CREATE TABLE IF NOT EXISTS historico_audios (
                id SERIAL PRIMARY KEY,
                usuario VARCHAR(100) NOT NULL,
                titulo TEXT NOT NULL,
                texto TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Criar usuário master padrão (master / 123456) caso não exista nenhum
        const checkMaster = await pool.query("SELECT * FROM usuarios WHERE nome = 'master'");
        if (checkMaster.rows.length === 0) {
            await pool.query(
                "INSERT INTO usuarios (nome, senha, tipo, status) VALUES ('master', '123456', 'master', 'aprovado')",
            );
            console.log('Usuário master criado com sucesso! (master / 123456)');
        }
    } catch (err) {
        console.error('Erro ao inicializar tabelas:', err);
    }
}
inicializarBanco();

// --- ROTAS DE HISTÓRICO DE ÁUDIOS ---

// Salvar um novo áudio gerado no histórico
app.post('/api/historico', async (req, res) => {
    const { usuario, titulo, texto } = req.body;
    try {
        const novo = await pool.query(
            'INSERT INTO historico_audios (usuario, titulo, texto) VALUES ($1, $2, $3) RETURNING *',
            [usuario, titulo, texto]
        );
        res.json({ sucesso: true, item: novo.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao salvar histórico.' });
    }
});

// Listar histórico de áudios
app.get('/api/historico', async (req, res) => {
    try {
        const lista = await pool.query('SELECT * FROM historico_audios ORDER BY id DESC LIMIT 50');
        res.json({ sucesso: true, historico: lista.rows });
    } catch (error) {
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar histórico.' });
    }
});
