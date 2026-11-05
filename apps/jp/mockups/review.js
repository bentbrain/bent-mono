const canvas = document.getElementById('canvas');
const screen = document.getElementById('screen');
const viewport = document.getElementById('viewport');
const dark = document.getElementById('dark');
const panel = document.getElementById('feedback-panel');
const form = document.getElementById('note-form');
const commentText = document.getElementById('comment-text');
const state = { surface: 'journal', viewport: 'desktop', dark: false, commenting: false, category: 'all', selectedMedia: 0, selectedExport: new Set([0, 1, 3, 5, 6, 7]), beers: 3, notes: [], target: null, mapCity: 'tokyo', playing: false, exportDay: 'tokyo', counterMode: 'both', showSafeAreas: true, mapPreviewOpen: false };
const assets = '/assets/';
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
const media = [
  { image: 'tokyo.jpg', place: 'tokyo', category: 'shopping', lat: 35.6895, lng: 139.6917 },
  { image: 'japan.jpg', place: 'tokyo', category: 'food', lat: 35.6938, lng: 139.7034 },
  { image: 'kyoto.jpg', place: 'kyoto', category: 'landscape', lat: 35.0116, lng: 135.7681 },
  { image: 'tokyo.jpg', place: 'tokyo', category: 'shopping', video: true, lat: 35.6895, lng: 139.6917 },
  { image: 'kyoto.jpg', place: 'kyoto', category: 'landscape', lat: 35.0116, lng: 135.7681 },
  { image: 'japan.jpg', place: 'tokyo', category: 'food', video: true, lat: 35.6938, lng: 139.7034 },
  { image: 'tokyo.jpg', place: 'tokyo', category: 'shopping', lat: 35.6895, lng: 139.6917 },
  { image: 'japan.jpg', place: 'tokyo', category: 'food', lat: null, lng: null },
  { image: 'kyoto.jpg', place: 'kyoto', category: 'landscape', lat: 35.0116, lng: 135.7681 },
];
media.forEach(item => { item.categories = [item.category]; });
const sprites = {
  beer: ['0000000000000000','0000000000000000','0001111111100000','0011000000110000','0010000000111100','0010101010100100','0010101010100100','0010101010100100','0010101010100100','0010101010111100','0010101010100000','0010101010100000','0010101010100000','0010000000100000','0001111111000000','0000000000000000'],
  rice: ['0000000000000000','0000000110000000','0000001001000000','0000010000100000','0000100000010000','0001000000001000','0010000000000100','0100000000000010','0100000000000010','0100001111000010','0100001111000010','0100001111000010','0010001111000100','0001111111111000','0000000000000000','0000000000000000'],
  shirt: ['0000000000000000','0001100000011000','0010011001100100','0100001111000010','0100000000000010','0111000000001110','0001000000001000','0001001010001000','0001000000001000','0001001110001000','0001000000001000','0001000000001000','0001111111111000','0000000000000000','0000000000000000','0000000000000000'],
  mountain: ['0000000000000000','0000000110000000','0000001111000000','0000010110100000','0000100000010000','0001000000001000','0010000000000100','0100000000000010','0100000000000010','0111111111111110','0000000000000000','0000000000000000','0000000000000000','0000000000000000','0000000000000000','0000000000000000'],
  bag: ['0000000000000000','0000011111000000','0000100000100000','0000100000100000','0001111111110000','0001000000010000','0001000000010000','0001001010010000','0001000000010000','0001001110010000','0001000000010000','0001000000010000','0001111111110000','0000000000000000','0000000000000000','0000000000000000'],
};
const icon = name => `<span class="pixel" data-pixel="${name}" aria-hidden="true"></span>`;
const review = (target, label) => `data-review="${escapeHtml(state.surface)}-${escapeHtml(target)}" data-review-label="${escapeHtml(label)}"`;
function header(admin = false) {
  return `<header class="site-header"><button class="brand" data-go="${admin ? 'posts' : 'journal'}" ${review('brand', 'Brand')}>jp.bent.build${admin ? ' / admin' : ''}</button>${!admin ? `<nav class="site-nav" ${review('navigation', 'Public navigation')}>${['journal','gallery'].map(name => `<button data-go="${name}" class="${state.surface === name ? 'active' : ''}">${name}</button>`).join('')}</nav><div class="beer" ${review('beer', 'Trip beer counter')}>${icon('beer')}<strong>27</strong><span>beers</span></div>` : '<span>liam</span>'}</header>${admin ? `<nav class="admin-tabs" ${review('navigation', 'Admin navigation')}>${[['posts','posts'],['media','media'],['export','export']].map(([id,name]) => `<button class="${state.surface === id || id === 'posts' && state.surface === 'editor' ? 'active' : ''}" data-go="${id}">${name}</button>`).join('')}</nav>` : ''}`;
}
function ad() { return `<a class="ad" href="https://shop.bent.build/?utm_source=jp.bent.build&utm_medium=blog" target="_blank" rel="noopener" ${review('shop-ad', 'Shop promotion')}><span class="shop-logo" aria-hidden="true"></span>shop.bent.build ↗</a>`; }
function tile(item, index, action = 'view') {
  const selected = action === 'select-export' ? state.selectedExport.has(index) : action === 'select-media' && state.selectedMedia === index;
  return `<button class="media-tile ${selected ? 'selected' : ''}" data-action="${action}" data-index="${index}" aria-label="${item.place} ${item.category} ${item.video ? 'video' : 'photo'} ${index + 1}" ${review(`media-${index}`, `${item.video ? 'Video' : 'Photo'} ${index + 1}`)}><img src="${assets}${item.image}" alt="Sample ${item.place} image" style="object-position:${index % 2 ? '70% center' : 'center'}" loading="lazy">${item.video ? '<span class="clip">▶ 00:08</span>' : ''}</button>`;
}
function filters() {
  return `<div class="filters" ${review('filters', 'Media categories')}>${[['all',''],['food','rice'],['shopping','bag'],['landscape','mountain']].map(([name,sprite])=>`<button data-category="${name}" class="${state.category === name ? 'active' : ''}">${sprite ? icon(sprite) : ''}${name}</button>`).join('')}</div>`;
}
function mapPane() {
  return `<div class="map-wrap" ${review('map','Japan media map')}><svg id="japan-map" role="img" aria-label="Japan map with sample media markers"></svg><div class="map-detail" ${review('map-preview','Map preview')} ${state.mapPreviewOpen?'':'hidden'}><button class="map-close" data-action="close-map-preview" aria-label="Close map preview">×</button><img id="map-image" src="${assets}${state.mapCity==='kyoto'?'kyoto.jpg':'tokyo.jpg'}" alt="Sample selected media"><p id="map-place">${state.mapCity}</p><button data-action="map-view">VIEW MEDIA →</button></div></div>`;
}
function journalMedia(indexes) {
  return `<div class="journal-media" role="region" aria-label="Post media" tabindex="0">${indexes.map(index=>media[index].video?`<div class="media-tile inline-video" ${review(`media-${index}`,`Video ${index+1}`)}><video src="${assets}sample.mp4" poster="${assets}${media[index].image}" controls playsinline preload="metadata"></video></div>`:tile(media[index],index)).join('')}</div>`;
}
function journal() {
  const posts=[
    {place:'tokyo',date:'15 oct / day 04',time:'2026-10-15',text:'Spent the evening walking through Shinjuku. Stopped for dinner, then kept walking.',images:[0,1,3]},
    {place:'kyoto',date:'14 oct / day 03',time:'2026-10-14',text:'An afternoon in Higashiyama.',images:[2,4,8]},
    {place:'tokyo',date:'13 oct / day 02',time:'2026-10-13',text:'Checked in, then went for a walk.',images:[6,5,7]},
  ].sort((a,b)=>b.time.localeCompare(a.time));
  return `${header()}<div class="content"><div class="journal-grid"><section class="journal-card journal-map-card"><div class="journal-card-inner">${mapPane()}</div></section>${posts.map((post,index)=>`<article class="journal-card journal-entry" data-date="${post.time}"><div class="journal-card-inner"><div class="day-header" ${review(index===0?'day-heading':`day-heading-${index}`,'Day heading')}><h1>${post.place}</h1><small>${post.date}</small></div><div class="journal-body" ${review(index===0?'day-summary':`post-content-${index}`,'Post content')}><p>${post.text}</p></div>${journalMedia(post.images)}</div></article>`).join('')}</div>${ad()}</div>`;
}

