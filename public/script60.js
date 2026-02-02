
function renderFinanceiroDashboard(payload) {
    const tbody = document.querySelector('#financeiro-table tbody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (!payload || !Array.isArray(payload.rows)) return;

    // rows: [{ key, label, values:{1:..}, children:[{label, values}] }]
    payload.rows.forEach((row) => {
        const tr = document.createElement('tr');
        tr.classList.add('hover-row', 'grupo'); // nível 1 em negrito (CSS)
        tr.dataset.key = row.key || row.label;

        // Coluna 1
        const td0 = document.createElement('td');
        td0.style.cursor = (row.children && row.children.length) ? 'pointer' : 'default';

        const hasChildren = Array.isArray(row.children) && row.children.length > 0;
        const icon = document.createElement('span');
        icon.className = 'toggle-icon';
        icon.textContent = hasChildren ? '▸' : '';
        td0.appendChild(icon);

        const label = document.createElement('span');
        label.textContent = row.label || '';
        td0.appendChild(label);

        tr.appendChild(td0);

        // Meses 1..12
        for (let mes = 1; mes <= 12; mes++) {
            const td = document.createElement('td');
            const v = row.values && row.values[mes] != null ? row.values[mes] : 0;
            td.textContent = formatCurrency(v);
            tr.appendChild(td);
        }

        tbody.appendChild(tr);

        // children rows (hidden by default)
        if (hasChildren) {
            row.children.forEach((child) => {
                const ctr = document.createElement('tr');
                ctr.classList.add('child-row', 'hover-row');
                ctr.dataset.parent = tr.dataset.key;
                ctr.style.display = 'none';

                const ctd0 = document.createElement('td');
                ctd0.textContent = child.label || '';
                ctr.appendChild(ctd0);

                for (let mes = 1; mes <= 12; mes++) {
                    const ctd = document.createElement('td');
                    const cv = child.values && child.values[mes] != null ? child.values[mes] : 0;
                    ctd.textContent = formatCurrency(cv);
                    ctr.appendChild(ctd);
                }
                tbody.appendChild(ctr);
            });

            // toggle click
            tr.addEventListener('click', () => {
                const open = tr.dataset.open === '1';
                tr.dataset.open = open ? '0' : '1';
                icon.textContent = open ? '▸' : '▾';

                const childs = tbody.querySelectorAll(`tr.child-row[data-parent="${CSS.escape(tr.dataset.key)}"]`);
                childs.forEach(r => r.style.display = open ? 'none' : '');
            });
        }
    });
}

async function fetchFinanceiroDashboard(ano) {
    const url = `/api/financeiro?ano=${encodeURIComponent(ano)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Erro ao buscar Financeiro (${res.status})`);
    return await res.json();
}
// ARQUIVO: public/script.js

const ANO_ATUAL = new Date().getFullYear();

const app = {
    user: null,
    chart: null,
    orcamentoChart: null,
    
    // --- ESTADO 2FA ---
    emailTemp: null,
    timer: null, // Novo estado para controlar o relógio

    // ESTADO INICIAL
    yearDashboard: ANO_ATUAL, 
    yearOrcamento: ANO_ATUAL,
    orcamentoView: 'orcamento',
    viewType: "mensal", 
    
    // CACHE
    dadosOrcamentoCache: null,

    init: () => {
        const usuarioSalvo = sessionStorage.getItem('dfc_user');
        // Ativa botões de mostrar/ocultar senha
        app.bindPasswordToggles();
        
        app.carregarAnosDisponiveis();

        // Recalcula alturas de sticky (Saldo Inicial/Final) quando a janela muda
        window.addEventListener('resize', () => {
            if (document.getElementById('finance-table')) {
                app.setupFinanceStickyRows();
                if (app.syncDfcFinanceiroColumns) app.syncDfcFinanceiroColumns();
            }
        });

        // Listeners Globais
        const loginForm = document.getElementById('loginForm');
        if(loginForm) loginForm.addEventListener('submit', app.login);

        // --- LISTENER NOVO PARA TOKEN ---
        const tokenForm = document.getElementById('tokenForm');
        if(tokenForm) tokenForm.addEventListener('submit', app.validarToken);

        const btnCancelarToken = document.getElementById('btn-cancelar-token');
        if(btnCancelarToken) btnCancelarToken.addEventListener('click', app.resetLoginUI);
        // ---------------------------------

        const btnLogout = document.getElementById('btn-logout');
        if(btnLogout) btnLogout.addEventListener('click', app.logout);

        const formCadastro = document.getElementById('form-cadastro');
        if(formCadastro) formCadastro.addEventListener('submit', app.cadastrarUsuario);
        
        const formReset = document.getElementById('form-reset');
        if(formReset) formReset.addEventListener('submit', app.confirmarResetSenha);

        const searchInput = document.getElementById('dashboard-search');
        const clearBtn = document.getElementById('btn-clear-search');

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const val = e.target.value;
                if (clearBtn) {
                    if (val.length > 0) clearBtn.classList.remove('hidden');
                    else clearBtn.classList.add('hidden');
                }
                app.searchDashboardTable(val);
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if(searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                }
                clearBtn.classList.add('hidden');
                app.resetDashboardTable(); 
            });
        }

        const viewSelect = document.getElementById('dashboard-view-type');
        if(viewSelect) {
            viewSelect.addEventListener('change', (e) => {
                app.viewType = e.target.value;
                app.toggleYearFilterVisibility();
                app.fetchData(); 
            });
        }

        // --- NOVO LISTENER PARA FILTRO DE STATUS (REALIZADO/ABERTO) ---
        const statusSelect = document.getElementById('dashboard-status-view');
        if(statusSelect) {
            statusSelect.addEventListener('change', () => {
                app.fetchData();
            });
        }
        
        
        const filtroViewOrc = document.getElementById('orcamento-view');
        if (filtroViewOrc) {
            filtroViewOrc.addEventListener('change', () => {
                app.orcamentoView = filtroViewOrc.value || 'orcamento';
                // mantém filtros atuais
                app.loadOrcamento();
            });
        }

