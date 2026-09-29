/* ============ CLOUD SYNC (this app's own API) ============ */
const API = /^https?:/.test(location.protocol) ? '/api' : null;
const CODE_KEY='my-torah-helper.code';
try{ if(!localStorage.getItem('my-torah-helper.code') && localStorage.getItem('uriel-kriah.code')) localStorage.setItem('my-torah-helper.code', localStorage.getItem('uriel-kriah.code')); }catch(e){}
const ACC_KEY='my-torah-helper.account';
const CHILD_KEY='my-torah-helper.child';
function account(){ try{ return JSON.parse(localStorage.getItem(ACC_KEY)||'null'); }catch(e){ return null; } }
function setAccount(a){ try{ a?localStorage.setItem(ACC_KEY,JSON.stringify(a)):localStorage.removeItem(ACC_KEY); }catch(e){} if(typeof demoClean==='function') demoClean(); }
function childId(){ try{ return localStorage.getItem(CHILD_KEY)||'c1'; }catch(e){ return 'c1'; } }
function setChildId(c){ try{ localStorage.setItem(CHILD_KEY,c); }catch(e){} }
function childList(){ const a=account(); return a&&a.children&&a.children.length?a.children:[{id:'c1',name:(typeof S!=='undefined'&&S&&S.settings&&S.settings.childName)||'My child'}]; }
function activeChild(){ return childList().find(c=>c.id===childId())||childList()[0]; }
function docKey(){ const c=familyCode(); const id=childId(); return id==='c1'?c:(c+'-'+id.toUpperCase()); }
async function api(path, body){ const h={'Content-Type':'application/json'}; const a=account(); if(a&&a.token) h['X-Auth']=a.token;
  const r=await fetch(API+path, body?{method:'POST',headers:h,body:JSON.stringify(body)}:{headers:h});
  let j={}; try{ j=await r.json(); }catch(e){}
  if(!r.ok) throw new Error(j.error||('server '+r.status)); return j; }
function switchChild(id){ if(id===childId()) return; try{ if(cloud.pending){ clearTimeout(cloud.pending); cloud.pending=null; fetch(API+'/family/'+docKey(),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:cloudState()})}); } }catch(e){}
  clearInterval(cloud.poll); cloud={on:false,status:'off',rev:0,pending:null,poll:null,inflight:false};
  setChildId(id); S=load(); window.parentOK=false; go({name:'home'}); cloudConnect(); }
const CLIENT_ID = Math.random().toString(36).slice(2,10);
let cloud={on:false, status:'off', rev:0, pending:null, poll:null, inflight:false};
function familyCode(){ const a=account(); if(a&&a.code) return a.code; try{ return localStorage.getItem(CODE_KEY)||''; }catch(e){ return ''; } }
function setFamilyCode(c){ try{ localStorage.setItem(CODE_KEY,c); }catch(e){} if(typeof demoClean==='function') demoClean(); }
function newFamilyCode(){ const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<6;i++) s+=A[Math.floor(Math.random()*A.length)]; return 'URIEL-'+s; }
function cloudAvailable(){ return !!API; }
function cloudConnect(){
  if(!API || !familyCode()) return;
  cloud.status='connecting';
  fetch(API+'/health').then(r=>r.json()).then(h=>{ cloud.storage=h.storage; if(view.name==='parent') render(); }).catch(()=>{});
  fetch(API+'/family/'+docKey()).then(r=>{ if(r.status===404) return null; if(r.status===402){ billingGate(); throw new Error('subscription'); } if(!r.ok) throw new Error('server '+r.status); return r.json(); }).then(r=>{
    if(r && r.state){ const rrev=(r.state.meta&&r.state.meta.rev)||0, lrev=(S.meta&&S.meta.rev)||0;
      if(rrev>=lrev || Object.keys(S.stats).length===0){ applyRemote(r.state, r.rev); } else { cloudPush(); } }
    else cloudPush();
    cloud.on=true; cloud.status='synced';
    clearInterval(cloud.poll); cloud.poll=setInterval(cloudPoll, 4000);
    document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') cloudPoll(); });
    render();
  }).catch(e=>{ cloud.status='error: '+e.message; render(); });
}
function cloudPoll(){
  if(!cloud.on || cloud.inflight || cloud.pending) return; cloud.inflight=true;
  fetch(API+'/family/'+docKey()+'?since='+cloud.rev).then(r=>{ if(r.status===204||r.status===404) return null; if(r.status===402){ billingGate(); throw new Error('subscription'); } if(!r.ok) throw new Error('server '+r.status); return r.json(); })
    .then(r=>{ if(r && r.state && (!r.state.meta || r.state.meta.client!==CLIENT_ID)) applyRemote(r.state, r.rev); else if(r) cloud.rev=r.rev; cloud.status='synced'; })
    .catch(e=>{ cloud.status='error: '+e.message; }).finally(()=>{ cloud.inflight=false; });
}
function applyRemote(remote, rev){ cloud.rev=rev||cloud.rev; const st=Object.assign({},S.settings,remote.settings||{});
  /* the demo flag is this device's business only — never take one from another device */
  delete st.demo; if(S.settings&&S.settings.demo&&demoCode()) st.demo=true; S=Object.assign(S,remote,{settings:st}); try{ localStorage.setItem(KEY, JSON.stringify(S)); }catch(e){} if(['home','parent','garage','setup'].includes(view.name)) render(); else { const el=document.querySelector('.stats .pill.gold'); if(el) el.textContent='★ '+S.points; } }
function cloudPush(){ if(!API||!familyCode()) return; clearTimeout(cloud.pending); cloud.pending=setTimeout(()=>{ cloud.pending=null;
  fetch(API+'/family/'+docKey(),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:cloudState()})}).then(r=>{ if(!r.ok) throw new Error('server '+r.status); return r.json(); }).then(r=>{ cloud.rev=r.rev; cloud.status='synced'; const el=document.getElementById('syncpill'); if(el){ el.textContent='☁️ Synced'; el.classList.remove('fire'); } }).catch(e=>{ cloud.status='error: '+e.message; });
}, 800); }
function billingGate(){ if(view.name!=='billing'&&view.name!=='setup'){ clearInterval(cloud.poll); cloud.on=false; cloud.status='billing'; go({name:'billing'}); } }
function cloudSignOut(){ clearInterval(cloud.poll); cloud={on:false,status:'off',rev:0,pending:null,poll:null,inflight:false}; try{ localStorage.removeItem(CODE_KEY); localStorage.removeItem(ACC_KEY); localStorage.removeItem(CHILD_KEY); localStorage.removeItem(KEY); for(const k of Object.keys(localStorage)) if(k.startsWith('my-torah-helper.v1:')) localStorage.removeItem(k); }catch(e){} S=load(); go({name:'setup'}); }

