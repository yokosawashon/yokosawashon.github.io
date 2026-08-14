const $ = id => document.getElementById(id);
const state = { photoDataURL:null, photoMeta:null, menuCandidates:[], restaurantCandidates:[], editingId:null };

const dbPromise = new Promise((resolve,reject) => {
  const request = indexedDB.open("GohanLog",1);
  request.onupgradeneeded = () => request.result.createObjectStore("meals",{keyPath:"id"});
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function store(mode,value){ const db=await dbPromise; return new Promise((resolve,reject)=>{const tx=db.transaction("meals","readwrite"), os=tx.objectStore("meals"); const r=mode==="put"?os.put(value):os.delete(value); r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);}); }
async function allMeals(){const db=await dbPromise;return new Promise((resolve,reject)=>{const r=db.transaction("meals").objectStore("meals").getAll();r.onsuccess=()=>resolve(r.result.sort((a,b)=>new Date(b.photographedAt)-new Date(a.photographedAt)));r.onerror=()=>reject(r.error);});}
async function getMeal(id){const db=await dbPromise;return new Promise((resolve,reject)=>{const r=db.transaction("meals").objectStore("meals").get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}

function showView(id){ document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===id)); document.querySelectorAll("nav button").forEach(b=>b.classList.toggle("active",b.dataset.view===id)); if(id==="listView")renderMeals(); }
document.querySelectorAll("nav button").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
$("settingsButton").onclick=()=>showView("settingsView");

$("photoInput").addEventListener("change",async event=>{
  const file=event.target.files[0]; if(!file)return; setBusy(true); clearError();
  try{
    const buffer=await file.arrayBuffer(); state.photoMeta=parseExif(buffer);
    state.photoDataURL=await resizeImage(file,1280,.82); $("preview").src=state.photoDataURL; $("preview").style.display="block"; $("photoPrompt").style.display="none";
    $("photographedAt").value=toLocalInput(state.photoMeta.date||new Date());
    const tasks=[predictMenu(state.photoDataURL)];
    if(state.photoMeta.latitude!=null)tasks.push(findRestaurants(state.photoMeta.latitude,state.photoMeta.longitude));
    const results=await Promise.allSettled(tasks);
    if(results[0].status==="rejected")showError(results[0].reason.message||"メニューを予測できませんでした。手入力できます。");
    if(state.photoMeta.latitude==null)showError("写真に位置情報がありません。店名は手入力してください。");
  }catch(e){showError(e.message||"写真を読み込めませんでした。");} finally{setBusy(false);}
});

async function predictMenu(dataURL){
  const key=localStorage.getItem("openai-api-key"); if(!key)throw new Error("設定画面でOpenAI APIキーを保存してください。");
  const prompt="料理写真を分析し、日本語の一般的なメニュー名を予測してください。店舗固有名は推測しないでください。JSONだけを返してください: {\"primary\":\"料理名\",\"candidates\":[\"候補1\",\"候補2\"],\"confidence\":0.7}";
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model:"gpt-5.4-nano",input:[{role:"user",content:[{type:"input_text",text:prompt},{type:"input_image",image_url:dataURL,detail:"low"}]}],max_output_tokens:300})});
  if(!response.ok){let msg=`OpenAI APIエラー（${response.status}）`;try{msg=(await response.json()).error.message}catch{}throw new Error(msg);}
  const json=await response.json(), text=(json.output||[]).flatMap(x=>x.content||[]).map(x=>x.text).find(Boolean); if(!text)throw new Error("AIの回答を読み取れませんでした。");
  const match=text.match(/\{[\s\S]*\}/); if(!match)throw new Error("AIの回答形式が不正です。"); const result=JSON.parse(match[0]);
  $("menuName").value=result.primary||""; state.menuCandidates=(result.candidates||[]).slice(0,3); renderChips("menuCandidates",state.menuCandidates,name=>$("menuName").value=name); state.confidence=result.confidence;
}

