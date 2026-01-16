require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db'); // Importa a conexão do db.js

const app = express();

// Configurações do Express
app.use(cors());
app.use(express.json());
// Serve os arquivos do site (index.html, css, js) da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

const SENHA_PADRAO = 'Obj@2026';

// =========================================================================
// ROTAS DE AUTENTICAÇÃO (LOGIN)
// =========================================================================

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        // MySQL usa '?' para parâmetros substituindo o '@param' do SQL Server
        const [rows] = await pool.query(
            `SELECT U.Email, U.Nome, U.Role, U.Nivel, U.Senha_prov, D.Nome_dep as Departamento 
             FROM Usuarios U 
             LEFT JOIN Departamentos D ON U.Pk_dep = D.Id_dep 
             WHERE U.Email = ? AND U.Senha = ?`,
            [email, password]
        );

        if (rows.length > 0) {
            const u = rows[0];
            console.log(`[LOGIN] Sucesso: ${u.Nome}`);
            res.json({ success: true, user: { ...u, Nome: u.Nome || 'Usuário', Role: u.Role || 'user' } });
        } else {
            console.warn(`[LOGIN] Falha: Credenciais inválidas para ${email}`);
            res.status(401).json({ success: false, message: 'E-mail ou senha incorretos' });
        }
    } catch (e) {
        console.error("[LOGIN] Erro Crítico:", e.message);
        res.status(500).json({ success: false, message: 'Erro ao conectar no banco de dados.' });
    }
});

app.post('/api/usuarios', async (req, res) => {
    const { nome, email, departamentoId, role, nivel } = req.body;
    try {
        const [check] = await pool.query('SELECT Email FROM Usuarios WHERE Email = ?', [email]);
        if (check.length > 0) return res.status(400).json({ success: false, message: 'Email já existe' });

        // Sintaxe MySQL: IFNULL em vez de ISNULL
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
        await pool.query('UPDATE Usuarios SET Senha = ?, Senha_prov = NULL WHERE Email = ?', [novaSenha, email]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// =========================================================================
// ROTAS DE DADOS AUXILIARES
// =========================================================================

app.get('/api/departamentos', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT Id_dep, Nome_dep FROM Departamentos');
        res.json(rows);
    } catch (e) { res.status(500).json([]); }
});

app.get('/api/anos', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT DISTINCT Ano FROM DFC_Analitica WHERE Ano IS NOT NULL ORDER BY Ano DESC');
        res.json(rows);
    } catch (e) { res.status(500).json([]); }
});

