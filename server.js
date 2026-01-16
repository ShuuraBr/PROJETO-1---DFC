require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db'); 
const nodemailer = require('nodemailer');
const crypto = require('crypto'); // Adicionado para gerar o token

const app = express();

// Configurações do Express
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SENHA_PADRAO = 'Obj@2026';

// --- NOVO: Configuração do Nodemailer ---
const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
        user: 'no-reply@dfc.objetivaatacadista.com.br', // Ajuste para seu email real
        pass: process.env.EMAIL_PASS // Adicione isso no seu .env
    }
});

// =========================================================================
// ROTAS DE AUTENTICAÇÃO (ALTERADO PARA 2FA)
// =========================================================================

// PASSO 1: Verifica senha e envia token
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log(`[LOGIN 1/2] Tentativa para: ${email}`);

    try {
        const query = `
            SELECT U.Email, U.Nome, U.Role, U.Nivel, U.Senha_prov, D.Nome_dep as Departamento 
            FROM usuarios U 
            LEFT JOIN departamentos D ON U.Pk_dep = D.Id_dep 
            WHERE U.Email = ? AND U.Senha = ?
        `;

        const [rows] = await pool.query(query, [email, password]);

        if (rows.length > 0) {
            // --- NOVA LÓGICA 2FA ---
            const token = crypto.randomInt(100000, 999999).toString();
            
            // CORREÇÃO: Usamos o horário do MySQL para evitar erro de fuso horário
            await pool.query(
                'INSERT INTO tokens_acesso (email, token, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 SECOND))',
                [email, token]
            );

            // Envia Email
            try {
                await transporter.sendMail({
                    from: '"Segurança DFC" <no-reply@dfc.objetivaatacadista.com.br>',
                    to: email,
                    subject: 'Seu Código de Acesso - DFC',
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                            <h2>Código de Verificação</h2>
                            <p>Seu código de acesso é:</p>
                            <h1 style="color: #2563eb; letter-spacing: 5px;">${token}</h1>
                            <p style="color: #dc2626; font-weight: bold;">⚠️ Válido por 30 segundos.</p>
                        </div>
                    `
                });
                console.log(`[LOGIN 1/2] Token enviado para ${email}`);
                
                // Retorna indicando que precisa do 2FA
                res.json({ success: true, require2fa: true, email: email });

            } catch (mailErr) {
                console.error("Erro ao enviar email:", mailErr);
                res.status(500).json({ success: false, message: 'Senha correta, mas erro ao enviar token por e-mail.' });
            }

        } else {
            console.warn(`[LOGIN] Falha: Credenciais inválidas para ${email}`);
            res.status(401).json({ success: false, message: 'E-mail ou senha incorretos' });
        }
    } catch (e) {
        console.error("[LOGIN] Erro Crítico:", e.message);
        res.status(500).json({ success: false, message: 'Erro ao conectar no banco de dados.' });
    }
});

// PASSO 2: Valida o Token (NOVA ROTA)
app.post('/api/validar-token', async (req, res) => {
    const { email, token } = req.body;

    try {
        // Busca token válido usando NOW() do banco
        const [tokens] = await pool.query(
            'SELECT * FROM tokens_acesso WHERE email = ? AND token = ? AND expira_em > NOW() ORDER BY id DESC LIMIT 1',
            [email, token]
        );

        if (tokens.length > 0) {
            // Token OK, agora recupera os dados do usuário para logar
            const queryUser = `
                SELECT U.Email, U.Nome, U.Role, U.Nivel, U.Senha_prov, D.Nome_dep as Departamento 
                FROM usuarios U 
                LEFT JOIN departamentos D ON U.Pk_dep = D.Id_dep 
                WHERE U.Email = ?
            `;
            const [users] = await pool.query(queryUser, [email]);
            const u = users[0];

            // Limpa token usado
            await pool.query('DELETE FROM tokens_acesso WHERE id = ?', [tokens[0].id]);

            console.log(`[LOGIN 2/2] Sucesso final: ${u.Nome}`);
            res.json({ success: true, user: { ...u, Nome: u.Nome || 'Usuário', Role: u.Role || 'user' } });
        } else {
            res.status(401).json({ success: false, message: 'Código inválido ou expirado.' });
        }
    } catch (e) {
        console.error("[VALIDAÇÃO] Erro:", e);
        res.status(500).json({ success: false, message: 'Erro ao validar token.' });
    }
});

// =========================================================================
// ROTAS DE DADOS (MANTIDAS IGUAIS)
// =========================================================================

app.post('/api/usuarios', async (req, res) => {
    const { nome, email, departamentoId, role, nivel } = req.body;
    try {
        const [check] = await pool.query('SELECT Email FROM usuarios WHERE Email = ?', [email]);
        if (check.length > 0) return res.status(400).json({ success: false, message: 'Email já existe' });

        await pool.query(
            `INSERT INTO usuarios (ID, Nome, Email, Senha, Senha_prov, Pk_dep, Role, Nivel) 
             VALUES ((SELECT IFNULL(MAX(ID),0)+1 FROM usuarios AS U_temp), ?, ?, ?, ?, ?, ?, ?)`,
            [nome, email, SENHA_PADRAO, SENHA_PADRAO, departamentoId, role, nivel]
        );
        res.json({ success: true, message: 'Criado com sucesso' });
    } catch (e) {
        console.error("[CADASTRO] Erro:", e);
        res.status(500).json({ success: false, message: "Erro ao criar usuário" });
    }
});

app.post('/api/definir-senha', async (req, res) => {
    const { email, novaSenha } = req.body;
    try {
        await pool.query('UPDATE usuarios SET Senha = ?, Senha_prov = NULL WHERE Email = ?', [novaSenha, email]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/departamentos', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT Id_dep, Nome_dep FROM departamentos');
        res.json(rows);
    } catch (e) { res.status(500).json([]); }
});

app.get('/api/anos', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT DISTINCT Ano FROM dfc_analitica WHERE Ano IS NOT NULL ORDER BY Ano DESC');
        res.json(rows);
    } catch (e) { res.status(500).json([]); }
});

app.get('/api/orcamento', async (req, res) => {
    const { email, ano } = req.query;
    try {
        const [users] = await pool.query(
            'SELECT Role, D.Nome_dep FROM usuarios U LEFT JOIN departamentos D ON U.Pk_dep = D.Id_dep WHERE Email = ?', 
            [email]
        );
        
        if (users.length === 0) return res.status(401).json({ error: 'Usuário não encontrado' });
        
        const user = users[0];
        const departamentoUsuario = user.Nome_dep || '';
        const isSuperUser = user.Role === 'admin' || (departamentoUsuario && departamentoUsuario.toLowerCase().includes('planejamento'));

        let queryOrc = `
            SELECT Plano, Nome, Departamento1, 
                   Janeiro, Fevereiro, Marco, Abril, Maio, Junho, 
                   Julho, Agosto, Setembro, Outubro, Novembro, Dezembro 
            FROM orcamento WHERE 1=1 `;
        
        const paramsOrc = [];
        if (!isSuperUser) {
            queryOrc += ' AND Departamento1 = ?';
            paramsOrc.push(departamentoUsuario);
        }
        queryOrc += ' ORDER BY Departamento1, Plano';

        const [orcamentoData] = await pool.query(queryOrc, paramsOrc);

        let queryReal = `
            SELECT Codigo_plano, Mes, SUM(Valor_mov) as ValorRealizado 
            FROM dfc_analitica 
            WHERE 1=1 `;
        const paramsReal = [];

        if (ano) {
            queryReal += ' AND Ano = ?';
            paramsReal.push(ano);
        }
        queryReal += ' GROUP BY Codigo_plano, Mes';

        const [resReal] = await pool.query(queryReal, paramsReal);

        const mapRealizado = {};
        resReal.forEach(r => {
            mapRealizado[`${r.Codigo_plano}-${r.Mes}`] = parseFloat(r.ValorRealizado) || 0;
        });

        const colunasBanco = ['Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        const chavesFrontend = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const grupos = {};

        const ocultarOrcado = (ano && ano.toString() === '2025');

        orcamentoData.forEach(row => {
            const codigo = row.Plano;
            const nome = row.Nome;
            const depto = row.Departamento1 || 'Sem Departamento';
            const contaFormatada = `${codigo} - ${nome}`;

            if (!grupos[depto]) {
                grupos[depto] = { conta: depto, tipo: 'grupo', dados: {}, detalhes: [] };
                chavesFrontend.forEach(k => grupos[depto].dados[k] = { orcado: 0, realizado: 0, diferenca: 0 });
            }

            const dadosMesesItem = {};

            chavesFrontend.forEach((chaveFront, index) => {
                const nomeColunaBanco = colunasBanco[index];
                const mesNumero = index + 1;

                let valOrcado = parseFloat(row[nomeColunaBanco]) || 0;
                if (ocultarOrcado) valOrcado = 0;

                const valRealizado = mapRealizado[`${codigo}-${mesNumero}`] || 0;
                const diferenca = valOrcado - valRealizado;

                dadosMesesItem[chaveFront] = { orcado: valOrcado, realizado: valRealizado, diferenca: diferenca };

                grupos[depto].dados[chaveFront].orcado += valOrcado;
                grupos[depto].dados[chaveFront].realizado += valRealizado;
                grupos[depto].dados[chaveFront].diferenca += diferenca;
            });

            grupos[depto].detalhes.push({ conta: contaFormatada, tipo: 'item', dados: dadosMesesItem });
        });

        res.json(Object.values(grupos));

    } catch (e) {
        console.error("Erro Orçamento:", e);
        res.status(500).json({ error: 'Erro ao processar orçamento' });
    }
});

app.get('/api/dashboard', async (req, res) => {
    try {
        const { ano, view } = req.query;
        let query = 'SELECT Origem_DFC, Nome_2, Codigo_plano, Nome, Mes, Ano, Valor_mov, Natureza FROM dfc_analitica';
        const params = [];
        if (view !== 'anual' && ano) { query += ' WHERE Ano = ?'; params.push(ano); }
        const [rawData] = await pool.query(query, params);

        let colunasKeys = []; let colunasLabels = [];
        if (view === 'anual') {
            const anosUnicos = [...new Set(rawData.map(r => r.Ano))].sort((a,b) => a - b);
            colunasKeys = anosUnicos.map(a => a.toString()); colunasLabels = colunasKeys;
        } else if (view === 'trimestral') {
            colunasKeys = ['Q1', 'Q2', 'Q3', 'Q4']; colunasLabels = ['1º Trim', '2º Trim', '3º Trim', '4º Trim'];
        } else {
            colunasKeys = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
            colunasLabels = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        }

        const mapaMeses = { 1: 'jan', 2: 'fev', 3: 'mar', 4: 'abr', 5: 'mai', 6: 'jun', 7: 'jul', 8: 'ago', 9: 'set', 10: 'out', 11: 'nov', 12: 'dez' };
        const zerarColunas = () => { const obj = {}; colunasKeys.forEach(k => obj[k] = 0); return obj; };
        const normalizar = (str) => str ? str.trim().toLowerCase().replace(/\s+/g, ' ') : '';
        const configCategorias = { '01-entradas operacionais': '01- Entradas Operacionais', '01- entradas operacionais': '01- Entradas Operacionais', '02- saidas operacionais': '02- Saídas Operacionais', '02-saidas operacionais': '02- Saídas Operacionais', '03- operações financeiras': '03- Operações Financeiras', '03- operacoes financeiras': '03- Operações Financeiras', '04 - ativo imobilizado': '04- Ativo Imobilizado', '04- ativo imobilizado': '04- Ativo Imobilizado', '06- movimentações de socios': '06- Movimentações de Sócios', '06- movimentacoes de socios': '06- Movimentações de Sócios', '07- caixas da loja': '07- Caixas da Loja' };

        let grupos = {}; let FluxoGlobal = zerarColunas(); let FluxoOperacional = zerarColunas(); let totalEntradasGlobal = 0; let totalSaidasGlobal = 0;

        rawData.forEach(row => {
            const numMes = row.Mes; const numAno = row.Ano;
            let chaveColuna = '';
            if (view === 'anual') { if (numAno) chaveColuna = numAno.toString(); } else if (view === 'trimestral') { const trim = Math.ceil(numMes / 3); chaveColuna = `Q${trim}`; } else { chaveColuna = mapaMeses[numMes]; }
            if (!colunasKeys.includes(chaveColuna)) return;
            const valorAbsoluto = parseFloat(row.Valor_mov) || 0; const natureza = row.Natureza ? row.Natureza.trim().toLowerCase() : ''; const ehSaida = natureza.includes('saída') || natureza.includes('saida');
            if (ehSaida) { FluxoGlobal[chaveColuna] -= valorAbsoluto; totalSaidasGlobal += valorAbsoluto; } else { FluxoGlobal[chaveColuna] += valorAbsoluto; totalEntradasGlobal += valorAbsoluto; }
            if (row.Origem_DFC) {
                const chaveBanco = normalizar(row.Origem_DFC); let tituloGrupo = configCategorias[chaveBanco];
                if (!tituloGrupo) { const keyEncontrada = Object.keys(configCategorias).find(k => k.includes(chaveBanco) || chaveBanco.includes(k)); if (keyEncontrada) tituloGrupo = configCategorias[keyEncontrada]; }
                if (tituloGrupo) {
                    if (!grupos[tituloGrupo]) grupos[tituloGrupo] = { titulo: tituloGrupo, total: zerarColunas(), subgruposMap: {} };
                    const grupo = grupos[tituloGrupo]; const nome2 = row.Nome_2 ? row.Nome_2.trim() : 'Outros'; const cod = row.Codigo_plano || ''; const nom = row.Nome || ''; const itemChave = `${cod} - ${nom}`;
                    let valorParaTabela = ehSaida ? -Math.abs(valorAbsoluto) : Math.abs(valorAbsoluto);
                    grupo.total[chaveColuna] += valorParaTabela;
                    if (!grupo.subgruposMap[nome2]) grupo.subgruposMap[nome2] = { conta: nome2, ...zerarColunas(), itensMap: {} };
                    grupo.subgruposMap[nome2][chaveColuna] += valorParaTabela;
                    if (!grupo.subgruposMap[nome2].itensMap[itemChave]) grupo.subgruposMap[nome2].itensMap[itemChave] = { conta: itemChave, ...zerarColunas(), tipo: 'item' };
                    grupo.subgruposMap[nome2].itensMap[itemChave][chaveColuna] += valorParaTabela;
                    const ehEntradaOp = tituloGrupo.includes('01'); const ehSaidaOp = tituloGrupo.includes('02');
                    if (ehEntradaOp || ehSaidaOp) { if (ehSaida) FluxoOperacional[chaveColuna] -= valorAbsoluto; else FluxoOperacional[chaveColuna] += valorAbsoluto; }
                }
            }
        });

        const ordemDesejada = ['01- Entradas Operacionais', '02- Saídas Operacionais', '03- Operações Financeiras', '04- Ativo Imobilizado', '06- Movimentações de Sócios', '07- Caixas da Loja'];
        let tabelaRows = []; const valInicial = 0;
        tabelaRows.push({ conta: 'Saldo Inicial', ...zerarColunas(), tipo: 'info' });
        ordemDesejada.forEach(titulo => { const g = grupos[titulo]; if (g) { const arraySubgrupos = Object.values(g.subgruposMap).map(sub => { const arrayItens = Object.values(sub.itensMap); return { conta: sub.conta, ...sub, tipo: 'subgrupo', detalhes: arrayItens }; }); tabelaRows.push({ conta: g.titulo, ...g.total, tipo: 'grupo', detalhes: arraySubgrupos }); } });
        const graficoData = []; const linhaSaldoFinal = zerarColunas();
        colunasKeys.forEach(col => { linhaSaldoFinal[col] = valInicial + FluxoGlobal[col]; graficoData.push(FluxoOperacional[col]); });
        tabelaRows.push({ conta: 'Saldo Final', ...linhaSaldoFinal, tipo: 'saldo' });
        const somaObj = (o) => Object.values(o).reduce((a, b) => a + b, 0); const totalSuperavitDeficit = somaObj(FluxoOperacional);

        res.json({ cards: { saldoInicial: valInicial, entrada: totalEntradasGlobal, saida: totalSaidasGlobal, deficitSuperavit: totalSuperavitDeficit, saldoFinal: valInicial + totalSuperavitDeficit }, grafico: { labels: colunasLabels, data: graficoData }, tabela: { rows: tabelaRows, columns: colunasKeys, headers: colunasLabels } });
    } catch (err) { console.error("ERRO DASHBOARD:", err); res.status(500).json({ error: "Erro interno" }); }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta http://192.168.3.67:${PORT}`));