async function findRestaurants(lat,lon){
  const query=`[out:json][timeout:15];(node(around:500,${lat},${lon})[amenity~"restaurant|cafe|fast_food|bar|pub"];way(around:500,${lat},${lon})[amenity~"restaurant|cafe|fast_food|bar|pub"];relation(around:500,${lat},${lon})[amenity~"restaurant|cafe|fast_food|bar|pub"];);out center tags;`;
  const response=await fetch("https://overpass-api.de/api/interpreter",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:"data="+encodeURIComponent(query)}); if(!response.ok)throw new Error("周辺店舗を取得できませんでした。");
  const data=await response.json(); state.restaurantCandidates=data.elements.map(e=>({name:e.tags?.name||e.tags?.["name:ja"],lat:e.lat??e.center?.lat,lon:e.lon??e.center?.lon})).filter(x=>x.name&&x.lat).map(x=>({...x,distance:haversine(lat,lon,x.lat,x.lon)})).sort((a,b)=>a.distance-b.distance).slice(0,5);
  if(state.restaurantCandidates[0])$("restaurantName").value=state.restaurantCandidates[0].name;
  renderChips("restaurantCandidates",state.restaurantCandidates.map(x=>`${x.name} · ${Math.round(x.distance)}m`),(label,i)=>$("restaurantName").value=state.restaurantCandidates[i].name);
}

$("mealForm").addEventListener("submit",async event=>{event.preventDefault();if(!state.photoDataURL)return; const record={id:crypto.randomUUID(),image:state.photoDataURL,photographedAt:new Date($("photographedAt").value||Date.now()).toISOString(),latitude:state.photoMeta?.latitude??null,longitude:state.photoMeta?.longitude??null,restaurantName:$("restaurantName").value.trim(),menuName:$("menuName").value.trim(),menuCandidates:state.menuCandidates,confidence:state.confidence??null,createdAt:new Date().toISOString()};await store("put",record);resetForm();showView("listView");});

async function renderMeals(){const meals=await allMeals(),grid=$("mealGrid");grid.innerHTML="";$("emptyState").classList.toggle("hidden",meals.length>0);meals.forEach(meal=>{const button=document.createElement("button");button.className="meal-tile";button.innerHTML=`<img alt="" src="${meal.image}"><span class="meal-caption"><strong>${escapeHtml(meal.menuName||"メニュー未設定")}</strong><small>${escapeHtml(meal.restaurantName||"店名未設定")}</small></span>`;button.onclick=()=>showDetail(meal.id);grid.append(button);});}
async function showDetail(id){const meal=await getMeal(id);$("detailContent").innerHTML=`<img class="detail-photo" src="${meal.image}" alt="料理写真"><div class="detail-fields"><label>店名<input id="detailRestaurant" value="${escapeAttr(meal.restaurantName||"")}"></label><label>メニュー名<input id="detailMenu" value="${escapeAttr(meal.menuName||"")}"></label><label>撮影日時<input id="detailDate" type="datetime-local" value="${toLocalInput(new Date(meal.photographedAt))}"></label><div class="detail-actions"><button id="updateMeal" class="primary">更新</button><button id="deleteMeal" class="danger">削除</button></div></div>`;$("updateMeal").onclick=async()=>{meal.restaurantName=$("detailRestaurant").value.trim();meal.menuName=$("detailMenu").value.trim();meal.photographedAt=new Date($("detailDate").value).toISOString();await store("put",meal);showView("listView");};$("deleteMeal").onclick=async()=>{if(confirm("この記録を削除しますか？")){await store("delete",id);showView("listView");}};showView("detailView");}

