const $ = id => document.getElementById(id);
const state = {
  photoDataURL:null, photoMeta:null, food:null, menuCandidates:[], rankedPlaces:[],
  selectedPlaceId:null, confidence:null
};

const dbPromise = new Promise((resolve,reject) => {
  const request = indexedDB.open("GohanLog",1);
  request.onupgradeneeded = () => request.result.createObjectStore("meals",{keyPath:"id"});
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function store(mode,value){const db=await dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction("meals","readwrite"),os=tx.objectStore("meals"),r=mode==="put"?os.put(value):os.delete(value);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);});}
async function allMeals(){const db=await dbPromise;return new Promise((resolve,reject)=>{const r=db.transaction("meals").objectStore("meals").getAll();r.onsuccess=()=>resolve(r.result.sort((a,b)=>new Date(b.photographedAt)-new Date(a.photographedAt)));r.onerror=()=>reject(r.error);});}
async function getMeal(id){const db=await dbPromise;return new Promise((resolve,reject)=>{const r=db.transaction("meals").objectStore("meals").get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}

function showView(id){document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===id));document.querySelectorAll("nav button").forEach(b=>b.classList.toggle("active",b.dataset.view===id));if(id==="listView")renderMeals();}
document.querySelectorAll("nav button").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
$("settingsButton").onclick=()=>showView("settingsView");

$("photoInput").addEventListener("change",async event=>{
  const file=event.target.files[0]; if(!file)return;
  setBusy(true,"写真を準備中…"); clearError(); clearAnalysis();
  try{
    const buffer=await file.arrayBuffer(); state.photoMeta=parseExif(buffer);
    state.photoDataURL=await resizeImage(file,1280,.82);
    $("preview").src=state.photoDataURL; $("preview").style.display="block"; $("photoPrompt").style.display="none";
    $("photographedAt").value=toLocalInput(state.photoMeta.date||new Date());

    setBusy(true,"料理名と見た目の特徴を分析中…");
    state.food=await analyzeFood(state.photoDataURL);
    applyFoodAnalysis(state.food);

    if(state.photoMeta.latitude==null){showError("写真に位置情報がありません。店名は手入力してください。");return;}
    setBusy(true,"料理と位置から近くの店を探索中…");
    const places=await searchPlaces(state.food,state.photoMeta.latitude,state.photoMeta.longitude);
    if(!places.length)throw new Error("周辺に候補店舗が見つかりませんでした。店名は手入力できます。");

    setBusy(true,"営業時間・口コミ・店舗写真を比較中…");
    state.rankedPlaces=await rankPlaces(places,state.food,state.photoDataURL,state.photoMeta);
    renderRankedPlaces();
    if(state.rankedPlaces[0]?.score>=90)selectPlace(state.rankedPlaces[0].id);
  }catch(e){showError(e.message||"解析できませんでした。店名とメニュー名は手入力できます。");}
  finally{setBusy(false);}
});

async function analyzeFood(dataURL){
  const prompt=`この飲食物の写真を、店舗特定に役立つ粒度で分析してください。
料理ジャンルを事前に仮定せず、和食、洋食、中華、韓国料理、東南アジア料理、南アジア料理、中東料理、アフリカ料理、中南米料理、麺類、米料理、パン、菓子、デザート、飲料、その他を同じ条件で検討してください。
写真から確認できる情報だけを使い、見えない材料、調理法、味、地域、店舗固有の商品名を断定しないでください。
categoryは広い料理分類、subCategoryは写真から妥当に識別できる細分類です。menuCandidatesは一般的なメニュー名の候補を可能性順に最大3件とします。
料理によって該当しない項目はnullまたは空配列にしてください。searchQueryは周辺店舗検索に有効な、料理名または料理ジャンルだけの短い日本語にしてください。
説明やMarkdownを付けず、次のキーを持つJSONオブジェクトだけを返してください。
{"category":string,"subCategory":string|null,"menuCandidates":string[],"soup":string|null,"toppings":string[],"ingredients":string[],"cookingMethod":string|null,"presentation":string|null,"container":string|null,"table":string|null,"visibleText":string[],"searchQuery":string}`;
  return callOpenAI([{type:"input_text",text:prompt},{type:"input_image",image_url:dataURL,detail:"high"}],900,"gpt-5.4-mini");
}

