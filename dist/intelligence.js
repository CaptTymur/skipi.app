// Skipi Intelligence lightweight module v0.1.0
// Extracted from skipi-public dist/index.html; global functions intentionally preserved.

// --- extracted from seafarer dist/index.html:2043-2054 (renderInformationCompassOverview) ---
async function renderInformationCompassOverview(profile,sp,payload){
    var h='<div class="compass-panel">';
    h+='<div class="compass-head"><div><div class="compass-title">'+esc(compassText('Market Reference','Рыночные ориентиры'))+'</div><div class="compass-sub">'+esc(compassText('Salary and vacancy references are grouped by rank, vessel type and source quality.','Зарплаты и вакансии сгруппированы по должности, типу судна и качеству источника.'))+'</div></div><span class="compass-pill accent">'+esc(compassText('privacy-first','privacy-first'))+'</span></div>';
    h+='<div class="compass-grid">';
    h+='<div class="compass-card"><div class="compass-kicker">'+esc(compassText('Sources','Источники'))+'</div><h3>'+esc(compassText('Vacancies and vessel feedback','Вакансии и оценки судов'))+'</h3><p>'+esc(compassText('Vacancies, vessel references, open sources, local profile context and anonymous aggregated vessel ratings.','Вакансии, референсы судов, открытые источники, локальный профиль и анонимные агрегированные оценки судов.'))+'</p></div>';
    h+='<div class="compass-card"><div class="compass-kicker">'+esc(compassText('Method','Метод'))+'</div><h3>'+esc(compassText('Group and compare','Группировка и сравнение'))+'</h3><p>'+esc(compassText('Deduplication, taxonomy and source-quality labels help avoid false certainty.','Дедупликация, таксономия и отметки качества источников помогают не создавать ложную уверенность.'))+'</p></div>';
    h+='<div class="compass-card"><div class="compass-kicker">'+esc(compassText('Result','Результат'))+'</div><h3>'+esc(compassText('Practical reference','Практический ориентир'))+'</h3><p>'+esc(compassText('Salary range, rank demand, vessel/company context and future offer comparison.','Зарплатный диапазон, спрос на должность, контекст судна/компании и будущая оценка оффера.'))+'</p></div>';
    h+='</div>';
    h+=renderCompassDataProducts(payload,sp,profile);
    h+='</div>';
    return h;
}

// --- extracted from seafarer dist/index.html:4783-4810 (renderMobileInformation) ---
async function renderMobileInformation(){
    var ru=getUiLang()==='ru';
    var info=mobileModuleInfo('information');
    mobileMainHtml('<div class="mobile-card"><div class="mobile-card-title">'+mobileEsc(info.title)+'</div><div class="mobile-card-sub">'+mobileEsc(ru?'Загружаю salary index...':'Loading salary index...')+'</div></div>');
    try{
        var sp={}, profile=null, payload=null, band=null;
        try{sp=await invoke('get_seafarer_personal');}catch(e){sp={};}
        try{profile=await invoke('get_profile_status');}catch(e){profile=null;}
        try{
            payload=await loadSkipiInfoIndex();
            band=pickSkipiInfoSalaryBand(skipiInfoIndexToBands(payload),sp,profile);
        }catch(e){
            logError('mobile_information_salary_index',e);
        }
        if(mobileView!=='information')return;
        var h='<div class="mobile-card"><div class="mobile-row"><div style="min-width:0;"><div class="mobile-card-title">'+mobileEsc(info.title)+'</div><div class="mobile-card-sub">'+mobileEsc(info.sub)+'</div></div><span class="mobile-action-icon" style="width:38px;height:38px;font-size:18px;">'+info.icon+'</span></div></div>';
        h+=mobileInfoSalaryCard(band,sp,profile,payload);
        if(!band&&payload){
            h+='<div class="mobile-card"><div class="mobile-card-title">'+mobileEsc(ru?'Что нужно для точности':'What improves accuracy')+'</div><div class="mobile-card-sub">'+mobileEsc(ru?'Укажите должность, тип судна и минимальную зарплату в профиле. Когда в индексе будет достаточно наблюдений, Скипи Моряк покажет медиану автоматически.':'Set rank, vessel type, and minimum salary in the profile. When the index has enough observations, Skipi Seafarer will show the median automatically.')+'</div></div>';
        }
        mobileMainHtml(h);
    }catch(e){
        if(mobileView==='information'){
            mobileMainHtml('<div class="mobile-card"><div class="mobile-card-title">'+mobileEsc(info.title)+'</div><div class="mobile-card-sub">'+mobileEsc(ru?'Не удалось загрузить salary index.':'Could not load salary index.')+'</div></div>');
        }
        logError('mobile_information_render',e);
    }
}

