
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var base = location.origin;
  var me = null;        // { email, role, status, sub }
  var modelsCache = null;

  // ---- same-origin fetch. Cookie auth only — NEVER an Authorization header. ----
  function api(path, opts){
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(base + path, opts).then(function(r){
      return r.text().then(function(t){
        var j=null; try{ j = t ? JSON.parse(t) : null; }catch(e){ j={raw:t}; }
        return { ok:r.ok, status:r.status, body:j };
      });
    });
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function pad2(n){ return (n<10?'0':'')+n; }
  // local time (was UTC via toISOString — showed CST users a -8h skew)
  function fmtDate(ms){ if(!ms) return '–'; try{ var d=new Date(ms); return pad2(d.getMonth()+1)+'-'+pad2(d.getDate())+' '+pad2(d.getHours())+':'+pad2(d.getMinutes()); }catch(e){ return '–'; } }
  function fmtNum(n){ try{ return (n==null?0:n).toLocaleString('en-US'); }catch(e){ return String(n==null?0:n); } }
  // enum → 中文 (UI is Simplified Chinese; backend stores English enums)
  var KIND_ZH={topup:'Top up',charge:'spent',usage:'spent'};
  var ROLE_CN={admin:'Admin',user:'Users'};
  var STATUS_CN={pending:'pending',approved:'approved',blocked:'disabled'};
  function copy(text, el){
    var done=function(){ if(el){ var o=el.textContent; el.textContent='Copied'; setTimeout(function(){ el.textContent=o; },900); } };
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done,done); }
    else { try{ var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); }catch(e){} }
  }
  window.__kpCopy = copy; // bound in inline handlers

  function show(view){
    ['view-landing','view-pending','view-console'].forEach(function(v){ $(v).style.display='none'; });
    $(view).style.display = (view==='view-console') ? 'flex' : 'block';
  }

  // ---------------- models (shared) ----------------
  var modelsErr=false; // distinguish a failed /v1/models fetch from a genuinely empty pool
  var modelsFetchedAt=0; // ms of last successful /v1/models fetch (drives the Updated at hint)
  // owned_by id → Display name (fallback to the raw id)
  var PROVIDER_ZH={gemini:'Google Gemini',openai:'OpenAI',deepseek:'DeepSeek',qwen:'Qwen',glm:'ZhipuGLM',moonshot:'Kimi',mistral:'Mistral',groq:'Groq',openrouter:'OpenRouter'};
  function loadModels(){
    return api('/v1/models').then(function(r){
      if(!r.ok){ modelsErr=true; modelsCache=[]; return []; }
      var list = (r.body && (r.body.data || r.body)) || [];
      if(!Array.isArray(list)) list = [];
      modelsErr=false; modelsCache = list; modelsFetchedAt = Date.now();
      return list;
    }).catch(function(){ modelsErr=true; modelsCache=[]; return []; });
  }
  function renderModelsInto(tbodyId){
    var tb=$(tbodyId); if(!tb) return;
    var list=modelsCache||[];
    if(modelsErr){ tb.innerHTML='<tr><td colspan="2"><span class="e">Load failed</span> · <button class="btn ghost small" id="'+tbodyId+'-retry">Retry</button></td></tr>'; var rb=$(tbodyId+'-retry'); if(rb) rb.onclick=function(){ loadModels().then(function(){ renderModelsInto(tbodyId); }); }; return; }
    if(!list.length){ tb.innerHTML='<tr><td colspan="2" style="color:var(--faint)">No available models yet.</td></tr>'; return; }
    tb.innerHTML = list.map(function(m){
      var d=MODEL_LABELS[m.id];
      var ob=String(m.owned_by||m.ownedBy||'').toLowerCase();
      var src=ob?'<span class="badge">'+esc(PROVIDER_ZH[ob]||m.owned_by||m.ownedBy)+'</span>':'<span style="color:var(--faint)">–</span>';
      return '<tr><td style="font-weight:700" class="mono-token copyable" data-copy="'+esc(m.id)+'" title="click to copy">'+esc(m.id)+(d?'<span style="font-weight:400;color:var(--faint)"> — '+esc(d)+'</span>':'')+'</td><td>'+src+'</td></tr>';
    }).join('');
    bindCopy(tb);
  }

  // ---------------- model leaderboard (consumer) ----------------
  var msRows=null;            // cached /me/model-stats rows
  var msSort='avg_latency';   // current sort key
  var msAsc=true;             // ascending? (latency default asc = fastest first)
  function loadModelStats(){
    var tb=$('modelstats-body'); if(!tb) return;
    tb.innerHTML='<tr><td colspan="7" style="color:var(--faint)">Loading……</td></tr>';
    return api('/me/model-stats').then(function(r){
      if(!r.ok){ tb.innerHTML='<tr><td colspan="7" style="color:var(--red)">Load failed · <button class="btn ghost small" id="ms-retry">Retry</button></td></tr>'; var rb=$('ms-retry'); if(rb) rb.onclick=loadModelStats; return; }
      msRows=Array.isArray(r.body)?r.body:[];
      renderModelStats();
    }).catch(function(){ tb.innerHTML='<tr><td colspan="7" style="color:var(--red)">Network error</td></tr>'; });
  }
  // USD per 1M tokens from micro-USD, trimmed to a compact significant form.
  function mtokUsd(micro){ var v=(micro||0)/1e6; return v>=1?v.toFixed(2):v.toFixed(3); }
  // sort key; price sorts by output price (the dominant cost). Models with no
  // successful sample have meaningless latency/output, so they sink (Infinity in
  // asc, -Infinity in desc) for those columns — but price/rate/n stay comparable.
  function msVal(x,k){
    if(k==='rate') return x.n>0?x.ok/x.n:0;
    if(k==='n') return x.n||0;
    if(k==='price') return x.price_out_micro||0;
    if(x.ok<=0) return msAsc?Infinity:-Infinity; // latency/avg_out undefined without a success
    return x[k]||0;
  }
  function renderModelStats(){
    var tb=$('modelstats-body'); if(!tb) return;
    if(!msRows || !msRows.length){ tb.innerHTML='<tr><td colspan="7" style="color:var(--faint)">No call data in the last 7 days yet.</td></tr>'; return; }
    var rows=msRows.slice().sort(function(a,b){ var d=msVal(a,msSort)-msVal(b,msSort); return msAsc?d:-d; });
    tb.innerHTML=rows.map(function(x){
      var d=MODEL_LABELS[x.model];
      var prov=x.provider?('<span class="badge">'+esc(PROVIDER_ZH[String(x.provider).toLowerCase()]||x.provider)+'</span>'):'<span style="color:var(--faint)">–</span>';
      var rate=x.n>0?Math.round(x.ok/x.n*100):0;
      var ratec=rate>=95?'var(--green)':(rate>=80?'var(--amber)':'var(--red)');
      var hasOk=x.ok>0;
      return '<tr><td style="font-weight:700" class="mono-token copyable" data-copy="'+esc(x.model)+'" title="click to copy">'+esc(x.model)+(d?'<span style="font-weight:400;color:var(--faint)"> — '+esc(d)+'</span>':'')+'</td>'
        +'<td>'+prov+'</td>'
        +'<td class="n">'+(hasOk?fmtNum(Math.round(x.avg_latency))+' ms':'<span style="color:var(--faint)">–</span>')+'</td>'
        +'<td class="n" style="color:'+ratec+'">'+rate+'%</td>'
        +'<td class="n" title="USD price per 1M tokens(incl. discount)">'+mtokUsd(x.price_in_micro)+' / '+mtokUsd(x.price_out_micro)+'</td>'
        +'<td class="n">'+(hasOk?fmtNum(Math.round(x.avg_out)):'<span style="color:var(--faint)">–</span>')+'</td>'
        +'<td class="n">'+fmtNum(x.n)+'</td></tr>';
    }).join('');
    bindCopy(tb);
    // reflect the active sort column + direction in the header arrows
    Array.prototype.forEach.call(document.querySelectorAll('#sec-modelstats .ms-sort'), function(th){
      var k=th.getAttribute('data-sort'); var base=th.textContent.replace(/[ ▲▼]+$/,'');
      th.textContent = base + (k===msSort ? (msAsc?' ▲':' ▼') : '');
      th.style.cursor='pointer';
    });
  }
  function initModelStats(){
    var rf=$('modelstats-refresh'); if(rf) rf.onclick=loadModelStats;
    Array.prototype.forEach.call(document.querySelectorAll('#sec-modelstats .ms-sort'), function(th){
      th.onclick=function(){
        var k=th.getAttribute('data-sort');
        // same column toggles direction; a new column defaults to latency-asc (fastest)
        // or descending for the rest (higher tps/rate/output/calls = better first).
        if(msSort===k){ msAsc=!msAsc; } else { msSort=k; msAsc=(k==='avg_latency'); }
        renderModelStats();
      };
    });
    loadModelStats();
  }

  // ---------------- sidebar nav ----------------
  var NAV = {
    user: [
      {id:'dashboard', label:'Console', color:'red'},
      {id:'chat',      label:'Chat', color:'blue'},
      {id:'tokens',    label:'My tokens', color:'blue'},
      {id:'models',    label:'Model', color:'green'},
      {id:'modelstats',label:'Model ranking', color:'green'},
      {id:'usage',     label:'usage', color:'amber'},
      {id:'balance',   label:'Balance', color:'red'},
      {id:'docs',      label:'Docs', color:'yellow'}
    ],
    admin: [
      {id:'overview',    label:'Overview', color:'green'},
      {id:'debugchat',   label:'Debug chat', color:'blue'},
      {id:'channels',    label:'Channel', color:'yellow'},
      {id:'users',       label:'Users', color:'blue'},
      {id:'admintokens', label:'Token', color:'green'},
      {id:'logs',        label:'Logs', color:'amber'},
      {id:'billing',     label:'Billing', color:'red'},
      {id:'account',     label:'Account', color:'blue'},
      {id:'settings',    label:'Settings', color:'green'},
      {id:'docs',        label:'Docs', color:'amber'}
    ]
  };
  var previewUser=false;
  var navIds=[];
  function buildNav(role){
    var items = NAV[role] || NAV.user;
    navIds = items.map(function(it){ return it.id; });
    $('nav').innerHTML = items.map(function(it){
      return '<a class="navitem c-'+it.color+'" data-sec="'+it.id+'" href="#'+it.id+'"><span class="hd"></span>'+it.label+'</a>';
    }).join('');
    Array.prototype.forEach.call($('nav').querySelectorAll('.navitem'), function(a){
      a.onclick = function(ev){ ev.preventDefault(); var id=a.getAttribute('data-sec'); if(location.hash!=='#'+id) location.hash=id; else selectSection(id); };
    });
    // Honor the URL hash on (re)build; fall back to the first nav item.
    var want = location.hash.replace(/^#/,'');
    selectSection(navIds.indexOf(want)>=0 ? want : items[0].id);
  }
  function selectSection(id){
    if(navIds.indexOf(id)<0) id = navIds[0];
    Array.prototype.forEach.call(document.querySelectorAll('.section'), function(s){ s.classList.remove('active'); });
    var sec=$('sec-'+id); if(sec) sec.classList.add('active');
    Array.prototype.forEach.call($('nav').querySelectorAll('.navitem'), function(a){
      a.classList.toggle('active', a.getAttribute('data-sec')===id);
    });
    if(location.hash!=='#'+id) { try{ history.replaceState(null,'','#'+id); }catch(e){} }
    onSectionEnter(id);
  }
  // Back/forward + manual hash edits switch sections.
  window.addEventListener('hashchange', function(){
    var id=location.hash.replace(/^#/,''); if(id && navIds.indexOf(id)>=0) selectSection(id);
  });
  function onSectionEnter(id){
    if(id==='models' || id==='docs'){
      loadModels().then(function(){ renderModelsInto('models-body'); renderModelsInto('docs-models-body'); fillDocs(); var mu=$('models-updated'); if(mu) mu.textContent=modelsFetchedAt?'Updated at '+fmtDate(modelsFetchedAt):''; });
      var mrf=$('models-refresh'); if(mrf) mrf.onclick=function(){ mrf.disabled=true; loadModels().then(function(){ renderModelsInto('models-body'); var mu=$('models-updated'); if(mu) mu.textContent=modelsFetchedAt?'Updated at '+fmtDate(modelsFetchedAt):''; mrf.disabled=false; }); };
    }
    if(id==='modelstats') initModelStats();
    if(id==='dashboard') loadModels().then(loadDashboard);
    if(id==='tokens'){ var mo=$('my-mint-out'); if(mo){ mo.style.display='none'; mo.innerHTML=''; } loadMyTokens(); }
    if(id==='overview') loadStats('ov');
    if(id==='channels') loadChannels();
    if(id==='settings') loadSettings();
    if(id==='users') loadUsers();
    if(id==='account'){ loadAccount(); var as=$('acc-save'); if(as) as.onclick=saveAccount; var ps=$('pwd-save'); if(ps) ps.onclick=savePassword; }
    if(id==='admintokens') loadAdminTokens();
    if(id==='usage'){ var ur=$('usage-refresh'); if(ur) ur.onclick=loadUserUsage; loadUserUsage(); }
    if(id==='logs'){
      var lr=$('logs-refresh'); if(lr) lr.onclick=loadAdminUsage;
      var rr=$('rank-refresh'); if(rr) rr.onclick=loadAdminRank;
      var su=$('logs-user'); if(su) su.onchange=function(){ logsOwner=su.value; logsPage=0; loadAdminUsage(); };
      var pv=$('logs-prev'); if(pv) pv.onclick=function(){ if(logsPage>0){ logsPage--; loadAdminLogs(); } };
      var nx=$('logs-next'); if(nx) nx.onclick=function(){ logsPage++; loadAdminLogs(); };
      loadAdminUsage();
    }
    if(id==='billing') loadBilling();
    if(id==='balance'){ loadBalance(); loadPayMethods(); }
    if(id==='chat') initChat();
    if(id==='debugchat') initDbgChat();
  }

  // ---------------- chat playgrounds ----------------
  function renderChat(logId, msgs){
    var el=$(logId); if(!el) return;
    if(!msgs.length){ el.innerHTML='<span style="color:var(--faint)">Start chat…</span>'; return; }
    el.innerHTML = msgs.map(function(m){
      var who = m.role==='user'?'You':(m.role==='assistant'?'AI':m.role);
      var col = m.role==='user'?'var(--blue)':'var(--green)';
      var note = m.note ? '<div style="font-size:12px;color:var(--amber);margin-top:2px">⤷ '+esc(m.note)+'</div>' : '';
      var raw = String(m.content==null?'':m.content);
      var body = (m.role==='assistant' && raw==='') ? '<span style="color:var(--faint)">▍…</span>' : esc(raw);
      return '<div style="margin-bottom:11px"><b style="font-family:var(--marker);color:'+col+'">'+who+'</b>'+note
        +'<div style="white-space:pre-wrap;word-break:break-word">'+body+'</div></div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }
  function chatReply(r){
    if(r.ok && r.body && r.body.choices && r.body.choices[0] && r.body.choices[0].message)
      return r.body.choices[0].message.content;
    var e = r.body && (r.body.error && r.body.error.message || r.body.error) || JSON.stringify(r.body);
    return '⚠ [Error '+r.status+'] '+e;
  }
  function bindEnter(inputId, sendFn){
    var el=$(inputId); if(!el||el.__b) return; el.__b=1;
    el.addEventListener('keydown', function(ev){ if(ev.isComposing || ev.keyCode===229) return; if(ev.key==='Enter' && !ev.shiftKey){ ev.preventDefault(); sendFn(); } });
  }
  // streaming chat: append an assistant bubble that fills in as SSE arrives.
  function streamChat(path, payload, logId, msgs, btn){
    var asst={role:'assistant',content:''};
    var usage=null, provider='';
    msgs.push(asst); renderChat(logId, msgs);
    payload.stream=true;
    payload.stream_options={include_usage:true};
    function fail(s,t){
      var j=null; try{j=JSON.parse(t);}catch(e){}
      if(s===402){
        asst.content='insufficient balance,please top up first'; renderChat(logId,msgs);
        var lg=$(logId);
        if(lg){ var bt=document.createElement('button'); bt.className='btn primary small'; bt.textContent='go top up'; bt.style.marginTop='6px'; bt.onclick=function(){ selectSection('balance'); }; lg.appendChild(bt); lg.scrollTop=lg.scrollHeight; }
        if(btn){ btn.disabled=false; btn.textContent='Send'; }
        return;
      }
      asst.content='⚠ [Error '+s+'] '+((j&&j.error&&(j.error.message||j.error))||t||''); renderChat(logId,msgs); if(btn){ btn.disabled=false; btn.textContent='Send'; }
    }
    fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(resp){
      if(!resp.ok || !resp.body){ return resp.text().then(function(t){ fail(resp.status,t); }); }
      // If the gateway fell back to a different model, label the reply honestly.
      if(resp.headers.get('X-KeyPool-Fallback')){
        var actual=resp.headers.get('X-KeyPool-Model')||'';
        if(actual && actual!==(payload.model||'')) asst.note='The selected model is temporarily unavailable.,automatically switched to '+actual;
      }
      provider=resp.headers.get('X-KeyPool-Provider')||'';
      var reader=resp.body.getReader(), dec=new TextDecoder(), buf='';
      (function pump(){
        return reader.read().then(function(res){
          if(res.done){
            if(!asst.content) asst.content='(No content)';
            if(usage){ var ntk=(usage.total_tokens!=null)?usage.total_tokens:((usage.prompt_tokens||0)+(usage.completion_tokens||0)); var un='this round ~'+ntk+' tokens'+(provider?' · '+provider:''); asst.note=asst.note?asst.note+' · '+un:un; }
            renderChat(logId,msgs); refreshChatBalance(); if(btn){ btn.disabled=false; btn.textContent='Send'; } return;
          }
          buf+=dec.decode(res.value,{stream:true});
          var parts=buf.split('\n'); buf=parts.pop();
          parts.forEach(function(line){
            line=line.trim(); if(line.indexOf('data:')!==0) return;
            var data=line.slice(5).trim(); if(!data||data==='[DONE]') return;
            try{ var o=JSON.parse(data); if(o&&o.usage) usage=o.usage; var d=o.choices&&o.choices[0]&&o.choices[0].delta; if(d&&typeof d.content==='string') asst.content+=d.content; }catch(e){}
          });
          renderChat(logId,msgs);
          return pump();
        });
      })();
    }).catch(function(){ asst.content=asst.content||'⚠ Network error'; renderChat(logId,msgs); if(btn){ btn.disabled=false; btn.textContent='Send'; } });
  }
  // consumer chat (billed)
  var chatMsgs=[];
  // Friendly Chinese descriptions so tier-alias model ids (qwen-max etc.) are legible.
  var MODEL_LABELS={
    'mistral-large-latest':'Mistral flagship','mistral-small-latest':'Mistral lightweight','open-mistral-nemo':'Mistral Nemo open source','codestral-latest':'Mistral Code',
    'moonshot-v1-8k':'Kimi 8K Context','moonshot-v1-32k':'Kimi 32K Context','moonshot-v1-128k':'Kimi 128K long text','kimi-k2-0711-preview':'Kimi K2 preview',
    'glm-4-flash':'Zhipu GLM-4 Flash(Free)','glm-4-plus':'Zhipu GLM-4 Plus','glm-4-air':'Zhipu GLM-4 Air','glm-4':'Zhipu GLM-4',
    'qwen-max':'Qwen Max(strongest)','qwen-plus':'Qwen Plus(balanced)','qwen-turbo':'Qwen Turbo(fast/cheap)','qwen2.5-72b-instruct':'Qwen 2.5 72B',
    'gemini-2.0-flash':'Gemini 2.0 Flash','gemini-2.0-flash-lite':'Gemini 2.0 Flash Lite','gemini-1.5-flash':'Gemini 1.5 Flash','gemini-1.5-pro':'Gemini 1.5 Pro',
    'gpt-4o':'OpenAI GPT-4o','gpt-4o-mini':'OpenAI GPT-4o mini','o3-mini':'OpenAI o3-mini',
    'deepseek-chat':'DeepSeek V3 chat','deepseek-reasoner':'DeepSeek R1 reasoning',
    'llama-3.3-70b-versatile':'Llama 3.3 70B (Groq)','llama-3.1-8b-instant':'Llama 3.1 8B (Groq)'
  };
  function modelLabel(id){ var d=MODEL_LABELS[id]; return d ? id+' — '+d : id; }
  function initChat(){
    loadModels().then(function(){
      var sel=$('chat-model'); var b=$('chat-send'); var inp=$('chat-input');
      var none=(modelsCache||[]).length===0;
      if(none){
        if(!chatMsgs.length) renderChat('chat-log', chatMsgs);
        $('chat-log').innerHTML='<span style="color:var(--faint)">// '+(modelsErr?'Failed to load the model list.,try again later':'No available models yet.,try again later')+'</span>';
        if(b) b.disabled=true; if(inp) inp.disabled=true;
        return;
      }
      if(b) b.disabled=false; if(inp) inp.disabled=false;
      if(sel && !sel.options.length){
        var groups={};
        (modelsCache||[]).forEach(function(m){ (groups[m.owned_by]=groups[m.owned_by]||[]).push(m.id); });
        sel.innerHTML = Object.keys(groups).map(function(p){
          return '<optgroup label="'+esc(p)+'">'+groups[p].map(function(id){return '<option value="'+esc(id)+'">'+esc(modelLabel(id))+'</option>';}).join('')+'</optgroup>';
        }).join('');
      }
    });
    var b=$('chat-send'); if(b) b.onclick=sendChat; refreshChatBalance();
    var cl=$('chat-clear'); if(cl) cl.onclick=function(){ chatMsgs=[]; renderChat('chat-log',chatMsgs); };
    bindEnter('chat-input', sendChat);
  }
  function refreshChatBalance(){
    var el=$('chat-bal-usd'); if(!el) return;
    api('/me/balance').then(function(r){
      if(!(r.ok && r.body && r.body.balance_micro!=null)){ el.innerHTML='<span class="e">Read failed</span>'; return; }
      var bal=r.body.balance_micro; el.textContent=usd(bal); el.style.color = bal<=0 ? 'var(--red)' : '';
    }).catch(function(){ el.textContent='–'; });
  }
  function sendChat(){
    var inp=$('chat-input'), txt=inp.value.trim(); if(!txt) return;
    var model=$('chat-model').value; if(!model) return;
    chatMsgs.push({role:'user',content:txt}); inp.value='';
    var btn=$('chat-send'); btn.disabled=true; btn.textContent='Sending……';
    streamChat('/v1/chat/completions', {model:model, messages:chatMsgs.slice()}, 'chat-log', chatMsgs, btn);
  }
  // admin debug chat (channel model, real billing)
  var dbgMsgs=[];
  function initDbgChat(){
    var ms=$('dbg-model'); var b=$('dbg-send');
    loadModels().then(function(){
      if(!ms) return;
      var opts=(modelsCache||[]).filter(function(m){ return (m.owned_by||m.ownedBy)==='channel'; });
      if(!opts.length){ $('dbg-log').innerHTML='<span style="color:var(--faint)">// No enabled channel models yet.,go toChannels to add one</span>'; if(b) b.disabled=true; return; }
      if(b) b.disabled=false;
      ms.innerHTML=opts.map(function(m){ return '<option value="'+esc(m.id)+'">'+esc(modelLabel(m.id))+'</option>'; }).join('');
    });
    if(b) b.onclick=sendDbg;
    var cl=$('dbg-clear'); if(cl) cl.onclick=function(){ dbgMsgs=[]; renderChat('dbg-log',dbgMsgs); };
    bindEnter('dbg-input', sendDbg);
  }
  function sendDbg(){
    var inp=$('dbg-input'), txt=inp.value.trim(); if(!txt) return;
    var model=$('dbg-model').value; if(!model){ $('dbg-log').innerHTML='<span style="color:var(--faint)">Pick a model above first.</span>'; return; }
    var mt=parseInt(($('dbg-maxtok').value||'').trim(),10);
    dbgMsgs.push({role:'user',content:txt}); inp.value='';
    var btn=$('dbg-send'); btn.disabled=true;
    var payload={model:model,messages:dbgMsgs.slice()};
    if(mt>0) payload.max_tokens=mt;
    streamChat('/v1/chat/completions', payload, 'dbg-log', dbgMsgs, btn);
  }

  // ---------------- usage / logs (shared renderers) ----------------
  function pct(ok,n){ return n>0 ? Math.round(ok/n*100)+'%' : '–'; }
  function renderUsage(d, p){
    $(p+'-total').textContent = fmtNum(d.total||0);
    $(p+'-rate').textContent = pct(d.ok||0, d.total||0);
    $(p+'-tokens').textContent = fmtNum(d.tokens||0);
    var rows=(d.byProvider||[]).map(function(x){
      return '<tr><td style="font-weight:700">'+esc(x.provider)+'</td><td class="n">'+fmtNum(x.n)+'</td>'
        +'<td class="n">'+fmtNum(x.ok)+'</td><td class="n">'+Math.round(x.avg_latency||0)+'ms</td>'
        +'<td class="n">'+fmtNum(x.tokens||0)+'</td></tr>';
    }).join('');
    $(p+'-byprov').innerHTML = rows || '<tr><td colspan="5" style="color:var(--faint)">none</td></tr>';
  }
  function renderRecent(rows, tbodyId, showOwner){
    var cols = showOwner ? 7 : 6;
    var html=(rows||[]).map(function(r){
      var t=fmtDate(r.created_at);
      var okc=r.ok?'var(--green)':'var(--red)';
      var owner='';
      if(showOwner){
        // admin view: who sent it. owner_sub NULL = an admin-minted token (no user).
        var who = r.owner_email || r.owner_name || (r.owner_sub ? ('…'+String(r.owner_sub).slice(-6)) : 'Admin token');
        var full = r.owner_email || r.owner_name || r.owner_sub || 'Admin token';
        owner='<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(String(full))+'">'+esc(String(who))+'</td>';
      }
      return '<tr><td style="color:var(--faint)">'+t+'</td>'+owner+'<td>'+esc(r.provider)+'</td>'
        +'<td>'+esc(r.model||'–')+'</td><td style="color:'+okc+'">'+(r.status_code==null?'–':r.status_code)+'</td>'
        +'<td class="n">'+(r.latency_ms==null?'–':r.latency_ms+'ms')+'</td>'
        +'<td class="n">'+(r.total_tokens==null?'–':fmtNum(r.total_tokens))+'</td></tr>';
    }).join('');
    $(tbodyId).innerHTML = html || '<tr><td colspan="'+cols+'" style="color:var(--faint)">none</td></tr>';
  }
  // Inline SVG daily bar chart: last 14 days (byDay is newest-first), drawn
  // oldest->newest, ok in green stacked under failures in the red accent.
  function renderDayChart(containerId, byDay){
    var el=$(containerId); if(!el) return;
    var days=(Array.isArray(byDay)?byDay:[]).slice(0,14).reverse(); // oldest -> newest
    if(!days.length){ el.innerHTML='<div class="hint" style="margin:0">No daily data yet.</div>'; return; }
    var slot=34, bw=22, H=128, base=H-22, top=18;
    var W=days.length*slot+10;
    var max=1; days.forEach(function(d){ var n=d.n||0; if(n>max) max=n; });
    var bars=days.map(function(d,i){
      var n=d.n||0, ok=d.ok||0, fail=n-ok; if(fail<0) fail=0;
      var x=5+i*slot;
      var hN=Math.round((n/max)*(base-top));
      var hFail=Math.round((fail/max)*(base-top));
      var hOk=hN-hFail; if(hOk<0) hOk=0;
      var yTop=base-hN;
      var label=String(d.day||'').slice(5); // MM-DD
      var g='';
      if(hFail>0) g+='<rect x="'+x+'" y="'+yTop+'" width="'+bw+'" height="'+hFail+'" fill="var(--red)" stroke="var(--ink)" stroke-width="1.5" rx="2"/>';
      if(hOk>0) g+='<rect x="'+x+'" y="'+(yTop+hFail)+'" width="'+bw+'" height="'+hOk+'" fill="var(--green)" stroke="var(--ink)" stroke-width="1.5" rx="2"/>';
      if(n>0) g+='<text x="'+(x+bw/2)+'" y="'+(yTop-3)+'" text-anchor="middle" font-size="9" fill="var(--muted)" font-family="ui-monospace,monospace">'+esc(String(n))+'</text>';
      g+='<text x="'+(x+bw/2)+'" y="'+(H-7)+'" text-anchor="middle" font-size="8.5" fill="var(--faint)" font-family="ui-monospace,monospace">'+esc(label)+'</text>';
      return g;
    }).join('');
    var sumN=0, sumOk=0; days.forEach(function(d){ sumN+=(d.n||0); sumOk+=(d.ok||0); });
    var aria='last '+days.length+' days, '+sumN+' requests,success '+sumOk+'';
    // Fixed display height; width derives from the viewBox so a 2-day chart
    // stays small instead of being scaled up to fill the whole card.
    el.innerHTML='<svg role="img" aria-label="'+esc(aria)+'" height="150" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMinYMid meet" style="max-width:100%;display:block">'
      +'<line x1="5" y1="'+base+'" x2="'+(W-5)+'" y2="'+base+'" stroke="var(--ink)" stroke-width="1.5"/>'
      +bars+'</svg>';
  }
  function loadUserUsage(){
    ['u-total','u-rate','u-tokens'].forEach(function(i){ if($(i)) $(i).textContent='…'; });
    // Onboarding CTA fires only when we positively know both usage total and
    // logs are empty (0/0). On any API failure these stay null, so the error
    // states below are never masked by a fake empty state.
    var uTotal=null, uLogs=null;
    function maybeOnboard(){
      if(uTotal!==0 || uLogs!==0) return;
      $('u-byprov').innerHTML='<tr><td colspan="5" style="color:var(--muted);padding:16px 10px;line-height:1.7">No call records yet · go toTokens, create a token and make your first request<br>'
        +'<button class="btn ghost small" id="u-onboard-go" style="margin-top:8px">go create a token</button></td></tr>';
      var go=$('u-onboard-go'); if(go) go.onclick=function(){ selectSection('tokens'); };
    }
    api('/me/usage').then(function(r){
      if(r.ok){ renderUsage(r.body,'u'); renderDayChart('u-chart', r.body&&r.body.byDay); uTotal=(r.body&&r.body.total)||0; maybeOnboard(); return; }
      ['u-total','u-rate','u-tokens'].forEach(function(i){ if($(i)) $(i).textContent='–'; });
      $('u-byprov').innerHTML='<tr><td colspan="5"><span class="e">Load failed</span> · <button class="btn ghost small" id="u-usage-retry">Retry</button></td></tr>';
      var rb=$('u-usage-retry'); if(rb) rb.onclick=loadUserUsage;
    }).catch(function(){ ['u-total','u-rate','u-tokens'].forEach(function(i){ if($(i)) $(i).textContent='–'; }); });
    api('/me/logs').then(function(r){
      if(r.ok){ var lg=Array.isArray(r.body)?r.body:[]; renderRecent(lg, 'u-recent'); uLogs=lg.length; maybeOnboard(); return; }
      $('u-recent').innerHTML='<tr><td colspan="6" style="color:var(--red)">Load failed,click to retry</td></tr>';
      var c=$('u-recent').querySelector('td'); if(c) c.onclick=loadUserUsage;
    });
  }
  // admin logs view state: owner filter (owner_sub, '' = all) + zero-based page.
  var logsOwner='';
  var logsPage=0;
  function fmtUser(o){
    return o.owner_email || o.owner_name || (o.owner_sub ? ('…'+String(o.owner_sub).slice(-6)) : 'Admin token');
  }
  function loadAdminLogs(){
    var q='?page='+logsPage+'&size=50'+(logsOwner?('&owner='+encodeURIComponent(logsOwner)):'');
    return api('/admin/logs'+q).then(function(r){
      if(!r.ok) return;
      var b=r.body||{}; var rows=b.rows||[];
      renderRecent(rows,'l-recent',true);
      var pg=$('logs-page'); if(pg) pg.textContent='Page '+(logsPage+1)+'';
      var pv=$('logs-prev'); if(pv) pv.disabled = logsPage<=0;
      var nx=$('logs-next'); if(nx) nx.disabled = !b.hasMore;
    });
  }
  function loadAdminRank(){
    return api('/admin/usage/by-user').then(function(r){
      if(!r.ok) return;
      var rows=Array.isArray(r.body)?r.body:[];
      var tb=$('l-rank'); if(!tb) return;
      if(!rows.length){ tb.innerHTML='<tr><td colspan="6" style="color:var(--faint)">none</td></tr>'; return; }
      tb.innerHTML=rows.map(function(u,i){
        var rate=u.n>0?Math.round(u.ok/u.n*100)+'%':'–';
        var last=u.last_at?new Date(u.last_at).toISOString().slice(5,16).replace('T',' '):'–';
        var full=u.owner_email||u.owner_name||u.owner_sub||'Admin token';
        return '<tr data-sub="'+esc(String(u.owner_sub||''))+'" style="cursor:pointer">'
          +'<td class="n">'+(i+1)+'</td>'
          +'<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(String(full))+'">'+esc(fmtUser(u))+'</td>'
          +'<td class="n">'+u.n+'</td><td class="n">'+rate+'</td>'
          +'<td class="n">'+(u.tokens||0)+'</td>'
          +'<td style="color:var(--faint)">'+last+'</td></tr>';
      }).join('');
      Array.prototype.forEach.call(tb.querySelectorAll('tr[data-sub]'),function(tr){
        tr.onclick=function(){
          logsOwner=tr.getAttribute('data-sub'); logsPage=0;
          var sel=$('logs-user'); if(sel) sel.value=logsOwner;
          loadAdminUsage();
        };
      });
    });
  }
  function loadAdminUsers(){
    var sel=$('logs-user'); if(!sel||sel.__filled) return;
    api('/admin/users').then(function(r){
      if(!r.ok) return;
      var users=Array.isArray(r.body)?r.body:[];
      var opts='<option value="">All users</option>';
      users.forEach(function(u){
        var label=u.email||u.name||('…'+String(u.sub).slice(-6));
        opts+='<option value="'+esc(String(u.sub))+'">'+esc(label)+'</option>';
      });
      sel.innerHTML=opts; sel.__filled=true; sel.value=logsOwner;
    });
  }
  function loadAdminUsage(){
    var oq=logsOwner?('?owner='+encodeURIComponent(logsOwner)):'';
    api('/admin/usage'+oq).then(function(r){ if(r.ok){ renderUsage(r.body,'l'); renderDayChart('l-chart', r.body&&r.body.byDay); } });
    loadAdminLogs();
    loadAdminRank();
    loadAdminUsers();
  }

  // ---------------- billing / balance (money in micro-USD) ----------------
  function usd(micro){ return ((micro==null?0:micro)/1000000).toFixed(4); }
  function usd2(micro){ return ((micro==null?0:micro)/1000000).toFixed(2); }
  // micro precision (6dp) for the ledger — cheap models charge 1 micro-USD per
  // request, which toFixed(4) would render as a misleading 0.0000.
  function usd6(micro){ return ((micro==null?0:micro)/1000000).toFixed(6); }
  function txnRow(t, withSub){
    var time=fmtDate(t.created_at);
    var amtc=(t.kind==='topup')?'var(--green)':'var(--red)';
    var sign=(t.kind==='topup')?'+':'-';
    var cells='<td style="color:var(--faint)">'+esc(time)+'</td>';
    if(withSub){
      // show WHO consumed (email/name); fall back to the sub suffix; admin-minted = Admin token
      var who = t.owner_email || t.owner_name || (t.sub ? ('…'+String(t.sub).slice(-6)) : 'Admin token');
      var full = t.owner_email || t.owner_name || t.sub || 'Admin token';
      cells+='<td style="max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(String(full))+'">'+esc(String(who))+'</td>';
    }
    cells+='<td>'+esc(KIND_ZH[t.kind]||t.kind)+'</td>'
      +'<td class="n" style="color:'+amtc+'">'+sign+usd6(Math.abs(t.amount_micro))+'</td>'
      +'<td class="n">'+usd6(t.balance_after_micro)+'</td>'
      +'<td>'+esc(t.model||'–')+'</td>'
      +'<td class="n">'+(t.tokens==null?'–':t.tokens)+'</td>'
      +'<td style="color:var(--faint)">'+esc(t.note||'–')+(t.estimated?' <span class="badge" title="upstream did not report usage,estimated at the cap">estimate</span>':'')+'</td>';
    return '<tr>'+cells+'</tr>';
  }

  // ---------------- admin: billing ----------------
  function loadBilling(){
    loadBalances(); loadBillingTxns(); loadPrices(); loadBillTxnsUsers(); loadPayConfig();
    api('/admin/config').then(function(r){ if(!r.ok) return; var b=r.body||{};
      var zhe = b.discount!=null ? (b.discount*10) : 10;
      $('bill-config').innerHTML = '· Billing'+(b.billing_enabled?'<b style="color:var(--green)"> enabled</b>':'<b style="color:var(--red)"> disabled</b>')+' · discount <b>'+zhe+' off</b>(market price×'+(b.discount!=null?b.discount:1)+')';
    });
  }
  function loadBalances(){
    var tb=$('bill-balances-body');
    return api('/admin/balances').then(function(r){
      if(!r.ok){ tb.innerHTML='<tr><td colspan="4" class="e">Error '+r.status+'</td></tr>'; ['bal-sum','bal-users','bal-paid'].forEach(function(i){ if($(i)) $(i).textContent='–'; }); return; }
      var list=Array.isArray(r.body)?r.body:[];
      var bsum=0,bpaid=0; list.forEach(function(b){ var m=b.balance_micro||0; bsum+=m; if(m>0)bpaid++; });
      if($('bal-sum')) $('bal-sum').textContent=usd(bsum);
      if($('bal-users')) $('bal-users').textContent=list.length;
      if($('bal-paid')) $('bal-paid').textContent=bpaid;
      if(!list.length){ tb.innerHTML='<tr><td colspan="4" style="color:var(--faint)">none</td></tr>'; return; }
      tb.innerHTML=list.map(function(b){
        return '<tr><td style="font-weight:700; word-break:break-all">'+esc(b.email||'–')+'</td>'
          +'<td style="font-family:ui-monospace,monospace;font-size:12px">'+esc(String(b.sub||'').slice(0,16))+'</td>'
          +'<td class="n">'+usd(b.balance_micro)+'</td>'
          +'<td><button class="btn ghost small" data-fillsub="'+esc(b.sub)+'">Top up</button></td></tr>';
      }).join('');
      Array.prototype.forEach.call(tb.querySelectorAll('[data-fillsub]'), function(btn){
        btn.onclick=function(){ $('bill-sub').value=btn.getAttribute('data-fillsub'); $('bill-amount').focus(); };
      });
    }).catch(function(){ tb.innerHTML='<tr><td colspan="4" class="e">error</td></tr>'; ['bal-sum','bal-users','bal-paid'].forEach(function(i){ if($(i)) $(i).textContent='–'; }); });
  }
  function loadBillingTxns(){
    var tb=$('bill-txns-body');
    var sel=$('bill-txns-user'); var owner=sel?sel.value:'';
    var q=owner?('?owner='+encodeURIComponent(owner)):'';
    return api('/admin/transactions'+q).then(function(r){
      var list=Array.isArray(r.body)?r.body:[];
      if(!list.length){ tb.innerHTML='<tr><td colspan="8" style="color:var(--faint)">none</td></tr>'; return; }
      tb.innerHTML=list.map(function(t){ return txnRow(t, true); }).join('');
    }).catch(function(){ tb.innerHTML='<tr><td colspan="8" class="e">error</td></tr>'; });
  }
  // populate the Recent transactions user filter once, from the balances list (has email+sub)
  function loadBillTxnsUsers(){
    var sel=$('bill-txns-user'); if(!sel||sel.__filled) return;
    api('/admin/balances').then(function(r){
      if(!r.ok) return;
      var list=Array.isArray(r.body)?r.body:[];
      var opts='<option value="">All users</option>';
      list.forEach(function(b){ if(!b.sub) return; var label=b.email||('…'+String(b.sub).slice(-6)); opts+='<option value="'+esc(String(b.sub))+'">'+esc(label)+'</option>'; });
      sel.innerHTML=opts; sel.__filled=true;
    });
  }
  function topUp(){
    var sub=$('bill-sub').value.trim();
    var amount=parseFloat($('bill-amount').value);
    var note=$('bill-note').value.trim();
    var o=$('bill-topup-out'); o.style.display='block';
    if(!sub || !(amount>0)){ o.innerHTML='<span class="e">Please enter a valid sub and amount.</span>'; return; }
    if(!confirm('confirm as '+sub.slice(0,16)+' Top up '+amount+' USD？')){ o.style.display='none'; return; }
    var btn=$('bill-topup'); btn.disabled=true;
    var payload={amount_usd:amount}; if(note) payload.note=note;
    api('/admin/balances/'+encodeURIComponent(sub)+'/topup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){ btn.disabled=false;
      if(!r.ok){ var msg=(r.body&&r.body.error&&r.body.error.message)||('Error '+r.status); o.innerHTML='<span class="e">'+esc(msg)+'</span>'; return; }
      var bal=(r.body&&r.body.balance_micro);
      o.innerHTML='<span class="k">Top-up successful</span> New balance '+usd(bal)+' USD';
      $('bill-amount').value=''; $('bill-note').value='';
      loadBalances(); loadBillingTxns();
    }).catch(function(){ btn.disabled=false; o.innerHTML='<span class="e">Network error</span>'; });
  }

  // ---------------- admin: model prices ----------------
  function priceUsd(micro){ return ((micro==null?0:micro)/1000000).toFixed(4); }
  function loadPrices(){
    var tb=$('prices-body');
    return api('/admin/prices').then(function(r){
      var list=Array.isArray(r.body)?r.body:((r.body&&r.body.prices)||[]);
      if(!Array.isArray(list)||!list.length){ tb.innerHTML='<tr><td colspan="4" style="color:var(--faint)">none</td></tr>'; return; }
      tb.innerHTML=list.map(function(p){
        var inp=p.input_per_mtok_micro!=null?p.input_per_mtok_micro:p.price_per_mtok_micro;
        var out=p.output_per_mtok_micro!=null?p.output_per_mtok_micro:p.price_per_mtok_micro;
        var cch=p.cached_input_per_mtok_micro;
        return '<tr><td style="font-weight:700" class="mono-token">'+esc(p.model)+'</td>'
          +'<td class="n">'+priceUsd(inp)+'</td>'
          +'<td class="n">'+(cch!=null?priceUsd(cch):'<span class="hint">=input</span>')+'</td>'
          +'<td class="n">'+priceUsd(out)+'</td></tr>';
      }).join('');
    }).catch(function(){ tb.innerHTML='<tr><td colspan="5" class="e">error</td></tr>'; });
  }
  function savePrice(){
    var model=$('price-model').value.trim();
    var inUsd=parseFloat($('price-input').value);
    var outUsd=parseFloat($('price-output').value);
    var cachedRaw=$('price-cached').value.trim();
    var o=$('price-out'); o.style.display='block';
    if(!model || !(inUsd>=0) || !(outUsd>=0)){ o.innerHTML='<span class="e">Please enter the model and a valid price.</span>'; return; }
    var payload={ model:model, input_per_mtok_micro:Math.round(inUsd*1000000), output_per_mtok_micro:Math.round(outUsd*1000000) };
    if(cachedRaw!==''){
      var cachedUsd=parseFloat(cachedRaw);
      if(!(cachedUsd>=0)){ o.innerHTML='<span class="e">Invalid cache-hit price (leave empty to use the input price）</span>'; return; }
      payload.cached_input_per_mtok_micro=Math.round(cachedUsd*1000000);
    }
    var btn=$('price-save'); btn.disabled=true;
    api('/admin/prices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){ btn.disabled=false;
      if(!r.ok){ var msg=(r.body&&r.body.error&&r.body.error.message)||('Error '+r.status); o.innerHTML='<span class="e">'+esc(msg)+'</span>'; return; }
      o.innerHTML='<span class="k">Saved</span> '+esc(model);
      $('price-model').value=''; $('price-input').value=''; $('price-output').value=''; $('price-cached').value='';
      loadPrices();
    }).catch(function(){ btn.disabled=false; o.innerHTML='<span class="e">Network error</span>'; });
  }

  // ---------------- consumer: top-up via EPay ----------------
  function payIcon(key){
    var icons={
      usdt:'<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><circle cx="24" cy="24" r="23" fill="#26A17B"/><text x="24" y="34" font-size="24" text-anchor="middle" fill="#fff" font-weight="bold" font-family="Arial,Helvetica,sans-serif">₮</text></svg>',
      stripe:'<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><rect x="2" y="2" width="44" height="44" rx="11" fill="#635BFF"/><text x="24" y="29" font-size="14" text-anchor="middle" fill="#fff" font-style="italic" font-weight="bold" font-family="Arial,Helvetica,sans-serif">stripe</text></svg>',
      paypal:'<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><rect x="2" y="2" width="44" height="44" rx="11" fill="#003087"/><text x="15" y="32" font-size="22" text-anchor="middle" fill="#fff" font-weight="bold" font-family="Arial,Helvetica,sans-serif">P</text><text x="27" y="32" font-size="22" text-anchor="middle" fill="#9BC4F2" font-weight="bold" font-family="Arial,Helvetica,sans-serif">P</text></svg>',
      wechat:'<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><circle cx="24" cy="24" r="23" fill="#07C160"/><path d="M12 19.4C12 14.3 17.4 10 24 10s12 4.3 12 9.4S30.6 28.8 24 28.8c-1.3 0-2.6-.2-3.8-.5l-4.7 2.5 1.2-3.6C14.2 25.5 12 22.6 12 19.4z" fill="#fff"/><circle cx="18.6" cy="19.5" r="1.7" fill="#07C160"/><circle cx="25.4" cy="19.5" r="1.7" fill="#07C160"/><circle cx="29.4" cy="19.5" r="1.7" fill="#fff"/></svg>',
      alipay:'<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><circle cx="24" cy="24" r="23" fill="#1677FF"/><text x="24" y="34" font-size="23" text-anchor="middle" fill="#fff" font-weight="bold" font-family="Arial,Helvetica,sans-serif">支</text></svg>',
      dcpay:'<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><circle cx="24" cy="24" r="23" fill="#C8102E"/><text x="24" y="30" font-size="13.5" text-anchor="middle" fill="#fff" font-weight="bold" font-family="Arial,Helvetica,sans-serif">e-CNY</text></svg>'
    };
    return icons[key]||'';
  }
  function loadPayMethods(){
    var box=$('bal-topup-methods');
    api('/me/pay-methods').then(function(r){
      if(!r.ok || !r.body || !r.body.enabled){ box.innerHTML='<span class="e">Payments are not configured; contact an admin.</span>'; return; }
      var ms=r.body.methods||[];
      if(!ms.length){ box.innerHTML='<span class="e">No payment methods available.</span>'; return; }
      var sel=$('bal-topup-method'); if(!sel) return;
      box.innerHTML='';
      for(var i=0;i<ms.length;i++){
        (function(m){
          var b=document.createElement('button');
          b.className='pay-method-btn';
          b.type='button';
          b.title=m.label;
          b.setAttribute('aria-label',m.label);
          b.innerHTML=payIcon(m.key);
          b.onclick=function(){
            var bs=box.querySelectorAll('.pay-method-btn');
            for(var j=0;j<bs.length;j++) bs[j].classList.remove('on');
            b.classList.add('on');
            sel.value=m.key;
            var o=$('bal-topup-out'); if(o){ o.style.display='none'; }
          };
          box.appendChild(b);
        })(ms[i]);
      }
    }).catch(function(){ box.innerHTML='<span class="e">Failed to load payment methods.</span>'; });
  }
  function checkout(){
    var amount=parseFloat($('bal-topup-amount').value);
    var method=$('bal-topup-method').value;
    var o=$('bal-topup-out'); o.style.display='block';
    if(!(amount>0)){ o.innerHTML='<span class="e">Please enter a valid amount.</span>'; return; }
    if(amount<1){ o.innerHTML='<span class="e">lowest 1 USD</span>'; return; }
    if(!method){ o.innerHTML='<span class="e">Please choose a payment method.</span>'; return; }
    var btn=$('bal-topup-btn'); btn.disabled=true;
    api('/me/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amount_usd:amount, method:method})})
    .then(function(r){ btn.disabled=false;
      if(r.status===503){ o.innerHTML='<span class="e">Payments not configured</span>'; return; }
      if(r.ok && r.body && r.body.url){ location.href=r.body.url; return; }
      var msg=(r.body&&r.body.error&&r.body.error.message)||('Error '+r.status); o.innerHTML='<span class="e">'+esc(msg)+'</span>';
    }).catch(function(){ btn.disabled=false; o.innerHTML='<span class="e">Network error</span>'; });
  }
  // ---------------- admin: payment gateway config ----------------
  function loadPayConfig(){
    api('/admin/pay-config').then(function(r){
      if(!r.ok || !r.body) return;
      var b=r.body;
      $('pay-api-url').value=b.api_url||'';
      $('pay-pid').value=b.pid||'';
      var keyEl=$('pay-key');
      keyEl.value='';
      keyEl.placeholder=b.configured ? ('Saved（'+b.key+'），Leave empty to keep unchanged; enter a new value to replace it.') : 'Merchant key';
      var chs=document.querySelectorAll('#sec-billing input[data-method]');
      for(var i=0;i<chs.length;i++){
        chs[i].checked=(b.methods||[]).indexOf(chs[i].getAttribute('data-method'))>=0;
      }
    }).catch(function(){});
  }
  function savePayConfig(){
    var apiUrl=$('pay-api-url').value.trim();
    var pid=$('pay-pid').value.trim();
    var key=$('pay-key').value.trim() || '••••';
    var o=$('pay-config-out'); o.style.display='block';
    if(!apiUrl || !pid){ o.innerHTML='<span class="e">Base URL and merchant ID are required.</span>'; return; }
    var methods=[]; var methodTypes={};
    var chs=document.querySelectorAll('#sec-billing input[data-method]');
    for(var i=0;i<chs.length;i++){
      if(chs[i].checked) methods.push(chs[i].getAttribute('data-method'));
    }
    var btn=$('pay-config-save'); btn.disabled=true;
    api('/admin/pay-config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({api_url:apiUrl,pid:pid,key:key,methods:methods,method_types:{}})})
    .then(function(r){ btn.disabled=false;
      if(!r.ok){ var msg=(r.body&&r.body.error&&r.body.error.message)||('Error '+r.status); o.innerHTML='<span class="e">'+esc(msg)+'</span>'; return; }
      o.innerHTML='<span class="k">Saved</span> Payment gateway settings saved.';
      loadPayConfig();
    }).catch(function(){ btn.disabled=false; o.innerHTML='<span class="e">Network error</span>'; });
  }

  // ---------------- consumer: balance ----------------
  function loadBalance(){
    var rb=$('bal-refresh'); if(rb){ rb.disabled=true; rb.textContent='Refreshing……'; }
    var done=0; function fin(){ if(++done>=2 && rb){ rb.disabled=false; rb.textContent='Refresh'; } }
    // handle Stripe return query params, then strip them so a refresh doesn't re-show the banner
    if(/[?&]topup=success(?:&|$)/.test(location.search)){
      var h=$('bal-topup-success'); if(h) h.style.display='block';
      history.replaceState(null,'',location.pathname+location.hash);
      pollBalance(5); // async webhook may credit a few seconds after redirect
    } else if(/[?&]topup=cancel(?:&|$)/.test(location.search)){
      var oc=$('bal-topup-out'); if(oc){ oc.style.display='block'; oc.innerHTML='<span class="hint">Top-up cancelled.</span>'; }
      history.replaceState(null,'',location.pathname+location.hash);
    }
    api('/me/balance').then(function(r){
      // distinguish a failed read from a genuine zero balance — never show fake 0.00
      if(!(r.ok && r.body && r.body.balance_micro!=null)){ $('bal-usd').innerHTML='<span class="e">Read failed</span>'; fin(); return; }
      var bal=r.body.balance_micro;
      $('bal-usd').textContent = usd2(bal);
      $('bal-usd').style.color = bal<=0 ? 'var(--red)' : '';
      fin();
    }).catch(function(){ $('bal-usd').textContent='–'; fin(); });
    var tb=$('bal-txns-body');
    api('/me/transactions').then(function(r){
      var list=Array.isArray(r.body)?r.body:[];
      if(!list.length){ tb.innerHTML='<tr><td colspan="7" style="color:var(--faint)">none</td></tr>'; fin(); return; }
      tb.innerHTML=list.map(function(t){ return txnRow(t, false); }).join('');
      fin();
    }).catch(function(){ tb.innerHTML='<tr><td colspan="7" class="e">error</td></tr>'; fin(); });
  }
  // short-poll balance after a Stripe success so async webhook credit reflects without a manual refresh
  function pollBalance(left){
    if(left<=0) return;
    setTimeout(function(){
      api('/me/balance').then(function(r){
        if(r.ok && r.body && r.body.balance_micro!=null){
          var bal=r.body.balance_micro;
          $('bal-usd').textContent = usd2(bal);
          $('bal-usd').style.color = bal<=0 ? 'var(--red)' : '';
        }
        pollBalance(left-1);
      }).catch(function(){ pollBalance(left-1); });
    }, 3000);
  }

  // ---------------- admin: per-key list ----------------
  // Scale-safe probe all: the backend probes the pool in rotating batches (~48/
  // call, Worker subrequest cap). The button marks the whole pool due (?all=1),
  // then drains batches while showing progress. It's non-blocking — closing the
  // page is fine, the external pinger/cron keeps draining in the background.
  var keylistSweeping = false;
  function renderSweepProgress(done, total){
    var out=$('keylist-checkall-out'); if(!out) return;
    var pct = total>0 ? Math.min(100, Math.round(done*100/total)) : 0;
    var W=24, fill=Math.round(pct*W/100);
    var bar='['+Array(fill+1).join('█')+Array(W-fill+1).join('·')+']';
    out.innerHTML='Probing… '+bar+' '+done+' / '+total+'(you may close the page,continues in background)';
  }
  function checkAllKeys(){
    var btn=$('keylist-checkall'), out=$('keylist-checkall-out');
    if(keylistSweeping){ keylistSweeping=false; if(btn) btn.textContent='probe all'; return; }
    keylistSweeping=true; if(btn) btn.textContent='stop probing';
    if(out) out.textContent='mark all as pending probe…';
    var total=0, lastDue=-1, stall=0, batches=0;
    function drain(markAll){
      if(!keylistSweeping) return Promise.resolve();
      return api('/admin/sweep'+(markAll?'?all=1':''),{method:'POST'}).then(function(r){
        var b=r.body||{}; total=b.total||total;
        var due=(b.due==null?0:b.due); renderSweepProgress(Math.max(0,total-due), total);
        batches++; if(batches%5===0) loadKeyList();           // periodic list refresh
        if(due===lastDue){ if(++stall>=2) return; } else { stall=0; lastDue=due; }
        if(due>0 && keylistSweeping){
          return new Promise(function(res){ setTimeout(res,300); }).then(function(){ return drain(false); });
        }
      });
    }
    drain(true).then(function(){
      keylistSweeping=false; if(btn) btn.textContent='probe all';
      if(out) out.textContent='all probed '+(total||'')+' keys,see the status below';
      loadKeyList();
    }).catch(function(){
      keylistSweeping=false; if(btn) btn.textContent='probe all';
      if(out) out.textContent='error(background rotation continues)'; loadKeyList();
    });
  }
  var keylistShowDisabled = false;
  function loadKeyList(){
    var tb=$('keylist-body');
    tb.innerHTML='<tr><td colspan="7" style="color:var(--faint)">Loading……</td></tr>';
    return api('/admin/keys/list').then(function(r){
      var all=(r.body && r.body.keys) || [];
      var sm=$('keylist-summary');
      if(sm){
        var cD=0,cC=0,cW=0,cA=0;
        all.forEach(function(k){
          if(k.status==='disabled') cD++;
          else if(k.status==='cooldown') cC++;
          else if(k.last_error) cW++;
          else cA++;
        });
        sm.innerHTML = all.length
          ? ('total '+all.length+' · available '+cA+' · cooldown '+cC+' · disabled '+cD+(cW?' · error '+cW:''))
          : 'Pool is empty';
      }
      var disN = all.filter(function(k){return k.status==='disabled';}).length;
      var tg=$('keylist-toggle'); if(tg) tg.textContent = keylistShowDisabled ? 'enabled only' : ('show disabled('+disN+')');
      var keys = keylistShowDisabled ? all : all.filter(function(k){return k.status!=='disabled';});
      if(!all.length){ tb.innerHTML='<tr><td colspan="7" style="color:var(--faint)">Not yet key</td></tr>'; return; }
      if(!keys.length){ tb.innerHTML='<tr><td colspan="7" style="color:var(--faint)">All disabled · clickShow disabled to view</td></tr>'; return; }
      tb.innerHTML = keys.map(function(k){
        // active + a lingering last_error = valid key that's currently failing
        // (e.g. throttled gemini) — show amber 'warn', not a misleading green.
        var sd = k.status==='disabled' ? 'd-disabled'
               : k.status==='cooldown' ? 'd-cooldown'
               : k.last_error ? 'd-warn'
               : 'd-active';
        var reason = (k.status==='disabled' && k.disabled_reason) ? k.disabled_reason : k.last_error;
        var err = reason ? esc(String(reason).slice(0,60)) : '';
        var sLabel = sd==='d-disabled'?'disabled':sd==='d-cooldown'?'cooling down':sd==='d-warn'?'error(still in use)':'available';
        var toggle = (k.status==='active')
          ? '<button class="btn ghost small kl-disable">disabled</button>'
          : '<button class="btn ghost small kl-enable">Enable</button>';
        // gemini keys carry a Google project id (parsed on probe); show a short
        // 'proj …<last4>' badge so the operator can spot keys sharing a project.
        var proj = k.project_id
          ? ' <span class="badge" style="background:var(--cream);border-color:#cfcbbd;color:var(--faint);font-size:9.5px;padding:0 6px" title="project '+esc(String(k.project_id))+'">proj …'+esc(String(k.project_id).slice(-4))+'</span>'
          : '';
        // per-key health surfacing: consecutive-fail streak, cooldown deadline, last-used.
        var cf = (k.consecutive_fails>0) ? ' <span style="color:var(--red)">(losing streak '+k.consecutive_fails+'/3)</span>' : '';
        var cool = (k.status==='cooldown' && k.cooldown_until) ? ('cooldown until '+fmtDate(k.cooldown_until)) : '';
        var luTitle = 'Recently used '+(k.last_used_at ? fmtDate(k.last_used_at) : 'never used');
        // Stored upstream balance (openrouter/deepseek expose one) — show on load
        // so operators don't have to click probe for each. probe refreshes it live.
        var balStr = (k.balance_remaining!=null)
          ? 'left '+(Math.round(k.balance_remaining*100)/100)+' '+(k.balance_unit||'') : '';
        return '<tr data-id="'+k.id+'">'
          +'<td><span class="dot '+sd+'" title="'+sLabel+'"></span>'+esc(k.provider)+proj+'</td>'
          +'<td style="font-family:ui-monospace,monospace;font-size:12.5px;white-space:nowrap">'+esc(k.masked)+' <button class="btn ghost small kl-copy" title="copy full key">Copy</button></td>'
          +'<td class="n">'+k.total_requests+' / '+k.total_fails+cf+'</td>'
          +'<td class="kl-err" style="max-width:180px;color:var(--faint);font-size:12px;overflow:hidden;text-overflow:ellipsis"'+((cool||reason)?' title="'+esc(cool||String(reason))+'"':'')+'>'+(cool?'<span style="color:var(--amber)">'+esc(cool)+'</span>':err)+'</td>'
          +'<td class="kl-result" style="font-size:12.5px;white-space:nowrap">'+(balStr?'<span style="color:var(--faint)" title="last probe balance">'+esc(balStr)+'</span>':'')+'</td>'
          +'<td style="color:var(--faint);font-size:12px;white-space:nowrap" title="'+esc((k.created_at?'Added on '+new Date(k.created_at).toLocaleString()+' · ':'')+luTitle)+'">'+(k.created_at?fmtDate(k.created_at):'–')+'</td>'
          +'<td style="white-space:nowrap"><button class="btn ghost small kl-check">probe</button> '+toggle+' <button class="btn ghost small kl-del">Del</button></td>'
          +'</tr>';
      }).join('');
      Array.prototype.forEach.call(tb.querySelectorAll('tr[data-id]'), function(tr){
        var id=tr.getAttribute('data-id');
        var res=tr.querySelector('.kl-result');
        var chk=tr.querySelector('.kl-check');
        if(chk) chk.onclick=function(){
          chk.disabled=true; res.textContent='probe…';
          api('/admin/keys/'+id+'/check',{method:'POST'}).then(function(r){
            chk.disabled=false; var b=r.body||{};
            var dot=tr.querySelector('.dot');
            var ec=tr.querySelector('.kl-err');
            if(b.alive){
              var bal = (b.balance && b.balance.remaining!=null)
                ? ' · left '+(Math.round(b.balance.remaining*100)/100)+' '+b.balance.unit : '';
              res.innerHTML='<span style="color:var(--green)">available'+(b.rateLimited?'(rate limit)':'')+'</span>'+bal;
              // a passing check reactivates the key server-side (unless rate-limited).
              // reflect that on THIS row in place — never reload the whole table, which
              // would wipe other rows' in-progress probe results.
              if(dot){
                if(b.rateLimited){ dot.className='dot d-warn'; dot.title='error(still in use)'; }
                else { dot.className='dot d-active'; dot.title='available'; if(ec){ ec.textContent=''; ec.removeAttribute('title'); } }
              }
            } else { res.innerHTML='<span style="color:var(--red)">unavailable '+(b.status||'')+'</span>'; }
          }).catch(function(){ chk.disabled=false; res.innerHTML='<span style="color:var(--red)">error</span>'; });
        };
        var cp=tr.querySelector('.kl-copy'); if(cp) cp.onclick=function(){ cp.disabled=true; var o=cp.textContent; api('/admin/keys/'+id+'/reveal').then(function(r){ cp.disabled=false; if(r.ok && r.body && r.body.api_key){ copy(r.body.api_key, cp); } else { cp.textContent='failed'; setTimeout(function(){cp.textContent=o;},900); } }).catch(function(){ cp.disabled=false; cp.textContent='failed'; setTimeout(function(){cp.textContent=o;},900); }); };
        var en=tr.querySelector('.kl-enable'); if(en) en.onclick=function(){ api('/admin/keys/'+id+'/enable',{method:'POST'}).then(loadKeyList); };
        var dis=tr.querySelector('.kl-disable'); if(dis) dis.onclick=function(){ api('/admin/keys/'+id+'/disable',{method:'POST'}).then(loadKeyList); };
        var del=tr.querySelector('.kl-del'); if(del) del.onclick=function(){ if(confirm('delete this key?cannot be undone')) api('/admin/keys/'+id,{method:'DELETE'}).then(loadKeyList); };
      });
    }).catch(function(){
      tb.innerHTML='<tr><td colspan="7" style="color:var(--red)">Load failed · <button class="btn ghost small" id="keylist-retry">Retry</button></td></tr>';
      var rb=$('keylist-retry'); if(rb) rb.onclick=loadKeyList;
      var sm=$('keylist-summary'); if(sm) sm.innerHTML='';
    });
  }

  // ---------------- consumer: dashboard ----------------
  function loadDashboard(){
    $('dash-greet').textContent = '// Welcome back, ' + (me.email||'');
    var ep = 'POST ' + base + '/v1/chat/completions';
    var es=$('dash-endpoint'); es.textContent = ep; es.setAttribute('data-copy', ep); bindCopy(es.parentNode);
    var cc=$('dash-curl-copy'); if(cc) cc.onclick = function(){ copy($('dash-curl').textContent, cc); };
    var tu=$('dash-topup'); if(tu) tu.onclick = function(){ selectSection('balance'); };
    loadDashTokens();
    loadDashStats();
  }
  function loadDashTokens(){
    var area=$('dash-token-area');
    area.innerHTML = '<div class="hint" style="color:var(--faint)">Loading tokens……</div>';
    api('/me/tokens').then(function(r){
      if(!r.ok){
        area.innerHTML = '<span class="e">Failed to load tokens.</span> · <button class="btn ghost small" id="dash-tok-retry">Retry</button>';
        var rb=$('dash-tok-retry'); if(rb) rb.onclick=loadDashTokens;
        $('dash-curl').innerHTML = curlSnippet(null); return;
      }
      var list = Array.isArray(r.body)? r.body : [];
      var enabled = list.filter(function(t){ return t.enabled; });
      var tok = enabled.length ? enabled[0].token : null;
      if(tok){
        area.innerHTML = '<label>Your tokens</label>'
          + '<div class="endpoint"><span class="mono-token copyable" data-copy="'+esc(tok)+'">'+esc(tok)+'</span></div>'
          + '<div class="hint">Click to copy. More tokens atMy Tokens.</div>';
        bindCopy(area);
      } else if(me.status!=='approved'){
        area.innerHTML = '<div class="hint">Account pending approval; contact an admin.</div>';
      } else {
        area.innerHTML = '<button class="btn primary" id="dash-first">Generate my first token</button>'
          + '<div class="hint">No tokens yet. Generate one to start calling the API.。</div>';
        $('dash-first').onclick = function(){ selectSection('tokens'); };
      }
      $('dash-curl').innerHTML = curlSnippet(tok);
    }).catch(function(){
      area.innerHTML = '<span class="e">Network error</span> · <button class="btn ghost small" id="dash-tok-retry">Retry</button>';
      var rb=$('dash-tok-retry'); if(rb) rb.onclick=loadDashTokens;
      $('dash-curl').innerHTML = curlSnippet(null);
    });
  }
  function loadDashStats(){
    var bn=$('dash-balance'), bh=$('dash-bal-hint');
    bn.textContent='…'; if(bh) bh.style.display='none';
    api('/me/balance').then(function(r){
      // distinguish a failed read from a genuine zero balance — never show fake 0.0000
      if(!(r.ok && r.body && r.body.balance_micro!=null)){ bn.innerHTML='<span class="e">Read failed</span>'; return; }
      var bal=r.body.balance_micro;
      bn.textContent = usd(bal);
      if(bh) bh.style.display = bal<=0 ? 'block' : 'none';
    }).catch(function(){ bn.textContent='–'; });
    var rq=$('dash-req'), tk=$('dash-tok');
    rq.textContent='…'; tk.textContent='…';
    api('/me/usage').then(function(r){
      if(!(r.ok && r.body)){ rq.textContent='–'; tk.textContent='–'; return; }
      rq.textContent = fmtNum(r.body.total||0);
      tk.textContent = fmtNum(r.body.tokens||0);
    }).catch(function(){ rq.textContent='–'; tk.textContent='–'; });
  }
  function curlSnippet(tok){
    var key = tok || '$KEY';
    var model = (modelsCache && modelsCache[0] && modelsCache[0].id) || 'gemini-2.0-flash';
    return 'curl ' + base + '/v1/chat/completions \\\n'
      + '  -H "Authorization: Bearer ' + esc(key) + '" \\\n'
      + '  -H "Content-Type: application/json" \\\n'
      + '  -d \'{"model":"' + esc(model) + '","messages":[{"role":"user","content":"hello"}]}\'';
  }

  function bindCopy(scope){
    Array.prototype.forEach.call((scope||document).querySelectorAll('.copyable'), function(el){
      if(el.__bound) return; el.__bound=true;
      el.onclick = function(){ copy(el.getAttribute('data-copy'), el); };
    });
  }

  // ---------------- consumer: my tokens ----------------
  function loadMyTokens(){
    var tb=$('my-token-list');
    if(tb) tb.innerHTML='<tr><td colspan="9" style="color:var(--faint)">Loading……</td></tr>';
    return api('/me/tokens').then(function(r){
      if(!r.ok){ tb.innerHTML='<tr><td colspan="9" style="color:var(--red)">Load failed · '+esc((r.body&&r.body.error&&r.body.error.message)||('Error '+r.status))+' <button class="btn ghost small" id="my-tokens-retry">Retry</button></td></tr>'; var rb=$('my-tokens-retry'); if(rb) rb.onclick=loadMyTokens; return; }
      var list = Array.isArray(r.body)? r.body : [];
      if(!list.length){ tb.innerHTML='<tr><td colspan="9" style="color:var(--faint)">No tokens yet.</td></tr>'; return; }
      tb.innerHTML = list.map(function(t){
        var expired = t.expires_at!=null && Date.now()>t.expires_at;
        return '<tr><td>'+t.id+'</td>'
          + '<td style="font-weight:700">'+esc(t.name||'–')+'</td>'
          + '<td><span class="mono-token copyable" data-copy="'+esc(t.token)+'">'+esc(t.token)+'</span></td>'
          + '<td>'+(expired?'<span class="dot d-disabled"></span><span style="color:var(--red)">expired</span>':'<span class="dot '+(t.enabled?'d-active':'d-disabled')+'"></span>'+(t.enabled?'Enable':'Disable'))+'</td>'
          + '<td class="n">'+t.used_requests+'/'+(t.quota_requests==null?'∞':t.quota_requests)+'</td>'
          + '<td class="n">'+(t.rpm_limit==null?'∞':t.rpm_limit+'/min')+'</td>'
          + '<td style="color:var(--faint)">'+(t.expires_at==null?'permanent':(expired?'<span style="color:var(--red)">expired</span>':fmtDate(t.expires_at)))+'</td>'
          + '<td style="color:var(--faint)">'+fmtDate(t.created_at)+'</td>'
          + '<td><button class="btn ghost small" data-del="'+t.id+'">Delete</button></td></tr>';
      }).join('');
      bindCopy(tb);
      Array.prototype.forEach.call(tb.querySelectorAll('[data-del]'), function(b){
        b.onclick = function(){
          if(!confirm('Delete this token? This cannot be undone.。')) return;
          b.disabled=true;
          api('/me/tokens/'+b.getAttribute('data-del'),{method:'DELETE'}).then(function(r){ if(!r.ok){ b.disabled=false; return; } loadMyTokens(); }).catch(function(){ b.disabled=false; });
        };
      });
    }).catch(function(){ if(tb) tb.innerHTML='<tr><td colspan="9" style="color:var(--red)">Network error</td></tr>'; });
  }
  function mintMy(){
    var name=$('my-tname').value.trim();
    var btn=$('my-mint'); btn.disabled=true; btn.textContent='Generating……';
    api('/me/tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name})})
    .then(function(r){ btn.disabled=false; btn.textContent='Generate token'; var o=$('my-mint-out'); o.style.display='block';
      if(!r.ok){
        var msg=(r.body&&r.body.error&&r.body.error.message)||('Error '+r.status);
        o.innerHTML='<span class="e">'+esc(msg)+'</span>'; return;
      }
      o.innerHTML='New token(Copy now): <span class="k mono-token copyable" data-copy="'+esc(r.body.token)+'">'+esc(r.body.token)+'</span> <button class="btn ghost small" id="my-mint-close">I have copied it · Close</button>';
      bindCopy(o); var cb=$('my-mint-close'); if(cb) cb.onclick=function(){ o.style.display='none'; o.innerHTML=''; }; $('my-tname').value=''; loadMyTokens();
    }).catch(function(){ btn.disabled=false; btn.textContent='Generate token'; });
  }

  // ---------------- docs (shared, static from models) ----------------
  function fillDocs(){
    var model = (modelsCache && modelsCache[0] && modelsCache[0].id) || 'gemini-2.0-flash';
    function setEp(id, val){ var el=$(id); if(!el) return; el.textContent=val; el.setAttribute('data-copy', val); }
    setEp('docs-endpoint', 'POST ' + base + '/v1/chat/completions');
    setEp('docs-baseurl', base + '/v1');
    setEp('docs-models-ep', base + '/v1/models');
    setEp('docs-anthropic-ep', base + '/v1/messages');

    var curlRaw = 'curl ' + base + '/v1/chat/completions \\\n'
      + '  -H "Authorization: Bearer <Your tokens>" \\\n'
      + '  -H "Content-Type: application/json" \\\n'
      + '  -d \'{"model":"' + model + '","messages":[{"role":"user","content":"hello"}]}\'';
    $('docs-curl').innerHTML = esc(curlRaw);

    var reqRaw = '{\n'
      + '  "model": "' + model + '",\n'
      + '  "messages": [{"role":"user","content":"hello"}],\n'
      + '  "stream": false,\n'
      + '  "fallback": true\n'
      + '}';
    if($('docs-reqbody')) $('docs-reqbody').innerHTML = esc(reqRaw);

    var sdkRaw = 'from openai import OpenAI\n'
      + 'client = OpenAI(\n'
      + '    base_url="' + base + '/v1",\n'
      + '    api_key="<Your tokens>",\n'
      + ')\n'
      + 'resp = client.chat.completions.create(\n'
      + '    model="' + model + '",\n'
      + '    messages=[{"role":"user","content":"hello"}],\n'
      + ')\n'
      + 'print(resp.choices[0].message.content)';
    $('docs-sdk').innerHTML = esc(sdkRaw);

    var anthRaw = 'curl ' + base + '/v1/messages \\\n'
      + '  -H "x-api-key: <Your tokens>" \\\n'
      + '  -H "anthropic-version: 2023-06-01" \\\n'
      + '  -H "Content-Type: application/json" \\\n'
      + '  -d \'{"model":"' + model + '","max_tokens":1024,"messages":[{"role":"user","content":"hello"}]}\'';
    if($('docs-anthropic')) $('docs-anthropic').innerHTML = esc(anthRaw);

    function bindBtn(id, raw){ var b=$(id); if(b) b.onclick=function(){ copy(raw, this); }; }
    bindBtn('docs-curl-copy', curlRaw);
    bindBtn('docs-reqbody-copy', reqRaw);
    bindBtn('docs-sdk-copy', sdkRaw);
    bindBtn('docs-anthropic-copy', anthRaw);

    bindCopy($('sec-docs'));
  }

  // ---------------- admin: stats (overview + keys) ----------------
  function renderStats(s, tbodyId){
    var t=(s&&s.totals)||{active:0,cooldown:0,disabled:0};
    if($('t-active')){ $('t-active').textContent=t.active; $('t-cooldown').textContent=t.cooldown; $('t-disabled').textContent=t.disabled; }
    var total=(t.active||0)+(t.cooldown||0)+(t.disabled||0);
    // overview-only: one-line health verdict + Updated at stamp in the Pool status card header
    if(tbodyId==='ov-byprovider'){
      var vd=$('ov-verdict');
      if(vd){
        if(total===0) vd.innerHTML='<span class="dot d-disabled"></span>Pool is empty';
        else if((t.cooldown||0)+(t.disabled||0)===0) vd.innerHTML='<span class="dot d-active"></span>All available';
        else vd.innerHTML='<span class="dot d-cooldown"></span> '+(t.cooldown||0)+' cooling · '+(t.disabled||0)+' disabled';
      }
      var stp=$('ov-stamp'); if(stp) stp.textContent='Updated at '+fmtDate(Date.now());
    }
    var html='';
    if(total===0){
      // pool empty: don't render phantom all-zero gemini/mistral/openrouter rows
      html='<tr><td colspan="4" class="kp-stats-empty" style="color:var(--faint);cursor:pointer">No channels yet · goChannels to add one</td></tr>';
    } else {
      var prov={}, order=['gemini','mistral','openrouter'];
      order.forEach(function(p){ prov[p]={active:0,cooldown:0,disabled:0}; });
      ((s&&s.byProviderStatus)||[]).forEach(function(r){ if(!prov[r.provider])prov[r.provider]={active:0,cooldown:0,disabled:0}; prov[r.provider][r.status]=r.n; });
      Object.keys(prov).forEach(function(p){ var x=prov[p];
        html += '<tr><td style="font-weight:700">'+p+'</td>'
          +'<td class="n"><span class="dot d-active '+(x.active>0?'':'d-zero')+'"></span>'+x.active+'</td>'
          +'<td class="n"><span class="dot d-cooldown '+(x.cooldown>0?'':'d-zero')+'"></span>'+x.cooldown+'</td>'
          +'<td class="n"><span class="dot d-disabled '+(x.disabled>0?'':'d-zero')+'"></span>'+x.disabled+'</td></tr>';
      });
    }
    if($(tbodyId)){
      $(tbodyId).innerHTML = html;
      var ec=$(tbodyId).querySelector('.kp-stats-empty');
      if(ec) ec.onclick=function(){ selectSection('channels'); };
    }
  }
  function loadStats(prefix){
    var tbodyId = prefix==='ov' ? 'ov-byprovider' : 'keys-byprovider';
    if($(tbodyId)) $(tbodyId).innerHTML='<tr><td colspan="4" style="color:var(--faint)">Loading……</td></tr>';
    function errTiles(){ ['t-active','t-cooldown','t-disabled'].forEach(function(i){ if($(i)) $(i).textContent='–'; }); if(prefix==='ov'){ var vd=$('ov-verdict'); if(vd) vd.innerHTML=''; var stp=$('ov-stamp'); if(stp) stp.textContent=''; } }
    return api('/admin/keys').then(function(r){
      if(!r.ok){ if($(tbodyId)) $(tbodyId).innerHTML='<tr><td colspan="4" class="e">Error '+r.status+'</td></tr>'; errTiles(); return; }
      renderStats(r.body, tbodyId);
    }).catch(function(){ if($(tbodyId)) $(tbodyId).innerHTML='<tr><td colspan="4" class="e">Network error</td></tr>'; errTiles(); });
  }
  function probe(){
    var btn=$('ov-probe'); btn.disabled=true; var o=$('ov-probe-out'); o.style.display='block'; o.textContent='Inspecting……';
    api('/admin/probe',{method:'POST'}).then(function(r){ btn.disabled=false;
      if(!r.ok){ o.innerHTML='<span class="e">Error '+r.status+'</span>'; return; }
      var b=r.body||{};
      // format the typed fields into Chinese instead of dumping raw English JSON
      if(b.revived!=null || b.probed!=null || b.reactivated!=null)
        o.innerHTML='<span class="k">Inspection done</span> wake cooldown '+(b.revived||0)+' · probe disabled '+(b.probed||0)+' · revive '+(b.reactivated||0);
      else o.innerHTML='<span class="k">Inspection done</span> '+esc(JSON.stringify(b));
      loadStats('ov');
    }).catch(function(){ btn.disabled=false; o.innerHTML='<span class="e">Network error</span>'; });
  }
  function importKeys(){
    var keys=$('keys').value; if(!keys.trim()) return;
    var btn=$('importBtn'); btn.disabled=true; var o=$('importOut'); o.style.display='block'; o.textContent='importing……(broken keys are probed immediately)';
    api('/admin/keys/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keys:keys})})
    .then(function(r){ btn.disabled=false;
      if(!r.ok){ o.innerHTML='<span class="e">'+esc((r.body&&r.body.error&&r.body.error.message)||('Error '+r.status))+'</span>'; return; }
      var b=r.body||{}, by=b.byProvider?Object.keys(b.byProvider).map(function(k){return k+'='+b.byProvider[k];}).join('  '):'';
      var skipN=(b.skipped&&b.skipped.length)||0;
      var html='<span class="k">Add '+b.added+'</span>  duplicate '+b.duplicate+'  Skip '+skipN+'\n'+esc(by);
      if(skipN && Array.isArray(b.skipped)) html+='\n<span class="e">the following rows were skipped(check the provider prefix):</span>\n'+b.skipped.map(function(s){return esc(String(s).slice(0,40));}).join('\n');
      o.innerHTML=html;
      $('keys').value=''; loadStats('keys'); loadStats('ov');
    }).catch(function(){ btn.disabled=false; o.innerHTML='<span class="e">Network error</span>'; });
  }

  // ---------------- admin: channels ----------------
  function loadChannels(){
    var box=$('channels-list'); if(!box) return;
    api('/admin/channels').then(function(r){
      if(!r.ok){ box.innerHTML='<div class="card r1"><span class="e">Load failed '+r.status+'</span></div>'; return; }
      var list=(r.body&&r.body.channels)||[];
      if(!list.length){ box.innerHTML='<div class="card r1"><div class="hint">No channels yet. Fill in the channel name, base URL and API Key above, then clickAdd Channel.</div></div>'; return; }
      box.innerHTML=list.map(function(ch){
        var models=(ch.models||[]).map(function(m){
          return '<tr><td class="mono-token">'+esc(m.model_id)+'</td>'
            +'<td class="n">'+priceUsd(m.input_per_mtok_micro)+'</td>'
            +'<td class="n">'+(m.cached_input_per_mtok_micro!=null?priceUsd(m.cached_input_per_mtok_micro):'=input')+'</td>'
            +'<td class="n">'+priceUsd(m.output_per_mtok_micro)+'</td>'
            +'<td><button class="btn ghost small" data-channel="'+ch.id+'" data-delmodel="'+esc(m.model_id)+'">Delete</button></td></tr>';
        }).join('');
        if(!models) models='<tr><td colspan="5" class="hint">No models yet</td></tr>';
        return '<div class="card '+(ch.enabled?'r1':'r2')+'">'
          +'<h2 class="h-'+(ch.enabled?'green':'red')+'"><span class="hd"></span>'+esc(ch.name)
          +'<span class="hint" style="margin-left:10px;font-weight:400">'+esc(ch.base_url)+'</span>'
          +'<span class="hint" style="margin-left:10px;font-weight:400">key '+esc(ch.api_key)+'</span>'
          +'<span style="flex:1"></span>'
          +'<button class="btn ghost small" data-toggle="'+ch.id+'" data-enabled="'+ch.enabled+'">'+(ch.enabled?'Disable':'Enable')+'</button>'
          +'<button class="btn ghost small" data-delchannel="'+ch.id+'" style="margin-left:6px">Delete channel</button>'
          +'</h2>'
          +'<div class="row" style="margin-top:6px">'
          +'<div style="flex:2;min-width:180px"><label>Model ID</label><input class="chm-model" placeholder="e.g. gemini-2.0-flash" autocomplete="off" /></div>'
          +'<div><label>input $/Mtok</label><input class="chm-input" type="number" step="0.0001" min="0" placeholder="0.5" /></div>'
          +'<div><label>cache hit $/Mtok</label><input class="chm-cached" type="number" step="0.0001" min="0" placeholder="leave empty=same as input" /></div>'
          +'<div><label>output $/Mtok</label><input class="chm-output" type="number" step="0.0001" min="0" placeholder="1.5" /></div>'
          +'<button class="btn primary" data-addmodel="'+ch.id+'" style="align-self:flex-end">Add model</button>'
          +'</div>'
          +'<div class="out" data-modelout="'+ch.id+'" style="display:none"></div>'
          +'<table style="margin-top:10px"><thead><tr><th>Model ID</th><th>input $/Mtok</th><th>cache hit $/Mtok</th><th>output $/Mtok</th><th></th></tr></thead>'
          +'<tbody>'+models+'</tbody></table>'
          +'</div>';
      }).join('');
      bindChannels(box);
    }).catch(function(){ box.innerHTML='<div class="card r1"><span class="e">Network error</span></div>'; });
  }
  function bindChannels(box){
    var q=box.querySelectorAll('[data-delmodel]');
    for(var i=0;i<q.length;i++) q[i].onclick=function(){ if(!confirm('Delete model '+this.getAttribute('data-delmodel')+'？pricing will be removed too')) return; var self=this; api('/admin/channels/'+self.getAttribute('data-channel')+'/models/'+encodeURIComponent(self.getAttribute('data-delmodel')),{method:'DELETE'}).then(loadChannels).catch(loadChannels); };
    var q2=box.querySelectorAll('[data-toggle]');
    for(var j=0;j<q2.length;j++) q2[j].onclick=function(){ var self=this; api('/admin/channels/'+self.getAttribute('data-toggle'),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled: self.getAttribute('data-enabled')!=='1'})}).then(loadChannels).catch(loadChannels); };
    var q3=box.querySelectorAll('[data-delchannel]');
    for(var k=0;k<q3.length;k++) q3[k].onclick=function(){ if(!confirm('Delete this channel? All its models and pricing will be removed too.')) return; var self=this; api('/admin/channels/'+self.getAttribute('data-delchannel'),{method:'DELETE'}).then(loadChannels).catch(loadChannels); };
    var q4=box.querySelectorAll('[data-addmodel]');
    for(var m=0;m<q4.length;m++) (function(btn){ btn.onclick=function(){
      var card=btn.closest('.card');
      var model=card.querySelector('.chm-model').value.trim();
      var inp=parseFloat(card.querySelector('.chm-input').value);
      var out=parseFloat(card.querySelector('.chm-output').value);
      var cachedRaw=card.querySelector('.chm-cached').value.trim();
      var o=card.querySelector('[data-modelout]'); o.style.display='block';
      if(!model || !(inp>=0) || !(out>=0)){ o.innerHTML='<span class="e">Model ID and a valid price are required.</span>'; return; }
      var payload={ model_id:model, input:Math.round(inp*1000000), output:Math.round(out*1000000) };
      if(cachedRaw!==''){ var cv=parseFloat(cachedRaw); if(!(cv>=0)){ o.innerHTML='<span class="e">Invalid cache-hit price.</span>'; return; } payload.cached=Math.round(cv*1000000); }
      btn.disabled=true;
      api('/admin/channels/'+btn.getAttribute('data-addmodel')+'/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){ btn.disabled=false;
        if(!r.ok){ o.innerHTML='<span class="e">'+esc((r.body&&r.body.error&&r.body.error.message)||('Error '+r.status))+'</span>'; return; }
        o.innerHTML='<span class="k">added</span> '+esc(model);
        loadChannels();
      }).catch(function(){ btn.disabled=false; o.innerHTML='<span class="e">Network error</span>'; });
    }; })(q4[m]);
  }
  function addChannel(){
    var name=$('ch-name').value.trim(), base=$('ch-base').value.trim(), key=$('ch-key').value.trim();
    var o=$('ch-out'); o.style.display='block';
    if(!name || !base || !key){ o.innerHTML='<span class="e">Channel name, base URL and API Key are all required.</span>'; return; }
    var btn=$('ch-add'); btn.disabled=true;
    api('/admin/channels',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name,base_url:base,api_key:key,enabled:$('ch-enabled').checked})})
    .then(function(r){ btn.disabled=false;
      if(!r.ok){ o.innerHTML='<span class="e">'+esc((r.body&&r.body.error&&r.body.error.message)||('Error '+r.status))+'</span>'; return; }
      o.innerHTML='<span class="k">added</span> '+esc(name);
      $('ch-name').value=''; $('ch-base').value=''; $('ch-key').value='';
      loadChannels();
    }).catch(function(){ btn.disabled=false; o.innerHTML='<span class="e">Network error</span>'; });
  }
  // ---------------- admin: model availability ----------------
  function loadModelStatus(){
    var el=$('modelstatus-body'); if(!el) return;
    return api('/admin/models-status').then(function(r){
      var list=Array.isArray(r.body)?r.body:[];
      if(!list.length){ el.innerHTML='<span style="color:var(--faint)">not probed yet · clickprobe models one by one</span>'; return; }
      var bad=list.filter(function(m){ return !m.available; });
      if(!bad.length){ el.innerHTML='<span style="color:var(--green)">all models available</span> · probed '+list.length+''; return; }
      el.innerHTML = '<div style="margin-bottom:6px;color:var(--muted)">unavailable '+bad.length+' / probed '+list.length+'</div>'
        + bad.map(function(m){
          return '<div style="margin:3px 0"><span class="dot d-disabled"></span><b class="mono-token">'+esc(m.model)+'</b>'
            +' <span style="color:var(--faint);font-size:12px">'+esc(m.provider||'')+'</span>'
            +(m.reason?' · <span style="color:var(--red);font-size:12px">'+esc(String(m.reason).slice(0,80))+'</span>':'')+'</div>';
        }).join('');
    }).catch(function(){ el.innerHTML='<span class="e">error</span>'; });
  }
  function probeModels(){
    var btn=$('modelstatus-probe'); var el=$('modelstatus-body');
    if(btn) btn.disabled=true; if(el) el.innerHTML='probing……(probe each model once,wait a few seconds)';
    api('/admin/probe-models',{method:'POST'}).then(function(r){ if(btn) btn.disabled=false;
      if(!r.ok){ if(el) el.innerHTML='<span class="e">probe error '+r.status+'</span>'; return; }
      var b=r.body||{};
      var p=loadModelStatus();
      if(el && b.checked!=null && p && p.then) p.then(function(){ el.innerHTML='<div style="margin-bottom:6px;color:var(--muted)">probe of this round '+(b.checked||0)+' · blocked '+(b.blocked||0)+'</div>'+el.innerHTML; });
    }).catch(function(){ if(btn) btn.disabled=false; if(el) el.innerHTML='<span class="e">probe error</span>'; });
  }

  // ---------------- admin: system settings ----------------
  var setLogoData='', setFavData='';
  function renderSetPrev(){
    var lp=$('set-logo-prev'), fp=$('set-fav-prev');
    if(lp) lp.innerHTML = setLogoData ? '<img src="'+esc(setLogoData)+'" style="max-width:120px;max-height:60px;border:2px solid var(--ink);border-radius:8px;background:#fff" alt="logo preview" />' : '<span class="hint">Not set</span>';
    if(fp) fp.innerHTML = setFavData ? '<img src="'+esc(setFavData)+'" style="width:40px;height:40px;border:2px solid var(--ink);border-radius:8px;background:#fff" alt="favicon preview" />' : '<span class="hint">Not set</span>';
  }
  function loadSettings(){
    var o=$('set-out'); if(o){ o.style.display='none'; }
    api('/admin/settings').then(function(r){
      if(!r.ok){ if(o){ o.style.display='block'; o.innerHTML='<span class="e">Load failed '+r.status+'</span>'; } return; }
      var s=(r.body&&r.body.settings)||{};
      $('set-brand').value=s.brand_name||'';
      $('set-chat-url').value=s.chat_url||'';
      $('set-tg-url').value=s.telegram_url||'';
      $('set-wa-url').value=s.whatsapp_url||'';
      $('set-yt-url').value=s.footer_youtube||'';
      $('set-ig-url').value=s.footer_instagram||'';
      $('set-x-url').value=s.footer_x||'';
      $('set-tk-url').value=s.footer_tiktok||'';
      $('set-rd-url').value=s.footer_reddit||'';
      $('set-footer-text').value=s.footer_text||'';
      setLogoData=s.logo||''; setFavData=s.favicon||'';
      renderSetPrev();
    }).catch(function(){ if(o){ o.style.display='block'; o.innerHTML='<span class="e">Network error</span>'; } });
  }
  function fileToDataUrl(file, cb){
    if(!file) return;
    if(file.size>512*1024){ cb(null,'Image exceeds 512KB; please compress and retry.'); return; }
    var rd=new FileReader();
    rd.onload=function(){ cb(String(rd.result)); };
    rd.onerror=function(){ cb(null,'Failed to read the file.'); };
    rd.readAsDataURL(file);
  }
  function saveSettings(){
    var btn=$('set-save'); btn.disabled=true;
    var o=$('set-out'); o.style.display='block'; o.textContent='Saving……';
    var payload={
      brand_name:$('set-brand').value.trim(),
      chat_url:$('set-chat-url').value.trim(),
      telegram_url:$('set-tg-url').value.trim(),
      whatsapp_url:$('set-wa-url').value.trim(),
      footer_youtube:$('set-yt-url').value.trim(),
      footer_instagram:$('set-ig-url').value.trim(),
      footer_x:$('set-x-url').value.trim(),
      footer_tiktok:$('set-tk-url').value.trim(),
      footer_reddit:$('set-rd-url').value.trim(),
      footer_text:$('set-footer-text').value.trim(),
      logo:setLogoData, favicon:setFavData
    };
    api('/admin/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){ btn.disabled=false;
      if(!r.ok){ o.innerHTML='<span class="e">'+esc((r.body&&r.body.error&&r.body.error.message)||('Error '+r.status))+'</span>'; return; }
      o.innerHTML='<span class="k">Saved</span> · takes effect site-wide after refresh <button class="btn ghost small" id="set-go-refresh">Refresh now</button>';
      var g=$('set-go-refresh'); if(g) g.onclick=function(){ location.reload(); };
    }).catch(function(){ btn.disabled=false; o.innerHTML='<span class="e">Network error</span>'; });
  }
  function initFloatDock(){
    var fc=$('float-chat'); if(!fc) return;
    fc.onclick=function(){
      var cb=$('chatbox'); if(!cb) return;
      cb.style.display = (cb.style.display==='none') ? 'flex' : 'none';
    };
    var cc=$('chatbox-close'); if(cc) cc.onclick=function(){ var cb=$('chatbox'); if(cb) cb.style.display='none'; };
  }
  // ---------------- admin: users ----------------
  function loadUsers(){
    var tb=$('users-body');
    if(tb) tb.innerHTML='<tr><td colspan="5" style="color:var(--faint)">Loading……</td></tr>';
    return api('/admin/users').then(function(r){
      if(!r.ok){ tb.innerHTML='<tr><td colspan="5" style="color:var(--red)">Load failed ('+r.status+') · <button class="btn ghost small" id="users-retry">Retry</button></td></tr>'; var rb=$('users-retry'); if(rb) rb.onclick=loadUsers; var pb0=$('users-pending'); if(pb0) pb0.textContent=''; return; }
      var list = Array.isArray(r.body)? r.body : [];
      var pb=$('users-pending');
      if(pb){
        var pend=list.filter(function(u){return u.status==='pending';}).length;
        pb.className = pend>0 ? 'badge b-pending' : 'badge';
        pb.style.color = pend>0 ? '' : 'var(--faint)';
        pb.textContent = pend>0 ? ('pending '+pend) : 'no pending';
      }
      if(!list.length){ tb.innerHTML='<tr><td colspan="5" style="color:var(--faint)">No users yet.</td></tr>'; return; }
      tb.innerHTML = list.map(function(u){
        var bcls = u.status==='approved'?'b-approved':(u.status==='blocked'?'b-blocked':'b-pending');
        var action='';
        // never offer Disable on an admin row — would let an admin lock themselves out.
        // also never let an admin demote themselves (that would lock the console out).
        if(u.role==='admin'){
          action = (u.sub===me.sub)
            ? '<span class="hint">Admin(Current account)</span>'
            : '<span class="hint">Admin</span><button class="btn ghost small" data-role="user" data-rid="'+u.id+'">Remove admin</button>';
        }
        else if(u.status==='approved') action='<button class="btn ghost small" data-block="'+u.id+'">Disable</button><button class="btn ghost small" data-role="admin" data-rid="'+u.id+'">Make admin</button>';
        else if(u.status==='blocked') action='<button class="btn primary small" data-approve="'+u.id+'" data-was-blocked="1">Restore</button><button class="btn ghost small" data-role="admin" data-rid="'+u.id+'">Make admin</button>';
        else action='<button class="btn primary small" data-approve="'+u.id+'">approve</button><button class="btn ghost small" data-role="admin" data-rid="'+u.id+'">Make admin</button>';
        var hot = u.status==='pending' ? ' class="hot"' : '';
        return '<tr'+hot+'><td style="font-weight:700; word-break:break-all">'+esc(u.email||u.name||u.sub||'–')+'</td>'
          + '<td>'+esc(ROLE_CN[u.role]||u.role)+'</td>'
          + '<td><span class="badge '+bcls+'"'+(u.approved_at?' title="Approved on '+esc(fmtDate(u.approved_at))+'"':'')+'>'+esc(STATUS_CN[u.status]||u.status)+'</span></td>'
          + '<td style="color:var(--faint)">'+fmtDate(u.created_at)+'</td>'
          + '<td>'+action+'</td></tr>';
      }).join('');
      Array.prototype.forEach.call(tb.querySelectorAll('[data-approve]'), function(b){
        b.onclick=function(){
          if(b.getAttribute('data-was-blocked') && !confirm('Restore this user? Their tokens remain disabled.,needs to be enabled separately。')) return;
          b.disabled=true; api('/admin/users/'+b.getAttribute('data-approve')+'/approve',{method:'POST'}).then(function(r){ if(!r.ok){ b.disabled=false; return; } loadUsers(); }).catch(function(){ b.disabled=false; }); };
      });
      Array.prototype.forEach.call(tb.querySelectorAll('[data-block]'), function(b){
        b.onclick=function(){ if(!confirm('Disable this user? Their tokens will be disabled too.。')) return; b.disabled=true;
          api('/admin/users/'+b.getAttribute('data-block')+'/block',{method:'POST'}).then(function(r){ if(!r.ok){ b.disabled=false; return; } loadUsers(); }).catch(function(){ b.disabled=false; }); };
      });
      Array.prototype.forEach.call(tb.querySelectorAll('[data-role]'), function(b){
        b.onclick=function(){
          var want=b.getAttribute('data-role');
          if(!confirm(want==='admin'?'Make admin? This account will get full admin access.(view/delete keys, top-ups, user management, etc.)。':'Remove admin? This account will lose admin access.。')) return;
          b.disabled=true;
          api('/admin/users/'+b.getAttribute('data-rid')+'/role',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:want})})
            .then(function(r){ if(!r.ok){ b.disabled=false; return; } loadUsers(); })
            .catch(function(){ b.disabled=false; });
        };
      });
    }).catch(function(){ if(tb) tb.innerHTML='<tr><td colspan="5" style="color:var(--red)">Network error</td></tr>'; var pb1=$('users-pending'); if(pb1) pb1.textContent=''; });
  }

  // ---------------- account: change email/name + password ----------------
  function errMsg(r){
    var e = r && r.body && r.body.error;
    if(typeof e === 'string') return e;
    if(e && e.message) return e.message;
    return 'Error ' + (r ? r.status : 'Network');
  }
  function loadAccount(){
    var e=$('acc-email'); if(e) e.value = me.email || '';
    var n=$('acc-name'); if(n) n.value = me.name || '';
    var o1=$('acc-out'); if(o1){ o1.style.display='none'; }
    var o2=$('pwd-out'); if(o2){ o2.style.display='none'; }
  }
  function saveAccount(){
    var out=$('acc-out'); var b=$('acc-save');
    var email=$('acc-email').value.trim().toLowerCase();
    var name=$('acc-name').value.trim();
    b.disabled=true;
    api('/auth/account',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email,name:name})}).then(function(r){
      b.disabled=false;
      if(!r.ok){ out.style.display='block'; out.innerHTML='<span class="e">'+esc(errMsg(r))+'</span>'; return; }
      me.email = r.body.email; me.name = r.body.name;
      var mb=$('me-email'); if(mb) mb.textContent = me.email || '';
      out.style.display='block'; out.innerHTML='<span class="k">Saved。</span> New email：'+esc(r.body.email||'–');
    }).catch(function(){ b.disabled=false; out.style.display='block'; out.innerHTML='<span class="e">Network error</span>'; });
  }
  function savePassword(){
    var out=$('pwd-out'); var b=$('pwd-save');
    var oldp=$('pwd-old').value, np=$('pwd-new').value, np2=$('pwd-new2').value;
    if(np!==np2){ out.style.display='block'; out.innerHTML='<span class="e">The two new passwords do not match.</span>'; return; }
    if(np.length<8){ out.style.display='block'; out.innerHTML='<span class="e">new password at least 8 characters</span>'; return; }
    b.disabled=true;
    api('/auth/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({old_password:oldp,new_password:np})}).then(function(r){
      b.disabled=false;
      if(!r.ok){ out.style.display='block'; out.innerHTML='<span class="e">'+esc(errMsg(r))+'</span>'; return; }
      $('pwd-old').value=''; $('pwd-new').value=''; $('pwd-new2').value='';
      out.style.display='block'; out.innerHTML='<span class="k">Password updated.。</span> Use the new password to sign in next time.。';
    }).catch(function(){ b.disabled=false; out.style.display='block'; out.innerHTML='<span class="e">Network error</span>'; });
  }

  // ---------------- admin: tokens ----------------
  function loadAdminTokens(){
    var tb=$('adm-token-list');
    if(tb) tb.innerHTML='<tr><td colspan="10" style="color:var(--faint)">Loading……</td></tr>';
    return api('/admin/tokens').then(function(r){
      if(!r.ok){ tb.innerHTML='<tr><td colspan="10"><span class="e">Error '+r.status+'</span></td></tr>'; return; }
      var list = Array.isArray(r.body)? r.body : [];
      if(!list.length){ tb.innerHTML='<tr><td colspan="10" style="color:var(--faint)">Not yet</td></tr>'; return; }
      tb.innerHTML = list.map(function(t){
        return '<tr><td>'+t.id+'</td><td style="font-weight:700">'+esc(t.name||'–')+'</td>'
          + '<td><span class="badge">'+esc(ROLE_CN[t.role]||t.role)+'</span></td>'
          + '<td>'+(t.owner_sub==null?'<span class="badge">Global</span>':'<span style="color:var(--faint)" title="'+esc(t.owner_sub)+'">…'+esc(String(t.owner_sub).slice(-8))+'</span>')+'</td>'
          + '<td class="n">'+t.used_requests+'/'+(t.quota_requests==null?'∞':t.quota_requests)+'</td>'
          + '<td class="n">'+(t.rpm_limit==null?'∞':t.rpm_limit)+'</td>'
          + '<td style="color:var(--faint)">'+(t.expires_at==null?'permanent':fmtDate(t.expires_at))+'</td>'
          + '<td><span class="dot '+(t.enabled?'d-active':'d-disabled')+'"></span>'+(t.enabled?'Enable':'Disable')+'</td>'
          + '<td style="color:var(--faint)">'+fmtDate(t.created_at)+'</td>'
          + '<td><button class="btn ghost small" data-del="'+t.id+'">Delete</button></td></tr>';
      }).join('');
      Array.prototype.forEach.call(tb.querySelectorAll('[data-del]'), function(b){
        b.onclick = function(){
          if(!confirm('Delete this token? Its users will be rejected immediately.。')) return;
          b.disabled=true;
          api('/admin/tokens/'+b.getAttribute('data-del'),{method:'DELETE'}).then(function(r){ if(!r.ok){ b.disabled=false; return; } loadAdminTokens(); }).catch(function(){ b.disabled=false; });
        };
      });
    }).catch(function(){ if(tb) tb.innerHTML='<tr><td colspan="10"><span class="e">Network error</span></td></tr>'; });
  }
  function mintAdmin(){
    var name=$('adm-tname').value.trim();
    var q=parseInt($('adm-quota').value,10), rpm=parseInt($('adm-rpm').value,10), exp=parseInt($('adm-exp').value,10);
    var role=$('adm-role').value;
    var payload={name:name};
    if(q>0) payload.quota_requests=q;
    if(rpm>0) payload.rpm_limit=rpm;
    if(exp>0) payload.expires_in_days=exp;
    if(role==='admin'){ if(!confirm('Issue an admin token? It can access the admin APIs.。')) return; payload.role='admin'; }
    var btn=$('adm-mint'); var lbl=btn.textContent; btn.disabled=true; btn.textContent='issuing……';
    api('/admin/tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){ btn.disabled=false; btn.textContent=lbl; var o=$('adm-mint-out'); o.style.display='block';
      if(!r.ok){ o.innerHTML='<span class="e">Error '+r.status+'</span>'; return; }
      o.innerHTML='New token(Copy now): <span class="k mono-token copyable" data-copy="'+esc(r.body.token)+'">'+esc(r.body.token)+'</span>';
      bindCopy(o); $('adm-tname').value=''; $('adm-quota').value=''; $('adm-rpm').value=''; $('adm-exp').value=''; loadAdminTokens();
    }).catch(function(){ btn.disabled=false; btn.textContent=lbl; });
  }

  // ---------------- wire static handlers ----------------
  $('my-mint').onclick = mintMy;
  $('my-tokens-refresh').onclick = loadMyTokens;
  $('ov-refresh').onclick = function(){ var b=$('ov-refresh'); b.disabled=true; var po=$('ov-probe-out'); if(po) po.style.display='none'; loadStats('ov').then(function(){ b.disabled=false; }).catch(function(){ b.disabled=false; }); };
  $('ov-probe').onclick = probe;
  var chAdd=$('ch-add'); if(chAdd) chAdd.onclick=addChannel;
  $('users-refresh').onclick = loadUsers;
  $('adm-mint').onclick = mintAdmin;
  $('adm-tokens-refresh').onclick = loadAdminTokens;
  $('bill-topup').onclick = topUp;
  $('bill-balances-refresh').onclick = loadBalances;
  $('bill-txns-refresh').onclick = loadBillingTxns;
  $('bill-txns-user').onchange = loadBillingTxns;
  $('prices-refresh').onclick = loadPrices;
  $('bal-refresh').onclick = loadBalance;
  var accS=$('acc-save'); if(accS) accS.onclick=saveAccount;
  var setSave=$('set-save'); if(setSave) setSave.onclick=saveSettings;
  var setRefresh=$('set-refresh'); if(setRefresh) setRefresh.onclick=loadSettings;
  var logoFile=$('set-logo-file'); if(logoFile) logoFile.onchange=function(){ var f=logoFile.files&&logoFile.files[0]; if(!f) return; fileToDataUrl(f,function(d,err){ if(err){ var lp=$('set-logo-prev'); if(lp) lp.innerHTML='<span class="e">'+esc(err)+'</span>'; return; } setLogoData=d; renderSetPrev(); }); };
  var favFile=$('set-fav-file'); if(favFile) favFile.onchange=function(){ var f=favFile.files&&favFile.files[0]; if(!f) return; fileToDataUrl(f,function(d,err){ if(err){ var fp=$('set-fav-prev'); if(fp) fp.innerHTML='<span class="e">'+esc(err)+'</span>'; return; } setFavData=d; renderSetPrev(); }); };
  var logoClear=$('set-logo-clear'); if(logoClear) logoClear.onclick=function(){ setLogoData=''; renderSetPrev(); };
  var favClear=$('set-fav-clear'); if(favClear) favClear.onclick=function(){ setFavData=''; renderSetPrev(); };
  var pwdS=$('pwd-save'); if(pwdS) pwdS.onclick=savePassword;
  $('bal-topup-btn').onclick = checkout;
  var pcs=$('pay-config-save'); if(pcs) pcs.onclick=savePayConfig;
  (function(){ var c=$('bal-topup-chips'); if(c){ var bs=c.querySelectorAll('button'); for(var i=0;i<bs.length;i++){ bs[i].onclick=function(){ $('bal-topup-amount').value=this.getAttribute('data-amt'); }; } } })();
  // (pending page refresh changed to native links,no longer needs JS binding.)

  // ---------------- boot / routing ----------------
  function showLanding(){
    show('view-landing');
    loadModels().then(function(list){
      if(list.length){ $('landing-models').style.display='block'; renderModelsInto('landing-models-body'); }
    });
  }
  function showPending(){
    show('view-pending');
    $('pending-email').textContent = me.email || '';
    if(me.status==='blocked'){ $('pending-msg').textContent='This account has been disabled; contact an admin.。'; }
  }
  function showConsole(){
    show('view-console');
    $('me-email').textContent = me.email || '';
    $('me-role').textContent = me.role;
    $('me-rolepill').className = 'pill ' + (me.role==='admin'?'ok':'');
    previewUser=false;
    buildNav(me.role);
    var pt=$('preview-toggle');
    if(pt){
      if(me.role==='admin'){
        pt.style.display='flex';
        pt.textContent='👤 Preview user view';
        pt.onclick=function(){
          previewUser=!previewUser;
          pt.textContent = previewUser ? '↩ back to admin' : '👤 Preview user view';
          buildNav(previewUser ? 'user' : 'admin');
        };
      } else { pt.style.display='none'; }
    }
  }
  function boot(){
    return api('/auth/me').then(function(r){
      if(r.status===401 || !r.ok || !r.body || !r.body.role){ me=null; showLanding(); return; }
      me = r.body; // { email, role, status, sub }
      if(me.role==='admin'){ showConsole(); return; }
      if(me.status==='approved'){ showConsole(); return; }
      showPending();
    }).catch(function(){ me=null; showLanding(); });
  }
  boot();
  // floating dock is injected after the script block; bind once the DOM has it
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', initFloatDock); } else { initFloatDock(); }
})();