function applyFoodAnalysis(food){
  state.menuCandidates=(food.menuCandidates||[]).slice(0,3);
  $("menuName").value=state.menuCandidates[0]||food.subCategory||food.category||"";
  renderChips("menuCandidates",state.menuCandidates,name=>$("menuName").value=name);
  const features=[food.soup,...(food.toppings||[]),...(food.ingredients||[]),food.cookingMethod,food.presentation,food.container&&`器:${food.container}`,food.table&&`テーブル:${food.table}`].filter(Boolean);
  $("foodFeatures").innerHTML=`<strong>${escapeHtml(food.subCategory||food.category||"料理")}</strong>${escapeHtml(features.join("・")||"特徴を抽出しました")}`;
  $("foodFeatures").classList.remove("hidden");
}

let googleMapsPromise;
async function loadGooglePlaces(){
  if(globalThis.google?.maps)return google.maps.importLibrary("places");
  if(googleMapsPromise)return googleMapsPromise;
  const key=localStorage.getItem("google-places-api-key");
  if(!key)throw new Error("設定画面でGoogle Places APIキーを保存してください。");
  googleMapsPromise=new Promise((resolve,reject)=>{
    const callback=`initGohanMaps_${Date.now()}`;
    globalThis[callback]=async()=>{try{resolve(await google.maps.importLibrary("places"));}catch(e){reject(e);}finally{delete globalThis[callback];}};
    const script=document.createElement("script");
    script.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&v=weekly&loading=async&callback=${callback}`;
    script.async=true; script.onerror=()=>reject(new Error("Google Mapsを読み込めませんでした。APIキー設定を確認してください。")); document.head.append(script);
  });
  return googleMapsPromise;
}

async function searchPlaces(food,lat,lng){
  const {Place}=await loadGooglePlaces();
  const query=food.searchQuery||food.subCategory||food.category||"レストラン";
  const request={
    textQuery:query,
    fields:["id","displayName","location","primaryTypeDisplayName","types","photos","regularOpeningHours","reviews","websiteURI","googleMapsURI","formattedAddress"],
    locationBias:{center:{lat,lng},radius:700},
    maxResultCount:15,
    language:"ja",
    region:"jp"
  };
  const {places}=await Place.searchByText(request);
  return (places||[]).map(place=>normalizePlace(place,lat,lng));
}

function normalizePlace(place,lat,lng){
  const pLat=typeof place.location?.lat==="function"?place.location.lat():place.location?.lat;
  const pLng=typeof place.location?.lng==="function"?place.location.lng():place.location?.lng;
  const photo=place.photos?.[0];
  return {
    id:place.id,
    name:place.displayName||"店名不明",
    address:place.formattedAddress||"",
    lat:pLat,lng:pLng,
    distance:pLat==null?9999:haversine(lat,lng,pLat,pLng),
    genre:place.primaryTypeDisplayName||"",
    types:place.types||[],
    hours:place.regularOpeningHours||null,
    reviews:(place.reviews||[]).slice(0,5).map(r=>typeof r.text==="string"?r.text:(r.text?.text||"")).filter(Boolean),
    website:place.websiteURI||null,
    mapsURI:place.googleMapsURI||null,
    photoURI:photo?.getURI?.({maxWidth:600,maxHeight:600})||null,
    photoCredit:(photo?.authorAttributions||[]).map(a=>a.displayName).filter(Boolean).join(", ")
  };
}

async function rankPlaces(places,food,userPhoto,meta){
  const photographedAt=meta.date||new Date();
  const preliminary=places.map(place=>{
    const distanceScore=Math.max(0,1-place.distance/700);
    const openScore=isOpenAt(place.hours,photographedAt);
    const searchable=`${place.name} ${place.genre} ${place.types.join(" ")} ${place.reviews.join(" ")}`.toLowerCase();
    const terms=[food.category,food.subCategory,food.soup,food.cookingMethod,...(food.toppings||[]),...(food.ingredients||[]),...(food.menuCandidates||[])].filter(Boolean);
    const lexical=terms.length?terms.filter(t=>searchable.includes(String(t).toLowerCase())).length/terms.length:.5;
    return {...place,distanceScore,openScore,lexical,preScore:distanceScore*.3+openScore*.2+lexical*.5};
  }).sort((a,b)=>b.preScore-a.preScore);

  const visualTargets=preliminary.filter(p=>p.photoURI).slice(0,5);
  let aiMatches={};
  if(visualTargets.length){
    try{aiMatches=await comparePlacePhotos(userPhoto,food,visualTargets);}catch(e){showError(`店舗写真比較を省略しました: ${e.message}`);}
  }
  return preliminary.map(place=>{
    const ai=aiMatches[place.id]||{};
    const imageScore=place.photoURI?(number01(ai.imageSimilarity)??.5):.4;
    const genreScore=number01(ai.genreMatch)??place.lexical;
    const menuScore=number01(ai.menuMatch)??place.lexical;
    const reviewScore=number01(ai.reviewMatch)??place.lexical;
    const score=Math.round(100*(place.distanceScore*.15+place.openScore*.10+genreScore*.15+menuScore*.20+imageScore*.35+reviewScore*.05));
    return {...place,imageScore,genreScore,menuScore,reviewScore,score,reason:ai.reason||"距離・営業時間・店舗情報から算出"};
  }).sort((a,b)=>b.score-a.score).slice(0,3);
}

async function comparePlacePhotos(userPhoto,food,places){
  const placeData=places.map((p,i)=>({index:i+1,id:p.id,name:p.name,genre:p.genre,reviews:p.reviews.join(" / ").slice(0,1200)}));
  const content=[{type:"input_text",text:`最初の画像はユーザーの料理写真です。続く画像は、次の店舗と同じ順番のGoogle店舗写真です。料理特徴と口コミも使い、各店との一致度を0～1で評価してください。店内外観写真しかない場合、画像類似度は中立値にしてください。JSONのみ返してください。
料理特徴:${JSON.stringify(food)}
店舗:${JSON.stringify(placeData)}
形式:{"matches":[{"id":"place id","imageSimilarity":0.8,"genreMatch":0.9,"menuMatch":0.8,"reviewMatch":0.7,"reason":"短い理由"}]}`} ,{type:"input_image",image_url:userPhoto,detail:"high"}];
  places.forEach(p=>content.push({type:"input_image",image_url:p.photoURI,detail:"low"}));
  const result=await callOpenAI(content,1400,"gpt-5.4-mini");
  return Object.fromEntries((result.matches||[]).map(x=>[x.id,x]));
}

async function callOpenAI(content,maxTokens,model){
  const key=localStorage.getItem("openai-api-key");
  if(!key)throw new Error("設定画面でOpenAI APIキーを保存してください。");
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model,input:[{role:"user",content}],max_output_tokens:maxTokens})});
  if(!response.ok){let msg=`OpenAI APIエラー（${response.status}）`;try{msg=(await response.json()).error.message}catch{}throw new Error(msg);}
  const json=await response.json(),text=(json.output||[]).flatMap(x=>x.content||[]).map(x=>x.text).find(Boolean),match=text?.match(/\{[\s\S]*\}/);
  if(!match)throw new Error("AIの回答を読み取れませんでした。");
  return JSON.parse(match[0]);
}

function isOpenAt(hours,date){
  const periods=hours?.periods; if(!periods?.length)return .5;
  const day=date.getDay(),minutes=date.getHours()*60+date.getMinutes();
  for(const period of periods){
    const open=period.open,close=period.close;
    if(!open)continue;
    const od=open.day,om=(open.hour||0)*60+(open.minute||0);
    if(!close){if(od===0&&om===0)return 1;continue;}
    const cd=close.day,cm=(close.hour||0)*60+(close.minute||0);
    if(od===cd&&day===od&&minutes>=om&&minutes<cm)return 1;
    if(od!==cd&&((day===od&&minutes>=om)||(day===cd&&minutes<cm)))return 1;
  }
  return 0;
}

function renderRankedPlaces(){
  const root=$("rankedPlaces");root.innerHTML="";
  state.rankedPlaces.forEach((place,index)=>{
    const button=document.createElement("button");button.type="button";button.className="place-card";button.dataset.placeId=place.id;
    const scoreClass=place.score>=90?"score-high":place.score<60?"score-low":"";
    button.innerHTML=`${place.photoURI?`<img src="${escapeAttr(place.photoURI)}" alt="${escapeAttr(place.name)}の店舗写真">`:`<span class="place-photo-placeholder">🍽️</span>`}<span class="place-main"><strong>${["🥇","🥈","🥉"][index]} ${escapeHtml(place.name)}</strong><small>${Math.round(place.distance)}m・${escapeHtml(place.genre||"飲食店")}</small><small>${escapeHtml(place.reason)}</small><span class="score-details"><span>距離 ${pct(place.distanceScore)}</span><span>営業 ${place.openScore===.5?"不明":pct(place.openScore)}</span><span>料理 ${pct(place.menuScore)}</span><span>写真 ${pct(place.imageScore)}</span></span>${place.photoCredit?`<small class="photo-credit">写真: ${escapeHtml(place.photoCredit)} / Google</small>`:""}</span><span class="place-score ${scoreClass}">${place.score}%</span>`;
    button.onclick=()=>selectPlace(place.id);root.append(button);
  });
  $("rankedPlacesSection").classList.remove("hidden");
}

function selectPlace(id){const place=state.rankedPlaces.find(p=>p.id===id);if(!place)return;state.selectedPlaceId=id;$("restaurantName").value=place.name;document.querySelectorAll(".place-card").forEach(el=>el.classList.toggle("selected",el.dataset.placeId===id));}

$("mealForm").addEventListener("submit",async event=>{
  event.preventDefault();if(!state.photoDataURL)return;
  const selected=state.rankedPlaces.find(p=>p.id===state.selectedPlaceId);
  const record={id:crypto.randomUUID(),image:state.photoDataURL,photographedAt:new Date($("photographedAt").value||Date.now()).toISOString(),latitude:state.photoMeta?.latitude??null,longitude:state.photoMeta?.longitude??null,restaurantName:$("restaurantName").value.trim(),placeId:selected?.id||null,menuName:$("menuName").value.trim(),menuCandidates:state.menuCandidates,confidence:selected?.score??null,foodFeatures:state.food||null,createdAt:new Date().toISOString()};
  await store("put",record);resetForm();showView("listView");
});

async function renderMeals(){const meals=await allMeals(),grid=$("mealGrid");grid.innerHTML="";$("emptyState").classList.toggle("hidden",meals.length>0);meals.forEach(meal=>{const button=document.createElement("button");button.className="meal-tile";button.innerHTML=`<img alt="" src="${meal.image}"><span class="meal-caption"><strong>${escapeHtml(meal.menuName||"メニュー未設定")}</strong><small>${escapeHtml(meal.restaurantName||"店名未設定")}${meal.confidence?` · ${meal.confidence}%`:""}</small></span>`;button.onclick=()=>showDetail(meal.id);grid.append(button);});}
async function showDetail(id){const meal=await getMeal(id);$("detailContent").innerHTML=`<img class="detail-photo" src="${meal.image}" alt="料理写真"><div class="detail-fields"><label>店名<input id="detailRestaurant" value="${escapeAttr(meal.restaurantName||"")}"></label><label>メニュー名<input id="detailMenu" value="${escapeAttr(meal.menuName||"")}"></label><label>撮影日時<input id="detailDate" type="datetime-local" value="${toLocalInput(new Date(meal.photographedAt))}"></label>${meal.confidence?`<p class="note">店舗推定スコア: ${meal.confidence}%</p>`:""}<div class="detail-actions"><button id="updateMeal" class="primary">更新</button><button id="deleteMeal" class="danger">削除</button></div></div>`;$("updateMeal").onclick=async()=>{meal.restaurantName=$("detailRestaurant").value.trim();meal.menuName=$("detailMenu").value.trim();meal.photographedAt=new Date($("detailDate").value).toISOString();await store("put",meal);showView("listView");};$("deleteMeal").onclick=async()=>{if(confirm("この記録を削除しますか？")){await store("delete",id);showView("listView");}};showView("detailView");}

$("saveKeyButton").onclick=()=>saveLocalKey("openai-api-key","apiKey","keyStatus");
$("deleteKeyButton").onclick=()=>deleteLocalKey("openai-api-key","keyStatus");
$("saveGoogleKeyButton").onclick=()=>saveLocalKey("google-places-api-key","googleApiKey","googleKeyStatus");
$("deleteGoogleKeyButton").onclick=()=>{deleteLocalKey("google-places-api-key","googleKeyStatus");googleMapsPromise=null;};
function saveLocalKey(storageKey,inputId,statusId){const key=$(inputId).value.trim();if(!key)return;localStorage.setItem(storageKey,key);$(inputId).value="";$(statusId).textContent="この端末に保存しました。";}
function deleteLocalKey(storageKey,statusId){localStorage.removeItem(storageKey);$(statusId).textContent="削除しました。";}
$("exportButton").onclick=async()=>{const data=JSON.stringify(await allMeals(),null,2),blob=new Blob([data],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`gohan-log-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);};

function renderChips(id,labels,handler){const el=$(id);el.innerHTML="";labels.forEach((label,i)=>{const b=document.createElement("button");b.type="button";b.textContent=label;b.onclick=()=>handler(label,i);el.append(b);});}
function setBusy(value,text){$("analysisStatus").classList.toggle("hidden",!value);if(text)$("analysisText").textContent=text;}
function showError(text){$("errorMessage").textContent=text;$("errorMessage").classList.remove("hidden");}
function clearError(){$("errorMessage").classList.add("hidden");}
function clearAnalysis(){$("foodFeatures").classList.add("hidden");$("rankedPlacesSection").classList.add("hidden");$("rankedPlaces").innerHTML="";state.food=null;state.rankedPlaces=[];state.selectedPlaceId=null;}
function resetForm(){$("mealForm").reset();$("preview").style.display="none";$("photoPrompt").style.display="block";$("menuCandidates").innerHTML="";clearAnalysis();clearError();state.photoDataURL=null;state.photoMeta=null;state.menuCandidates=[];}
function number01(x){const n=Number(x);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):null;}
function pct(x){return `${Math.round((x??0)*100)}%`;}
function toLocalInput(date){const d=new Date(date.getTime()-date.getTimezoneOffset()*60000);return d.toISOString().slice(0,16);}
function haversine(a,b,c,d){const r=6371000,p=Math.PI/180,x=(c-a)*p,y=(d-b)*p,z=Math.sin(x/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(y/2)**2;return 2*r*Math.asin(Math.sqrt(z));}
function escapeHtml(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML;}
function escapeAttr(s){return escapeHtml(s).replaceAll('"','&quot;');}
function resizeImage(file,max,q){return new Promise((resolve,reject)=>{const img=new Image(),url=URL.createObjectURL(file);img.onload=()=>{const scale=Math.min(1,max/Math.max(img.width,img.height)),canvas=document.createElement("canvas");canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);URL.revokeObjectURL(url);resolve(canvas.toDataURL("image/jpeg",q));};img.onerror=reject;img.src=url;});}