function post() {
  return `${header()}<article class="content post-prose"><div class="day-header" ${review('post-meta','Post date and authorship')}><span>15 oct / tokyo</span></div><h1 ${review('title','Post title')}>tokyo, after dark</h1><p ${review('body','Post body')}>Spent the evening walking through Shinjuku. Stopped for dinner, then kept walking.</p><div class="photo-grid big">${[0,1,3].map(i=>tile(media[i],i)).join('')}</div><div class="caption-row"><span>shinjuku</span><span>3 beers / 27 total</span></div>${ad()}</article>`;
}
function gallery() {
  const items = media.map((item,index)=>({ item,index })).filter(({item})=>state.category === 'all' || item.categories.includes(state.category));
  return `${header()}<div class="content">${filters()}<div class="photo-grid" ${review('grid','Gallery grid')}>${items.map(({item,index})=>tile(item,index)).join('')}</div>${ad()}</div>`;
}
function viewer() {
  const item=media[state.selectedMedia];
  return `${header()}<section class="lightbox" ${review('viewer','Media viewer')}><div class="lightbox-top"><span>${state.selectedMedia+1} / ${media.length}</span><button data-go="gallery" aria-label="Close media">CLOSE ×</button></div>${item.video ? `<video src="${assets}sample.mp4" poster="${assets}${item.image}" controls playsinline preload="metadata"></video>` : `<img src="${assets}${item.image}" alt="Sample ${item.place} image">`}<div class="actions"><button data-action="previous">← PREVIOUS</button><button data-action="next">NEXT →</button></div></section><div class="media-details" ${review('details','Media metadata')}><span>${item.place} / 15 oct / ${escapeHtml(item.categories.join(', '))}</span><button data-go="map">VIEW ON MAP</button></div>`;
}
function map() { return journal(); }

