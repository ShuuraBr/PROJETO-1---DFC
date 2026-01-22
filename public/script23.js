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
    viewType: "mensal", 
    
    // CACHE
    dadosOrcamentoCache: null,

    init: () => {
        const usuarioSalvo = sessionStorage.getItem('dfc_user');
        
        app.carregarAnosDisponiveis();

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
        const tbody = document.querySelector('#orcamento-table tbody');
        const kpiContainer = document.getElementById('kpi-orcamento-container');

        if(tbody) tbody.innerHTML = '<tr><td colspan="49" style="text-align:center; padding:20px;">Carregando dados...</td></tr>';
        if(kpiContainer) kpiContainer.innerHTML = ''; 

        try {
            const email = app.user.Email;
            const anoParam = app.yearOrcamento; 
            
            const res = await fetch(`/api/orcamento?email=${encodeURIComponent(email)}&ano=${anoParam}`);
            const data = await res.json();

            if (data.error) throw new Error(data.error);
            
            app.dadosOrcamentoCache = data;
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

        const select = document.getElementById('filtro-dep-orcamento');
        const deptSelecionado = select ? select.value : "";

        let dadosFiltrados = app.dadosOrcamentoCache;

        if (deptSelecionado !== "") {
            dadosFiltrados = app.dadosOrcamentoCache.filter(grupo => grupo.conta === deptSelecionado);
        }

        app.renderOrcamentoTable(dadosFiltrados);
        app.renderOrcamentoKPIs(dadosFiltrados);
        app.renderOrcamentoChart(dadosFiltrados);
        app.renderThermometer(dadosFiltrados);
    },

    renderThermometer: (data) => {
        const fillEl = document.getElementById('thermometer-fill');
        const bulbEl = document.getElementById('thermometer-bulb-color');
        const titleGoal = document.getElementById('thermometer-goal-title');
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
        let projecaoTotal = gastoDiario * diasRestantes;

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

    renderOrcamentoKPIs: (data) => {
        const container = document.getElementById('kpi-orcamento-container');
        if (!container || !data) return;

        const hoje = new Date();
        const mesIndex = hoje.getMonth(); 
        const anoAnalise = app.yearOrcamento; 
        
        const chavesMeses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const nomesMeses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        const nomeMes = nomesMeses[mesIndex];
        const keyMes = chavesMeses[mesIndex];

        let totalOrcado = 0;
        let totalRealizado = 0;

        data.forEach(grupo => {
            if (grupo.dados && grupo.dados[keyMes]) {
                totalOrcado += Math.abs(grupo.dados[keyMes].orcado || 0);
                totalRealizado += (grupo.dados[keyMes].realizado || 0);
            }
        });

        const diferencaValor = totalOrcado - totalRealizado; 
        let diferencaPerc = 0;
        if (totalOrcado !== 0) {
            diferencaPerc = (diferencaValor / totalOrcado) * 100;
        } else if (totalRealizado > 0) {
            diferencaPerc = -100; 
        }

        const fmt = v => new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'}).format(v);
        const fmtPerc = v => new Intl.NumberFormat('pt-BR', {maximumFractionDigits: 1}).format(v) + '%';
        const corDif = diferencaValor >= 0 ? 'text-green' : 'text-red';

        let cardDias = '---';
        let cardMeta = '---';
        let cardGasto = '---';
        let cardProj = '---';
        let corGasto = '';
        let rodapeDias = 'Selecione um ano';

        if (anoAnalise) {
            const dias = app.getDiasUteis(mesIndex, anoAnalise);
            rodapeDias = 'Decorridos / Totais';
            cardDias = `${dias.decorridos} / ${dias.totais}`;
            
            const diasRestantes = dias.totais - dias.decorridos;

            let metaDiaria = 0;
            if (dias.totais > 0) metaDiaria = totalOrcado / dias.totais;

            let gastoDiario = 0;
            if (dias.decorridos > 0) gastoDiario = totalRealizado / dias.decorridos;

            let projecaoTotal = gastoDiario * diasRestantes;

            cardMeta = fmt(metaDiaria);
            cardGasto = fmt(gastoDiario);
            cardProj = fmt(projecaoTotal);
            corGasto = (gastoDiario > metaDiaria) ? 'text-red' : 'text-green';
        }

        const mkCard = (titulo, valor, corTexto, rodape = '') => `
            <div class="card">
                <div class="card-title">${titulo}</div>
                <div class="card-value ${corTexto}">${valor}</div>
                ${rodape ? `<div style="font-size:11px; color:#6b7280; margin-top:5px; padding-top:4px; border-top:1px solid #f3f4f6;">${rodape}</div>` : ''}
            </div>
        `;

        const labelMes = anoAnalise ? `(${nomeMes})` : '(Geral)';

        container.innerHTML = 
            mkCard(`Orçado ${labelMes}`, fmt(totalOrcado), 'col-orc') +
            mkCard(`Realizado ${labelMes}`, fmt(totalRealizado), 'col-real') +
            mkCard(`Diferença R$`, fmt(Math.abs(diferencaValor)), corDif) +
            mkCard(`Diferença %`, fmtPerc(Math.abs(diferencaPerc)), corDif) +
            mkCard(`Dias Úteis (${anoAnalise || '-'})`, cardDias, 'text-dark', rodapeDias) +
            mkCard(`Meta Diária`, cardMeta, 'col-orc', 'Teto de gasto') +
            mkCard(`Gasto Diário`, cardGasto, corGasto, 'Média realizada') +
            mkCard(`Projeção Final`, cardProj, 'text-primary', 'Tendência');
    },

    renderOrcamentoChart: (data) => {
        const canvas = document.getElementById('orcamentoChart');
        if(!canvas) return;
        if (typeof Chart === 'undefined') return;

        const customLegend = document.getElementById('custom-chart-legend');
        if(customLegend) customLegend.remove();

        const existingChart = Chart.getChart(canvas);
        if (existingChart) existingChart.destroy();
        if (app.orcamentoChart) { app.orcamentoChart.destroy(); app.orcamentoChart = null; }

        const labels = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const chaves = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        
        const arrOrcado = new Array(12).fill(0);
        const arrRealizado = new Array(12).fill(0);

        data.forEach(grupo => {
            chaves.forEach((key, idx) => {
                if(grupo.dados && grupo.dados[key]) {
                    arrOrcado[idx] += Math.abs(grupo.dados[key].orcado || 0);
                    arrRealizado[idx] += Math.abs(grupo.dados[key].realizado || 0);
                }
            });
        });

        if (typeof ChartDataLabels !== 'undefined') { try { Chart.register(ChartDataLabels); } catch(e){} }

        const ctx = canvas.getContext('2d');
        const gradientReal = ctx.createLinearGradient(0, 0, 0, 400);
        gradientReal.addColorStop(0, 'rgba(37, 99, 235, 0.4)');
        gradientReal.addColorStop(1, 'rgba(37, 99, 235, 0.05)');

        const gradientOrc = ctx.createLinearGradient(0, 0, 0, 400);
        gradientOrc.addColorStop(0, 'rgba(121, 182, 97, 0.46)');
        gradientOrc.addColorStop(1, 'rgba(95, 145, 80, 0.53)');

        app.orcamentoChart = new Chart(ctx, {
            type: 'line', 
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Orçado',
                        data: arrOrcado,
                        borderColor: '#189629ff', 
                        backgroundColor: gradientOrc, 
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true, 
                        order: 2,
                        pointRadius: 3
                    },
                    {
                        label: 'Realizado',
                        data: arrRealizado,
                        borderColor: '#2563eb', 
                        backgroundColor: gradientReal, 
                        borderWidth: 3,
                        tension: 0.4,
                        fill: true, 
                        order: 1,
                        pointRadius: 4,
                        pointBackgroundColor: '#fff'
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                layout: { padding: { top: 30, bottom: 10, left: 20, right: 30 } },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { position: 'top', labels: { usePointStyle: true } },
                    tooltip: { enabled: false }, 
                    datalabels: {
                        display: function(context) { return window.innerWidth > 768; },
                        align: 'top', anchor: 'end', offset: 8, clamp: true,       
                        color: function(context) { return context.dataset.data[context.dataIndex] >= 0 ? '#059669' : '#dc2626'; },
                        font: { weight: 'bold', size: 12 },
                        formatter: function(value) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: "compact" }).format(value); }
                    }
                },
                scales: {
                    y: { beginAtZero: true, grace: '50%', grid: { borderDash: [5, 5], color: '#f3f4f6' }, ticks: { callback: v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: "compact" }).format(v) } },
                    x: { offset: true, grid: { display: false } }
                }
            }
        });
    },

    renderTable: (data) => {
        const rows = data.rows;
        const columns = data.columns; 
        const headers = data.headers;

        const tbody = document.querySelector('#finance-table tbody');
        const thead = document.querySelector('#finance-table thead');
        
        if(!tbody || !thead) return;

        let thHtml = `<tr>
            <th>Plano Financeiro</th>`;
        headers.forEach(h => {
            thHtml += `<th>${h}</th>`;
        });
        thHtml += `</tr>`;
        thead.innerHTML = thHtml;

        if(!rows || rows.length===0) { tbody.innerHTML='<tr><td colspan="15">Sem dados</td></tr>'; return; }

        const fmt = v => v ? new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'}).format(v) : '-';

        let html = '';
        rows.forEach((row, idx1) => {
            const idNivel1 = `L1-${idx1}`; 
            let trStyle = ''; 
            let tdClass = ''; 
            let icon = '';
            let clickAction = '';
            let rowClass = '';

            if (row.tipo === 'saldo' || row.tipo === 'info') {
                trStyle = 'background-color: #eff6ff; font-weight: 800; color: #1e3a8a; border-top: 2px solid #bfdbfe;';
            } else if (row.tipo === 'grupo') {
                rowClass = 'hover-row';
                trStyle = 'font-weight: 600; cursor: pointer; background-color: #fff;'; 
                icon = '<i class="fa-solid fa-chevron-right toggle-icon"></i> ';
                clickAction = `onclick="app.toggleGroup('${idNivel1}', this)"`;
                if (row.conta.includes('Entradas')) tdClass = 'text-green';
                if (row.conta.includes('Saídas')) tdClass = 'text-red';
            }

            let tdsValores = '';
            columns.forEach(colKey => {
                tdsValores += `<td class="${tdClass}">${fmt(row[colKey])}</td>`;
            });

            html += `<tr style="${trStyle}" class="${rowClass}" ${clickAction}>
                    <td style="text-align:left; padding-left:10px;">${icon}<span class="${tdClass}">${row.conta}</span></td>
                    ${tdsValores}
                </tr>`;

            if (row.detalhes && row.detalhes.length > 0) {
                row.detalhes.forEach((subgrupo, idx2) => {
                    const idNivel2 = `L2-${idx1}-${idx2}`; 
                    
                    let tdsSub = '';
                    columns.forEach(colKey => {
                        tdsSub += `<td>${fmt(subgrupo[colKey])}</td>`;
                    });

                    html += `<tr class="child-row hidden pai-${idNivel1} hover-row" onclick="app.toggleSubGroup('${idNivel2}', this)" style="cursor: pointer;">
                            <td style="text-align:left; padding-left: 25px; font-weight: 600;">
                                <i class="fa-solid fa-chevron-right toggle-icon"></i> ${subgrupo.conta}
                            </td>
                            ${tdsSub}
                        </tr>`;
                    if (subgrupo.detalhes) {
                        subgrupo.detalhes.forEach(item => {
                            let tdsItem = '';
                            columns.forEach(colKey => {
                                tdsItem += `<td>${fmt(item[colKey])}</td>`;
                            });

                            html += `<tr class="child-row hidden pai-${idNivel2} avo-${idNivel1}">
                                    <td style="text-align:left; padding-left: 50px; color: #555;">${item.conta}</td>
                                    ${tdsItem}
                                </tr>`;
                        });
                    }
                });
            }
        });
        tbody.innerHTML = html;
    },

    renderOrcamentoTable: (data) => {
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
                let clsDif = vals.diferenca < 0 ? 'text-red' : (vals.diferenca > 0 ? 'text-green' : '');
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
                        let clsDif = vals.diferenca < 0 ? 'text-red' : (vals.diferenca > 0 ? 'text-green' : '');
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
            if(data.error) throw new Error(data.error);
            
            app.renderKPIs(data.cards);
            await app.loadInadimplenciaKPIs();
            app.renderTable(data.tabela); 
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

    // Carrega 3 KPIs extras (apenas quando filtro "Todos" estiver selecionado)
    // 1) Inadimplência (R$) -> Baixa IS NULL e Financeiro IS NOT NULL (mês atual)
    // 2) % da inadimplência sobre o plano 1.001.006 - BOLETOS (mês atual)
    // 3) Nº de inadimplentes (COUNT DISTINCT Nome)
    loadInadimplenciaKPIs: async () => {
        const ct = document.getElementById('kpi-container');
        if (!ct) return;

        const statusSelect = document.getElementById('dashboard-status-view');
        const statusVal = statusSelect ? String(statusSelect.value || '').toLowerCase() : 'todos';

        // Se não estiver em "Todos", não mostra os KPIs extras
        if (statusVal !== 'todos') {
            // garante que nada extra permaneça
            ct.querySelectorAll('.kpi-extra-inad').forEach(el => el.remove());
            return;
        }

        // Remove cards extras antigos antes de recriar
        ct.querySelectorAll('.kpi-extra-inad').forEach(el => el.remove());

        const hoje = new Date();
        const mesAtual = hoje.getMonth() + 1;

        // Usa o ano selecionado no Dashboard, com fallback para o ano atual
        const anoAlvo = Number.isFinite(parseInt(app.yearDashboard, 10)) ? parseInt(app.yearDashboard, 10) : hoje.getFullYear();

        try {
            const res = await fetch(`/api/inadimplencia?ano=${encodeURIComponent(anoAlvo)}&mes=${encodeURIComponent(mesAtual)}`);
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Falha ao carregar inadimplência');

            const inadValor = Number(data.inadimplenciaValor || 0);
            const inadPerc = Number(data.inadimplenciaPercBoletos || 0);
            const inadCount = Number(data.inadimplentesCount || 0);

            const fmtMoney = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
            const fmtInt = (v) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(v);
            const fmtPerc = (v) => `${v.toFixed(2).replace('.', ',')}%`;

            const mk = (label, valueHtml, cls) => `
                <div class="card kpi-extra-inad">
                    <div class="card-title">${label}</div>
                    <div class="card-value ${cls || ''}">${valueHtml}</div>
                </div>
            `;

            // KPIs extras: ordem após os 5 atuais
            const kpi1 = mk('Inadimplência (mês atual)', fmtMoney(inadValor), 'text-red');
            const kpi2 = mk('% da Inadimplência em BOLETOS (1.001.006)', fmtPerc(inadPerc), inadPerc >= 0 ? '' : 'text-red');
            const kpi3 = mk('Nº de Inadimplentes (mês atual)', fmtInt(inadCount), '');

            ct.insertAdjacentHTML('beforeend', kpi1 + kpi2 + kpi3);

        } catch (err) {
            console.error('KPI inadimplência:', err);
            // Em caso de erro, não quebra a tela; apenas não mostra os extras.
        }
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
    }
};

document.addEventListener('DOMContentLoaded', app.init);