// JPEG/TIFF EXIFから撮影日時とGPSを読み取る。対応タグがない場合は空オブジェクト。
function parseExif(buffer){try{const v=new DataView(buffer);if(v.getUint16(0)!==0xffd8)return{};let p=2;while(p<v.byteLength){if(v.getUint16(p)===0xffe1&&ascii(v,p+4,6)==="Exif\0\0")return parseTiff(v,p+10);p+=2+v.getUint16(p+2);}return{};}catch{return{};}}
function parseTiff(v,start){const little=v.getUint16(start)===0x4949,u16=o=>v.getUint16(start+o,little),u32=o=>v.getUint32(start+o,little);function entries(offset){const out={};for(let i=0,n=u16(offset);i<n;i++){const o=offset+2+i*12,tag=u16(o),type=u16(o+2),count=u32(o+4),value=count*(type===3?2:type===5?8:1)>4?u32(o+8):o+8;out[tag]={type,count,value};}return out;}function str(e){let s="";for(let i=0;i<e.count-1;i++)s+=String.fromCharCode(v.getUint8(start+e.value+i));return s;}function rationals(e){const a=[];for(let i=0;i<e.count;i++){const o=e.value+i*8;a.push(u32(o)/u32(o+4));}return a;}const root=entries(u32(4)),result={};if(root[0x8769]){const ex=entries(u32(root[0x8769].value));if(ex[0x9003]){const m=str(ex[0x9003]).match(/(\d+):(\d+):(\d+) (\d+):(\d+):(\d+)/);if(m)result.date=new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]);}}if(root[0x8825]){const gps=entries(u32(root[0x8825].value));if(gps[1]&&gps[2]&&gps[3]&&gps[4]){const la=rationals(gps[2]),lo=rationals(gps[4]);result.latitude=la[0]+la[1]/60+la[2]/3600;result.longitude=lo[0]+lo[1]/60+lo[2]/3600;if(str(gps[1])==="S")result.latitude*=-1;if(str(gps[3])==="W")result.longitude*=-1;}}return result;}
function ascii(v,o,n){let s="";for(let i=0;i<n;i++)s+=String.fromCharCode(v.getUint8(o+i));return s;}

if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js");
if(!localStorage.getItem("openai-api-key")||!localStorage.getItem("google-places-api-key"))showView("settingsView");else renderMeals();
