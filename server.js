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



// ==============================
// TABELA FINANCEIRO (Dashboard)
// - Só deve ser exibida quando status=view = "todos" (Tipo de Visão = Todos)
// - Sem cálculos: apenas somas por mês dos títulos em aberto (Baixa IS NULL) com Financeiro preenchido
// - Hierarquia:
//   1- Previsões a Receber -> 1.001.006 - BOLETOS
//   2- Previsões a Pagar   -> 2.001.001 / 2.001.002 / 2.001.003
// ==============================
/* =========================================================
   FINANCEIRO (Dashboard) — tabela separada
   - Fonte: dfc_analitica
   - Apenas previsões em aberto: Baixa IS NULL
   - Somente quando Tipo de Visão = "Todos" (status=todos)
   ========================================================= */
async function handleFinanceiroDashboard(req, res) {
  try {
    const ano = parseInt(req.query.ano, 10);
    if (!Number.isFinite(ano)) return res.status(400).json({ error: 'Ano inválido.' });

    const status = (req.query.status || 'todos').toString().toLowerCase();
    if (status !== 'todos') {
      // Front esconde o painel; devolvemos vazio para não quebrar render.
      return res.json({ year: ano, rows: [] });
    }

    const colKeys = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
    const mapaMeses = { 1: 'jan', 2: 'fev', 3: 'mar', 4: 'abr', 5: 'mai', 6: 'jun', 7: 'jul', 8: 'ago', 9: 'set', 10: 'out', 11: 'nov', 12: 'dez' };

    const zeros = () => {
      const o = {};
      colKeys.forEach(k => o[k] = 0);
      return o;
    };

    const normalizar = (s) => (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
    const ehSaidaOperacional = (origem) => {
      const o = normalizar(origem);
      // cobre variações comuns: "02- Saídas Operacionais", "02 - Saidas operacionais", etc.
      return o.includes('02') && o.includes('sa') && o.includes('oper');
    };

    // Consulta base: títulos em aberto (Baixa IS NULL) e com Financeiro preenchido, no ano selecionado.
    // OBS: o Código pode vir em Codigo_plano (preferencial) ou no prefixo do campo Financeiro.
    const sql = `
      SELECT
        Origem_DFC,
        COALESCE(NULLIF(TRIM(Codigo_plano), ''), NULLIF(SUBSTRING(TRIM(Financeiro), 1, 9), '')) AS Codigo,
        COALESCE(NULLIF(TRIM(Nome), ''), TRIM(Financeiro)) AS Nome,
        Mes,
        Ano,
        SUM(Valor_mov) AS valor
      FROM dfc_analitica
      WHERE
        Baixa IS NULL
        AND Financeiro IS NOT NULL
        AND Ano = ?
      GROUP BY Origem_DFC, Codigo, Nome, Mes, Ano
      ORDER BY Codigo, Mes
    `;
    const [rows] = await pool.query(sql, [ano]);

    // Agrega por código para montar as linhas (detalhes) por grupo
    const mapByCodigo = new Map();
    for (const r of rows) {
      const codigo = (r.Codigo || '').toString().trim();
      if (!codigo) continue;

      const mesKey = mapaMeses[Number(r.Mes)];
      if (!mesKey) continue;

      const nome = (r.Nome || '').toString().trim();
      const conta = nome ? `${codigo} - ${nome}` : codigo;

      if (!mapByCodigo.has(codigo)) {
        mapByCodigo.set(codigo, { conta, dados: zeros(), origemDFC: r.Origem_DFC });
      }
      const ref = mapByCodigo.get(codigo);
      // mantém a origem mais “forte” (se vier vazia em algum registro, não sobrescreve)
      if (!ref.origemDFC && r.Origem_DFC) ref.origemDFC = r.Origem_DFC;

      ref.dados[mesKey] += Number(r.valor || 0);
    }

    // Grupo 1: Previsões a Receber — BOLETOS (1.001.006)
    const receberDetalhes = [];
    const boleto = mapByCodigo.get('1.001.006');
    receberDetalhes.push(
      boleto
        ? { conta: boleto.conta, tipo: 'item', dados: boleto.dados }
        : { conta: '1.001.006 - BOLETOS', tipo: 'item', dados: zeros() }
    );

    // Grupo 2: Previsões a Pagar — SOMENTE Origem_DFC = 02- Saídas Operacionais (em aberto)
    // IMPORTANTE: conforme solicitado, NÃO filtra por 2.001.001/2.001.002/2.001.003.
    const pagarDetalhes = [];
    for (const [codigo, item] of mapByCodigo.entries()) {
      if (codigo === '1.001.006') continue; // já está no Receber
      if (ehSaidaOperacional(item.origemDFC)) {
        pagarDetalhes.push({ conta: item.conta, tipo: 'item', dados: item.dados });
      }
    }
    pagarDetalhes.sort((a, b) => a.conta.localeCompare(b.conta, undefined, { numeric: true, sensitivity: 'base' }));

    const somaTotal = (detalhes) => {
      const total = zeros();
      detalhes.forEach(d => colKeys.forEach(k => total[k] += Number((d.dados && d.dados[k]) || 0)));
      return total;
    };

    return res.json({
      year: ano,
      rows: [
        { conta: '1- Previsões a Receber', tipo: 'grupo', dados: somaTotal(receberDetalhes), detalhes: receberDetalhes },
        { conta: '2- Previsões a Pagar', tipo: 'grupo', dados: somaTotal(pagarDetalhes), detalhes: pagarDetalhes },
      ],
    });
  } catch (e) {
    console.error('Erro Financeiro (Dashboard):', e);
    return res.status(500).json({ error: 'Erro ao consultar Financeiro.' });
  }
}

app.get('/api/financeiro-dashboard', handleFinanceiroDashboard);
// compat (se algum trecho do front chamar /api/financeiro)
app.get('/api/financeiro', handleFinanceiroDashboard);

app.get('/api/dashboard', async (req, res) => {
  try {
    const hoje = new Date();
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
      const anosUnicos = [...new Set(rawData.map(r => r.Ano))].sort((a, b) => a - b);
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
      '02- saídas operacionais': '02- Saídas Operacionais',
      '02-saidas operacionais': '02- Saídas Operacionais',
      '01- entradas operacionais': '01- Entradas Operacionais',
      '01-entradas operacionais': '01- Entradas Operacionais',
      '03- operações financeiras': '03- Operações Financeiras',
      '03- operações finaceiras': '03- Operações Financeiras',
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
      const valorParaTabela = ehSaida ? -Math.abs(valorAbsoluto) : Math.abs(valorAbsoluto);

      FluxoGlobal[chaveColuna] += valorParaTabela;

      if (row.Origem_DFC) {
        const chaveBanco = normalizar(row.Origem_DFC);
        const tituloGrupo = configCategorias[chaveBanco] || Object.values(configCategorias).find(v => normalizar(v).includes(chaveBanco));

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

    const ordemDesejada = ['01- Entradas Operacionais', '02- Saídas Operacionais', '03- Operações Financeiras', '04- Ativo Imobilizado', '06- Movimentações de Sócios', '07- Caixas da Loja'];

    // =========================================================
    // SALDO INICIAL (CICLO ANUAL) — movimentos_contas
    // Jan de cada ano: soma de todos os anos anteriores
    // Meses seguintes: saldo final do mês anterior
    // =========================================================
    const saldoInicialCols = zerarColunas();

    const sqlMov = `
      SELECT Ano, Mes,
             SUM(CASE
                 WHEN LOWER(Natureza) LIKE 'sa%' THEN -ABS(valor)
                 ELSE ABS(valor)
             END) AS liquido
      FROM movimentos_contas
      WHERE
        (
          ? = 'anual' AND Ano <= ?
        ) OR (
          ? <> 'anual' AND (Ano < ? OR (Ano = ? AND Mes BETWEEN 1 AND 12))
        )
      GROUP BY Ano, Mes
    `;

    const anoSel = Number(ano) || hoje.getFullYear();

    let movRows = [];
    if (view === 'anual') {
      const years = colunasKeys.map(y => parseInt(y, 10)).filter(Number.isFinite);
      const maxY = years.length ? Math.max(...years) : anoSel;
      const [r] = await pool.query(sqlMov, ['anual', maxY, 'anual', anoSel, anoSel]);
      movRows = r;
      // converte para liquido por ano
      const netByYear = new Map();
      movRows.forEach(x => {
        const y = Number(x.Ano);
        netByYear.set(y, (netByYear.get(y) || 0) + Number(x.liquido || 0));
      });
      let prefix = 0;
      years.sort((a,b)=>a-b).forEach(y => {
        saldoInicialCols[y.toString()] = prefix;
        prefix += (netByYear.get(y) || 0);
      });
    } else if (view === 'trimestral') {
      const [r] = await pool.query(sqlMov, [view || 'mensal', 0, view || 'mensal', anoSel, anoSel]);
      movRows = r;

      let base = 0;
      const netMes = new Map();
      movRows.forEach(x => {
        if (Number(x.Ano) < anoSel) base += Number(x.liquido || 0);
        if (Number(x.Ano) === anoSel) netMes.set(Number(x.Mes), (netMes.get(Number(x.Mes)) || 0) + Number(x.liquido || 0));
      });

      const quarterMonths = { Q1: [1,2,3], Q2: [4,5,6], Q3: [7,8,9], Q4: [10,11,12] };
      let running = base;
      colunasKeys.forEach(q => {
        saldoInicialCols[q] = running;
        const months = quarterMonths[q] || [];
        let netQ = 0;
        months.forEach(m => netQ += (netMes.get(m) || 0));
        running += netQ;
      });
    } else {
      const [r] = await pool.query(sqlMov, [view || 'mensal', 0, view || 'mensal', anoSel, anoSel]);
      movRows = r;

      let base = 0;
      const netMes = new Map();
      movRows.forEach(x => {
        if (Number(x.Ano) < anoSel) base += Number(x.liquido || 0);
        if (Number(x.Ano) === anoSel) netMes.set(Number(x.Mes), (netMes.get(Number(x.Mes)) || 0) + Number(x.liquido || 0));
      });

      let running = base;
      for (let m = 1; m <= 12; m++) {
        const key = mapaMeses[m];
        saldoInicialCols[key] = running;
        running += (netMes.get(m) || 0);
      }
    }

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
      } else {
        // garante a linha estrutural (ex.: 04- Ativo Imobilizado)
        tabelaRows.push({ conta: titulo, ...zerarColunas(), tipo: 'grupo', detalhes: [] });
      }
    });

    const totalEntradasOperacionais = grupos['01- Entradas Operacionais']
      ? Object.values(grupos['01- Entradas Operacionais'].total).reduce((a, b) => a + b, 0)
      : 0;

    const totalSaidasOperacionais = grupos['02- Saídas Operacionais']
      ? Math.abs(Object.values(grupos['02- Saídas Operacionais'].total).reduce((a, b) => a + b, 0))
      : 0;

    const linhaSaldoFinal = zerarColunas();
    const graficoData = [];

    colunasKeys.forEach(col => {
      linhaSaldoFinal[col] = (saldoInicialCols[col] || 0) + (FluxoGlobal[col] || 0);
      graficoData.push(FluxoOperacional[col] || 0);
    });

    tabelaRows.push({ conta: 'Saldo Final', ...linhaSaldoFinal, tipo: 'saldo' });

    const totalSuperavitDeficit = Object.values(FluxoOperacional).reduce((a, b) => a + b, 0);

    const saldoInicialCard = (view === 'anual')
      ? (colunasKeys.length ? (saldoInicialCols[colunasKeys[0]] || 0) : 0)
      : (saldoInicialCols['jan'] || 0);

    const saldoFinalCard = colunasKeys.length
      ? (linhaSaldoFinal[colunasKeys[colunasKeys.length - 1]] || 0)
      : 0;

    res.json({
      cards: {
        saldoInicial: saldoInicialCard,
        entrada: totalEntradasOperacionais,
        saida: totalSaidasOperacionais,
        deficitSuperavit: totalSuperavitDeficit,
        saldoFinal: saldoFinalCard
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