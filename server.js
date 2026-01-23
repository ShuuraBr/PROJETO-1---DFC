require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db'); 
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();

// Configurações do Express
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SENHA_PADRAO = 'Obj@2026';

// --- LOGICA DE FERIADOS E DIAS ÚTEIS (NOVA) ---
const getFeriados = (ano) => {
    const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];
    const moveis = {
        2024: ['02-13', '03-29', '05-30'],
        2025: ['03-04', '04-18', '06-19'],
        2026: ['02-17', '04-03', '06-04'],
        2027: ['02-09', '03-26', '05-27'],
        2028: ['02-29', '04-14', '06-15']
    };
    return fixos.map(f => `${ano}-${f}`).concat(moveis[ano] || []);
};

const getProximoDiaUtil = (dataInput) => {
    let data = new Date(dataInput);
    // Ajuste para evitar problemas de fuso horário local na conversão
    if (typeof dataInput === 'string' && !dataInput.includes('T')) {
        data = new Date(dataInput + 'T12:00:00');
    }

    const ehDiaUtil = (d) => {
        const ano = d.getFullYear();
        const mes = String(d.getMonth() + 1).padStart(2, '0');
        const dia = String(d.getDate()).padStart(2, '0');
        const dataFormatada = `${ano}-${mes}-${dia}`;
        const diaSemana = d.getDay(); // 0 = Domingo, 6 = Sábado
        const feriados = getFeriados(ano);
        return diaSemana !== 0 && diaSemana !== 6 && !feriados.includes(dataFormatada);
    };

    while (!ehDiaUtil(data)) {
        data.setDate(data.getDate() + 1);
    }
    return data;
};

// --- Configuração do Nodemailer ---
const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
        user: 'no-reply@dfc.objetivaatacadista.com.br', 
        pass: process.env.EMAIL_PASS 
    }
});

