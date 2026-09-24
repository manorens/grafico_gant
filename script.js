(function(){
  "use strict";

  /* ---------------- armazenamento ---------------- */
  const STORAGE_KEY = "weg_manutencao_charts_v3";
  const OLD_STORAGE_KEY = "weg_gantt_charts_v2";

  /* tipos de manutenção (categoria/cor de cada atividade) */
  const MAINT_TYPES = [
    {id:"preventiva",  hex:"#0d6fb8", label:"Preventiva"},
    {id:"corretiva",   hex:"#d1495b", label:"Corretiva"},
    {id:"preditiva",   hex:"#0090c8", label:"Preditiva"},
    {id:"inspecao",    hex:"#e8a13a", label:"Inspeção"},
    {id:"parada",      hex:"#00243b", label:"Parada programada"},
    {id:"calibracao",  hex:"#2e9e5b", label:"Calibração"}
  ];
  // migração dos ids de cor da versão anterior do cronograma
  const COLOR_MIGRATION = {blue:"preventiva",cyan:"preditiva",amber:"inspecao",green:"calibracao",red:"corretiva",navy:"parada"};

  /* situação de cada atividade */
  const STATUS_META = {
    pendente:  {label:"Pendente"},
    andamento: {label:"Em andamento"},
    concluida: {label:"Concluída"},
    atrasada:  {label:"Atrasada"}
  };
  const STATUS_FILTERS = [
    {key:"todas",     label:"Todas"},
    {key:"pendente",  label:"Pendentes"},
    {key:"andamento", label:"Em andamento"},
    {key:"concluida", label:"Concluídas"},
    {key:"atrasada",  label:"Atrasadas"}
  ];

  const DOW = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
  const MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  const BAR_FONT = "600 11px 'Inter', Arial, sans-serif";
  const ROW_HEIGHT = 62;
  let BASE_DAY_WIDTH = 56;         // pode ser reduzido temporariamente para a impressão
  const SCREEN_DAY_WIDTH = 56;     // valor original, usado na tela
  const MIN_PRINT_DAY_WIDTH = 14;  // menor largura de dia aceitável no PDF
  const NAME_COL_WIDTH = 260;      // precisa bater com .task-name-cell / .task-col-header no CSS
  let isPrintRender = false;       // true enquanto o gantt está redesenhado para impressão

  const $ = (sel) => document.querySelector(sel);
  const ganttRoot = $("#ganttRoot");
  const swatchesEl = $("#swatches");
  const tabbarEl = $("#tabbar");
  const depSelect = $("#taskDependency");
  const depWarning = $("#depWarning");
  const dashboardEl = $("#dashboard");
  const statusFiltersEl = $("#statusFilters");
  const searchInputEl = $("#searchInput");
  const ganttViewEl = $("#ganttView");
  const listViewEl = $("#listView");
  const activitiesBody = $("#activitiesBody");
  const printOrientationEl = $("#printOrientation");

  let state = { charts: [], activeId: null };
  let selectedType = MAINT_TYPES[0].id;
  let viewMode = "gantt";
  let currentFilter = "todas";
  let currentSearch = "";

  function uid(prefix){ return (prefix||"id") + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  /* ---------------- modelo de dados ---------------- */
  function normalizeTask(t){
    return {
      id: t.id || uid("t"),
      name: t.name || "Atividade",
      start: t.start,
      time: t.time || "08:00",
      durationValue: t.durationValue!=null ? t.durationValue : (t.duration!=null ? t.duration : 1),
      durationUnit: t.durationUnit || (t.duration!=null ? "dias" : "horas"),
      progress: t.progress || 0,
      color: t.color || MAINT_TYPES[0].id,
      dependency: t.dependency || "",
      components: t.components || "",
      responsible: t.responsible || "",
      deadline: t.deadline || ""
    };
  }

  function ensureValidState(){
    if(!state.charts || state.charts.length===0){
      const c = { id:uid("c"), name:"Cronograma 1", tasks:[] };
      state = { charts:[c], activeId:c.id };
    }
    if(!state.activeId || !state.charts.find(c=>c.id===state.activeId)){
      state.activeId = state.charts[0].id;
    }
  }

  function loadState(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(raw){
        state = JSON.parse(raw);
        state.charts.forEach(c=>{ c.tasks = (c.tasks||[]).map(normalizeTask); });
        ensureValidState();
        return;
      }
      const rawOld = localStorage.getItem(OLD_STORAGE_KEY);
      if(rawOld){
        const old = JSON.parse(rawOld);
        state = {
          charts: (old.charts||[]).map(c=>({
            id: c.id || uid("c"),
            name: c.name || "Cronograma",
            tasks: (c.tasks||[]).map(t=>{
              const n = normalizeTask(t);
              n.color = COLOR_MIGRATION[t.color] || MAINT_TYPES[0].id;
              return n;
            })
          })),
          activeId: old.activeId
        };
        ensureValidState();
        saveState();
        return;
      }
      const firstChart = { id:uid("c"), name:"Cronograma 1", tasks:[] };
      state = { charts:[firstChart], activeId:firstChart.id };
    }catch(e){
      const firstChart = { id:uid("c"), name:"Cronograma 1", tasks:[] };
      state = { charts:[firstChart], activeId:firstChart.id };
    }
  }
  function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function activeChart(){ return state.charts.find(c=>c.id===state.activeId); }

  /* ---------------- datas ---------------- */
  function parseDate(str){
    const [y,m,d] = str.split("-").map(Number);
    return new Date(y, m-1, d);
  }
  function parseDateTime(t){
    const d = parseDate(t.start);
    const [hh,mm] = (t.time||"08:00").split(":").map(Number);
    d.setHours(hh||0, mm||0, 0, 0);
    return d;
  }
  function durationHours(t){ return t.durationUnit==="horas" ? Number(t.durationValue) : Number(t.durationValue)*24; }
  function endDateTime(t){ return new Date(parseDateTime(t).getTime() + durationHours(t)*3600000); }
  function deadlineDateOf(t){
    if(t.deadline){
      const d = parseDate(t.deadline);
      d.setHours(23,59,59,999);
      return d;
    }
    return endDateTime(t);
  }
  function fmtISO(date){ return date.getFullYear() + "-" + String(date.getMonth()+1).padStart(2,"0") + "-" + String(date.getDate()).padStart(2,"0"); }
  function fmtBR(date){ return String(date.getDate()).padStart(2,"0") + "/" + String(date.getMonth()+1).padStart(2,"0"); }
  function fmtBRFull(date){ return String(date.getDate()).padStart(2,"0") + "/" + String(date.getMonth()+1).padStart(2,"0") + "/" + date.getFullYear(); }
  function fmtHM(date){ return String(date.getHours()).padStart(2,"0") + ":" + String(date.getMinutes()).padStart(2,"0"); }
  function fmtDateTimeShort(date){ return fmtBR(date) + " " + fmtHM(date); }
  function addDays(date, n){ const d = new Date(date); d.setDate(d.getDate()+n); return d; }
  function isSameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
  function escapeHtml(str){ const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }

  let measureCanvas = null;
  function measureTextWidth(text, font){
    if(!measureCanvas) measureCanvas = document.createElement("canvas");
    const ctx = measureCanvas.getContext("2d");
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  /* ---------------- situação / filtros / busca ---------------- */
  function computeStatus(t){
    if(Number(t.progress) >= 100) return "concluida";
    const now = new Date();
    const dl = deadlineDateOf(t);
    if(now > dl) return "atrasada";
    const start = parseDateTime(t);
    if(now >= start) return "andamento";
    return "pendente";
  }
  function typeOf(id){ return MAINT_TYPES.find(x=>x.id===id) || MAINT_TYPES[0]; }
  function statusBadgeHtml(statusKey){
    const meta = STATUS_META[statusKey] || STATUS_META.pendente;
    return "<span class='status-badge status-"+statusKey+"'>"+meta.label+"</span>";
  }
  function matchesSearch(t, q){
    if(!q) return true;
    const hay = (t.name+" "+t.components+" "+t.responsible).toLowerCase();
    return hay.includes(q.toLowerCase());
  }
  function componentList(t){
    return (t.components||"").split(",").map(s=>s.trim()).filter(Boolean);
  }

  /* ---------------- abas (cronogramas) ---------------- */
  function renderTabs(){
    tabbarEl.innerHTML = "";
    state.charts.forEach(chart=>{
      const tab = document.createElement("div");
      tab.className = "tab" + (chart.id===state.activeId ? " active":"");
      const label = document.createElement("span");
      label.textContent = chart.name;
      tab.appendChild(label);

      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "✕";
      close.title = "Excluir cronograma";
      close.addEventListener("click",(e)=>{
        e.stopPropagation();
        if(state.charts.length===1){ alert("Deve existir ao menos um cronograma."); return; }
        if(confirm('Excluir o cronograma "'+chart.name+'" e todas as suas atividades?')){
          state.charts = state.charts.filter(c=>c.id!==chart.id);
          if(state.activeId===chart.id) state.activeId = state.charts[0].id;
          saveState();
          renderAll();
        }
      });
      tab.appendChild(close);

      tab.addEventListener("click",()=>{
        state.activeId = chart.id;
        saveState();
        resetForm();
        renderAll();
      });
      tab.addEventListener("dblclick",()=>{
        const novoNome = prompt("Renomear cronograma:", chart.name);
        if(novoNome && novoNome.trim()){
          chart.name = novoNome.trim();
          saveState();
          renderAll();
        }
      });
      tabbarEl.appendChild(tab);
    });

    const addTab = document.createElement("div");
    addTab.className = "tab-add";
    addTab.textContent = "+ Novo cronograma";
    addTab.addEventListener("click",()=>{
      const nome = prompt("Nome do novo cronograma:", "Cronograma " + (state.charts.length+1));
      if(nome===null) return;
      const chart = { id:uid("c"), name: nome.trim() || ("Cronograma " + (state.charts.length+1)), tasks: [] };
      state.charts.push(chart);
      state.activeId = chart.id;
      saveState();
      resetForm();
      renderAll();
    });
    tabbarEl.appendChild(addTab);
  }

  /* ---------------- formulário ---------------- */
  function renderSwatches(){
    swatchesEl.innerHTML = "";
    MAINT_TYPES.forEach(c=>{
      const el = document.createElement("div");
      el.className = "swatch" + (c.id===selectedType ? " active":"");
      el.style.background = c.hex;
      el.title = c.label;
      el.addEventListener("click",()=>{ selectedType = c.id; renderSwatches(); });
      swatchesEl.appendChild(el);
    });
  }

  function refreshDependencyOptions(excludeId){
    const chart = activeChart();
    depSelect.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "Nenhuma atividade";
    depSelect.appendChild(noneOpt);
    chart.tasks.filter(t=>t.id!==excludeId).forEach(t=>{
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      depSelect.appendChild(opt);
    });
  }

  function resetForm(){
    $("#taskId").value = "";
    $("#taskName").value = "";
    $("#taskComponents").value = "";
    $("#taskResponsible").value = "";
    $("#taskStart").value = fmtISO(new Date());
    $("#taskTime").value = "08:00";
    $("#taskDuration").value = 2;
    $("#taskUnit").value = "horas";
    $("#taskDeadline").value = "";
    $("#taskProgress").value = 0;
    selectedType = MAINT_TYPES[0].id;
    renderSwatches();
    refreshDependencyOptions(null);
    depSelect.value = "";
    depWarning.style.display = "none";
    $("#formTitle").textContent = "Nova atividade";
    $("#saveTask").textContent = "Adicionar atividade";
    $("#cancelEdit").style.display = "none";
    $("#deleteTask").style.display = "none";
  }

  function editTask(id){
    const chart = activeChart();
    const t = chart.tasks.find(x=>x.id===id);
    if(!t) return;
    $("#taskId").value = t.id;
    $("#taskName").value = t.name;
    $("#taskComponents").value = t.components || "";
    $("#taskResponsible").value = t.responsible || "";
    $("#taskStart").value = t.start;
    $("#taskTime").value = t.time;
    $("#taskDuration").value = t.durationValue;
    $("#taskUnit").value = t.durationUnit;
    $("#taskDeadline").value = t.deadline || "";
    $("#taskProgress").value = t.progress;
    selectedType = t.color;
    renderSwatches();
    refreshDependencyOptions(t.id);
    depSelect.value = t.dependency || "";
    checkDependencyWarning();
    $("#formTitle").textContent = "Editar atividade";
    $("#saveTask").textContent = "Salvar alterações";
    $("#cancelEdit").style.display = "inline-flex";
    $("#deleteTask").style.display = "inline-flex";
    window.scrollTo({top:0,behavior:"smooth"});
  }

  function checkDependencyWarning(){
    const depId = depSelect.value;
    if(!depId){ depWarning.style.display = "none"; return; }
    const chart = activeChart();
    const dep = chart.tasks.find(t=>t.id===depId);
    if(!dep){ depWarning.style.display = "none"; return; }
    const start = $("#taskStart").value;
    const time = $("#taskTime").value || "08:00";
    if(!start){ depWarning.style.display = "none"; return; }
    const thisStart = parseDateTime({start:start, time:time});
    const depEnd = endDateTime(dep);
    if(thisStart < depEnd){
      depWarning.style.display = "block";
      depWarning.textContent = "Atenção: essa atividade começa antes de \"" + dep.name + "\" terminar (termina em " + fmtDateTimeShort(depEnd) + ").";
    }else{
      depWarning.style.display = "none";
    }
  }
  depSelect.addEventListener("change", checkDependencyWarning);
  $("#taskStart").addEventListener("change", checkDependencyWarning);
  $("#taskTime").addEventListener("change", checkDependencyWarning);

  $("#saveTask").addEventListener("click",()=>{
    const name = $("#taskName").value.trim();
    const components = $("#taskComponents").value.trim();
    const responsible = $("#taskResponsible").value.trim();
    const start = $("#taskStart").value;
    const time = $("#taskTime").value || "08:00";
    const durationValue = Math.max(Number($("#taskDuration").value)||1, 1);
    const durationUnit = $("#taskUnit").value;
    const deadline = $("#taskDeadline").value;
    const progress = Math.min(Math.max(parseInt($("#taskProgress").value,10)||0,0),100);
    const dependency = depSelect.value;
    if(!name || !start){
      alert("Preencha ao menos o nome e o início previsto da atividade.");
      return;
    }
    const chart = activeChart();
    const id = $("#taskId").value;
    if(id){
      const t = chart.tasks.find(x=>x.id===id);
      Object.assign(t, {name,components,responsible,start,time,durationValue,durationUnit,deadline,progress,color:selectedType,dependency});
    }else{
      chart.tasks.push({id:uid("t"),name,components,responsible,start,time,durationValue,durationUnit,deadline,progress,color:selectedType,dependency});
    }
    saveState();
    resetForm();
    rerender();
  });
  $("#cancelEdit").addEventListener("click", resetForm);
  $("#deleteTask").addEventListener("click",()=>{
    const id = $("#taskId").value;
    if(!id) return;
    if(confirm("Excluir esta atividade do cronograma?")){
      const chart = activeChart();
      chart.tasks = chart.tasks.filter(t=>t.id!==id);
      chart.tasks.forEach(t=>{ if(t.dependency===id) t.dependency = ""; });
      saveState();
      resetForm();
      rerender();
    }
  });

  /* ---------------- barra de ferramentas: visão / busca / filtros ---------------- */
  $("#viewSwitch").querySelectorAll(".view-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      viewMode = btn.dataset.view;
      $("#viewSwitch").querySelectorAll(".view-btn").forEach(b=>b.classList.toggle("active", b===btn));
      ganttViewEl.style.display = viewMode==="gantt" ? "" : "none";
      listViewEl.style.display = viewMode==="list" ? "" : "none";
      rerender();
    });
  });
  searchInputEl.addEventListener("input",(e)=>{ currentSearch = e.target.value; rerender(); });

  function renderStatusFilters(searchFilteredTasks){
    const counts = {todas:searchFilteredTasks.length, pendente:0, andamento:0, concluida:0, atrasada:0};
    searchFilteredTasks.forEach(t=>{ counts[computeStatus(t)]++; });
    statusFiltersEl.innerHTML = STATUS_FILTERS.map(f=>
      "<button type='button' class='chip-filter"+(currentFilter===f.key?" active":"")+"' data-key='"+f.key+"'>"+
        f.label+" <span class='chip-count'>"+counts[f.key]+"</span></button>"
    ).join("");
    statusFiltersEl.querySelectorAll(".chip-filter").forEach(btn=>{
      btn.addEventListener("click",()=>{ currentFilter = btn.dataset.key; rerender(); });
    });
  }

  /* ---------------- dashboard ---------------- */
  function renderDashboard(tasks){
    const total = tasks.length;
    const counts = {pendente:0, andamento:0, concluida:0, atrasada:0};
    let progressSum = 0;
    tasks.forEach(t=>{ counts[computeStatus(t)]++; progressSum += Number(t.progress)||0; });
    const avg = total ? Math.round(progressSum/total) : 0;
    const cards = [
      {cls:"total",     value:total,               label:"Atividades no cronograma"},
      {cls:"pendente",  value:counts.pendente,      label:"Pendentes"},
      {cls:"andamento", value:counts.andamento,     label:"Em andamento"},
      {cls:"concluida", value:counts.concluida,     label:"Concluídas"},
      {cls:"atrasada",  value:counts.atrasada,      label:"Atrasadas"},
      {cls:"avg",       value:avg+"%",              label:"Progresso médio"}
    ];
    dashboardEl.innerHTML = cards.map(c=>
      "<div class='stat-card stat-"+c.cls+"'><span class='stat-value'>"+c.value+"</span><span class='stat-label'>"+c.label+"</span></div>"
    ).join("");
  }

  /* ---------------- informações para impressão/PDF ---------------- */
  function renderPrintDetails(tasks, chart){
    const printDetails = $("#printDetails");
    if(!printDetails) return;

    if(!tasks || tasks.length===0){
      printDetails.innerHTML = "";
      return;
    }

    const sorted = [...tasks].sort((a,b)=> parseDateTime(a)-parseDateTime(b));
    printDetails.innerHTML = `
      <h2>Informações das atividades</h2>
      <table class="print-details-table">
        <thead>
          <tr>
            <th>Atividade</th>
            <th>Componentes envolvidos</th>
            <th>Tipo de manutenção</th>
            <th>Responsável</th>
            <th>Período previsto</th>
            <th>Prazo de entrega</th>
            <th>Progresso</th>
            <th>Situação</th>
            <th>Depende de</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(t=>{
            const status = computeStatus(t);
            const type = typeOf(t.color);
            const s = parseDateTime(t);
            const e = endDateTime(t);
            const dep = t.dependency ? chart.tasks.find(x=>x.id===t.dependency) : null;
            const components = componentList(t).join(", ") || "—";
            const deadline = t.deadline ? fmtBRFull(parseDate(t.deadline)) : "Fim previsto: "+fmtBR(e);
            return `<tr>
              <td>${escapeHtml(t.name)}</td>
              <td>${escapeHtml(components)}</td>
              <td>${escapeHtml(type.label)}</td>
              <td>${escapeHtml(t.responsible || "—")}</td>
              <td>${fmtDateTimeShort(s)} – ${fmtDateTimeShort(e)}</td>
              <td>${escapeHtml(deadline)}</td>
              <td>${Number(t.progress)||0}%</td>
              <td>${escapeHtml((STATUS_META[status] || {}).label || status)}</td>
              <td>${escapeHtml(dep ? dep.name : "Nenhuma atividade")}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
  }

  /* ---------------- Gantt ---------------- */
  function getRange(tasks){
    if(tasks.length===0){
      const start = new Date(); start.setHours(0,0,0,0);
      return { start: addDays(start,-1), end: addDays(start, 14) };
    }
    let min=null, max=null;
    tasks.forEach(t=>{
      const s = parseDateTime(t), e = endDateTime(t);
      if(!min || s<min) min = s;
      if(!max || e>max) max = e;
    });
    const startDay = new Date(min); startDay.setHours(0,0,0,0);
    const endDay = new Date(max); endDay.setHours(0,0,0,0);
    return { start: addDays(startDay,-1), end: addDays(endDay,2) };
  }

  function getDayWidths(tasks, start, totalDays){
    const widths = Array(totalDays).fill(BASE_DAY_WIDTH);
    const dayLoad = Array(totalDays).fill(0);
    const dayText = Array(totalDays).fill(0);
    tasks.forEach(t=>{
      const s = parseDateTime(t), e = endDateTime(t);
      const first = Math.max(0, Math.floor((new Date(s.getFullYear(),s.getMonth(),s.getDate())-start)/86400000));
      const lastMoment = new Date(e.getTime()-1);
      const last = Math.min(totalDays-1, Math.floor((new Date(lastMoment.getFullYear(),lastMoment.getMonth(),lastMoment.getDate())-start)/86400000));
      for(let d=first; d<=last; d++){
        dayLoad[d]++;
        if(!isPrintRender && d===first) dayText[d] = Math.max(dayText[d], measureTextWidth(t.name, BAR_FONT)+26);
      }
    });
    for(let d=0; d<totalDays; d++){
      widths[d] = isPrintRender
        ? BASE_DAY_WIDTH
        : Math.max(BASE_DAY_WIDTH, dayText[d], BASE_DAY_WIDTH + Math.max(0,dayLoad[d]-1)*18);
    }
    return widths;
  }

  function renderGantt(filteredTasks, chart){
    ganttRoot.innerHTML = "";
    const printTitle = $("#printTitle");
    printTitle.innerHTML = escapeHtml(chart.name) + "<span>Gerado em " + fmtBRFull(new Date()) + "</span>";
    renderPrintDetails(filteredTasks, chart);

    if(chart.tasks.length===0){
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<h3>Nenhuma atividade ainda</h3><p>Use o painel à esquerda para adicionar a primeira atividade deste cronograma: componentes envolvidos, responsável, período previsto e prazo de entrega.</p>";
      ganttRoot.appendChild(empty);
      return;
    }
    if(filteredTasks.length===0){
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<h3>Nenhuma atividade encontrada</h3><p>Ajuste a busca ou o filtro de situação para ver outras atividades deste cronograma.</p>";
      ganttRoot.appendChild(empty);
      return;
    }

    const { start, end } = getRange(filteredTasks);
    const totalDays = Math.round((end-start)/86400000)+1;
    const today = new Date(); today.setHours(0,0,0,0);
    const dayWidths = getDayWidths(filteredTasks, start, totalDays);
    const dayLefts = [0];
    for(let d=0; d<totalDays; d++) dayLefts.push(dayLefts[d]+dayWidths[d]);
    const timelineWidth = dayLefts[totalDays];

    const xForDate = (date)=>{
      const dayStart = new Date(date.getFullYear(),date.getMonth(),date.getDate());
      const idx = Math.max(0, Math.min(totalDays-1, Math.floor((dayStart-start)/86400000)));
      const fraction = (date-dayStart)/86400000;
      return dayLefts[idx] + fraction*dayWidths[idx];
    };
    const widthBetween = (a,b)=>Math.max(xForDate(b)-xForDate(a)-4,4);

    const monthBand = document.createElement("div");
    monthBand.className = "month-band";
    const corner = document.createElement("div");
    corner.className = "month-corner";
    monthBand.appendChild(corner);
    let i=0;
    while(i<totalDays){
      const monthStart = addDays(start,i);
      let count=0, monthWidth=0;
      while(i<totalDays){
        const day = addDays(start,i);
        if(day.getMonth()!==monthStart.getMonth() || day.getFullYear()!==monthStart.getFullYear()) break;
        monthWidth += dayWidths[i]; count++; i++;
      }
      const mc = document.createElement("div");
      mc.className = "month-cell";
      mc.style.width = monthWidth+"px";
      mc.textContent = MONTHS[monthStart.getMonth()] + " " + monthStart.getFullYear();
      monthBand.appendChild(mc);
    }
    ganttRoot.appendChild(monthBand);

    const header = document.createElement("div");
    header.className = "gantt-header";
    const taskColHeader = document.createElement("div");
    taskColHeader.className = "task-col-header";
    taskColHeader.textContent = "Atividade";
    header.appendChild(taskColHeader);
    for(let d=0; d<totalDays; d++){
      const day = addDays(start,d);
      const cell = document.createElement("div");
      cell.className = "day-cell" + (isSameDay(day,today)?" today":"") + ((day.getDay()===0||day.getDay()===6)?" weekend":"");
      cell.style.width = dayWidths[d]+"px";
      cell.innerHTML = "<span class='dow'>"+DOW[day.getDay()]+"</span>"+day.getDate();
      header.appendChild(cell);
    }
    ganttRoot.appendChild(header);

    const sorted = [...filteredTasks].sort((a,b)=> parseDateTime(a)-parseDateTime(b));
    const barRefs = {};

    sorted.forEach(t=>{
      const status = computeStatus(t);
      const row = document.createElement("div");
      row.className = "task-row";
      const s = parseDateTime(t);
      const e = endDateTime(t);
      const dep = t.dependency ? chart.tasks.find(x=>x.id===t.dependency) : null;
      const hasConflict = dep ? (s < endDateTime(dep)) : false;

      const nameCell = document.createElement("div");
      nameCell.className = "task-name-cell";
      const durLabel = t.durationUnit==="horas" ? (t.durationValue+"h") : (t.durationValue+"d");
      let metaHtml = "<div class='name-row'><span class='name'>"+escapeHtml(t.name)+"</span>"+statusBadgeHtml(status)+"</div>";
      metaHtml += "<span class='meta'>"+fmtDateTimeShort(s)+" – "+fmtDateTimeShort(e)+" · "+durLabel+"</span>";
      if(dep) metaHtml += "<span class='dep-meta"+(hasConflict?" conflict":"")+"'>"+(hasConflict?"⚠ ":"↳ ")+"Depende de: "+escapeHtml(dep.name)+"</span>";
      nameCell.innerHTML = metaHtml;
      nameCell.addEventListener("click",()=>editTask(t.id));
      row.appendChild(nameCell);

      const track = document.createElement("div");
      track.className = "row-track";
      track.style.width = timelineWidth+"px";
      track.style.height = ROW_HEIGHT+"px";
      for(let d=1; d<totalDays; d++){
        const grid = document.createElement("div");
        grid.style.cssText = "position:absolute;left:"+dayLefts[d]+"px;top:0;bottom:0;width:1px;background:rgba(215,227,236,.65);z-index:0;pointer-events:none;";
        track.appendChild(grid);
      }

      const bar = document.createElement("div");
      bar.className = "bar" + (hasConflict ? " conflict" : "");
      bar.dataset.taskId = t.id;
      bar.style.left = xForDate(s)+"px";
      bar.style.width = widthBetween(s,e)+"px";
      bar.style.background = typeOf(t.color).hex;
      bar.title = t.name + " · " + fmtDateTimeShort(s) + " – " + fmtDateTimeShort(e) + " · " + (t.progress||0) + "% · " + STATUS_META[status].label +
        (t.responsible ? " · Responsável: "+t.responsible : "") +
        (t.components ? " · Componentes: "+t.components : "") +
        (t.deadline ? " · Prazo: "+fmtBRFull(parseDate(t.deadline)) : "");
      bar.addEventListener("click",()=>editTask(t.id));
      const fill = document.createElement("div"); fill.className="fill"; fill.style.width=Math.min(Math.max(t.progress||0,0),100)+"%"; bar.appendChild(fill);
      const label = document.createElement("span"); label.textContent=t.name; bar.appendChild(label);
      track.appendChild(bar); barRefs[t.id]=bar;

      if(today>=start && today<=end){
        const idx = Math.floor((today-start)/86400000);
        const line = document.createElement("div");
        line.className="today-line"; line.style.left=dayLefts[idx]+"px"; line.style.height=ROW_HEIGHT+"px"; track.appendChild(line);
      }
      row.appendChild(track); ganttRoot.appendChild(row);
    });
    drawDependencyArrows(sorted, barRefs);
  }

  function drawDependencyArrows(tasks, barRefs){
    const withDeps = tasks.filter(t=>t.dependency && barRefs[t.dependency] && barRefs[t.id]);
    if(withDeps.length===0) return;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS,"svg");
    svg.setAttribute("class","dep-overlay");
    const rootRect = ganttRoot.getBoundingClientRect();
    svg.setAttribute("width", ganttRoot.scrollWidth);
    svg.setAttribute("height", ganttRoot.scrollHeight);

    const defs = document.createElementNS(svgNS,"defs");
    const marker = document.createElementNS(svgNS,"marker");
    marker.setAttribute("id","arrowhead");
    marker.setAttribute("markerWidth","8");
    marker.setAttribute("markerHeight","8");
    marker.setAttribute("refX","6");
    marker.setAttribute("refY","3");
    marker.setAttribute("orient","auto");
    const arrowPath = document.createElementNS(svgNS,"path");
    arrowPath.setAttribute("d","M0,0 L6,3 L0,6 Z");
    arrowPath.setAttribute("fill","#5b6b76");
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    withDeps.forEach(t=>{
      const fromBar = barRefs[t.dependency];
      const toBar = barRefs[t.id];
      const fromRect = fromBar.getBoundingClientRect();
      const toRect = toBar.getBoundingClientRect();
      const x1 = fromRect.right - rootRect.left;
      const y1 = fromRect.top - rootRect.top + fromRect.height/2;
      const x2 = toRect.left - rootRect.left;
      const y2 = toRect.top - rootRect.top + toRect.height/2;
      const midX = x2 > x1 ? x1 + Math.max(14,(x2-x1)/2) : x1 + 18;
      const laneY = y1 < y2 ? Math.max(y1+12, y2-18) : Math.min(y1-12, y2+18);

      const path = document.createElementNS(svgNS,"path");
      const d = "M "+x1+" "+y1+" L "+midX+" "+y1+" L "+midX+" "+laneY+" L "+(x2-6)+" "+laneY+" L "+(x2-6)+" "+y2;
      path.setAttribute("d", d);
      path.setAttribute("fill","none");
      path.setAttribute("stroke","#5b6b76");
      path.setAttribute("stroke-width","1.5");
      path.setAttribute("stroke-dasharray","4 3");
      path.setAttribute("marker-end","url(#arrowhead)");
      svg.appendChild(path);
    });

    ganttRoot.appendChild(svg);
  }

  /* ---------------- lista de atividades ---------------- */
  function renderList(filteredTasks, chart){
    activitiesBody.innerHTML = "";
    if(chart.tasks.length===0){
      activitiesBody.innerHTML = "<tr><td colspan='8'><div class='table-empty'>Nenhuma atividade ainda. Use o painel à esquerda para cadastrar a primeira.</div></td></tr>";
      return;
    }
    if(filteredTasks.length===0){
      activitiesBody.innerHTML = "<tr><td colspan='8'><div class='table-empty'>Nenhuma atividade encontrada com a busca/filtro atuais.</div></td></tr>";
      return;
    }
    const sorted = [...filteredTasks].sort((a,b)=> parseDateTime(a)-parseDateTime(b));
    sorted.forEach(t=>{
      const status = computeStatus(t);
      const s = parseDateTime(t), e = endDateTime(t);
      const type = typeOf(t.color);
      const tr = document.createElement("tr");
      tr.className = "row-"+status;
      tr.addEventListener("click",()=>editTask(t.id));

      const comps = componentList(t);
      const compsHtml = comps.length ? comps.map(c=>"<span class='chip'>"+escapeHtml(c)+"</span>").join("") : "<span class='muted'>—</span>";

      const deadlineIsCustom = !!t.deadline;
      const deadlineDate = deadlineDateOf(t);
      const deadlineHtml = deadlineIsCustom
        ? "<span class='mono"+(status==="atrasada"?" deadline-late":"")+"'>"+fmtBRFull(deadlineDate)+"</span>"
        : "<span class='mono muted'>fim previsto: "+fmtBR(e)+"</span>";

      tr.innerHTML =
        "<td><div class='cell-title'>"+escapeHtml(t.name)+"</div>"+
          (t.dependency && chart.tasks.find(x=>x.id===t.dependency) ? "<div class='cell-subtitle'>↳ depende de: "+escapeHtml(chart.tasks.find(x=>x.id===t.dependency).name)+"</div>" : "")+
        "</td>"+
        "<td>"+compsHtml+"</td>"+
        "<td><span class='type-badge' style='--type-color:"+type.hex+"'>"+type.label+"</span></td>"+
        "<td>"+(t.responsible ? escapeHtml(t.responsible) : "<span class='muted'>—</span>")+"</td>"+
        "<td><span class='mono'>"+fmtDateTimeShort(s)+" – "+fmtDateTimeShort(e)+"</span></td>"+
        "<td>"+deadlineHtml+"</td>"+
        "<td><div class='progress-cell'><div class='mini-bar'><div class='mini-fill' style='width:"+Math.min(Math.max(t.progress||0,0),100)+"%'></div></div><span>"+(t.progress||0)+"%</span></div></td>"+
        "<td>"+statusBadgeHtml(status)+"</td>";
      activitiesBody.appendChild(tr);
    });
  }

  /* ---------------- orquestração ---------------- */
  function rerender(){
    const chart = activeChart();
    const tasks = chart.tasks;
    renderDashboard(tasks);
    const searchFiltered = tasks.filter(t=>matchesSearch(t, currentSearch));
    renderStatusFilters(searchFiltered);
    const filtered = searchFiltered.filter(t=> currentFilter==="todas" || computeStatus(t)===currentFilter);
    if(viewMode==="gantt"){
      renderGantt(filtered, chart);
    }else{
      renderList(filtered, chart);
      const printTitle = $("#printTitle");
      printTitle.innerHTML = escapeHtml(chart.name) + "<span>Gerado em " + fmtBRFull(new Date()) + "</span>";
      renderPrintDetails(filtered, chart);
    }
  }

  function renderAll(){
    renderTabs();
    rerender();
  }

  /* ---------------- impressão / PDF ---------------- */
  const PRINT_MARGIN_MM = 10; // precisa bater com a margem usada em @page no CSS
  const MM_TO_PX = 96/25.4;

  function pageOrientation(){
    return printOrientationEl ? printOrientationEl.value : "landscape";
  }

  function applyPageSizeStyle(){
    let styleEl = document.getElementById("pageSizeStyle");
    if(!styleEl){
      styleEl = document.createElement("style");
      styleEl.id = "pageSizeStyle";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = "@page{ size: A4 "+pageOrientation()+"; margin: "+PRINT_MARGIN_MM+"mm; }";
  }

  function currentFilteredTasks(chart){
    const searchFiltered = chart.tasks.filter(t=>matchesSearch(t, currentSearch));
    return searchFiltered.filter(t=> currentFilter==="todas" || computeStatus(t)===currentFilter);
  }

  // Redesenha o gráfico do zero com a largura de dia reduzida para caber
  // na folha impressa, em vez de "espremer" visualmente o que já estava
  // desenhado (zoom/transform bagunçava a posição das barras e das setas).
  function preparePrintGantt(){
    applyPageSizeStyle();
    if(viewMode !== "gantt") return;

    const chart = activeChart();
    const filtered = currentFilteredTasks(chart);
    if(filtered.length === 0) return;

    const { start, end } = getRange(filtered);
    const totalDays = Math.round((end-start)/86400000)+1;

    const pageWidthMM = pageOrientation()==="landscape" ? 297 : 210;
    const availablePx = (pageWidthMM - PRINT_MARGIN_MM*2) * MM_TO_PX;
    const availableForDays = availablePx - NAME_COL_WIDTH;

    let printDayWidth = Math.floor(availableForDays / totalDays);
    printDayWidth = Math.max(MIN_PRINT_DAY_WIDTH, Math.min(SCREEN_DAY_WIDTH, printDayWidth));

    BASE_DAY_WIDTH = printDayWidth;
    isPrintRender = true;
    renderGantt(filtered, chart);
  }

  function restoreScreenGantt(){
    if(!isPrintRender) return;
    isPrintRender = false;
    BASE_DAY_WIDTH = SCREEN_DAY_WIDTH;
    rerender();
  }

  window.addEventListener("beforeprint", preparePrintGantt);
  window.addEventListener("afterprint", restoreScreenGantt);
  if(printOrientationEl) printOrientationEl.addEventListener("change", applyPageSizeStyle);

  // não restaura logo após o window.print(): em vários navegadores essa
  // chamada não bloqueia, e reverter cedo demais faria a impressão sair
  // com a versão de tela (larga) em vez da versão ajustada para a folha.
  // O evento "afterprint" cuida de restaurar quando a caixa de diálogo fecha.
  $("#btnPdf").addEventListener("click",()=>{ preparePrintGantt(); window.print(); });

  // init
  loadState();
  renderSwatches();
  resetForm();
  applyPageSizeStyle();
  renderAll();
})();