$("saveKeyButton").onclick=()=>{const key=$("apiKey").value.trim();if(!key)return;localStorage.setItem("openai-api-key",key);$("apiKey").value="";$("keyStatus").textContent="この端末に保存しました。";};
$("deleteKeyButton").onclick=()=>{localStorage.removeItem("openai-api-key");$("keyStatus").textContent="削除しました。";};
$("exportButton").onclick=async()=>{const data=JSON.stringify(await allMeals(),null,2),blob=new Blob([data],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`gohan-log-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);};

function renderChips(id,labels,handler){const el=$(id);el.innerHTML="";labels.forEach((label,i)=>{const b=document.createElement("button");b.type="button";b.textContent=label;b.onclick=()=>handler(label,i);el.append(b);});}
function setBusy(value){$("analysisStatus").classList.toggle("hidden",!value);}
function showError(text){$("errorMessage").textContent=text;$("errorMessage").classList.remove("hidden");}function clearError(){$("errorMessage").classList.add("hidden");}
function resetForm(){$("mealForm").reset();$("preview").style.display="none";$("photoPrompt").style.display="block";$("restaurantCandidates").innerHTML="";$("menuCandidates").innerHTML="";state.photoDataURL=null;state.photoMeta=null;state.menuCandidates=[];}
function toLocalInput(date){const d=new Date(date.getTime()-date.getTimezoneOffset()*60000);return d.toISOString().slice(0,16);}
function haversine(a,b,c,d){const r=6371000,p=Math.PI/180,x=(c-a)*p,y=(d-b)*p,z=Math.sin(x/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(y/2)**2;return 2*r*Math.asin(Math.sqrt(z));}
function escapeHtml(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML;}function escapeAttr(s){return escapeHtml(s).replaceAll('"','&quot;');}
function resizeImage(file,max,q){return new Promise((resolve,reject)=>{const img=new Image(),url=URL.createObjectURL(file);img.onload=()=>{let{width,height}=img,scale=Math.min(1,max/Math.max(width,height));const canvas=document.createElement("canvas");canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);URL.revokeObjectURL(url);resolve(canvas.toDataURL("image/jpeg",q));};img.onerror=reject;img.src=url;});}

// JPEG/TIFF EXIFから撮影日時とGPSを読み取る。対応タグがない場合はnullを返す。
function parseExif(buffer){try{const v=new DataView(buffer);if(v.getUint16(0)!==0xffd8)return{};let p=2;while(p<v.byteLength){if(v.getUint16(p)===0xffe1&&ascii(v,p+4,6)==="Exif\0\0")return parseTiff(v,p+10);p+=2+v.getUint16(p+2);}return{};}catch{return{};}}
function parseTiff(v,start){const little=v.getUint16(start)===0x4949,u16=o=>v.getUint16(start+o,little),u32=o=>v.getUint32(start+o,little);function entries(offset){const out={};for(let i=0,n=u16(offset);i<n;i++){const o=offset+2+i*12,tag=u16(o),type=u16(o+2),count=u32(o+4),value=count*(type===3?2:type===5?8:1)>4?u32(o+8):o+8;out[tag]={type,count,value};}return out;}function str(e){let s="";for(let i=0;i<e.count-1;i++)s+=String.fromCharCode(v.getUint8(start+e.value+i));return s;}function rationals(e){const a=[];for(let i=0;i<e.count;i++){const o=e.value+i*8;a.push(u32(o)/u32(o+4));}return a;}const root=entries(u32(4)),result={};if(root[0x8769]){const ex=entries(u32(root[0x8769].value));if(ex[0x9003]){const m=str(ex[0x9003]).match(/(\d+):(\d+):(\d+) (\d+):(\d+):(\d+)/);if(m)result.date=new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]);}}if(root[0x8825]){const gps=entries(u32(root[0x8825].value));if(gps[1]&&gps[2]&&gps[3]&&gps[4]){const la=rationals(gps[2]),lo=rationals(gps[4]);result.latitude=la[0]+la[1]/60+la[2]/3600;result.longitude=lo[0]+lo[1]/60+lo[2]/3600;if(str(gps[1])==="S")result.latitude*=-1;if(str(gps[3])==="W")result.longitude*=-1;}}return result;}
function ascii(v,o,n){let s="";for(let i=0;i<n;i++)s+=String.fromCharCode(v.getUint8(o+i));return s;}

if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js");
if(!localStorage.getItem("openai-api-key"))showView("settingsView");else renderMeals();