// =========================================================================
// ROTAS DE AUTENTICAÇÃO (2FA - 60 Segundos via MySQL)
// =========================================================================

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
            const token = crypto.randomInt(100000, 999999).toString();
            await pool.query(
                `INSERT INTO tokens_acesso (email, token, expira_em) 
                 VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 60 SECOND))`,
                [email, token]
            );

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
                            <p>Válido por <strong>60 segundos</strong>.</p>
                        </div>
                    `
                });
                res.json({ success: true, require2fa: true, email: email });

            } catch (mailErr) {
                console.error("Erro ao enviar email:", mailErr);
                res.status(500).json({ success: false, message: 'Erro envio email.' });
            }

        } else {
            res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }
    } catch (e) {
        console.error("[LOGIN] Erro:", e.message);
        res.status(500).json({ success: false, message: 'Erro BD.' });
    }
});

app.post('/api/validar-token', async (req, res) => {
    const { email, token } = req.body;
    try {
        const [tokens] = await pool.query(
            `SELECT * FROM tokens_acesso WHERE email = ? AND token = ? AND expira_em > NOW() ORDER BY id DESC LIMIT 1`,
            [email, token]
        );

        if (tokens.length > 0) {
            const queryUser = `
                SELECT U.Email, U.Nome, U.Role, U.Nivel, U.Senha_prov, D.Nome_dep as Departamento 
                FROM usuarios U LEFT JOIN departamentos D ON U.Pk_dep = D.Id_dep WHERE U.Email = ?
            `;
            const [users] = await pool.query(queryUser, [email]);
            const u = users[0];
            await pool.query('DELETE FROM tokens_acesso WHERE id = ?', [tokens[0].id]);
            res.json({ success: true, user: { ...u, Nome: u.Nome || 'Usuário', Role: u.Role || 'user' } });
        } else {
            res.status(401).json({ success: false, message: 'Token inválido/expirado.' });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

// =========================================================================
// ROTAS DO SISTEMA
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
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/definir-senha', async (req, res) => {
    const { email, novaSenha } = req.body;
    try {
        await pool.query('UPDATE usuarios SET Senha = ?, Senha_prov = NULL WHERE Email = ?', [novaSenha, email]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
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

        let queryOrc = `SELECT Plano, Nome, Departamento1, Janeiro, Fevereiro, Marco, Abril, Maio, Junho, Julho, Agosto, Setembro, Outubro, Novembro, Dezembro FROM orcamento WHERE 1=1 `;
        const paramsOrc = [];
        if (!isSuperUser) { queryOrc += ' AND Departamento1 = ?'; paramsOrc.push(departamentoUsuario); }
        queryOrc += ' ORDER BY Departamento1, Plano';

        const [orcamentoData] = await pool.query(queryOrc, paramsOrc);

        let queryReal = `SELECT Codigo_plano, Nome, Mes, Ano, Dt_mov, Valor_mov FROM dfc_analitica WHERE 1=1 `;
        const paramsReal = [];
        // Busca um range de 2 anos para capturar boletos que podem transbordar o ano
        if (ano) { queryReal += ' AND (Ano = ? OR Ano = ?)'; paramsReal.push(ano, parseInt(ano) + 1); }
        queryReal += ' ORDER BY Dt_mov';

        const [resRealRaw] = await pool.query(queryReal, paramsReal);
        const mapRealizado = {};
        
        resRealRaw.forEach(r => {
            let mesAlvo = r.Mes;
            let anoAlvo = r.Ano;

            // Condição para Boletos - Afeta a competência (mês/ano)
            if (r.Nome && r.Nome.toLowerCase().includes('boleto') && r.Dt_mov) {
                const dataUtil = getProximoDiaUtil(r.Dt_mov);
                mesAlvo = dataUtil.getMonth() + 1;
                anoAlvo = dataUtil.getFullYear();
            }

            // Atribui ao mapa apenas se, após a postergação, pertencer ao ano filtrado
            if (!ano || anoAlvo.toString() === ano.toString()) {
                const chave = `${r.Codigo_plano}-${mesAlvo}`;
                mapRealizado[chave] = (mapRealizado[chave] || 0) + (parseFloat(r.Valor_mov) || 0);
            }
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

        // Lógica de Ordenação Crescente Numérica (Aba Orçamento)
        Object.values(grupos).forEach(grupo => {
            grupo.detalhes.sort((a, b) => a.conta.localeCompare(b.conta, undefined, { numeric: true, sensitivity: 'base' }));
        });

        res.json(Object.values(grupos));
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: 'Erro ao processar orçamento' }); 
    }
});

app.get('/api/dashboard', async (req, res) => {
    try {
        const { ano, view, status } = req.query; 
        
        let query = 'SELECT Origem_DFC, Nome_2, Codigo_plano, Nome, Mes, Ano, Valor_mov, Natureza, Dt_mov, Baixa FROM dfc_analitica WHERE 1=1';
        const params = [];

        // Buscamos um ano antes para capturar boletos de 31/12 que pulam para 01/01
        if (view !== 'anual' && ano) {
            query += ' AND (Ano = ? OR ( (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") AND Ano = ?))';
            params.push(ano, parseInt(ano) - 1);
        }

        // --- FILTRO POR STATUS (REALIZADO / EM ABERTO) ---
        if (status === 'realizado') {
            query += ' AND (NOT (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") OR Baixa IS NOT NULL)';
        } else if (status === 'aberto') {
            query += ' AND (NOT (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") OR Baixa IS NULL)';
        }

        const [rawData] = await pool.query(query, params);

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
            '02- saidas operacionais': '02- Saídas Operacionais',
            '03- operações financeiras': '03- Operações Financeiras',
            '04- ativo imobilizado': '04- Ativo Imobilizado',
            '06- movimentações de socios': '06- Movimentações de Sócios',
            '07- caixas da loja': '07- Caixas da Loja'
        };

        let grupos = {};
        let FluxoGlobal = zerarColunas(); 
        let FluxoOperacional = zerarColunas();
        
        rawData.forEach(row => {
            let numMes = row.Mes;
            let numAno = row.Ano;

            // Lógica de Boletos: Próximo Dia Útil (Define a competência do mês/ano)
            if (row.Nome && row.Nome.toLowerCase().includes('boleto') && row.Dt_mov) {
                const dataUtil = getProximoDiaUtil(row.Dt_mov);
                numMes = dataUtil.getMonth() + 1;
                numAno = dataUtil.getFullYear();
            }

            // Filtro final: ignora se após postergar o boleto ele saiu do ano selecionado
            if (view !== 'anual' && ano && numAno.toString() !== ano.toString()) return;

            let chaveColuna = '';
            if (view === 'anual') {
                chaveColuna = numAno.toString();
            } else if (view === 'trimestral') {
                chaveColuna = `Q${Math.ceil(numMes / 3)}`;
            } else {
                chaveColuna = mapaMeses[numMes];
            }

            if (!colunasKeys.includes(chaveColuna)) return;

            const valorAbsoluto = parseFloat(row.Valor_mov) || 0; 
            const natureza = row.Natureza ? row.Natureza.trim().toLowerCase() : '';
            const ehSaida = natureza.includes('saída') || natureza.includes('saida');
            let valorParaTabela = ehSaida ? -Math.abs(valorAbsoluto) : Math.abs(valorAbsoluto);

            FluxoGlobal[chaveColuna] += valorParaTabela;

            if (row.Origem_DFC) {
                const chaveBanco = normalizar(row.Origem_DFC);
                let tituloGrupo = configCategorias[chaveBanco] || Object.values(configCategorias).find(v => normalizar(v).includes(chaveBanco));

                if (tituloGrupo) {
                    if (!grupos[tituloGrupo]) grupos[tituloGrupo] = { titulo: tituloGrupo, total: zerarColunas(), subgruposMap: {} };
                    const grupo = grupos[tituloGrupo];
                    
                    const nome2 = row.Nome_2 ? row.Nome_2.trim() : 'Outros';
                    const cod = row.Codigo_plano || '';
                    const nom = row.Nome || '';
                    const itemChave = `${cod} - ${nom}`;

                    grupo.total[chaveColuna] += valorParaTabela;

                    if (!grupo.subgruposMap[nome2]) grupo.subgruposMap[nome2] = { conta: nome2, ...zerarColunas(), itensMap: {} };
                    grupo.subgruposMap[nome2][chaveColuna] += valorParaTabela;
                    
                    if (!grupo.subgruposMap[nome2].itensMap[itemChave]) grupo.subgruposMap[nome2].itensMap[itemChave] = { conta: itemChave, ...zerarColunas(), tipo: 'item' };
                    grupo.subgruposMap[nome2].itensMap[itemChave][chaveColuna] += valorParaTabela;

                    if (tituloGrupo.includes('01') || tituloGrupo.includes('02')) {
                        FluxoOperacional[chaveColuna] += valorParaTabela;
                    }
                }
            }
        });

        
        // ==============================
        // SALDO INICIAL (movimentos_contas) + CUMULATIVO (a partir de Jan/2025)
        // Regras:
        // - Natureza = 'Entrada' soma, Natureza = 'Saída/Saida' subtrai
        // - Saldo Inicial de Jan/2025 = liquidação de TODOS os anos anteriores (movimentos_contas)
        // - Para frente: saldo final de Jan/2025 alimenta os próximos períodos (acumulado)
        // ==============================

        const parseAnoNum = (a) => parseInt(a, 10);
        const anoSelNum = ano ? parseAnoNum(ano) : null;

        const assinarValor = (naturezaStr, valor) => {
            const n = (naturezaStr || '').toString().trim().toLowerCase();
            const v = parseFloat(valor) || 0;
            if (n.includes('saída') || n.includes('saida')) return -Math.abs(v);
            return Math.abs(v);
        };

        // 1) Baseline: saldo acumulado até Dez/2024 (tudo antes de Jan/2025)
        let baselineSaldoJan2025 = 0;
        try {
            const [rowsSaldoBase] = await pool.query(
                `SELECT COALESCE(SUM(CASE
                    WHEN LOWER(Natureza) LIKE '%saida%' OR LOWER(Natureza) LIKE '%saída%' THEN -ABS(valor)
                    ELSE ABS(valor)
                 END), 0) AS saldoBase
                 FROM movimentos_contas
                 WHERE CAST(Ano AS SIGNED) < 2025`
            );
            baselineSaldoJan2025 = parseFloat(rowsSaldoBase?.[0]?.saldoBase) || 0;
        } catch (e) {
            console.warn('[Saldo Inicial] Falha ao consultar movimentos_contas:', e.message);
            baselineSaldoJan2025 = 0;
        }

        // 2) Carry: soma dos fluxos do DFC (dfc_analitica) de Jan/2025 até o período anterior ao exibido
        //    (necessário para anos > 2025 e para visão anual com primeiro ano > 2025)
        let carryAntesPeriodo = 0;

        // Determina "primeiro período exibido" para saber até onde acumular
        let primeiroAnoExibido = null;
        if (view === 'anual') {
            const anosCols = colunasKeys.map(k => parseAnoNum(k)).filter(n => Number.isFinite(n)).sort((a,b)=>a-b);
            primeiroAnoExibido = anosCols.length ? anosCols[0] : anoSelNum;
        } else {
            primeiroAnoExibido = anoSelNum;
        }

        if (Number.isFinite(primeiroAnoExibido) && primeiroAnoExibido > 2025) {
            // Busca dfc_analitica de 2025 até ano anterior ao primeiro exibido (inclusive)
            let queryCarry = 'SELECT Nome, Mes, Ano, Valor_mov, Natureza, Dt_mov, Baixa FROM dfc_analitica WHERE 1=1';
            const paramsCarry = [];

            queryCarry += ' AND CAST(Ano AS SIGNED) >= 2025 AND CAST(Ano AS SIGNED) < ?';
            paramsCarry.push(primeiroAnoExibido);

            // aplica o mesmo filtro de status do dashboard
            if (status === 'realizado') {
                queryCarry += ' AND (NOT (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") OR Baixa IS NOT NULL)';
            } else if (status === 'aberto') {
                queryCarry += ' AND (NOT (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") OR Baixa IS NULL)';
            }

            const [rowsCarry] = await pool.query(queryCarry, paramsCarry);

            rowsCarry.forEach(row => {
                let y = row.Ano;
                let mth = row.Mes;

                // Mesma regra de competência para boletos (próximo dia útil)
                if (row.Nome && row.Nome.toLowerCase().includes('boleto') && row.Dt_mov) {
                    const dataUtil = getProximoDiaUtil(row.Dt_mov);
                    mth = dataUtil.getMonth() + 1;
                    y = dataUtil.getFullYear();
                }

                const valorAssinado = assinarValor(row.Natureza, row.Valor_mov);
                // acumula tudo de 2025 até (primeiroAnoExibido-1)
                if (Number.isFinite(parseAnoNum(y)) && parseAnoNum(y) >= 2025 && parseAnoNum(y) < primeiroAnoExibido) {
                    carryAntesPeriodo += valorAssinado;
                }
            });
        }

        // 3) Saldo inicial por coluna exibida (acumulado)
        const saldoInicialCols = zerarColunas();
        const saldoFinalCols = zerarColunas();

        // só aplicamos a regra a partir de 2025 (conforme solicitado)
        let saldoAtual = 0;
        if ((view === 'anual' && Number.isFinite(primeiroAnoExibido) && primeiroAnoExibido >= 2025) ||
            (view !== 'anual' && Number.isFinite(anoSelNum) && anoSelNum >= 2025)) {
            saldoAtual = baselineSaldoJan2025 + carryAntesPeriodo;
        }

        // ordem de colunas para acumular
        const ordemColunas = colunasKeys.slice(); // já vem na ordem correta
        ordemColunas.forEach(colKey => {
            saldoInicialCols[colKey] = saldoAtual;
            saldoAtual = saldoAtual + (FluxoGlobal[colKey] || 0);
            saldoFinalCols[colKey] = saldoAtual;
        });

const ordemDesejada = ['01- Entradas Operacionais', '02- Saídas Operacionais', '03- Operações Financeiras', '04- Ativo Imobilizado', '06- Movimentações de Sócios', '07- Caixas da Loja'];

        let tabelaRows = [{ conta: 'Saldo Inicial', ...saldoInicialCols, tipo: 'info' }];

        ordemDesejada.forEach(titulo => {
            const g = grupos[titulo];
            if (g) {
                const arraySubgrupos = Object.values(g.subgruposMap).map(sub => {
                    const arrayItens = Object.values(sub.itensMap);
                    arrayItens.sort((a, b) => a.conta.localeCompare(b.conta, undefined, { numeric: true }));
                    return { conta: sub.conta, ...sub, tipo: 'subgrupo', detalhes: arrayItens };
                });
                arraySubgrupos.sort((a, b) => a.conta.localeCompare(b.conta, undefined, { numeric: true }));
                tabelaRows.push({ conta: g.titulo, ...g.total, tipo: 'grupo', detalhes: arraySubgrupos });
            }
        });

        const totalEntradasOperacionais = grupos['01- Entradas Operacionais'] ? Object.values(grupos['01- Entradas Operacionais'].total).reduce((a, b) => a + b, 0) : 0;
        const totalSaidasOperacionais = grupos['02- Saídas Operacionais'] ? Math.abs(Object.values(grupos['02- Saídas Operacionais'].total).reduce((a, b) => a + b, 0)) : 0;

        const linhaSaldoFinal = saldoFinalCols;
        const graficoData = [];
        colunasKeys.forEach(col => {
            graficoData.push(FluxoOperacional[col]);
        });

        tabelaRows.push({ conta: 'Saldo Final', ...linhaSaldoFinal, tipo: 'saldo' });
        const totalSuperavitDeficit = Object.values(FluxoOperacional).reduce((a, b) => a + b, 0);

        res.json({
            cards: {
                saldoInicial: saldoInicialCols[colunasKeys[0]] || 0, 
                entrada: totalEntradasOperacionais, 
                saida: totalSaidasOperacionais,
                deficitSuperavit: totalSuperavitDeficit,
                saldoFinal: saldoFinalCols[colunasKeys[colunasKeys.length-1]] || 0
            },
            grafico: { labels: colunasLabels, data: graficoData },
            tabela: { rows: tabelaRows, columns: colunasKeys, headers: colunasLabels }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro interno" });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta http://192.168.3.67:${PORT}`));