// --- extracted from seafarer dist/index.html:12294-12297 (INFORMATION_API,INFORMATION_CACHE_KEY,informationSnapshot,informationPersonal) ---
var INFORMATION_API = '/api/information/snapshot';
var INFORMATION_CACHE_KEY = 'skipi-information-snapshot-v2';
var informationSnapshot = null;
var informationPersonal = {};

// --- extracted from seafarer dist/index.html:12299-12349 (informationFallbackSnapshot) ---
function informationFallbackSnapshot(){
    var now=(new Date()).toISOString();
    return {
        schema_version:1,
        generated_at:now,
        cache_ttl_hours:24,
        source_note:'Local fallback. Live aggregate snapshot unavailable.',
        salary_index:[],
        industry_signals:[
            {id:'fallback_docs',title:'Complete document packs reduce friction',impact:'A current CV and certificate package helps a crewing manager assess you faster.',severity:'info',confidence:'curated',source:'Skipi local guidance',last_updated:now},
            {id:'fallback_offer_terms',title:'Contract terms matter beyond salary',impact:'Check internet access, joining window, relief plan, and repatriation terms before accepting.',severity:'info',confidence:'curated',source:'Skipi local guidance',last_updated:now},
            {id:'fallback_reviews',title:'Sea Service unlocks vessel intelligence',impact:'Adding contracts with IMO numbers makes vessel review signals useful inside Skipi.',severity:'info',confidence:'curated',source:'Skipi local guidance',last_updated:now},
            {id:'fallback_samples',title:'Small samples stay hidden',impact:'Skipi does not show salary slices until enough aggregate observations exist.',severity:'warning',confidence:'curated',source:'Skipi aggregation policy',last_updated:now}
        ],
        reference_signals:[
            {id:'fallback_bimco',title:'Qualified officers remain a structural concern',summary:'Industry bodies continue to focus on officer supply, training, and retention.',implication:'Use salary as one signal, but check workload, training requirements, and onboard support.',source:'BIMCO seafarer policy update',source_url:'https://www.bimco.org/news-insights/bimco-news/2026/03/focus-on-seafarers/',source_date:'2026-03',confidence:'public_reference'},
            {id:'fallback_imo',title:'Fatigue and STCW review stay active',summary:'IMO work on fatigue, rest hours, and STCW modernization keeps competence and workload in focus.',implication:'Ask how rest hours are actually managed onboard before accepting.',source:'IMO human element / STCW update',source_url:'https://www.imo.org/en/MediaCentre/PressBriefings/Pages/Seafarer-fatigue-work-hours-harassment.aspx',source_date:'2026',confidence:'public_reference'},
            {id:'fallback_numbeo',title:'Purchasing power needs a separate lens',summary:'Cost-of-living and local purchasing-power indices give a rough outside baseline.',implication:'A higher salary is not always a better between-contract life if the base is expensive.',source:'Numbeo Local Purchasing Power Index 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?displayColumn=5',source_date:'2026',confidence:'public_reference'}
        ],
        country_baselines:[
            {id:'in',country:'India',cost_of_living_index:18.9,rent_index:4.3,cost_plus_rent_index:12.4,groceries_index:21.6,restaurant_price_index:15.6,local_purchasing_power_index:76.4,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'id',country:'Indonesia',cost_of_living_index:26.1,rent_index:9.1,cost_plus_rent_index:18.5,groceries_index:33.6,restaurant_price_index:15.3,local_purchasing_power_index:29.3,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'ua',country:'Ukraine',cost_of_living_index:28.2,rent_index:8.2,cost_plus_rent_index:19.2,groceries_index:28.8,restaurant_price_index:25.4,local_purchasing_power_index:50.0,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'ph',country:'Philippines',cost_of_living_index:30.1,rent_index:7.8,cost_plus_rent_index:20.2,groceries_index:35.4,restaurant_price_index:19.7,local_purchasing_power_index:33.9,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'az',country:'Azerbaijan',cost_of_living_index:30.7,rent_index:9.7,cost_plus_rent_index:21.3,groceries_index:29.2,restaurant_price_index:35.3,local_purchasing_power_index:40.3,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'lk',country:'Sri Lanka',cost_of_living_index:33.9,rent_index:7.2,cost_plus_rent_index:22.0,groceries_index:48.1,restaurant_price_index:24.3,local_purchasing_power_index:19.0,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'ge',country:'Georgia',cost_of_living_index:33.1,rent_index:12.7,cost_plus_rent_index:24.0,groceries_index:32.3,restaurant_price_index:36.2,local_purchasing_power_index:43.0,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'ru',country:'Russia',cost_of_living_index:36.5,rent_index:12.3,cost_plus_rent_index:25.7,groceries_index:35.7,restaurant_price_index:35.4,local_purchasing_power_index:61.6,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'md',country:'Moldova',cost_of_living_index:35.8,rent_index:14.7,cost_plus_rent_index:26.4,groceries_index:33.6,restaurant_price_index:32.5,local_purchasing_power_index:54.1,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'ro',country:'Romania',cost_of_living_index:40.6,rent_index:12.0,cost_plus_rent_index:27.8,groceries_index:39.0,restaurant_price_index:43.5,local_purchasing_power_index:76.8,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'bg',country:'Bulgaria',cost_of_living_index:41.6,rent_index:11.1,cost_plus_rent_index:28.0,groceries_index:42.6,restaurant_price_index:42.6,local_purchasing_power_index:84.1,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'am',country:'Armenia',cost_of_living_index:40.9,rent_index:15.2,cost_plus_rent_index:29.5,groceries_index:36.1,restaurant_price_index:40.3,local_purchasing_power_index:41.4,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'jp',country:'Japan',cost_of_living_index:47.5,rent_index:14.7,cost_plus_rent_index:32.8,groceries_index:56.8,restaurant_price_index:30.3,local_purchasing_power_index:118.3,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'pl',country:'Poland',cost_of_living_index:47.3,rent_index:18.4,cost_plus_rent_index:34.4,groceries_index:41.1,restaurant_price_index:48.1,local_purchasing_power_index:97.1,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'ca',country:'Canada',cost_of_living_index:63.0,rent_index:31.5,cost_plus_rent_index:48.9,groceries_index:69.6,restaurant_price_index:64.1,local_purchasing_power_index:119.4,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'de',country:'Germany',cost_of_living_index:68.7,rent_index:24.6,cost_plus_rent_index:49.0,groceries_index:64.9,restaurant_price_index:66.9,local_purchasing_power_index:138.3,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'us',country:'United States',cost_of_living_index:68.8,rent_index:40.7,cost_plus_rent_index:56.3,groceries_index:74.0,restaurant_price_index:72.8,local_purchasing_power_index:146.0,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'},
            {id:'no',country:'Norway',cost_of_living_index:83.7,rent_index:29.2,cost_plus_rent_index:59.4,groceries_index:85.4,restaurant_price_index:88.6,local_purchasing_power_index:124.7,source:'Numbeo Cost of Living Index by Country 2026',source_url:'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026',source_date:'2026',confidence:'public_reference'}
        ],
        places:[
            {id:'ge_tbilisi',label:'Tbilisi, Georgia',summary:'Low tax, good flight access via TBS, moderate rent, strong fit for a between-contract base.',salary_power:'strong',flight_access:'medium',visa_residency:'strong',confidence:'curated'},
            {id:'ge_batumi',label:'Batumi, Georgia',summary:'Black Sea port city with low living costs and easy regional travel, but fewer long-haul flight options.',salary_power:'strong',flight_access:'low',visa_residency:'strong',confidence:'curated'},
            {id:'tr_istanbul',label:'Istanbul, Turkiye',summary:'Major maritime hub with excellent flights and services; rent is higher but agency access is strong.',salary_power:'medium',flight_access:'strong',visa_residency:'medium',confidence:'curated'},
            {id:'bg_varna',label:'Varna, Bulgaria',summary:'Practical Black Sea base with maritime services, EU access, and moderate living costs.',salary_power:'medium',flight_access:'medium',visa_residency:'medium',confidence:'curated'},
            {id:'ph_manila',label:'Manila, Philippines',summary:'Deep crewing ecosystem, training access, and good salary purchasing power for many ranks.',salary_power:'strong',flight_access:'strong',visa_residency:'medium',confidence:'curated'}
        ],
        vessel_employer_trends:[
            {kind:'reviews',label:'Vessel and employer signals',summary:'Live trend summaries need more approved seafarer reviews.',sample_size:0,confidence:'low'}
        ]
    };
}

// --- extracted from seafarer dist/index.html:12351-12356 (informationEffectiveRank) ---
function informationEffectiveRank(sp){
    var rank=(sp&&sp.rank)||null;
    if(!rank&&currentWizardPosition)rank=WIZARD_POSITION_TO_RANK[currentWizardPosition]||null;
    if(rank&&typeof canonicalRank==='function')rank=canonicalRank(rank);
    return rank||null;
}

// --- extracted from seafarer dist/index.html:12358-12362 (informationEffectiveVesselType) ---
function informationEffectiveVesselType(sp,profile){
    var vt=(sp&&sp.preferred_vessel_types?sp.preferred_vessel_types:'').split(',')[0].trim();
    if(!vt&&profile&&profile.vessel_category)vt=profile.vessel_category;
    return vt||null;
}

// --- extracted from seafarer dist/index.html:12364-12395 (loadInformationSnapshot) ---
async function loadInformationSnapshot(profile,sp){
    var q=[];
    var rank=informationEffectiveRank(sp);
    var vesselType=informationEffectiveVesselType(sp,profile);
    if(rank)q.push('rank='+encodeURIComponent(rank));
    if(vesselType)q.push('vessel_type='+encodeURIComponent(vesselType));
    var url='/api/information/snapshot' + (q.length?'?'+q.join('&'):'');
    try{
        var r=await apiFetch(url,{},8000);
        if(!r.ok)throw new Error('server '+r.status);
        var snap=await r.json();
        snap._source='live';
        try{localStorage.setItem(INFORMATION_CACHE_KEY,JSON.stringify(snap));}catch(e){}
        informationSnapshot=snap;
        return snap;
    }catch(e){
        logError('information_snapshot',e);
        try{
            var raw=localStorage.getItem(INFORMATION_CACHE_KEY);
            if(raw){
                var cached=JSON.parse(raw);
                cached._source='cache';
                informationSnapshot=cached;
                return cached;
            }
        }catch(_){}
        var fallback=informationFallbackSnapshot();
        fallback._source='fallback';
        informationSnapshot=fallback;
        return fallback;
    }
}

// --- extracted from seafarer dist/index.html:12397-12402 (informationDate) ---
function informationDate(iso){
    if(!iso)return 'unknown';
    var d=new Date(iso);
    if(isNaN(d.getTime()))return String(iso).slice(0,10);
    return d.toISOString().slice(0,10);
}

// --- extracted from seafarer dist/index.html:12404-12409 (informationSourceLabel) ---
function informationSourceLabel(snap){
    if(!snap)return '';
    if(snap._source==='cache')return 'Cached snapshot';
    if(snap._source==='fallback')return 'Local fallback';
    return 'Live aggregate';
}

// --- extracted from seafarer dist/index.html:12411-12428 (informationPickBand) ---
function informationPickBand(snapshot,sp){
    var bands=(snapshot&&snapshot.salary_index)||[];
    if(!bands.length)return null;
    var rank=(informationEffectiveRank(sp)||'').toLowerCase();
    var vessel=(informationEffectiveVesselType(sp,{})||'').toLowerCase();
    for(var i=0;i<bands.length;i++){
        var b=bands[i];
        if(rank&&String(b.rank||'').toLowerCase()!==rank)continue;
        if(vessel&&String(b.vessel_type||'').toLowerCase()!==vessel)continue;
        return b;
    }
    if(rank){
        for(var j=0;j<bands.length;j++){
            if(String(bands[j].rank||'').toLowerCase()===rank)return bands[j];
        }
    }
    return bands[0]||null;
}

// --- extracted from seafarer dist/index.html:12430-12444 (renderInformationSignals) ---
function renderInformationSignals(snapshot){
    var signals=(snapshot&&snapshot.industry_signals)||[];
    if(!signals.length)return '<div class="info-empty">No market signals available yet.</div>';
    var h='<div class="info-grid">';
    signals.slice(0,7).forEach(function(s){
        h+='<div class="info-card">';
        h+='<div class="info-kicker">'+esc(s.severity||'info')+'</div>';
        h+='<h3>'+esc(s.title)+'</h3>';
        h+='<p>'+esc(s.impact)+'</p>';
        h+='<div class="info-row"><span>'+esc(s.source||'aggregate')+'</span><span class="info-pill">'+esc(s.confidence||'low')+'</span></div>';
        h+='</div>';
    });
    h+='</div>';
    return h;
}

// --- extracted from seafarer dist/index.html:12446-12467 (renderInformationSalaryBands) ---
function renderInformationSalaryBands(snapshot){
    var bands=(snapshot&&snapshot.salary_index)||[];
    if(!bands.length){
        return '<div class="info-empty">Not enough aggregate salary data yet. Skipi hides salary slices below the minimum sample threshold.</div>';
    }
    var h='<div class="info-grid">';
    bands.slice(0,6).forEach(function(b){
        h+='<div class="info-card">';
        h+='<div class="info-kicker">'+esc(b.currency||'USD')+' per '+esc(b.period||'month')+'</div>';
        h+='<h3>'+esc(b.rank)+' / '+esc(b.vessel_type)+'</h3>';
        h+='<div class="info-band">';
        h+='<div><b>'+esc(b.p25)+'</b><span>p25</span></div>';
        h+='<div><b>'+esc(b.p50)+'</b><span>median</span></div>';
        h+='<div><b>'+esc(b.p75)+'</b><span>p75</span></div>';
        h+='</div>';
        h+='<div class="info-row"><span>'+esc(b.sample_size)+' observations</span><span class="info-pill">'+esc(b.confidence)+'</span></div>';
        h+='<p style="margin-top:8px;">Observed '+esc(b.observed_from)+' to '+esc(b.observed_to)+'.</p>';
        h+='</div>';
    });
    h+='</div>';
    return h;
}

// --- extracted from seafarer dist/index.html:12469-12485 (renderInformationBenchmarkCard) ---
function renderInformationBenchmarkCard(snapshot){
    var band=informationPickBand(snapshot,informationPersonal);
    if(!band){
        return '<div class="info-card locked"><div class="info-kicker">Internal benchmark</div><h3>Salary index is still building</h3><p>Skipi hides salary bands until there are at least 5 usable observations for a slice. Until then, use the external reference cards below as market context, not as a salary benchmark.</p><div class="info-row"><span>Source</span><span class="info-pill">Skipi aggregate</span></div></div>';
    }
    var h='<div class="info-card">';
    h+='<div class="info-kicker">Internal benchmark</div>';
    h+='<h3>'+esc(band.rank)+' / '+esc(band.vessel_type)+'</h3>';
    h+='<div class="info-band">';
    h+='<div><b>'+esc(band.currency)+' '+esc(band.p25)+'</b><span>low edge</span></div>';
    h+='<div><b>'+esc(band.currency)+' '+esc(band.p50)+'</b><span>normal point</span></div>';
    h+='<div><b>'+esc(band.currency)+' '+esc(band.p75)+'</b><span>strong edge</span></div>';
    h+='</div>';
    h+='<div class="info-row"><span>'+esc(band.sample_size)+' observations</span><span class="info-pill">'+esc(band.confidence)+'</span></div>';
    h+='</div>';
    return h;
}

// --- extracted from seafarer dist/index.html:12487-12502 (renderInformationReferences) ---
function renderInformationReferences(snapshot){
    var refs=(snapshot&&snapshot.reference_signals)||[];
    if(!refs.length)return '<div class="info-empty">No external reference signals available.</div>';
    var h='<div class="info-grid">';
    refs.slice(0,5).forEach(function(r){
        h+='<div class="info-card">';
        h+='<div class="info-kicker">'+esc(r.confidence||'reference')+'</div>';
        h+='<h3>'+esc(r.title)+'</h3>';
        h+='<p>'+esc(r.summary)+'</p>';
        h+='<p style="margin-top:8px;color:var(--text);">'+esc(r.implication)+'</p>';
        h+='<div class="info-row"><span>'+esc(r.source_date||'')+'</span><a href="'+escAttr(r.source_url||'#')+'" onclick="openInformationSource(this.href);return false;" style="color:var(--accent);">source</a></div>';
        h+='</div>';
    });
    h+='</div>';
    return h;
}

// --- extracted from seafarer dist/index.html:12504-12507 (openInformationSource) ---
async function openInformationSource(url){
    try{await invoke('open_external_url',{url:url});}
    catch(e){window.open(url,'_blank');}
}

// --- extracted from seafarer dist/index.html:12509-12525 (renderInformationOfferCard) ---
function renderInformationOfferCard(profileComplete,snapshot,sp){
    if(!profileComplete){
        return '<div class="info-card locked"><div class="info-kicker">Personalized</div><h3>Offer Check</h3><p>Complete your profile to personalize salary and market signals.</p><div class="info-row"><button class="btn btn-outline btn-sm" onclick="openSettings()">Open profile</button><span class="info-pill">85% needed</span></div></div>';
    }
    var band=informationPickBand(snapshot,sp);
    if(!band){
        return '<div class="info-card locked"><div class="info-kicker">Offer Check</div><h3>Waiting for salary sample</h3><p>Skipi does not have enough aggregate salary observations for your current rank and vessel type yet.</p></div>';
    }
    var cur=band.currency||'USD';
    var h='<div class="info-card">';
    h+='<div class="info-kicker">Local only</div><h3>Offer Check</h3>';
    h+='<p>Type an offered monthly salary. It stays on this device and is compared with the aggregate band only.</p>';
    h+='<div class="field" style="margin-top:10px;"><label>Offered salary ('+esc(cur)+')</label><input id="info-offer-input" type="number" min="0" step="50" oninput="renderInformationOfferCheck()" placeholder="'+esc(band.p50)+'" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:13px;"></div>';
    h+='<div id="info-offer-result" class="info-offer-result">Range: '+esc(cur)+' '+esc(band.p25)+'-'+esc(band.p75)+' per month. Sample '+esc(band.sample_size)+', '+esc(band.confidence)+' confidence.</div>';
    h+='</div>';
    return h;
}

// --- extracted from seafarer dist/index.html:12527-12549 (renderInformationOfferCheck) ---
function renderInformationOfferCheck(){
    var el=document.getElementById('info-offer-result');
    var input=document.getElementById('info-offer-input');
    if(!el||!input)return;
    var band=informationPickBand(informationSnapshot,informationPersonal);
    if(!band)return;
    var v=parseFloat(input.value);
    el.className='info-offer-result';
    if(!v||v<=0){
        el.textContent='Range: '+band.currency+' '+band.p25+'-'+band.p75+' per month. Sample '+band.sample_size+', '+band.confidence+' confidence.';
        return;
    }
    if(v<band.p25){
        el.className+=' warn';
        el.textContent='Below market range for this aggregate slice. Compare the offer against contract length, trade area, internet, and relief terms. Sample '+band.sample_size+', '+band.confidence+' confidence.';
    }else if(v>band.p75){
        el.className+=' strong';
        el.textContent='Strong offer against this aggregate slice. Still check contract length, deductions, and joining conditions. Sample '+band.sample_size+', '+band.confidence+' confidence.';
    }else{
        el.className+=' good';
        el.textContent='Normal range for this aggregate slice. Median is '+band.currency+' '+band.p50+'. Sample '+band.sample_size+', '+band.confidence+' confidence.';
    }
}

// --- extracted from seafarer dist/index.html:12551-12555 (informationIndexValue) ---
function informationIndexValue(v){
    var n=parseFloat(v);
    if(isNaN(n))return 'n/a';
    return n.toFixed(1);
}

// --- extracted from seafarer dist/index.html:12557-12595 (renderInformationCountryBaselines) ---
function renderInformationCountryBaselines(snapshot){
    var countries=((snapshot&&snapshot.country_baselines)||[]).slice();
    if(!countries.length)return '<div class="info-empty">No country baseline available.</div>';
    countries.sort(function(a,b){
        var av=parseFloat(a.cost_plus_rent_index), bv=parseFloat(b.cost_plus_rent_index);
        if(isNaN(av))av=999;
        if(isNaN(bv))bv=999;
        return av-bv;
    });
    var first=countries[0]||{};
    var sourceUrl=first.source_url||'https://www.numbeo.com/cost-of-living/rankings_by_country.jsp?title=2026';
    var top=countries.slice(0,3);
    var h='<div class="info-country-summary">';
    top.forEach(function(c,idx){
        h+='<div class="info-country-card">';
        h+='<div class="rank">#'+esc(idx+1)+' USD baseline</div>';
        h+='<div class="country">'+esc(c.country||'')+'</div>';
        h+='<div class="value"><span>Cost+rent</span><strong>'+esc(informationIndexValue(c.cost_plus_rent_index))+'</strong></div>';
        h+='<div class="value"><span>Local power</span><strong>'+esc(informationIndexValue(c.local_purchasing_power_index))+'</strong></div>';
        h+='</div>';
    });
    h+='</div>';
    h+='<details class="info-country-details"><summary>Full country table ('+countries.length+')</summary>';
    h+='<div class="info-country-list">';
    h+='<div class="info-country-row head"><span>#</span><span>Country</span><span class="info-country-num">Cost+rent</span><span class="info-country-num">Rent</span><span class="info-country-num">Groceries</span><span class="info-country-num">Local power</span></div>';
    countries.forEach(function(c,idx){
        h+='<div class="info-country-row">';
        h+='<span class="info-pill">#'+esc(idx+1)+'</span>';
        h+='<span class="info-country-name">'+esc(c.country||'')+'</span>';
        h+='<span class="info-country-num"><small>Cost+rent</small>'+esc(informationIndexValue(c.cost_plus_rent_index))+'</span>';
        h+='<span class="info-country-num"><small>Rent</small>'+esc(informationIndexValue(c.rent_index))+'</span>';
        h+='<span class="info-country-num"><small>Groceries</small>'+esc(informationIndexValue(c.groceries_index))+'</span>';
        h+='<span class="info-country-num"><small>Local power</small>'+esc(informationIndexValue(c.local_purchasing_power_index))+'</span>';
        h+='</div>';
    });
    h+='</div></details>';
    h+='<div class="info-empty">Sorted by lower cost-plus-rent for a USD salary. Local purchasing power reflects local income, not seafarer contracts. War, visa, tax, banking, and safety are not included. <a href="'+escAttr(sourceUrl)+'" onclick="openInformationSource(this.href);return false;" style="color:var(--accent);">Numbeo 2026 source</a></div>';
    return h;
}

// --- extracted from seafarer dist/index.html:12597-12613 (renderInformationPlaces) ---
function renderInformationPlaces(snapshot){
    var places=(snapshot&&snapshot.places)||[];
    if(!places.length)return '<div class="info-empty">No places snapshot available.</div>';
    var h='<div class="info-grid">';
    places.slice(0,5).forEach(function(p){
        h+='<div class="info-card">';
        h+='<div class="info-kicker">'+esc(p.confidence||'curated')+'</div>';
        h+='<h3>'+esc(p.label)+'</h3>';
        h+='<p>'+esc(p.summary)+'</p>';
        h+='<div class="info-row"><span>Salary power</span><span class="info-pill">'+esc(p.salary_power)+'</span></div>';
        h+='<div class="info-row"><span>Flights</span><span class="info-pill">'+esc(p.flight_access)+'</span></div>';
        h+='<div class="info-row"><span>Visa/residency</span><span class="info-pill">'+esc(p.visa_residency)+'</span></div>';
        h+='</div>';
    });
    h+='</div>';
    return h;
}

// --- extracted from seafarer dist/index.html:12615-12632 (renderInformationTrends) ---
function renderInformationTrends(snapshot,seaServiceCount){
    if(!seaServiceCount){
        return '<div class="info-card locked"><div class="info-kicker">Vessel intelligence</div><h3>Add sea service to unlock vessel/employer intelligence.</h3><p>Contracts with IMO numbers let Skipi connect market information with vessel reviews and trends.</p><div class="info-row"><button class="btn btn-outline btn-sm" onclick="showView(\'experience\')">Sea Service</button><span class="info-pill">local vault</span></div></div>';
    }
    var trends=(snapshot&&snapshot.vessel_employer_trends)||[];
    if(!trends.length)return '<div class="info-empty">No vessel/employer aggregate trends available yet.</div>';
    var h='<div class="info-grid">';
    trends.slice(0,5).forEach(function(t){
        h+='<div class="info-card">';
        h+='<div class="info-kicker">'+esc(t.kind||'trend')+'</div>';
        h+='<h3>'+esc(t.label)+'</h3>';
        h+='<p>'+esc(t.summary)+'</p>';
        h+='<div class="info-row"><span>'+esc(t.sample_size)+' approved reviews</span><span class="info-pill">'+esc(t.confidence||'low')+'</span></div>';
        h+='</div>';
    });
    h+='</div>';
    return h;
}

// --- extracted from seafarer dist/index.html:12634-12652 (showInformation) ---
async function showInformation(){
    var content=document.getElementById('scr-content');
    show('scr-content');updateTabs('Information');
    var profile=null, sp={}, payload=null;
    try{profile=await invoke('get_profile_status');}catch(e){profile=null;}
    try{sp=await invoke('get_seafarer_personal');}catch(e){sp={};}
    try{payload=await loadSkipiInfoIndex();}catch(e){payload=null;}
    var h='<div class="info-wrap">';
    h+='<div class="info-head"><div><h2>Skipi.info</h2><div class="info-sub">Public seafarer market index, methodology, country baseline, and reference materials.</div></div>';
    h+='<div class="info-meta">Public site<br>Opens independently from your private vault</div></div>';
    h+=await renderInformationCompassOverview(profile,sp,payload);
    h+='<div class="info-web-actions">';
    h+='<button class="btn btn-outline" onclick="openInformationSource(\''+escAttr(SKIPI_INFO_SITE_URL)+'\')">Open in browser</button>';
    h+='<button class="btn btn-outline" onclick="openInformationSource(\'https://skipi.info/methodology.html\')">Methodology</button>';
    h+='</div>';
    h+='<div class="info-web-frame"><iframe src="'+escAttr(SKIPI_INFO_SITE_URL)+'" title="Skipi.info"></iframe></div>';
    h+='</div>';
    content.innerHTML=h;
}