// =========================================================================
// ROTA DE ORÇAMENTO
// =========================================================================
app.get('/api/orcamento', async (req, res) => {
    const { email, ano } = req.query;
    try {
        // Verificar usuário
        const [users] = await pool.query(
            'SELECT Role, D.Nome_dep FROM usuarios U LEFT JOIN departamentos D ON U.Pk_dep = D.Id_dep WHERE Email = ?', 
            [email]
        );
        
        if (users.length === 0) return res.status(401).json({ error: 'Usuário não encontrado' });
        
        const user = users[0];
        const departamentoUsuario = user.Nome_dep || '';
        const isSuperUser = user.Role === 'admin' || (departamentoUsuario && departamentoUsuario.toLowerCase().includes('planejamento'));

        // Busca Orçamento
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

        // Busca Realizado
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

        // 4. Processamento de Dados (Merge)
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

                // Acumula no grupo
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

// =========================================================================
// ROTA DASHBOARD (Fluxo de Caixa)
// =========================================================================
app.get('/api/dashboard', async (req, res) => {
    try {
        const { ano, view } = req.query; // view = 'mensal', 'trimestral', 'anual'
        
        let query = 'SELECT Origem_DFC, Nome_2, Codigo_plano, Nome, Mes, Ano, Valor_mov, Natureza FROM DFC_Analitica';
        const params = [];

        if (view !== 'anual' && ano) {
            query += ' WHERE Ano = ?';
            params.push(ano);
        }

        const [rawData] = await pool.query(query, params);

        // Lógica de Processamento do Dashboard
        let colunasKeys = [];
        let colunasLabels = [];

        if (view === 'anual') {
            const anosUnicos = [...new Set(rawData.map(r => r.Ano))].sort((a,b) => a - b);
            colunasKeys = anosUnicos.map(a => a.toString());
            colunasLabels = colunasKeys;
        } else if (view === 'trimestral') {
            colunasKeys = ['Q1', 'Q2', 'Q3', 'Q4'];
            colunasLabels = ['1º Trim', '2º Trim', '3º Trim', '4º Trim'];
        } else {
            colunasKeys = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
            colunasLabels = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        }

        const mapaMeses = { 1: 'jan', 2: 'fev', 3: 'mar', 4: 'abr', 5: 'mai', 6: 'jun', 7: 'jul', 8: 'ago', 9: 'set', 10: 'out', 11: 'nov', 12: 'dez' };
        
        const zerarColunas = () => {
            const obj = {};
            colunasKeys.forEach(k => obj[k] = 0);
            return obj;
        };

        const normalizar = (str) => str ? str.trim().toLowerCase().replace(/\s+/g, ' ') : '';
        const configCategorias = {
            '01-entradas operacionais': '01- Entradas Operacionais',
            '01- entradas operacionais': '01- Entradas Operacionais', 
            '02- saidas operacionais': '02- Saídas Operacionais',
            '02-saidas operacionais': '02- Saídas Operacionais',
            '03- operações financeiras': '03- Operações Financeiras',
            '03- operacoes financeiras': '03- Operações Financeiras',
            '04 - ativo imobilizado': '04- Ativo Imobilizado',
            '04- ativo imobilizado': '04- Ativo Imobilizado',
            '06- movimentações de socios': '06- Movimentações de Sócios',
            '06- movimentacoes de socios': '06- Movimentações de Sócios',
            '07- caixas da loja': '07- Caixas da Loja'
        };

        let grupos = {};
        let FluxoGlobal = zerarColunas(); 
        let FluxoOperacional = zerarColunas();
        let totalEntradasGlobal = 0;
        let totalSaidasGlobal = 0;

        rawData.forEach(row => {
            const numMes = row.Mes;
            const numAno = row.Ano;
            
            let chaveColuna = '';
            
            if (view === 'anual') {
                if (numAno) chaveColuna = numAno.toString();
            } else if (view === 'trimestral') {
                const trim = Math.ceil(numMes / 3);
                chaveColuna = `Q${trim}`;
            } else {
                chaveColuna = mapaMeses[numMes];
            }

            if (!colunasKeys.includes(chaveColuna)) return;

            const valorAbsoluto = parseFloat(row.Valor_mov) || 0; 
            const natureza = row.Natureza ? row.Natureza.trim().toLowerCase() : '';
            const ehSaida = natureza.includes('saída') || natureza.includes('saida');
            
            if (ehSaida) {
                FluxoGlobal[chaveColuna] -= valorAbsoluto;
                totalSaidasGlobal += valorAbsoluto;
            } else {
                FluxoGlobal[chaveColuna] += valorAbsoluto;
                totalEntradasGlobal += valorAbsoluto;
            }

            if (row.Origem_DFC) {
                const chaveBanco = normalizar(row.Origem_DFC);
                let tituloGrupo = configCategorias[chaveBanco];

                if (!tituloGrupo) {
                    const keyEncontrada = Object.keys(configCategorias).find(k => k.includes(chaveBanco) || chaveBanco.includes(k));
                    if (keyEncontrada) tituloGrupo = configCategorias[keyEncontrada];
                }

                if (tituloGrupo) {
                    if (!grupos[tituloGrupo]) grupos[tituloGrupo] = { titulo: tituloGrupo, total: zerarColunas(), subgruposMap: {} };
                    const grupo = grupos[tituloGrupo];
                    
                    const nome2 = row.Nome_2 ? row.Nome_2.trim() : 'Outros';
                    const cod = row.Codigo_plano || '';
                    const nom = row.Nome || '';
                    const itemChave = `${cod} - ${nom}`;
                    
                    let valorParaTabela = ehSaida ? -Math.abs(valorAbsoluto) : Math.abs(valorAbsoluto);

                    grupo.total[chaveColuna] += valorParaTabela;

                    if (!grupo.subgruposMap[nome2]) grupo.subgruposMap[nome2] = { conta: nome2, ...zerarColunas(), itensMap: {} };
                    grupo.subgruposMap[nome2][chaveColuna] += valorParaTabela;
                    
                    if (!grupo.subgruposMap[nome2].itensMap[itemChave]) grupo.subgruposMap[nome2].itensMap[itemChave] = { conta: itemChave, ...zerarColunas(), tipo: 'item' };
                    grupo.subgruposMap[nome2].itensMap[itemChave][chaveColuna] += valorParaTabela;

                    const ehEntradaOp = tituloGrupo.includes('01'); 
                    const ehSaidaOp = tituloGrupo.includes('02');
                    
                    if (ehEntradaOp || ehSaidaOp) {
                        if (ehSaida) FluxoOperacional[chaveColuna] -= valorAbsoluto;
                        else FluxoOperacional[chaveColuna] += valorAbsoluto;
                    }
                }
            }
        });

        const ordemDesejada = [
            '01- Entradas Operacionais', '02- Saídas Operacionais', '03- Operações Financeiras',
            '04- Ativo Imobilizado', '06- Movimentações de Sócios', '07- Caixas da Loja'
        ];

        let tabelaRows = [];
        const valInicial = 0; 
        
        tabelaRows.push({ conta: 'Saldo Inicial', ...zerarColunas(), tipo: 'info' });

        ordemDesejada.forEach(titulo => {
            const g = grupos[titulo];
            if (g) {
                const arraySubgrupos = Object.values(g.subgruposMap).map(sub => {
                    const arrayItens = Object.values(sub.itensMap);
                    return { conta: sub.conta, ...sub, tipo: 'subgrupo', detalhes: arrayItens };
                });
                tabelaRows.push({ conta: g.titulo, ...g.total, tipo: 'grupo', detalhes: arraySubgrupos });
            }
        });

        const graficoData = [];
        const linhaSaldoFinal = zerarColunas();

        colunasKeys.forEach(col => {
            linhaSaldoFinal[col] = valInicial + FluxoGlobal[col];
            graficoData.push(FluxoOperacional[col]);
        });

        tabelaRows.push({ conta: 'Saldo Final', ...linhaSaldoFinal, tipo: 'saldo' });
        const somaObj = (o) => Object.values(o).reduce((a, b) => a + b, 0);
        const totalSuperavitDeficit = somaObj(FluxoOperacional);

        res.json({
            cards: {
                saldoInicial: valInicial, 
                entrada: totalEntradasGlobal, 
                saida: totalSaidasGlobal,
                deficitSuperavit: totalSuperavitDeficit,
                saldoFinal: valInicial + totalSuperavitDeficit
            },
            grafico: { labels: colunasLabels, data: graficoData },
            tabela: { rows: tabelaRows, columns: colunasKeys, headers: colunasLabels }
        });

    } catch (err) {
        console.error("ERRO DASHBOARD:", err);
        res.status(500).json({ error: "Erro interno" });
    }
});

// Tratamento para SPA (Redireciona para index.html)
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor MySQL rodando na porta  http://localhost:${PORT}`));