const filtroDept = document.getElementById('filtro-dep-orcamento');
        if(filtroDept) {
            filtroDept.addEventListener('change', () => {
                app.aplicarFiltrosOrcamento();
            });
        }

        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (btn.id === 'btn-logout' || btn.closest('#btn-logout')) return;
                const target = btn.dataset.target;
                if (target) app.switchTab(target);
            });
        });

        if (usuarioSalvo) {
            try {
                app.user = JSON.parse(usuarioSalvo);
                if (app.user.Senha_prov) {
                    document.getElementById('view-login').classList.add('hidden');
                    document.getElementById('modal-reset').classList.remove('hidden');
                } else {
                    app.showApp();
                }
            } catch (e) {
                console.error("Erro ao restaurar sessão:", e);
                sessionStorage.removeItem('dfc_user'); 
                app.showLogin();
            }
        } else {
            app.showLogin();
        }
    },

    toggleYearFilterVisibility: () => {
        const anoFilter = document.getElementById('ano-dashboard');
        if(!anoFilter) return;

        if (app.viewType === 'anual') {
            anoFilter.classList.add('hidden');
        } else {
            anoFilter.classList.remove('hidden');
        }
    },

    resetDashboardTable: () => {
        const tbody = document.querySelector('#finance-table tbody');
        if (!tbody) return;

        const rows = Array.from(tbody.querySelectorAll('tr'));
        
        rows.forEach(row => {
            row.classList.remove('highlight-row');
            if (row.classList.contains('child-row')) {
                row.classList.add('hidden');
            }
            const icon = row.querySelector('.toggle-icon');
            if (icon) {
                icon.style.transform = 'rotate(0deg)';
            }
        });
    },

    searchDashboardTable: (term) => {
        const tbody = document.querySelector('#finance-table tbody');
        if (!tbody) return;

        const termo = term.toLowerCase().trim();
        if (termo.length < 2) {
            app.resetDashboardTable();
            return;
        }

        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.forEach(r => r.classList.remove('highlight-row'));

        let encontrouAlgo = false;

        const abrirPai = (classePai) => {
            const idAlvo = classePai.replace('pai-', '');
            const rowPai = rows.find(r => r.getAttribute('onclick') && r.getAttribute('onclick').includes(`'${idAlvo}'`));
            
            if (rowPai) {
                const icon = rowPai.querySelector('.toggle-icon');
                if (icon) icon.style.transform = 'rotate(90deg)';
                rowPai.classList.remove('hidden');
                const classesPai = Array.from(rowPai.classList);
                const classeAvo = classesPai.find(c => c.startsWith('pai-')); 
                if (classeAvo) abrirPai(classeAvo);
            }
        };

        rows.forEach(row => {
            const cellText = row.cells[0] ? row.cells[0].innerText.toLowerCase() : '';
            if (!row.classList.contains('child-row') && !row.getAttribute('onclick')) return; 
            
            if (cellText.includes(termo)) {
                encontrouAlgo = true;
                row.classList.add('highlight-row');
                row.classList.remove('hidden');
                const classes = Array.from(row.classList);
                const classePai = classes.find(c => c.startsWith('pai-'));
                if (classePai) abrirPai(classePai);
            }
        });

        if (encontrouAlgo) {
            const primeiro = tbody.querySelector('.highlight-row');
            if (primeiro) primeiro.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    },

    carregarAnosDisponiveis: async () => {
        let anos = [2025]; 
        
        try {
            const res = await fetch('/api/anos');
            if (res.ok) {
                const dados = await res.json();
                if (Array.isArray(dados) && dados.length > 0) {
                    anos = dados.map(d => parseInt(d.Ano || d));
                }
            }
        } catch (error) {
            console.log("API de anos offline, usando padrão.");
        }

        if (!anos.includes(ANO_ATUAL)) {
            anos.push(ANO_ATUAL);
        }

        anos = [...new Set(anos)].sort((a, b) => a - b);

        app.setupYearFilters(anos);
        
        if (app.user && !document.getElementById('page-dashboard').classList.contains('hidden')) {
            app.fetchData();
        }
    },

    setupYearFilters: (anosDisponiveis) => {
        const selects = [
            { id: 'ano-dashboard', context: 'dashboard' },
            { id: 'ano-orcamento', context: 'orcamento' }
        ];
        
        let anoAlvo = ANO_ATUAL;
        
        if (!anosDisponiveis.includes(ANO_ATUAL) && anosDisponiveis.length > 0) {
            anoAlvo = anosDisponiveis[anosDisponiveis.length - 1];
        }

        app.yearDashboard = anoAlvo;
        app.yearOrcamento = anoAlvo;

        selects.forEach(obj => {
            const el = document.getElementById(obj.id);
            if(el) {
                el.innerHTML = '';
                
                anosDisponiveis.forEach(ano => {
                    const opt = document.createElement('option');
                    opt.value = ano;
                    opt.innerText = ano;
                    
                    if (ano === anoAlvo) {
                        opt.setAttribute('selected', 'selected');
                        opt.selected = true;
                    }
                    
                    el.appendChild(opt);
                });

                el.value = anoAlvo;

                const newEl = el.cloneNode(true);
                el.parentNode.replaceChild(newEl, el);

                newEl.value = anoAlvo;

                newEl.addEventListener('change', (e) => {
                    const valor = parseInt(e.target.value);
                    
                    if (obj.context === 'dashboard') {
                        app.yearDashboard = valor;
                        app.fetchData(); 
                    } else {
                        app.yearOrcamento = valor;
                        app.loadOrcamento(); 
                    }
                });
            }
        });
    },

    setLoading: (show) => {
        const el = document.getElementById('loader');
        if(el) show ? el.classList.remove('hidden') : el.classList.add('hidden');
    },

    showLogin: () => {
        const viewLogin = document.getElementById('view-login');
        const viewApp = document.getElementById('view-app');
        const modalReset = document.getElementById('modal-reset');
        if(viewLogin) viewLogin.classList.remove('hidden');
        if(viewApp) viewApp.classList.add('hidden');
        if(modalReset) modalReset.classList.add('hidden');
        app.user = null;
    },

    login: async (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const err = document.getElementById('msg-error');
        
        app.setLoading(true);
        err.innerText = "";
        
        try {
            const res = await fetch('/api/login', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            const grupos = Array.isArray(data) ? data : (data.grupos || []);
            app.dadosOrcamentoMeta = Array.isArray(data) ? null : (data.meta || null);
            
            if (data.success && data.require2fa) {
                app.emailTemp = data.email;
                document.getElementById('loginForm').classList.add('hidden');
                document.getElementById('tokenForm').classList.remove('hidden');
                document.getElementById('token-input').value = "";
                document.getElementById('token-input').focus();
                
                app.startCountdown();

            } else if (!data.success) { 
                err.innerText = data.message; 
                err.style.color = 'var(--danger)';
            }
        } catch (e) { 
            err.innerText = "Erro de conexão."; 
            err.style.color = 'var(--danger)';
        } finally { 
            app.setLoading(false); 
        }
    },

    startCountdown: () => {
        const err = document.getElementById('msg-error');
        let timeLeft = 60;
        
        if (app.timer) clearInterval(app.timer);
        
        err.innerText = `Código enviado! Válido por ${timeLeft}s`;
        err.style.color = '#2563eb'; 

        app.timer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(app.timer);
                err.innerText = "Tempo esgotado. Solicite novo código.";
                err.style.color = '#ef4444'; 
            } else {
                err.innerText = `Código enviado! Válido por ${timeLeft}s`;
            }
        }, 1000);
    },

    validarToken: async (e) => {
        e.preventDefault();
        const token = document.getElementById('token-input').value;
        const err = document.getElementById('msg-error');

        if(!token || token.length < 6) {
            err.innerText = "Digite o código completo.";
            err.style.color = '#ef4444';
            return;
        }

        app.setLoading(true);

        try {
            const res = await fetch('/api/validar-token', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email: app.emailTemp, token: token })
            });
            const data = await res.json();
            const grupos = Array.isArray(data) ? data : (data.grupos || []);
            app.dadosOrcamentoMeta = Array.isArray(data) ? null : (data.meta || null);

            if (data.success) {
                if (app.timer) clearInterval(app.timer); 
                
                app.user = data.user;
                sessionStorage.setItem('dfc_user', JSON.stringify(app.user));
                
                document.getElementById('password').value = "";
                app.resetLoginUI();

                if (app.user.Senha_prov) {
                    document.getElementById('view-login').classList.add('hidden');
                    document.getElementById('modal-reset').classList.remove('hidden'); 
                } else { app.showApp(); }
            } else {
                err.innerText = data.message; 
                err.style.color = '#ef4444';
            }
        } catch (e) {
            err.innerText = "Erro ao validar token.";
            err.style.color = '#ef4444';
        } finally {
            app.setLoading(false);
        }
    },

    resetLoginUI: () => {
        if (app.timer) clearInterval(app.timer); 
        
        document.getElementById('loginForm').classList.remove('hidden');
        document.getElementById('tokenForm').classList.add('hidden');
        document.getElementById('msg-error').innerText = "";
        app.emailTemp = null;
    },

    confirmarResetSenha: async (e) => {
        e.preventDefault();
        const s1 = document.getElementById('nova-senha').value;
        const s2 = document.getElementById('confirma-senha').value;
        const msg = document.getElementById('msg-reset');
        if (s1 !== s2) { msg.innerText = "As senhas não coincidem!"; return; }

        app.setLoading(true);
        try {
            const res = await fetch('/api/definir-senha', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email: app.user.Email, novaSenha: s1 })
            });
            const data = await res.json();
            const grupos = Array.isArray(data) ? data : (data.grupos || []);
            app.dadosOrcamentoMeta = Array.isArray(data) ? null : (data.meta || null);
            if (data.success) {
                alert("Senha atualizada!");
                document.getElementById('modal-reset').classList.add('hidden');
                app.user.Senha_prov = null; 
                sessionStorage.setItem('dfc_user', JSON.stringify(app.user));
                app.showApp();
            } else { msg.innerText = data.message; }
        } catch (err) { msg.innerText = "Erro ao atualizar senha."; } 
        finally { app.setLoading(false); }
    },

    showApp: () => {
        document.getElementById('view-login').classList.add('hidden');
        document.getElementById('modal-reset').classList.add('hidden');
        document.getElementById('view-app').classList.remove('hidden');
        
        const nome = app.user.Nome ? app.user.Nome.split(' ')[0] : 'User';
        const depto = app.user.Departamento || 'Geral';
        const textoUsuario = `${nome} | ${depto}`;

        const elDash = document.getElementById('user-info');
        if(elDash) {
            elDash.innerText = textoUsuario;
            document.getElementById('user-avatar').innerText = nome.charAt(0).toUpperCase();
        }

        const elOrc = document.getElementById('user-info-orcamento');
        if(elOrc) {
            elOrc.innerText = textoUsuario;
        }

        const role = app.user.Role; 
        const nivel = parseInt(app.user.Nivel || 0);

        const isSuperAdmin = (role === 'admin' && nivel === 1);
        const isGestor = (role === 'admin' && (nivel === 1 || nivel === 2));

        document.querySelectorAll('.restricted').forEach(el => {
            el.style.setProperty('display', isSuperAdmin ? 'flex' : 'none', 'important');
        });

        const btnDashboard = document.querySelector('.nav-btn[data-target="dashboard"]');
        if (btnDashboard) {
            btnDashboard.style.display = isGestor ? 'flex' : 'none';
        }

        if(isSuperAdmin) app.loadDepartamentos();
        
        if (isGestor) {
            app.switchTab('dashboard');
            setTimeout(() => app.fetchData(), 100);
        } else {
            app.switchTab('reports');
        }
    },

    logout: () => { 
        if (app.timer) clearInterval(app.timer);
        app.user = null; 
        sessionStorage.removeItem('dfc_user');
        app.showLogin(); 
    },

    switchTab: (tab) => {
        document.querySelectorAll('.page-section').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
        
        const targetSection = document.getElementById(`page-${tab}`);
        if(targetSection) targetSection.classList.add('active');
        
        const btn = document.querySelector(`.nav-btn[data-target="${tab}"]`);
        if(btn) btn.classList.add('active');

        if (tab !== 'dashboard' && app.chart) {
            app.chart.destroy();
            app.chart = null;
        }
        if (tab !== 'reports' && app.orcamentoChart) {
            app.orcamentoChart.destroy();
            app.orcamentoChart = null;
        }

        if (tab === 'reports') {
            app.loadOrcamento();
        } else if (tab === 'dashboard') {
            app.fetchData();
        }
    },

    loadOrcamento: async () => {
        app.setLoading(true);
        // evita render duplicado por chamadas concorrente (orcamento)
        app.__orcReqId = (app.__orcReqId || 0) + 1;
        const __reqId = app.__orcReqId;
        const tbody = document.querySelector('#orcamento-table tbody');
        const kpiContainer = document.getElementById('kpi-orcamento-container');

        if(tbody) tbody.innerHTML = '<tr><td colspan="49" style="text-align:center; padding:20px;">Carregando dados...</td></tr>';
        if(kpiContainer) kpiContainer.innerHTML = ''; 

        try {
            const email = app.user.Email;
            const anoParam = app.yearOrcamento; 
            
            const visaoParam = app.orcamentoView || 'orcamento';
            const res = await fetch(`/api/orcamento?email=${encodeURIComponent(email)}&ano=${anoParam}&visao=${encodeURIComponent(visaoParam)}`);
            const data = await res.json();
            const grupos = Array.isArray(data) ? data : (data.grupos || []);
            app.dadosOrcamentoMeta = Array.isArray(data) ? null : (data.meta || null);
            // ignora respostas antigas (caso tenha mais de uma requisição em paralelo)
            if (__reqId !== app.__orcReqId) return;
            if (data.error) throw new Error(data.error);
            
            app.dadosOrcamentoCache = grupos;
            app.updateOrcamentoUIForView(app.orcamentoView);

            app.povoarFiltroDepartamentos(data);
            app.aplicarFiltrosOrcamento();

        } catch (err) {
            console.error(err);
            if(tbody) tbody.innerHTML = `<tr><td colspan="49" style="text-align:center; color:red; padding:20px;">Erro: ${err.message}</td></tr>`;
        } finally {
            app.setLoading(false);
        }
    },

    povoarFiltroDepartamentos: (data) => {
        const select = document.getElementById('filtro-dep-orcamento');
        if(!select) return;

        const valorAtual = select.value;
        select.innerHTML = '<option value="">Todos Departamentos</option>';
        const departamentos = [...new Set(data.map(d => d.conta))].sort();
        
        departamentos.forEach(dep => {
            const opt = document.createElement('option');
            opt.value = dep;
            opt.innerText = dep;
            select.appendChild(opt);
        });

        if(departamentos.includes(valorAtual)) {
            select.value = valorAtual;
        }
    },

    aplicarFiltrosOrcamento: () => {
        if(!app.dadosOrcamentoCache) return;

        const view = app.orcamentoView || 'orcamento';

        const select = document.getElementById('filtro-dep-orcamento');
        const deptSelecionado = select ? select.value : "";

        let dadosFiltrados = app.dadosOrcamentoCache;

        if (deptSelecionado !== "") {
            dadosFiltrados = app.dadosOrcamentoCache.filter(grupo => grupo.conta === deptSelecionado);
        }

        app.renderOrcamentoTable(dadosFiltrados, view);
        app.renderOrcamentoKPIs(dadosFiltrados, view);

        // Gráficos variam por tipo de visão
        if (view === 'todos') {
            app.renderOrcamentoChart(dadosFiltrados, view);
            app.toggleThermometer(false);
        } else {
            app.renderOrcamentoChart(dadosFiltrados, view);
            app.toggleThermometer(true);
            app.renderThermometer(dadosFiltrados, view);
        }
    },

    renderOrcamentoChart: (data, view) => {
    const canvas = document.getElementById('orcamentoChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (typeof Chart === 'undefined') return;

    // destrói chart anterior
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    if (app.orcamentoChart) { try { app.orcamentoChart.destroy(); } catch(e){} app.orcamentoChart = null; }

    const mesLabels = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    const v = (view || app.orcamentoView || 'orcamento').toLowerCase();

    // Helper: soma planejado/realizado por mês a partir da tabela
    const sumByMonth = (field) => {
        const keys = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const arr = new Array(12).fill(0);
        (data || []).forEach(grupo => {
            if (!grupo || !grupo.dados) return;
            keys.forEach((k, i) => {
                const cell = grupo.dados[k];
                if (!cell) return;
                const val = Number(cell[field] || 0);
                arr[i] += isFinite(val) ? val : 0;
            });
        });
        return arr;
    };

    // Quando visao = TODOS: mostrar apenas linhas de Realizado de Receitas e Realizado de Despesas
    if (v === 'todos') {
        const meta = app.dadosOrcamentoMeta || null;
        const serieReceita = meta?.series?.receita?.realizado;
        const serieDespesa = meta?.series?.despesa?.realizado;

        // Fallback: tenta somar realizado do dataset filtrado (caso meta não venha)
        const fallbackReal = sumByMonth('realizado').map(x => Math.abs(x));

        const dataReceita = Array.isArray(serieReceita) && serieReceita.length === 12 ? serieReceita.map(Number) : fallbackReal;
        const dataDespesa = Array.isArray(serieDespesa) && serieDespesa.length === 12 ? serieDespesa.map(Number) : fallbackReal.map(x => -Math.abs(x));

        app.orcamentoChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: mesLabels,
                datasets: [
                    {
                        label: 'Realizado (Receitas)',
                        data: dataReceita,
                        tension: 0.35,
                        borderWidth: 2,
                        pointRadius: 3,
                        fill: false
                    },
                    {
                        label: 'Realizado (Despesas)',
                        data: dataDespesa,
                        tension: 0.35,
                        borderWidth: 2,
                        pointRadius: 3,
                        fill: false
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true },
                    tooltip: {
                        callbacks: {
                            label: (ctx2) => {
                                const v2 = Number(ctx2.parsed.y || 0);
                                const fmt = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' });
                                return `${ctx2.dataset.label}: ${fmt.format(v2)}`;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        ticks: {
                            callback: (value) => {
                                const fmt = new Intl.NumberFormat('pt-BR', { notation: 'compact' });
                                return fmt.format(Number(value || 0));
                            }
                        }
                    }
                }
            }
        });

        return;
    }

    // Outras visoes: mantém gráfico de linhas com Planejado vs Realizado (um dataset por série)
    const planejado = sumByMonth('orcado').map(x => Math.abs(x));
    const realizado = sumByMonth('realizado').map(x => Math.abs(x));

    const labelPlanejado = (v === 'receita') ? 'Metas' : 'Orçado';
    const labelRealizado = 'Realizado';

    app.orcamentoChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: mesLabels,
            datasets: [
                {
                    label: labelPlanejado,
                    data: planejado,
                    tension: 0.35,
                    borderWidth: 2,
                    pointRadius: 3,
                    fill: false
                },
                {
                    label: labelRealizado,
                    data: realizado,
                    tension: 0.35,
                    borderWidth: 2,
                    pointRadius: 3,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true },
                tooltip: {
                    callbacks: {
                        label: (ctx2) => {
                            const v2 = Number(ctx2.parsed.y || 0);
                            const fmt = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' });
                            return `${ctx2.dataset.label}: ${fmt.format(v2)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    ticks: {
                        callback: (value) => {
                            const fmt = new Intl.NumberFormat('pt-BR', { notation: 'compact' });
                            return fmt.format(Number(value || 0));
                        }
                    }
                }
            }
        }
    });
},

renderThermometer: (data, view) => {
        const fillEl = document.getElementById('thermometer-fill');
        const bulbEl = document.getElementById('thermometer-bulb-color');
        const titleGoal = document.getElementById('thermometer-goal-title');
        const v = view || 'orcamento';
        if (titleGoal) {
            titleGoal.textContent = (v === 'receita') ? 'Meta de Receitas (Mês)' : 'Meta Orçamentária (Mês)';
        }

        const tooltipLeft = document.getElementById('tooltip-left');
        const tooltipRight = document.getElementById('tooltip-right');
        const lblPercent = document.getElementById('lbl-porcentagem');
        const lblValue = document.getElementById('lbl-valor');

        if (!fillEl || !data) return;

        const hoje = new Date();
        const mesIndex = hoje.getMonth(); 
        const mesChaves = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const chaveMes = mesChaves[mesIndex];
        const anoAtual = hoje.getFullYear();
        const anoFiltro = app.yearOrcamento || anoAtual;

        let totalOrcado = 0;
        let totalRealizado = 0;

        data.forEach(grupo => {
            if (grupo.dados && grupo.dados[chaveMes]) {
                totalOrcado += Math.abs(grupo.dados[chaveMes].orcado || 0);
                totalRealizado += Math.abs(grupo.dados[chaveMes].realizado || 0);
            }
        });

        const fmtMoney = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

        if(titleGoal) titleGoal.innerText = `FinanCheck: ${fmtMoney(totalOrcado)}`;

        const dias = app.getDiasUteis(mesIndex, anoFiltro);
        const diasTotais = dias.totais || 1;
        const diasDecorridos = dias.decorridos || 1; 
        const diasRestantes = diasTotais - diasDecorridos;

        let gastoDiario = totalRealizado / diasDecorridos;
        let projecaoTotal = (gastoDiario * diasRestantes) + totalRealizado;

        if (totalOrcado === 0) {
            fillEl.style.height = '0%';
            fillEl.style.backgroundColor = '#e5e7eb';
            if(bulbEl) bulbEl.style.backgroundColor = '#e5e7eb';
            if(lblPercent) lblPercent.innerText = "0%";
            if(lblValue) lblValue.innerText = fmtMoney(projecaoTotal);
            if(tooltipLeft) tooltipLeft.style.bottom = '45px';
            if(tooltipRight) tooltipRight.style.bottom = '45px';
            return;
        }

        let porcentagem = (projecaoTotal / totalOrcado) * 100;
        let alturaVisual = porcentagem > 100 ? 100 : porcentagem;
        if (alturaVisual < 0) alturaVisual = 0;

        let cor = '';
        if (porcentagem < 80) cor = '#3b82f6'; 
        else if (porcentagem >= 80 && porcentagem < 95) cor = '#10b981'; 
        else if (porcentagem >= 95 && porcentagem <= 100) cor = '#f59e0b'; 
        else cor = '#ef4444'; 

        fillEl.style.height = `${alturaVisual}%`;
        fillEl.style.backgroundColor = cor;
        if(bulbEl) bulbEl.style.backgroundColor = cor;
        
        if(lblPercent) lblPercent.innerText = `${porcentagem.toFixed(0)}%`;
        if(lblValue) lblValue.innerText = fmtMoney(projecaoTotal);

        const alturaBulboOffset = 45; 
        const alturaTubo = 220; 
        const pixelHeight = (alturaVisual / 100) * alturaTubo;
        const totalBottomPx = pixelHeight + alturaBulboOffset;

        if(tooltipLeft) tooltipLeft.style.bottom = `${totalBottomPx}px`;
        if(tooltipRight) tooltipRight.style.bottom = `${totalBottomPx}px`;
    },

    getFeriadosPorAno: (ano) => {
        const fixos = ['01/01', '21/04', '01/05', '07/09', '12/10', '02/11', '15/11', '25/12'];
        const moveis = {
            2024: ['13/02', '29/03', '30/05'],
            2025: ['04/03', '18/04', '19/06'],
            2026: ['17/02', '03/04', '04/06'],
            2027: ['09/02', '26/03', '27/05']
        };
        return fixos.concat(moveis[ano] || []);
    },

    getDiasUteis: (mes, ano) => {
        if (!ano) return { totais: 0, decorridos: 0 };
        const feriados = app.getFeriadosPorAno(ano);
        const ultimoDiaMes = new Date(ano, mes + 1, 0).getDate();
        const hoje = new Date();
        const diaAtual = hoje.getDate(); 
        const mesAtualReal = hoje.getMonth();
        const anoAtualReal = hoje.getFullYear();

        let uteisTotais = 0;
        let uteisDecorridos = 0;

        for (let dia = 1; dia <= ultimoDiaMes; dia++) {
            const dataCheck = new Date(ano, mes, dia);
            const diaSemana = dataCheck.getDay(); 
            const diaStr = String(dia).padStart(2, '0');
            const mesStr = String(mes + 1).padStart(2, '0');
            const dataFormatada = `${diaStr}/${mesStr}`;

            const ehFimDeSemana = (diaSemana === 0 || diaSemana === 6);
            const ehFeriado = feriados.includes(dataFormatada);

            if (!ehFimDeSemana && !ehFeriado) {
                uteisTotais++;
                if (ano < anoAtualReal) {
                    uteisDecorridos++; 
                } else if (ano === anoAtualReal) {
                    if (mes < mesAtualReal) {
                        uteisDecorridos++; 
                    } else if (mes === mesAtualReal) {
                        if (dia <= diaAtual) uteisDecorridos++;
                    }
                }
            }
        }
        return { totais: uteisTotais, decorridos: uteisDecorridos };
    },

    renderOrcamentoKPIs: (data, view) => {
        const container = document.getElementById('kpi-orcamento-container');
        if (!container || !data) return;

        const v = view || 'orcamento';

        const hoje = new Date();
        const mesIndex = hoje.getMonth();
        const anoAnalise = app.yearOrcamento;

        const chavesMeses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const nomesMeses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        const nomeMes = nomesMeses[mesIndex];
        const keyMes = chavesMeses[mesIndex];

        let totalPlanejado = 0;
        let totalRealizado = 0;

        data.forEach(grupo => {
            if (grupo.dados && grupo.dados[keyMes]) {
                totalPlanejado += Math.abs(grupo.dados[keyMes].orcado || 0);
                totalRealizado += Math.abs(grupo.dados[keyMes].realizado || 0);
            }
        });

        const diferencaValor = totalPlanejado - totalRealizado;
        let diferencaPerc = 0;
        if (totalPlanejado !== 0) {
            diferencaPerc = (diferencaValor / totalPlanejado) * 100;
        } else if (totalRealizado > 0) {
            diferencaPerc = -100;
        }

        const fmt = v => new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'}).format(v);
        const fmtPerc = v => new Intl.NumberFormat('pt-BR', {maximumFractionDigits: 1}).format(v) + '%';

        // Dias úteis agora fica na barra translúcida (não é mais KPI)
        const badge = document.getElementById('orcamento-dias-uteis');
        if (badge) {
            const dias = app.getDiasUteis(mesIndex, anoAnalise);
            badge.innerHTML = `Dias úteis: <strong>${dias.decorridos}/${dias.totais}</strong>`;
        }

        // Configura rótulos por tipo de visão
        const labelPlanejado = (v === 'receita') ? 'Metas' : (v === 'todos') ? 'Planejado' : 'Orçado';

        if (v === 'todos') {
            // 5 KPI's: Metas (Receita planejada), Realizado (Receita realizado),
            // Orçado (Despesa planejada), Realizado (Despesa realizado), Diferença (Receita Real - Despesa Real)
            // Para manter compatibilidade, o backend em "todos" envia planejado/realizado como saldo líquido.
            const desempenho = totalRealizado; // saldo líquido do mês
            const corDesempenho = desempenho >= 0 ? 'text-green' : 'text-red';
            const tituloDesempenho = desempenho >= 0 ? 'Desempenho Favorável' : 'Desempenho Desfavorável';

            container.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
            container.innerHTML = `
                <div class="kpi-card"><div class="kpi-title">Planejado</div><div class="kpi-value">${fmt(totalPlanejado)}</div><div class="kpi-foot">Saldo planejado • ${nomeMes}</div></div>
                <div class="kpi-card"><div class="kpi-title">Realizado</div><div class="kpi-value">${fmt(totalRealizado)}</div><div class="kpi-foot">Saldo realizado • ${nomeMes}</div></div>
                <div class="kpi-card"><div class="kpi-title">Diferença</div><div class="kpi-value ${diferencaValor >= 0 ? 'text-green':'text-red'}">${fmt(Math.abs(diferencaValor))}</div><div class="kpi-foot">Planejado - Realizado</div></div>
                <div class="kpi-card"><div class="kpi-title">Dif.%</div><div class="kpi-value ${diferencaValor >= 0 ? 'text-green':'text-red'}">${fmtPerc(Math.abs(diferencaPerc))}</div><div class="kpi-foot">Variação</div></div>
                <div class="kpi-card"><div class="kpi-title">${tituloDesempenho}</div><div class="kpi-value ${corDesempenho}">${fmt(Math.abs(desempenho))}</div><div class="kpi-foot">Saldo realizado (Receitas - Despesas)</div></div>
            `;
            return;
        }

        // Receita / Orçamento: mantém grade (sem Dias Úteis)
        container.style.gridTemplateColumns = 'repeat(6, minmax(0, 1fr))';

        // Regra de cor por visão
        let clsDif = '';
        if (v === 'orcamento') {
            clsDif = diferencaValor >= 0 ? 'text-green' : 'text-red';
        } else {
            // receita: abaixo da meta = vermelho; acima = verde
            clsDif = diferencaValor >= 0 ? 'text-red' : 'text-green';
        }

        container.innerHTML = `
            <div class="kpi-card"><div class="kpi-title">${labelPlanejado}</div><div class="kpi-value">${fmt(totalPlanejado)}</div><div class="kpi-foot">${nomeMes}</div></div>
            <div class="kpi-card"><div class="kpi-title">Realizado</div><div class="kpi-value">${fmt(totalRealizado)}</div><div class="kpi-foot">${nomeMes}</div></div>
            <div class="kpi-card"><div class="kpi-title">Diferença</div><div class="kpi-value ${clsDif}">${fmt(Math.abs(diferencaValor))}</div><div class="kpi-foot">${labelPlanejado} - Realizado</div></div>
            <div class="kpi-card"><div class="kpi-title">Dif. %</div><div class="kpi-value ${clsDif}">${fmtPerc(Math.abs(diferencaPerc))}</div><div class="kpi-foot">${labelPlanejado} - Realizado</div></div>
            <div class="kpi-card"><div class="kpi-title">Atingimento</div><div class="kpi-value">${totalPlanejado ? fmtPerc((totalRealizado/totalPlanejado)*100) : '0%'}</div><div class="kpi-foot">Realizado / ${labelPlanejado}</div></div>
            <div class="kpi-card"><div class="kpi-title">Saldo</div><div class="kpi-value ${totalRealizado - totalPlanejado >= 0 ? 'text-green':'text-red'}">${fmt(Math.abs(totalRealizado - totalPlanejado))}</div><div class="kpi-foot">Realizado - ${labelPlanejado}</div></div>
        `;
    },

    renderOrcamentoTable: (data, view) => {
        const tbody = document.querySelector('#orcamento-table tbody');
        if(!tbody) return;
        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="49" style="text-align:center; padding:20px;">Nenhum registro encontrado.</td></tr>';
            return;
        }

        const fmt = v => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
        const fmtPerc = v => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(v) + '%';
        const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

        let html = '';
        data.forEach((grupo, idx) => {
            const idGrupo = `orc-g-${idx}`;
            let colsHtmlGrupo = '';
            meses.forEach(m => {
                const vals = grupo.dados[m];
                let clsDif = '';
                if ((view || 'orcamento') === 'orcamento') {
                    clsDif = vals.diferenca < 0 ? 'text-red' : (vals.diferenca > 0 ? 'text-green' : '');
                } else {
                    // Receita / Todos: abaixo do planejado = vermelho, acima = verde
                    clsDif = vals.diferenca < 0 ? 'text-green' : (vals.diferenca > 0 ? 'text-red' : '');
                }
                let difPerc = vals.orcado !== 0 ? (vals.diferenca / vals.orcado) * 100 : (vals.realizado > 0 ? -100 : 0);
                
                colsHtmlGrupo += `
                    <td class="col-orc" style="font-weight:bold;">${fmt(vals.orcado)}</td>
                    <td class="col-real" style="font-weight:bold;">${fmt(vals.realizado)}</td>
                    <td class="col-dif ${clsDif}" style="font-weight:bold;">${fmt(Math.abs(vals.diferenca))}</td>
                    <td class="col-perc ${clsDif}">${fmtPerc(Math.abs(difPerc))}</td>`;
            });

            html += `<tr class="hover-row" onclick="app.toggleGroup('${idGrupo}', this)" style="cursor: pointer; background-color: #f8fafc;">
                    <td class="sticky-col" style="font-weight: 700; color: #1e3a8a; background-color: #f8fafc !important;"><i class="fa-solid fa-chevron-right toggle-icon"></i> ${grupo.conta}</td>
                    ${colsHtmlGrupo}
                </tr>`;

            if(grupo.detalhes) {
                grupo.detalhes.forEach(item => {
                    let colsHtmlItem = '';
                    meses.forEach(m => {
                        const vals = item.dados[m];
                        let clsDif = '';
                if ((view || 'orcamento') === 'orcamento') {
                    clsDif = vals.diferenca < 0 ? 'text-red' : (vals.diferenca > 0 ? 'text-green' : '');
                } else {
                    // Receita / Todos: abaixo do planejado = vermelho, acima = verde
                    clsDif = vals.diferenca < 0 ? 'text-green' : (vals.diferenca > 0 ? 'text-red' : '');
                }
                        let difPerc = vals.orcado !== 0 ? (vals.diferenca / vals.orcado) * 100 : (vals.realizado > 0 ? -100 : 0);
                        
                        colsHtmlItem += `<td class="col-orc" style="background-color:#fff;">${fmt(vals.orcado)}</td><td class="col-real" style="background-color:#f9fafb;">${fmt(vals.realizado)}</td><td class="col-dif ${clsDif}">${fmt(Math.abs(vals.diferenca))}</td><td class="col-perc ${clsDif}">${fmtPerc(Math.abs(difPerc))}</td>`;
                    });
                    html += `<tr class="child-row hidden pai-${idGrupo}">
                            <td class="sticky-col" style="padding-left: 30px !important; color: #4b5563;">${item.conta}</td>
                            ${colsHtmlItem}
                        </tr>`;
                });
            }
        });
        tbody.innerHTML = html;
            // Aplica sticky nas linhas de saldo após renderizar
        setTimeout(() => app.setupFinanceStickyRows(), 0);
    },

    loadDepartamentos: async () => {
        try {
            const res = await fetch('/api/departamentos');
            const deps = await res.json();
            const select = document.getElementById('cad-departamento');
            if(select) {
                select.innerHTML = '<option value="">Selecione...</option>';
                deps.forEach(d => { select.innerHTML += `<option value="${d.Id_dep}">${d.Nome_dep}</option>`; });
            }
        } catch (err) { console.error(err); }
    },

    cadastrarUsuario: async (e) => {
        e.preventDefault();
        const msg = document.getElementById('cad-mensagem');
        msg.innerText = "Enviando..."; msg.style.color = "blue";
        
        const prefixo = document.getElementById('cad-email-prefix').value.trim();
        const emailFinal = `${prefixo}@objetivaatacadista.com.br`;

        const dados = {
            nome: document.getElementById('cad-nome').value,
            email: emailFinal,
            departamentoId: document.getElementById('cad-departamento').value,
            role: document.getElementById('cad-role').value,
            nivel: document.getElementById('cad-nivel').value 
        };
        
        try {
            const res = await fetch('/api/usuarios', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dados)
            });
            const result = await res.json();
            if (result.success) {
                msg.innerText = "✅ " + result.message; msg.style.color = "green";
                document.getElementById('form-cadastro').reset();
                if(document.getElementById('cad-nivel')) document.getElementById('cad-nivel').value = '1';
            } else { msg.innerText = "❌ " + result.message; msg.style.color = "red"; }
        } catch (err) { msg.innerText = "Erro ao conectar."; msg.style.color = "red"; }
    },

    fetchData: async () => {
        app.setLoading(true);
        try {
            const anoParam = app.yearDashboard; 
            const viewParam = app.viewType || 'mensal';
            // --- CAPTURA O VALOR DO NOVO FILTRO DE STATUS ---
            const statusSelect = document.getElementById('dashboard-status-view');
            const statusParam = statusSelect ? statusSelect.value : 'todos';
            
            const res = await fetch(`/api/dashboard?ano=${anoParam}&view=${viewParam}&status=${statusParam}`);
            const data = await res.json();
            const grupos = Array.isArray(data) ? data : (data.grupos || []);
            app.dadosOrcamentoMeta = Array.isArray(data) ? null : (data.meta || null);
            if(data.error) throw new Error(data.error);
            
            app.renderKPIs(data.cards);
            app.renderTable(data.tabela);
        // Guarda as colunas atuais para a tabela Financeiro acompanhar exatamente a DFC
        window.__dashboardCols = { keys: data.tabela.columns, labels: data.tabela.headers };

        // Atualiza visibilidade/render da tabela Financeiro (só quando Tipo de Visão = Todos)
        if (typeof window.refreshFinanceiroIfNeeded === 'function') {
            window.refreshFinanceiroIfNeeded({ skipFetch: true });
        }
 
            
            if (typeof app.fetchFinanceiroData === 'function') { await app.fetchFinanceiroData(); }
setTimeout(() => app.renderChart(data.grafico), 50);
        } catch (err) { console.error(err); } 
        finally { app.setLoading(false); }
    },

    renderKPIs: (c) => {
        const fmt = v => new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'}).format(v);
        const ct = document.getElementById('kpi-container');
        if(!ct) return;
        const mk = (l, v, cl) => `<div class="card"><div class="card-title">${l}</div><div class="card-value ${cl}">${fmt(v)}</div></div>`;
        const labelResultado = c.deficitSuperavit >= 0 ? 'Superávit' : 'Déficit';
        ct.innerHTML = mk('Saldo Inicial',c.saldoInicial,'') + 
                       mk('Entradas',c.entrada,'text-green') + 
                       mk('Saídas',c.saida,'text-red') + 
                       mk(labelResultado, c.deficitSuperavit, c.deficitSuperavit>=0?'text-green':'text-red') + 
                       mk('Saldo Final',c.saldoFinal,'bold');
    },

    toggleGroup: (idPai, el) => {
        const filhos = document.getElementsByClassName(`pai-${idPai}`);
        if(filhos.length === 0) return;
        const estaEscondido = filhos[0].classList.contains('hidden');
        const icon = el.querySelector('.toggle-icon');
        if(icon) icon.style.transform = estaEscondido ? 'rotate(90deg)' : 'rotate(0deg)';
        Array.from(filhos).forEach(row => { row.classList.toggle('hidden', !estaEscondido); });
        
        if (!estaEscondido) { 
            const netos = document.getElementsByClassName(`avo-${idPai}`);
            if (netos.length > 0) {
                Array.from(netos).forEach(neto => neto.classList.add('hidden'));
                Array.from(filhos).forEach(rowL2 => {
                    const iconL2 = rowL2.querySelector('.toggle-icon');
                    if(iconL2) iconL2.style.transform = 'rotate(0deg)';
                });
            }
        }
    },

    toggleSubGroup: (idL2, el) => {
        const filhosNivel3 = document.getElementsByClassName(`pai-${idL2}`);
        if(filhosNivel3.length === 0) return;
        const estaEscondido = filhosNivel3[0].classList.contains('hidden');
        const icon = el.querySelector('.toggle-icon');
        if(icon) icon.style.transform = estaEscondido ? 'rotate(90deg)' : 'rotate(0deg)';
        Array.from(filhosNivel3).forEach(row => { row.classList.toggle('hidden', !estaEscondido); });
    },

    renderChart: (d) => {
        const canvas = document.getElementById('mainChart');
        if(!canvas) return;
        const ctx = canvas.getContext('2d');
        if (typeof Chart === 'undefined') return;

        const existingChart = Chart.getChart(canvas);
        if (existingChart) existingChart.destroy();
        if (app.chart) { app.chart.destroy(); app.chart = null; }

        if (typeof ChartDataLabels !== 'undefined') { try { Chart.register(ChartDataLabels); } catch(e){} }

        function getGradient(context, isBackground) {
            const chart = context.chart;
            const {ctx, chartArea, scales} = chart;
            if (!chartArea) return isBackground ? 'rgba(16, 185, 129, 0.1)' : '#10b981';
            const yAxis = scales.y;
            const yZero = yAxis.getPixelForValue(0); 
            const height = chartArea.bottom - chartArea.top;
            let offset = (chartArea.bottom - yZero) / height;
            offset = Math.min(Math.max(offset, 0), 1);
            const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
            if (isBackground) {
                gradient.addColorStop(0, 'rgba(239, 68, 68, 0.4)');     
                gradient.addColorStop(offset, 'rgba(239, 68, 68, 0.05)'); 
                gradient.addColorStop(offset, 'rgba(16, 185, 129, 0.05)'); 
                gradient.addColorStop(1, 'rgba(16, 185, 129, 0.4)');    
            } else {
                gradient.addColorStop(0, '#ef4444');      
                gradient.addColorStop(offset, '#ef4444'); 
                gradient.addColorStop(offset, '#10b981'); 
                gradient.addColorStop(1, '#10b981');      
            }
            return gradient;
        }

        app.chart = new Chart(ctx, {
            type: 'line',
            data: { 
                labels: d.labels, 
                datasets: [{
                    label: 'Fluxo', data: d.data, fill: true, tension: 0.4, borderWidth: 2,
                    pointBackgroundColor: '#fff', pointBorderWidth: 2, pointRadius: 5, 
                    borderColor: function(c) { return getGradient(c, false); },
                    backgroundColor: function(c) { return getGradient(c, true); },
                    pointBorderColor: function(c) { return c.raw >= 0 ? '#10b981' : '#ef4444'; }
                }] 
            },
            options: { 
                responsive: true, maintainAspectRatio: false, 
                layout: { padding: { top: 30, bottom: 10, left: 20, right: 30 } },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false }, tooltip: { enabled: false }, 
                    datalabels: {
                        display: function(context) { return window.innerWidth > 768; },
                        align: 'top', anchor: 'end', offset: 8, clamp: true,       
                        color: function(context) { return context.dataset.data[context.dataIndex] >= 0 ? '#059669' : '#dc2626'; },
                        font: { weight: 'bold', size: 12 },
                        formatter: function(value) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value); }
                    }
                }, 
                scales: {
                    x: { grid: { display: false }, offset: true }, 
                    y: { 
                        grid: { borderDash: [5,5] }, grace: '10%',
                        ticks: { padding: 10, callback: function(value) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value); } }
                    }
                } 
            }
        });
    
    },

    // =====================================================
    // FINANCEIRO (Dashboard) — tabela separada, com expand/recolhe independente
    // Regras:
    // - Só aparece quando Tipo de Visão = "todos"
    // =====================================================
    fetchFinanceiroData: async () => {
        // evita render duplicado por chamadas concorrentes
        app.__finReqId = (app.__finReqId || 0) + 1;
        const __reqId = app.__finReqId;
        try {
            const statusSelect = document.getElementById('dashboard-status-view');
            const statusParam = statusSelect ? statusSelect.value : 'todos';

            const painel = document.getElementById('financeiro-panel');
            const tbody = document.querySelector('#financeiro-table tbody');
            const thead = document.querySelector('#financeiro-table thead');

            if (statusParam !== 'todos') {
                if (painel) painel.style.setProperty('display', 'none', 'important');
                if (tbody) tbody.innerHTML = '';
                if (thead) thead.innerHTML = '';
                return;
            }

            if (painel) painel.style.setProperty('display', 'flex', 'important');

            const anoParam = app.yearDashboard;
            const viewParam = app.viewType || 'mensal';

            const res = await fetch(`/api/financeiro-dashboard?ano=${encodeURIComponent(anoParam)}&view=${encodeURIComponent(viewParam)}`);
            const data = await res.json();
            const grupos = Array.isArray(data) ? data : (data.grupos || []);
            app.dadosOrcamentoMeta = Array.isArray(data) ? null : (data.meta || null);
            if (data.error) throw new Error(data.error);

            if (data && data.tabela) {
                app.renderFinanceiroTable(data.tabela);
            }
        } catch (err) {
            console.error('Erro Financeiro Dashboard:', err);
        }
    },

    renderFinanceiroTable: (tabela) => {
        const rows = tabela.rows || [];
        const columns = tabela.columns || [];
        const headers = tabela.headers || [];

        const tbody = document.querySelector('#financeiro-table tbody');
        const thead = document.querySelector('#financeiro-table thead');
        if (!tbody || !thead) return;

        // Cabeçalho
        let thHtml = `<tr><th>Plano Financeiro</th>`;
        headers.forEach(h => thHtml += `<th>${h}</th>`);
        thHtml += `</tr>`;
        thead.innerHTML = thHtml;

        const fmt = (v) => (Number(v || 0)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

        // Corpo (2 níveis: grupo -> itens)
        let html = '';
        rows.forEach((grupo, idx) => {
            const idPai = `fin-${idx}`;
            const hasChildren = Array.isArray(grupo.detalhes) && grupo.detalhes.length > 0;

            html += `<tr class="grupo" data-id="${idPai}" onclick="app.toggleFinanceiroGroup('${idPai}', this)">
                        <td>
                          ${hasChildren ? '<span class="toggle-icon">▸</span>' : '<span class="toggle-icon" style="opacity:.0">▸</span>'}
                          ${grupo.conta || ''}
                        </td>`;

            columns.forEach(c => {
                html += `<td>${fmt(grupo[c] ?? 0)}</td>`;
            });
            html += `</tr>`;

            if (hasChildren) {
                grupo.detalhes.forEach(item => {
                    html += `<tr class="item fpai-${idPai} hidden">
                                <td style="padding-left: 28px;">${item.conta || ''}</td>`;
                    columns.forEach(c => {
                        html += `<td>${fmt(item[c] ?? 0)}</td>`;
                    });
                    html += `</tr>`;
                });
            }
        });

        tbody.innerHTML = html;
        setTimeout(() => { if (app.syncDfcFinanceiroColumns) app.syncDfcFinanceiroColumns(); }, 0);
    },
    syncDfcFinanceiroColumns: () => {
        const dfc = document.getElementById('finance-table');
        const fin = document.getElementById('financeiro-table');
        if (!dfc || !fin) return;

        const dfcThs = dfc.querySelectorAll('thead th');
        const finThs = fin.querySelectorAll('thead th');
        if (!dfcThs.length || finThs.length !== dfcThs.length) return;

        // Usa as larguras reais da DFC como referência
        const widths = Array.from(dfcThs).map(th => th.getBoundingClientRect().width);

        finThs.forEach((th, i) => { th.style.width = widths[i] + 'px'; });
        // aplica também nas células do corpo (1ª linha é suficiente para fixar table-layout)
        const finFirstRow = fin.querySelector('tbody tr');
        if (finFirstRow) {
            const tds = finFirstRow.children;
            for (let i = 0; i < tds.length; i++) {
                if (widths[i]) tds[i].style.width = widths[i] + 'px';
            }
        }
    },


    toggleFinanceiroGroup: (idPai, trEl) => {
        const filhos = document.querySelectorAll(`.fpai-${idPai}`);
        if (!filhos || filhos.length === 0) return;

        const icon = trEl ? trEl.querySelector('.toggle-icon') : null;
        const estaFechado = filhos[0].classList.contains('hidden');

        filhos.forEach(r => r.classList.toggle('hidden', !estaFechado));
        if (icon) icon.classList.toggle('rotated', estaFechado);
    },

    // --- Toggle de visibilidade de senha (Login e Alteração) ---
    bindPasswordToggles: () => {
        document.querySelectorAll('.btn-toggle-password').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.getAttribute('data-target');
                const input = document.getElementById(targetId);
                if (!input) return;
                const icon = btn.querySelector('i');
                const isHidden = input.type === 'password';
                input.type = isHidden ? 'text' : 'password';
                if (icon) {
                    icon.classList.toggle('fa-eye', !isHidden);
                    icon.classList.toggle('fa-eye-slash', isHidden);
                }
                btn.setAttribute('aria-label', isHidden ? 'Ocultar senha' : 'Exibir senha');
            });
        });
    },
};

document.addEventListener('DOMContentLoaded', app.init);


/* =========================================================
   PATCH FINAL — VISIBILIDADE DO FINANCEIRO (DASHBOARD)
   - Mostra Financeiro apenas quando Tipo de Visão = "Todos"
   - Em outros valores, esconde o painel e não deixa "sobrar" box
   - Não altera sua lógica existente; só garante o toggle
   ========================================================= */
(function () {
    // ============================================================
    // TABELA "FINANCEIRO" (Dashboard) — independente da DFC
    // Regras:
    // - Só aparece quando Tipo de Visão = "Todos" (dashboard-status-view = "todos")
    // - Mesmas colunas (mesmo período/headers) da DFC
    // - Expande/recolhe igual a DFC (grupo -> itens)
    // ============================================================

    const financeiroPanel = document.getElementById('financeiro-panel');
    const financeiroTable = document.getElementById('financeiro-table');

    const fallbackKeys = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
    const fallbackLabels = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    function getAnoSelecionado() {
        const el = document.getElementById('ano-dashboard');
        return el && el.value ? el.value : String(new Date().getFullYear());
    }

    function getStatusSelecionado() {
        const el = document.getElementById('dashboard-status-view');
        return el && el.value ? el.value : 'todos';
    }

    function getColsFromDashboard() {
        const keys = (window.__dashboardCols && Array.isArray(window.__dashboardCols.keys)) ? window.__dashboardCols.keys : fallbackKeys;
        const labels = (window.__dashboardCols && Array.isArray(window.__dashboardCols.labels)) ? window.__dashboardCols.labels : fallbackLabels;
        return { keys, labels };
    }

    function setFinanceiroVisible(show) {
        if (!financeiroPanel) return;
        // usa display: none; para o painel todo (some o "box" também)
        financeiroPanel.style.display = show ? '' : 'none';
    }

    async function fetchFinanceiroDashboard() {
        const ano = getAnoSelecionado();
        const status = getStatusSelecionado(); // aqui esperamos "todos" ou "realizado"
        const qs = new URLSearchParams({ ano, status });

        const resp = await fetch(`/api/financeiro-dashboard?${qs.toString()}`);
        if (!resp.ok) throw new Error('Falha ao buscar Financeiro.');
        return resp.json();
    }

    function formatBRL(value) {
        const n = Number(value || 0);
        return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    function clearFinanceiroTable() {
        if (!financeiroTable) return;
        const thead = financeiroTable.querySelector('thead');
        const tbody = financeiroTable.querySelector('tbody');
        if (thead) thead.innerHTML = '';
        if (tbody) tbody.innerHTML = '';
    }

    function renderFinanceiroDashboard(payload) {
        if (!financeiroTable) return;

        const thead = financeiroTable.querySelector('thead');
        const tbody = financeiroTable.querySelector('tbody');
        if (!thead || !tbody) return;

        const cols = getColsFromDashboard();
        const colKeys = cols.keys;
        const colLabels = cols.labels;

        // Header
        thead.innerHTML = `
            <tr>
                <th>Plano Financeiro</th>
                ${colLabels.map(h => `<th>${h}</th>`).join('')}
            </tr>
        `;

        // Body
        tbody.innerHTML = '';

        const rows = payload && payload.rows ? payload.rows : [];
        let rowId = 0;

        const createRow = ({ conta, dados, tipo, level, hasChildren, parentId }) => {
            const tr = document.createElement('tr');
            tr.className = 'hover-row';
            if (tipo === 'grupo') tr.classList.add('grupo');
            if (tipo === 'item') tr.classList.add('child-row');
            tr.dataset.rowId = String(++rowId);
            if (parentId) tr.dataset.parentId = parentId;

            // Primeira célula com toggle
            const td0 = document.createElement('td');
            td0.style.cursor = hasChildren ? 'pointer' : 'default';

            const indent = '&nbsp;'.repeat(level * 4);

            const toggle = hasChildren
                ? `<span class="toggle-icon" data-role="toggle">▶</span>`
                : `<span class="toggle-icon" style="opacity:0">▶</span>`;

            td0.innerHTML = `${toggle}${indent}<span class="conta-text">${conta || ''}</span>`;
            tr.appendChild(td0);

            // Valores por coluna
            colKeys.forEach(k => {
                const td = document.createElement('td');
                const v = dados && Object.prototype.hasOwnProperty.call(dados, k) ? dados[k] : 0;
                td.textContent = formatBRL(v);
                tr.appendChild(td);
            });

            // Clique para expandir/recolher
            if (hasChildren) {
                tr.dataset.expanded = 'false';
                tr.addEventListener('click', (ev) => {
                    // evita colidir com seleção de texto
                    ev.preventDefault();
                    const expanded = tr.dataset.expanded === 'true';
                    const newState = !expanded;
                    tr.dataset.expanded = newState ? 'true' : 'false';

                    // gira ícone
                    const icon = tr.querySelector('[data-role="toggle"]');
                    if (icon) {
                        icon.textContent = newState ? '▼' : '▶';
                    }

                    // mostra/oculta filhos imediatos (e se ocultar, recolhe todos abaixo)
                    const myId = tr.dataset.rowId;
                    const children = tbody.querySelectorAll(`tr[data-parent-id="${myId}"]`);
                    children.forEach(child => {
                        child.style.display = newState ? '' : 'none';
                        if (!newState) {
                            // recolhe descendentes também
                            const childId = child.dataset.rowId;
                            const descendants = tbody.querySelectorAll(`tr[data-parent-id="${childId}"]`);
                            descendants.forEach(d => d.style.display = 'none');
                            child.dataset.expanded = 'false';
                            const cIcon = child.querySelector('[data-role="toggle"]');
                            if (cIcon) cIcon.textContent = '▶';
                        }
                    });
                });
            }

            tbody.appendChild(tr);
            return tr.dataset.rowId;
        };

        rows.forEach(gr => {
            // grupo
            const grupoId = createRow({
                conta: gr.conta,
                dados: gr.dados || {},
                tipo: 'grupo',
                level: 0,
                hasChildren: Array.isArray(gr.detalhes) && gr.detalhes.length > 0,
                parentId: null
            });

            // itens (inicialmente escondidos)
            if (Array.isArray(gr.detalhes)) {
                gr.detalhes.forEach(item => {
                    const itemId = createRow({
                        conta: item.conta,
                        dados: item.dados || {},
                        tipo: 'item',
                        level: 1,
                        hasChildren: false,
                        parentId: grupoId
                    });
                    // começa escondido
                    const tr = tbody.querySelector(`tr[data-row-id="${itemId}"]`);
                    if (tr) tr.style.display = 'none';
                });
            }
        });
    }

    async function refreshFinanceiroIfNeeded(opts) {
        const status = getStatusSelecionado();
        const shouldShow = (status === 'todos');

        setFinanceiroVisible(shouldShow);

        // Não "limpa" a tabela aqui para evitar piscar (flicker). A limpeza/ocultação é tratada
        // pela lógica principal (app.fetchFinanceiroData) quando necessário.
        if (!shouldShow) return;

        // Quando chamado por mudanças de filtros (e não pelo fetch principal), atualiza os dados.
        const skipFetch = opts && opts.skipFetch;
        if (skipFetch) return;

        try {
            if (window.app && typeof window.app.fetchFinanceiroData === 'function') {
                await window.app.fetchFinanceiroData();
                return;
            }
            // Fallback: mantém comportamento antigo se a função principal não existir
            const data = await fetchFinanceiroDashboard();
            renderFinanceiroDashboard(data);
        } catch (e) {
            console.error('[Financeiro] Erro ao atualizar:', e);
            // não limpar tabela para não piscar
        }
    }

    // Expor para o restante do script (fetchData chama isso após atualizar colunas)
    window.refreshFinanceiroIfNeeded = refreshFinanceiroIfNeeded;

    // Garantir atualização ao trocar filtros relevantes
    document.addEventListener('DOMContentLoaded', () => {
        const st = document.getElementById('dashboard-status-view');
        const ano = document.getElementById('ano-dashboard');
        const periodo = document.getElementById('dashboard-view');

        if (st) st.addEventListener('change', () => refreshFinanceiroIfNeeded());
        if (ano) ano.addEventListener('change', () => refreshFinanceiroIfNeeded());
        if (periodo) periodo.addEventListener('change', () => refreshFinanceiroIfNeeded());
    });
})();

