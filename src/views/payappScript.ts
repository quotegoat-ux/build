/** Live totals for the pay app editor. Mirrors computePayApp in src/payapp.ts; the server recomputes on save. */
export const PAY_APP_SCRIPT = `(function(){
var f=document.getElementById("payapp");if(!f)return;
var C=Number(f.dataset.contract),P=Number(f.dataset.prev);
function cents(v){v=String(v).replace(/[\\s$]/g,"");var n=/^\\(.*\\)$/.test(v);if(n)v=v.slice(1,-1);if(!/^-?(\\d{1,3}(,\\d{3})+|\\d*)(\\.\\d{0,2})?$/.test(v)||!/\\d/.test(v))return null;v=v.replace(/,/g,"");var neg=v.charAt(0)==="-";if(neg)v=v.slice(1);var p=v.split(".");var c=Number(p[0]||"0")*100+Number(((p[1]||"")+"00").slice(0,2));return (neg!==n)?-c:c}
function bp(v){var m=/^(-)?(\\d{1,5})(?:\\.(\\d{0,2}))?%?$/.exec(String(v).trim());if(!m)return null;var b=Number(m[2])*100+Number(((m[3]||"")+"00").slice(0,2));return m[1]?-b:b}
function ret(a,r){return Math.round(a*r/10000)}
function pct(g,c){return c===0?0:Math.round(g*10000/c)}
function money(c){var s="$"+(Math.abs(c)/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});return c<0?"-"+s:s}
function fbp(b){return (b/100).toFixed(2).replace(/\\.?0+$/,"")}
function dec(c){return (c<0?"-":"")+(Math.abs(c)/100).toFixed(2)}
function set(el,v){if(el)el.textContent=v}
function recalc(src){
var rw=bp(f.retainage_work.value)||0,rs=bp(f.retainage_stored.value)||0;
var T={c:0,d:0,e:0,f:0,g:0,h:0,i:0};
f.querySelectorAll("tr[data-row]").forEach(function(tr){
var id=tr.getAttribute("data-row"),c=Number(tr.dataset.c),d=Number(tr.dataset.d);
var eI=f.elements["e_"+id],pI=f.elements["pct_"+id],p0=f.elements["pct0_"+id],fI=f.elements["f_"+id];
var fv=cents(fI.value)||0;
if(src===pI){var pb=bp(pI.value);if(pb!==null)eI.value=dec(Math.round(pb*c/10000)-d-fv)}
var e=cents(eI.value)||0,g=d+e+fv,h=c-g,i=ret(d+e,rw)+ret(fv,rs);
if(src!==pI){pI.value=fbp(pct(g,c));p0.value=pI.value}
set(tr.querySelector("[data-out=g]"),money(g));set(tr.querySelector("[data-out=h]"),money(h));set(tr.querySelector("[data-out=i]"),money(i));
tr.classList.toggle("over",c<0?g<c:g>c);
T.c+=c;T.d+=d;T.e+=e;T.f+=fv;T.g+=g;T.h+=h;T.i+=i});
["e","f","g","h","i"].forEach(function(k){set(f.querySelector("[data-total="+k+"]"),money(T[k]))});
set(f.querySelector("[data-total=pct]"),fbp(pct(T.g,T.c))+"%");
var l6=T.g-T.i,v={completedStoredToDate:T.g,retainage:T.i,earnedLessRetainage:l6,currentPaymentDue:l6-P,balanceToFinish:C-l6};
Object.keys(v).forEach(function(k){set(f.querySelector("[data-g702="+k+"]"),money(v[k]))})}
f.addEventListener("input",function(e){if(e.target.name)recalc(e.target)});
})();`;