function login() {
  return `<header class="site-header"><button class="brand" data-go="journal" ${review('brand','Brand')}>jp.bent.build</button></header><div class="login" ${review('login','Owner sign in')}>${icon('beer')}<h1>sign in</h1><button class="primary" data-action="passkey" ${review('passkey','Passkey sign in button')}>USE PASSKEY</button></div>`;
}
function posts() {
  return `${header(true)}<div class="content"><div class="section-heading"><h1>posts</h1><button class="primary" data-go="editor" ${review('new-post','Create post action')}>NEW POST</button></div><table class="table" ${review('post-list','Post list')}><thead><tr><th>title</th><th>date</th><th>status</th><th></th></tr></thead><tbody><tr><td>tokyo, after dark</td><td>15 oct</td><td>draft</td><td><button data-go="editor">EDIT</button></td></tr><tr><td>kyoto</td><td>14 oct</td><td>published</td><td><button data-go="editor">EDIT</button></td></tr></tbody></table><div class="beer-edit" ${review('beer-entry','Daily beer entry')}>${icon('beer')}<span>15 oct</span><button data-action="beer-minus" aria-label="Remove one beer">−</button><strong id="daily-beers">${state.beers}</strong><button data-action="beer-plus" aria-label="Add one beer">+</button></div></div>`;
}
function editor() {
  return `${header(true)}<div class="content"><div class="section-heading"><h1>edit post</h1><small>draft / liam</small></div><div class="editor-layout"><div ${review('rich-editor','Rich text editor')}><div class="editor-toolbar" ${review('editor-toolbar','Editor toolbar')}><button data-format="bold" aria-label="Bold"><b>B</b></button><button data-format="italic" aria-label="Italic"><i>I</i></button><button data-format="insertUnorderedList" aria-label="Bullet list">LIST</button><button data-action="insert-media">+ MEDIA</button></div><div class="editable" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Post content"><h2>tokyo, after dark</h2><p>Spent the evening walking through Shinjuku.</p><img src="${assets}tokyo.jpg" alt="Sample Tokyo image" contenteditable="false"></div></div><aside class="editor-side" ${review('publish-settings','Post publishing settings')}><label>date<input type="date" value="2026-10-15"></label><label>place<input value="tokyo"></label><label>author<input value="liam" readonly></label><div class="actions"><button data-action="save-draft">SAVE DRAFT</button><button class="primary" data-action="publish">PUBLISH</button><button data-go="post">PREVIEW</button></div></aside></div></div>`;
}
function mediaManager() {
  const item=media[state.selectedMedia];
  return `${header(true)}<div class="content"><div class="section-heading"><h1>media</h1><button class="primary" data-action="upload" ${review('upload','Upload media action')}>UPLOAD</button></div><div class="media-layout"><div><div class="photo-grid">${media.map((item,index)=>tile(item,index,'select-media')).join('')}</div></div><aside class="media-side" ${review('media-fields','Media metadata editor')}><img src="${assets}${item.image}" alt="Selected sample image"><label>captured<input type="datetime-local" value="2026-10-15T19:42"></label><label>location<input id="media-location" value="${item.lat === null ? '' : `${item.lat}, ${item.lng}`}" placeholder="set a location"></label>${item.lat === null ? '<div class="missing">location required</div>' : ''}<button data-action="set-pin">SET PIN</button><label style="margin-top:17px">categories</label><div class="tag-options">${['food','shopping','landscape'].map(name=>`<button class="${item.categories.includes(name) ? 'active' : ''}" data-tag="${name}">${name}</button>`).join('')}</div><div class="actions"><button data-action="save-media" class="primary">SAVE</button></div></aside></div></div>`;
}
function exporter() {
  const dayMedia=media.map((item,index)=>({item,index})).filter(({item})=>item.place===state.exportDay);
  const selected=dayMedia.filter(({index})=>state.selectedExport.has(index));
  const cards=selected.slice(0,3).map(({item},index)=>`<div class="stack ${index===2?'back':index===1?'middle':''}">${item.video?`<video src="${assets}sample.mp4" poster="${assets}${item.image}" muted loop playsinline ${state.playing?'autoplay':''}></video>`:`<img src="${assets}${item.image}" alt="Sample photo tile">`}</div>`).reverse().join('');
  const today=state.exportDay==='tokyo'?'03':'04',total=state.exportDay==='tokyo'?'27':'24';
  return `${header(true)}<div class="content"><div class="section-heading"><h1>story export</h1><small>1080 × 1920</small></div><div class="export-layout"><div class="export-settings"><label ${review('export-day','Export day selection')}>day<select id="export-day"><option value="tokyo" ${state.exportDay==='tokyo'?'selected':''}>15 oct / tokyo</option><option value="kyoto" ${state.exportDay==='kyoto'?'selected':''}>14 oct / kyoto</option></select></label><div class="photo-grid" ${review('export-selection','Export media selection')}>${dayMedia.map(({item,index})=>tile(item,index,'select-export')).join('')}</div><p class="export-status" id="selected-count">${selected.length} selected</p><label ${review('beer-setting','Export beer counter setting')}>beer counter<select id="counter-mode">${[['both','today + trip total'],['today','today'],['total','trip total'],['hidden','hidden']].map(([value,label])=>`<option value="${value}" ${state.counterMode===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="safe-area-toggle"><input id="safe-areas" type="checkbox" ${state.showSafeAreas?'checked':''}> safe area guides</label><div class="actions" ${review('export-actions','Story export actions')}><button data-action="play-stack">${state.playing?'PAUSE':'PLAY PREVIEW'}</button><button data-action="export-mp4" class="primary">EXPORT MP4</button><button data-action="export-png">EXPORT PNG</button></div></div><div class="story ${state.playing?'running':''} ${state.showSafeAreas?'show-guides':''}" ${review('story-composition','Isometric story composition')}><div class="story-safe-area" aria-hidden="true"></div><div class="story-title">${escapeHtml(state.exportDay)} / ${state.exportDay==='tokyo'?'15':'14'} oct</div>${cards}${state.counterMode!=='hidden'?`<div class="story-beer" ${review('story-beer','Story beer counter')}>${icon('beer')}<div><strong>${state.counterMode==='total'?total:today}</strong><small>${state.counterMode==='both'?`today / ${total} total`:state.counterMode==='total'?'total':'today'}</small></div></div>`:''}</div></div></div>`;
}

const screens={ journal,post,gallery,viewer,map,login,posts,editor,media:mediaManager,export:exporter };
let countries;
let toastTimer;
function toast(text) {
  const el=document.getElementById('demo-status');el.textContent=text;el.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.style.display='none',3500);
}
function pixelize() {
  canvas.querySelectorAll('[data-pixel]').forEach(el=>sprites[el.dataset.pixel].forEach(row=>row.split('').forEach(bit=>{const cell=document.createElement('i');if(bit==='0')cell.style.background='transparent';el.append(cell);})));
}
function render() {
  if(state.surface==='map')state.surface='journal';
  canvas.querySelectorAll('video').forEach(video=>video.pause());
  canvas.classList.toggle('mobile',state.viewport==='mobile');canvas.classList.toggle('dark',state.dark);canvas.classList.toggle('commenting',state.commenting);
  canvas.innerHTML=screens[state.surface]();pixelize();screen.value=state.surface;viewport.value=state.viewport;dark.checked=state.dark;
  document.querySelectorAll('[data-screen]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.screen===state.surface)));
  document.querySelectorAll('[data-viewport]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.viewport===state.viewport)));
  if(state.surface==='journal')drawMap();requestAnimationFrame(()=>{layoutJournal();drawPins();});
  localStorage.setItem('jp-review-view',JSON.stringify({surface:state.surface,viewport:state.viewport,dark:state.dark}));
}
function go(surface) {
  state.surface=Object.keys(screens).find(name=>name===surface && name!=='map')||'journal';state.target=null;form.hidden=true;render();window.scrollTo(0,0);
}
async function drawMap() {
  const svg=canvas.querySelector('#japan-map');if(!svg)return;
  try {
    if(!countries){const response=await fetch(`${assets}countries.json`);if(!response.ok)throw new Error();countries=await response.json();}
    if(!svg.isConnected)return;
    const features=topojson.feature(countries,countries.objects.countries).features;
    const japan=features.find(feature=>feature.id==='392');
    const width=Math.max(300,svg.parentElement.clientWidth),height=svg.parentElement.clientHeight;
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
    const projection=d3.geoMercator().fitExtent([[width*.18,22],[width*.87,height-25]],japan);
    const path=d3.geoPath(projection);const group=d3.select(svg);group.selectAll('*').remove();
    group.selectAll('path').data([japan]).join('path').attr('class','map-land').attr('d',path);
    const filtered=media.filter(item=>item.lat!==null);
    const locations=[{name:'tokyo',coords:[139.6917,35.6895]},{name:'kyoto',coords:[135.7681,35.0116]}].map(point=>({...point,count:filtered.filter(item=>item.place===point.name).length})).filter(point=>point.count>0);
    if(!locations.some(point=>point.name===state.mapCity))state.mapCity=locations[0]?.name||'tokyo';
    const updatePreview=name=>{canvas.querySelector('#map-image').src=`${assets}${name==='kyoto'?'kyoto.jpg':'tokyo.jpg'}`;canvas.querySelector('#map-place').textContent=name;};
    updatePreview(state.mapCity);
    locations.forEach(point=>{
      const [x,y]=projection(point.coords);
      const g=group.append('g').attr('role','button').attr('tabindex',0).attr('aria-label',`${point.name}, ${point.count} sample items`).attr('data-review',`${state.surface}-map-marker-${point.name}`).attr('data-review-label',`${point.name} map marker`);
      g.append('circle').attr('cx',x).attr('cy',y).attr('r',15).attr('class','map-pin');
      g.append('text').attr('x',x).attr('y',y+4).attr('text-anchor','middle').attr('fill','var(--paper)').style('font','11px monospace').text(point.count);
      g.append('text').attr('x',point.name==='kyoto'?x-21:x+21).attr('y',y+4).attr('text-anchor',point.name==='kyoto'?'end':'start').attr('class','map-label').text(point.name);
      const choose=()=>{if(state.commenting)return;state.mapCity=point.name;state.mapPreviewOpen=true;updatePreview(point.name);canvas.querySelector('.map-detail').hidden=false;drawPins();};
      g.on('mouseenter',choose).on('click',choose).on('keydown',event=>{if(event.key==='Enter'||event.key===' ')choose();});
    });
    layoutJournal();drawPins();
  }catch{toast('Map preview unavailable.');}
}
function layoutJournal() {
  const grid=canvas.querySelector('.journal-grid');if(!grid)return;
  const style=getComputedStyle(grid),row=parseFloat(style.gridAutoRows),gap=parseFloat(style.rowGap);
  if(!Number.isFinite(row)||row<=0)return;
  grid.querySelectorAll('.journal-card').forEach(card=>{const height=card.querySelector('.journal-card-inner').getBoundingClientRect().height;const span=Math.ceil((height+gap)/(row+gap));card.style.gridRowEnd=`span ${span}`;});
}
function noteSurface(note){return note.surface==='map'?'journal':note.surface;}
function noteTarget(note){return note.surface==='map'?note.target.replace(/^map-/,'journal-'):note.target;}
function drawPins() {
  canvas.querySelectorAll('.comment-pin').forEach(pin=>pin.remove());const base=canvas.getBoundingClientRect();
  state.notes.forEach((note,index)=>{
    if(noteSurface(note)!==state.surface||note.viewport!==state.viewport||note.dark!==state.dark)return;
    const target=canvas.querySelector(`[data-review="${noteTarget(note)}"]`);if(!target)return;
    const rect=target.getBoundingClientRect(),scroller=target.closest('.journal-media');if(scroller){const view=scroller.getBoundingClientRect(),x=rect.left+rect.width*note.x,y=rect.top+rect.height*note.y;if(x<view.left||x>view.right||y<view.top||y>view.bottom)return;}const button=document.createElement('button');button.className='comment-pin';button.textContent=index+1;button.setAttribute('aria-label',`Feedback ${index+1}: ${note.label}`);
    button.style.left=`${rect.left-base.left+rect.width*note.x}px`;button.style.top=`${rect.top-base.top+rect.height*note.y}px`;
    button.addEventListener('click',()=>openNote(note));canvas.append(button);
  });
}
function showNotes() {
  const list=document.getElementById('note-list');list.replaceChildren();document.getElementById('note-count').textContent=state.notes.length;
  if(!state.notes.length){const p=document.createElement('p');p.textContent='No feedback yet.';list.append(p);}
  state.notes.forEach((note,index)=>{const article=document.createElement('article');article.className='feedback-note';article.id=`note-${note.id}`;const button=document.createElement('button');button.textContent=`${index+1}. ${note.surface} / ${note.label}`;button.addEventListener('click',()=>openNote(note));const meta=document.createElement('small');meta.textContent=`${note.viewport} / ${note.dark?'dark':'light'} / ${note.revision} / ${note.status}`;const p=document.createElement('p');p.textContent=note.text;article.append(button,meta,p);if(note.response){const reply=document.createElement('p');reply.className='feedback-response';reply.textContent=note.response;article.append(reply);}list.append(article);});
}
function openNote(note) {
  state.viewport=note.viewport;state.dark=note.dark;go(note.surface);panel.hidden=false;showNotes();requestAnimationFrame(()=>{const target=canvas.querySelector(`[data-review="${noteTarget(note)}"]`);target?.classList.add('review-note-focus');target?.scrollIntoView({block:'center',inline:'nearest'});if(panel.scrollHeight>panel.clientHeight)document.getElementById(`note-${note.id}`)?.scrollIntoView({block:'nearest'});});
}
async function loadNotes() {
  try {const response=await fetch('/api/feedback');if(!response.ok)throw new Error();const data=await response.json();if(!Array.isArray(data))throw new Error();state.notes=data;document.getElementById('feedback-status').textContent='feedback saved locally';showNotes();drawPins();}
  catch{document.getElementById('feedback-status').textContent='feedback connection unavailable';}
}
function draftKey(){return state.target ? `jp-review-draft:${state.surface}:${state.target.target}` : null;}
canvas.addEventListener('click',event=>{
  if(!state.commenting||event.target.closest('.comment-pin'))return;
  const target=event.target.closest('[data-review]');if(!target)return;
  event.preventDefault();event.stopImmediatePropagation();canvas.querySelectorAll('.review-selected').forEach(el=>el.classList.remove('review-selected'));target.classList.add('review-selected');
  const rect=target.getBoundingClientRect();state.target={target:target.dataset.review,label:target.dataset.reviewLabel,x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};
  panel.hidden=false;form.hidden=false;document.getElementById('selected-label').textContent=`${state.surface} / ${state.target.label}`;commentText.value=localStorage.getItem(draftKey())||'';document.getElementById('save-status').textContent='';commentText.focus();
},true);
canvas.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.classList.contains('comment-pin'))return;
  if(button.dataset.go)return go(button.dataset.go);
  if(button.dataset.category){state.category=button.dataset.category;render();return;}
  if(button.dataset.tag){const item=media[state.selectedMedia],tag=button.dataset.tag;item.categories=item.categories.includes(tag)?item.categories.filter(name=>name!==tag):[...item.categories,tag];render();return;}
  if(button.dataset.format){canvas.querySelector('.editable')?.focus();document.execCommand(button.dataset.format);return;}
  const action=button.dataset.action,index=Number(button.dataset.index);
  if(action==='view'){state.selectedMedia=index;go('viewer');}
  else if(action==='select-media'){state.selectedMedia=index;render();}
  else if(action==='select-export'){if(state.selectedExport.has(index))state.selectedExport.delete(index);else state.selectedExport.add(index);render();}
  else if(action==='previous'||action==='next'){state.selectedMedia=(state.selectedMedia+(action==='next'?1:-1)+media.length)%media.length;render();}
  else if(action==='close-map-preview'){state.mapPreviewOpen=false;canvas.querySelector('.map-detail').hidden=true;drawPins();}
  else if(action==='map-view'){state.selectedMedia=state.mapCity==='kyoto'?2:0;go('viewer');}
  else if(action==='beer-plus'||action==='beer-minus'){state.beers=Math.max(0,state.beers+(action==='beer-plus'?1:-1));canvas.querySelector('#daily-beers').textContent=state.beers;}
  else if(action==='play-stack'){state.playing=!state.playing;render();}
  else if(action==='set-pin'){media[state.selectedMedia].lat=35.6895;media[state.selectedMedia].lng=139.6917;render();toast('Demo pin set to Tokyo.');}
  else if(action==='insert-media'){const editor=canvas.querySelector('.editable');const img=document.createElement('img');img.src=`${assets}japan.jpg`;img.alt='Sample image';img.contentEditable='false';editor.append(img);}
  else if(action)toast({passkey:'Sign-in mockup. No authentication is performed.','save-draft':'Draft action preview. Content is not saved.','publish':'Publishing action preview. Nothing was published.','upload':'Upload action preview. No files are uploaded.','save-media':'Media action preview. Sample changes are temporary.','export-mp4':'Export action preview. The production renderer is not connected.','export-png':'Export action preview. The production renderer is not connected.'}[action]||'Demo action.');
});
canvas.addEventListener('change',event=>{
  if(event.target.id==='export-day'){state.exportDay=event.target.value;state.selectedExport=new Set(media.map((item,index)=>({item,index})).filter(({item})=>item.place===state.exportDay).map(({index})=>index));render();}
  if(event.target.id==='safe-areas'){state.showSafeAreas=event.target.checked;canvas.querySelector('.story').classList.toggle('show-guides',state.showSafeAreas);}
  if(event.target.id==='counter-mode'){state.counterMode=event.target.value;render();}
});
screen.addEventListener('change',()=>go(screen.value));viewport.addEventListener('change',()=>{state.viewport=viewport.value;render();});dark.addEventListener('change',()=>{state.dark=dark.checked;render();});
document.querySelectorAll('[data-screen]').forEach(button=>button.addEventListener('click',()=>go(button.dataset.screen)));
document.querySelectorAll('[data-viewport]').forEach(button=>button.addEventListener('click',()=>{state.viewport=button.dataset.viewport;render();}));
document.getElementById('comment-mode').addEventListener('click',event=>{state.commenting=!state.commenting;event.currentTarget.setAttribute('aria-pressed',String(state.commenting));canvas.classList.toggle('commenting',state.commenting);if(state.commenting){panel.hidden=false;document.getElementById('feedback-status').textContent='select an element to comment';}else{document.getElementById('feedback-status').textContent='feedback saved locally';}});
document.getElementById('show-notes').addEventListener('click',()=>{panel.hidden=!panel.hidden;if(!panel.hidden)loadNotes();});document.getElementById('close-panel').addEventListener('click',()=>panel.hidden=true);
commentText.addEventListener('input',()=>{const key=draftKey();if(key)localStorage.setItem(key,commentText.value);});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(!state.target||!commentText.value.trim())return;const save=document.getElementById('save-note'),status=document.getElementById('save-status');save.disabled=true;status.textContent='saving…';
  const payload={...state.target,surface:state.surface,viewport:state.viewport,dark:state.dark,text:commentText.value,revision:'r5'};
  try {const response=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!response.ok)throw new Error();const note=await response.json();state.notes.push(note);localStorage.removeItem(draftKey());commentText.value='';status.textContent='saved';document.getElementById('feedback-status').textContent='feedback saved locally';showNotes();drawPins();}
  catch{status.textContent='Could not save. Your draft is retained. Retry while the local server is running.';}finally{save.disabled=false;}
});
document.getElementById('copy-notes').addEventListener('click',async()=>{const text=state.notes.map((note,index)=>`${index+1}. ${note.surface} / ${note.label} [${note.viewport}, ${note.dark?'dark':'light'}, ${note.revision}]\n${note.text}`).join('\n\n');try{await navigator.clipboard.writeText(text);toast('Feedback copied.');}catch{const area=document.createElement('textarea');area.value=text;panel.append(area);area.focus();area.select();toast('Select and copy the feedback text.');}});
new ResizeObserver(()=>{if(state.surface==='journal'){layoutJournal();drawMap();}else drawPins();}).observe(canvas);
try{const saved=JSON.parse(localStorage.getItem('jp-review-view'));if(saved&&screens[saved.surface]&&['desktop','mobile'].includes(saved.viewport)){state.surface=saved.surface;state.viewport=saved.viewport;state.dark=saved.dark===true;}}catch{}
canvas.addEventListener('load',()=>{layoutJournal();drawPins();},true);
canvas.addEventListener('scroll',()=>drawPins(),true);
render();loadNotes();
