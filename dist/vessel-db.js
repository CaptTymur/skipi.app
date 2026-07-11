// Skipi Vessel DB lightweight module v0.1.0
// Extracted from skipi-public dist/index.html; global functions intentionally preserved.

// --- extracted from seafarer dist/index.html:5743-5751 (mobileOpenVesselFromJob) ---
function mobileOpenVesselFromJob(vacancyId){
    var v=findJobById(vacancyId);
    if(!v){showToast('Vacancy not found','error');return;}
    var imo=normalizeImo(v.vessel_imo);
    if(!imo){showToast('This vacancy has no valid IMO.','warn');return;}
    vesselDbPendingImo=imo;
    vesselDbJobContext={source:'jobs',vacancyId:v.id,imo:imo,title:mobileJobTitle(v),vessel_name:jobsVesselDisplayName(v),reply_to:v.reply_to||''};
    mobileShow('vessels');
}

// --- extracted from seafarer dist/index.html:5815-5821 (mobileLatestEntryForImo) ---
function mobileLatestEntryForImo(entries,imo){
    var norm=normalizeImo(imo);
    if(!norm)return null;
    var matches=(entries||[]).filter(function(row){return normalizeImo(row&&row.imo)===norm;});
    matches.sort(function(a,b){return String(b.sign_off||b.sign_on||b.created_at||'').localeCompare(String(a.sign_off||a.sign_on||a.created_at||''));});
    return matches[0]||null;
}

// --- extracted from seafarer dist/index.html:6261-6366 (mobileVesselPendingImo,mobileVesselPendingEntryId,mobileOpenVesselFromExperience,mobileVesselListCard,mobileVesselResultActions,mobileRenderVesselLookupResult,mobileLookupVesselByImo,mobileLookupSpecificVessel,renderMobileVessels) ---
var mobileVesselPendingImo=null;
var mobileVesselPendingEntryId=null;
function mobileOpenVesselFromExperience(entryId,imo,vesselName){
    mobileVesselPendingImo=normalizeImo(imo);
    mobileVesselPendingEntryId=entryId||null;
    vesselDbPendingImo=mobileVesselPendingImo;
    vesselDbJobContext={source:'experience',entryId:entryId||'',imo:mobileVesselPendingImo,vessel_name:vesselName||''};
    mobileShow('vessels');
}
function mobileVesselListCard(v,entry){
    var meta=[v.type,v.flag,v.company].filter(Boolean).join(' · ');
    var h='<div class="mobile-card">';
    h+='<div class="mobile-row" style="align-items:flex-start;"><div style="min-width:0;flex:1;">';
    h+='<div class="mobile-card-title">'+mobileEsc(v.name||('IMO '+v.imo))+'</div>';
    h+='<div class="mobile-card-sub">IMO '+mobileEsc(v.imo)+(meta?' · '+mobileEsc(meta):'')+'</div>';
    h+='<div class="mobile-card-sub">'+mobileEsc(v.contracts+' sea service record'+(v.contracts===1?'':'s'))+'</div>';
    h+='</div>';
    if(entry&&vesselReviewHasLocal(entry))h+='<span class="mobile-pill ok">'+mobileEsc(localReviewRatingText(entry.local_review.overall_rating))+'</span>';
    h+='</div>';
    h+='<div class="mobile-actions" style="margin-top:11px;">';
    h+='<button class="btn btn-outline mobile-grow" type="button" onclick="mobileLookupSpecificVessel(\''+jsString(v.imo)+'\')">Open</button>';
    if(entry)h+='<button class="btn btn-accent mobile-grow" type="button" onclick="mobileStartAssessment(\''+jsString(entry.id)+'\')">Assess</button>';
    h+='</div></div>';
    return h;
}
function mobileVesselResultActions(imo,entries,payload){
    var entry=mobileLatestEntryForImo(entries,imo);
    var vesselName=(payload&&payload.name_current)||((entry&&entry.vessel_name)||'');
    var h='<div class="mobile-actions" style="margin:0 0 10px;">';
    if(entry){
        h+='<button class="btn btn-accent mobile-grow" type="button" onclick="mobileStartAssessment(\''+jsString(entry.id)+'\')">Assess this vessel</button>';
        h+='<button class="btn btn-outline mobile-grow" type="button" onclick="mobileShow(\'experience\')">Sea Service</button>';
    }else{
        h+='<button class="btn btn-accent mobile-grow" type="button" onclick="mobileShowExperienceForm(\'\',{imo:\''+jsString(imo)+'\',vessel_name:\''+jsString(vesselName)+'\'})">Add to Sea Service</button>';
    }
    h+='</div>';
    return h;
}
function mobileRenderVesselLookupResult(entry,imo,entries){
    entries=entries||[];
    if(!entry||entry.status==='error'){
        return '<div class="mobile-card"><div class="mobile-card-title">Vessel database unavailable</div><div class="mobile-card-sub">'+mobileEsc(entry&&entry.error?entry.error:'Network error')+'</div></div>'+mobileVesselResultActions(imo,entries,null);
    }
    if(entry.status==='not_found'||!entry.payload){
        return '<div class="mobile-card"><div class="mobile-card-title">No vessel found</div><div class="mobile-card-sub">Skipi does not have a public record for IMO '+mobileEsc(imo)+' yet. You can still add the vessel to Sea Service and assess your contract.</div></div>'+mobileVesselResultActions(imo,entries,null);
    }
    return mobileVesselResultActions(imo,entries,entry.payload)+'<div class="mobile-card mobile-db-result">'+renderVesselDbSummary(entry.payload)+'</div>';
}
async function mobileLookupVesselByImo(force){
    var input=document.getElementById('mobile-vdb-imo');
    var host=document.getElementById('mobile-vdb-result');
    if(!input||!host)return;
    var imo=normalizeImo(input.value);
    if(!imo){showToast('IMO must contain exactly 7 digits','warn');input.focus();return;}
    input.value=imo;
    mobileVesselPendingImo=imo;
    host.innerHTML='<div class="mobile-card"><div class="mobile-card-title">Searching IMO '+mobileEsc(imo)+'</div><div class="mobile-card-sub">Reading Skipi vessel intelligence...</div></div>';
    try{
        var entries=[];
        try{entries=await invoke('get_work_history')||[];}catch(_){entries=[];}
        var result=await fetchVesselReviewProjection(imo,!!force);
        if(mobileView!=='vessels')return;
        host.innerHTML=mobileRenderVesselLookupResult(result,imo,entries);
    }catch(e){
        host.innerHTML='<div class="mobile-card"><div class="mobile-card-title">Search failed</div><div class="mobile-card-sub">'+mobileEsc(String(e))+'</div></div>';
        logError('mobile_vessel_lookup',e);
    }
}
function mobileLookupSpecificVessel(imo){
    mobileVesselPendingImo=normalizeImo(imo);
    var input=document.getElementById('mobile-vdb-imo');
    if(input)input.value=mobileVesselPendingImo||'';
    mobileLookupVesselByImo(false);
    var host=document.getElementById('mobile-vdb-result');
    if(host&&host.scrollIntoView)host.scrollIntoView({block:'start',behavior:'smooth'});
}
async function renderMobileVessels(){
    if(vesselDbDemoEnabled()){
        renderMobileVesselDbDemo();
        return;
    }
    mobileMainHtml('<div class="mobile-card"><div class="mobile-card-title">Vessel DB</div><div class="mobile-card-sub">Loading vessel database...</div></div>');
    try{
        var entries=await invoke('get_work_history')||[];
        if(mobileView!=='vessels')return;
        var vessels=groupVesselsFromWorkHistory(entries);
        var h='<div class="mobile-card"><div class="mobile-row"><div style="min-width:0;"><div class="mobile-card-title">Vessel DB</div><div class="mobile-card-sub">Search vessel intelligence by IMO, or open a vessel from your Sea Service.</div></div><span class="mobile-action-icon" style="width:38px;height:38px;font-size:18px;">&#9872;</span></div></div>';
        h+='<div class="mobile-card"><div class="mobile-field"><label>IMO number</label><div class="mobile-vessel-search"><input id="mobile-vdb-imo" inputmode="numeric" maxlength="7" placeholder="e.g. 9855552" value="'+mobileEsc(mobileVesselPendingImo||'')+'" onkeydown="if(event.key===\'Enter\')mobileLookupVesselByImo(false)"><button class="btn btn-accent" type="button" onclick="mobileLookupVesselByImo(false)">Search</button></div></div></div>';
        h+='<div id="mobile-vdb-result"></div>';
        h+='<div class="mobile-section-title">From your Sea Service</div>';
        if(!vessels.length){
            h+='<div class="mobile-card"><div class="mobile-card-title">No vessels linked yet</div><div class="mobile-card-sub">Add sea service with a valid IMO number. Skipi Seafarer will connect the contract to the vessel database.</div></div>';
            h+='<button class="mobile-primary-action" type="button" onclick="mobileShowExperienceForm(\'\')"><span class="mobile-action-icon">+</span><span class="mobile-action-copy"><span class="mobile-action-title">Add sea service</span><span class="mobile-action-sub">Enter vessel, IMO, rank and dates.</span></span></button>';
        }else{
            vessels.forEach(function(v){h+=mobileVesselListCard(v,mobileLatestEntryForImo(entries,v.imo));});
        }
        mobileMainHtml(h);
        var pending=mobileVesselPendingImo||vesselDbPendingImo;
        if(pending)setTimeout(function(){mobileLookupSpecificVessel(pending);},80);
    }catch(e){
        if(mobileView==='vessels'){
            mobileMainHtml('<div class="mobile-card"><div class="mobile-card-title">Vessel DB</div><div class="mobile-card-sub">Could not load vessel database.</div></div>');
        }
        logError('mobile_vessels_render',e);
    }
}

// --- extracted from seafarer dist/index.html:11097-11103 (VESSEL_REVIEWS_API,VESSEL_REVIEWS_FALLBACK_API,VESSEL_REVIEW_CACHE_KEY,VESSEL_REVIEW_CACHE_TTL_MS,vesselReviewCache,vesselDbPendingImo,vesselDbJobContext) ---
var VESSEL_REVIEWS_API = '/api/vessels/';
var VESSEL_REVIEWS_FALLBACK_API = 'http://127.0.0.1:8000/api/vessels/';
var VESSEL_REVIEW_CACHE_KEY = 'skipi-vessel-reviews-cache-v2';
var VESSEL_REVIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
var vesselReviewCache = null;
var vesselDbPendingImo = null;
var vesselDbJobContext = null;

// --- extracted from seafarer dist/index.html:11109-11552 (parseLocalReviewDate,formatLocalReviewDate,localReviewLocked,localReviewStars,localReviewRatingText,renderOwnVesselReview,vesselReviewHighlightEntryId,VESSEL_DB_VISITS_KEY,rvText,vesselReviewHasLocal,vesselReviewNeedsLocal,vesselReviewSortKey,vesselReviewContributionStats,loadVesselReviewContributionStats,openLatestUnreviewedVesselReview,reviewContributionLine,renderReviewNudgeCard,noteVesselDbVisit,renderVesselDbReviewNudge,readVesselReviewCache,writeVesselReviewCache,vesselApiBases,fetchWithTimeout,requestVesselProjection,fetchVesselReviewProjection,vrevMetric,vrevSectionAvg,vrevFlagLabel,vrevReviewCta,renderVesselReviewProjection,renderVesselReviewLoading,renderRecentVesselReviews,loadRecentVesselReviews,openVesselFromRecentReview,vesselProjectionRatingSummary,renderExperienceVesselRating) ---
function parseLocalReviewDate(value){
    if(!value)return null;
    var d=new Date(value);
    return isNaN(d.getTime())?null:d;
}
function formatLocalReviewDate(value){
    var d=parseLocalReviewDate(value);
    return d?d.toISOString().slice(0,10):String(value||'');
}
function localReviewLocked(review){
    var d=parseLocalReviewDate(review&&review.lock_until);
    return !!(d&&d.getTime()>Date.now());
}
function localReviewStars(value){
    var n=Number(value);
    var full=isFinite(n)?Math.max(0,Math.min(5,Math.round(n))):0;
    var out='';
    for(var i=1;i<=5;i++)out+=i<=full?'★':'☆';
    return out;
}
function localReviewRatingText(value){
    var n=Number(value);
    return isFinite(n)?n.toFixed(1)+'/5':'not rated';
}
function renderOwnVesselReview(entry){
    var review=entry&&entry.local_review;
    if(!review||review===null||review.overall_rating===undefined||review.overall_rating===null)return '';
    var entryImo=normalizeImo(entry&&entry.imo);
    var reviewImo=normalizeImo(review&&review.vessel_imo);
    if(entryImo&&reviewImo&&entryImo!==reviewImo)return '';
    var locked=localReviewLocked(review);
    var meta='<strong>Your rating: '+esc(localReviewRatingText(review.overall_rating))+'</strong>';
    if(review.submitted_at)meta+=' · submitted '+esc(formatLocalReviewDate(review.submitted_at));
    if(locked)meta+=' · locked until '+esc(formatLocalReviewDate(review.lock_until));
    else meta+=' · can be updated';
    meta+=' · <span class="review-trust-chip">verified by Sea Service</span>';
    return '<div class="own-vessel-review '+(locked?'locked':'')+'"><span class="stars">'+localReviewStars(review.overall_rating)+'</span><span class="meta">'+meta+'</span></div>';
}
var vesselReviewHighlightEntryId=null;
var VESSEL_DB_VISITS_KEY='skipi-vessel-db-visits';
function rvText(ru,en){return getUiLang()==='ru'?ru:en;}
function vesselReviewHasLocal(entry){
    var r=entry&&entry.local_review;
    if(!r||r===null||r.overall_rating===undefined||r.overall_rating===null)return false;
    var entryImo=normalizeImo(entry&&entry.imo);
    var reviewImo=normalizeImo(r&&r.vessel_imo);
    return !(entryImo&&reviewImo&&entryImo!==reviewImo);
}
function vesselReviewNeedsLocal(entry){
    return !!(entry&&normalizeImo(entry.imo)&&!vesselReviewHasLocal(entry));
}
function vesselReviewSortKey(entry){
    return String((entry&&entry.sign_off)||(entry&&entry.sign_on)||(entry&&entry.created_at)||'');
}
function vesselReviewContributionStats(entries){
    entries=entries||[];
    var reviewed=entries.filter(vesselReviewHasLocal);
    var needs=entries.filter(vesselReviewNeedsLocal).sort(function(a,b){return vesselReviewSortKey(b).localeCompare(vesselReviewSortKey(a));});
    return {
        reviewed_count:reviewed.length,
        needs_count:needs.length,
        latest_unreviewed:needs[0]||null,
        total_with_imo:entries.filter(function(e){return !!normalizeImo(e&&e.imo);}).length
    };
}
async function loadVesselReviewContributionStats(){
    try{return vesselReviewContributionStats(await invoke('get_work_history')||[]);}
    catch(e){return vesselReviewContributionStats([]);}
}
function openLatestUnreviewedVesselReview(){
    var st=window._vesselReviewStats||{};
    var row=st.latest_unreviewed;
    if(row&&row.id)openReviewFromEntryId(row.id);
    else showView('experience');
}
function reviewContributionLine(stats){
    stats=stats||{};
    if(stats.reviewed_count>0){
        return rvText(
            'Вы уже помогли будущим морякам: подтверждённых отзывов '+stats.reviewed_count+'.',
            'You have helped future crews with '+stats.reviewed_count+' verified vessel review'+(stats.reviewed_count===1?'':'s')+'.'
        );
    }
    return rvText(
        'Первый отзыв особенно ценен: он превращает ваш Sea Service в полезный сигнал для других моряков.',
        'Your first review matters: it turns your Sea Service into a useful signal for other seafarers.'
    );
}
function renderReviewNudgeCard(stats,context){
    stats=stats||{};
    var row=stats.latest_unreviewed;
    if(!row&&stats.reviewed_count<=0)return '';
    var title='', body='';
    if(context==='jobs'){
        title=rvText('Проверьте судно перед откликом','Review vessels before applying');
        body=rvText(
            'Базовые вакансии остаются доступными всем. Чем больше моряки оставляют подтверждённых отзывов, тем полезнее становятся оценки судов рядом с предложениями.',
            'Basic vacancies stay visible for everyone. Verified vessel reviews make the vessel ratings beside job offers more useful.'
        );
    }else if(context==='vessels'){
        title=rvText('База судов становится сильнее от ваших рейсов','Vessel DB gets stronger from your Sea Service');
        body=rvText(
            'Если вы уже работали на судне, оценка сохранится в вашей истории и попадёт в общую анонимную статистику.',
            'If you worked on a vessel, your rating stays in your history and contributes to anonymous aggregate statistics.'
        );
    }else{
        title=rvText('Оцените судно из вашего Sea Service','Rate a vessel from your Sea Service');
        body=rvText(
            'Оценка сохраняется в вашем послужном списке, помогает сравнивать будущие предложения и публикуется анонимно.',
            'The rating stays in your career record, helps compare future offers, and is published anonymously.'
        );
    }
    var h='<div class="review-nudge-card">';
    h+='<div><strong>'+esc(title)+'</strong><p>'+esc(reviewContributionLine(stats))+' '+esc(body)+'</p>';
    if(row){
        h+='<p><span class="review-trust-chip">'+esc(rvText('подтверждается Sea Service','verified by Sea Service'))+'</span> '+esc(row.vessel_name||('IMO '+row.imo))+(row.imo?' · IMO '+esc(row.imo):'')+'</p>';
    }
    h+='</div><div class="review-nudge-actions">';
    if(row)h+='<button class="btn btn-accent btn-sm" onclick="openLatestUnreviewedVesselReview()">'+esc(rvText('Оценить судно','Rate vessel'))+'</button>';
    h+='<button class="btn btn-outline btn-sm" onclick="showView(\'vessels\')">'+esc(rvText('База судов','Vessel DB'))+'</button>';
    h+='</div></div>';
    return h;
}
function noteVesselDbVisit(){
    var n=0;
    try{n=parseInt(localStorage.getItem(VESSEL_DB_VISITS_KEY)||'0',10)||0;}catch(_){}
    n++;
    try{localStorage.setItem(VESSEL_DB_VISITS_KEY,String(n));}catch(_){}
    return n;
}
function renderVesselDbReviewNudge(stats,visitCount){
    if(!stats||!stats.latest_unreviewed)return '';
    if((visitCount||0)<2&&stats.reviewed_count>0)return '';
    return renderReviewNudgeCard(stats,'vessels');
}
function readVesselReviewCache(){
    if(vesselReviewCache)return vesselReviewCache;
    try{vesselReviewCache=JSON.parse(localStorage.getItem(VESSEL_REVIEW_CACHE_KEY)||'{}')||{};}
    catch(e){vesselReviewCache={};}
    return vesselReviewCache;
}
function writeVesselReviewCache(cache){
    vesselReviewCache=cache||{};
    try{localStorage.setItem(VESSEL_REVIEW_CACHE_KEY,JSON.stringify(vesselReviewCache));}catch(e){}
}
function vesselApiBases(){
    var bases=apiBaseCandidates().map(function(base){return base + '/api/vessels/';});
    if(VESSEL_REVIEWS_FALLBACK_API&&bases.indexOf(VESSEL_REVIEWS_FALLBACK_API)===-1)bases.push(VESSEL_REVIEWS_FALLBACK_API);
    return bases;
}
async function fetchWithTimeout(url,options,timeoutMs){
    if(typeof AbortController==='undefined')return fetch(url,options);
    var controller=new AbortController();
    var timer=setTimeout(function(){controller.abort();},timeoutMs||3500);
    var opts=Object.assign({},options||{},{signal:controller.signal});
    try{return await fetch(url,opts);}
    finally{clearTimeout(timer);}
}
async function requestVesselProjection(imo){
    var invokeErr = null;
    // Desktop-first path: use Tauri backend HTTP client. This bypasses
    // WebView fetch/CORS issues that can surface as "TypeError: Load failed".
    try{
        if(typeof invoke==='function'){
            var payload=await invoke('fetch_vessel_projection',{imo:String(imo||'')});
            if(payload&&typeof payload==='object'){
                return {status:'ok',imo:imo,payload:payload,source:'invoke'};
            }
            invokeErr = 'empty response from fetch_vessel_projection';
        }else{
            invokeErr = 'tauri invoke is unavailable';
        }
    }catch(e){
        invokeErr = String(e);
        logError('vessel_projection_invoke',e);
    }

    // Fallback path (kept for safety): direct fetch against known bases.
    var bases=vesselApiBases();
    return new Promise(function(resolve){
        var pending=bases.length;
        var done=false;
        var sawNotFound=false;
        var lastError='';
        function finishFallback(){
            if(done)return;
            if(pending>0)return;
            done=true;
            if(sawNotFound){
                resolve({status:'not_found',imo:imo});
                return;
            }
            var msg = lastError || 'network error';
            if(invokeErr)msg='invoke failed: '+invokeErr+'; fetch failed: '+msg;
            resolve({status:'error',imo:imo,error:msg});
        }
        bases.forEach(function(base){
            fetchWithTimeout(base+encodeURIComponent(imo),{headers:{'Accept':'application/json'}},3500).then(function(resp){
                if(done)return null;
                if(resp.status===404){sawNotFound=true;return null;}
                if(resp.ok){
                    done=true;
                    return resp.json().then(function(payload){resolve({status:'ok',imo:imo,payload:payload});});
                }
                lastError='server '+resp.status;
                return null;
            }).catch(function(e){
                lastError=String(e);
            }).finally(function(){
                pending--;
                finishFallback();
            });
        });
    });
}
async function fetchVesselReviewProjection(imo, force){
    var cache=readVesselReviewCache();
    var cached=cache[imo];
    if(!force&&cached&&cached.fetched_at&&Date.now()-cached.fetched_at<VESSEL_REVIEW_CACHE_TTL_MS){
        return cached;
    }
    try{
        var entry=await requestVesselProjection(imo);
        entry.fetched_at=Date.now();
        cache[imo]=entry;
        writeVesselReviewCache(cache);
        return entry;
    }catch(e){
        if(cached&&cached.payload){
            cached.stale=true;
            return cached;
        }
        return {status:'error',imo:imo,error:String(e),fetched_at:Date.now()};
    }
}
function vrevMetric(label,value){
    if(value===undefined||value===null||value==='')return '';
    var n=Number(value);
    if(!isFinite(n))return '';
    return '<span class="vrev-chip">'+esc(label)+' <strong>'+n.toFixed(1)+'&#9733;</strong></span>';
}
function vrevSectionAvg(epoch,sectionId){
    var rows=(epoch&&epoch.section_breakdown)||[];
    for(var i=0;i<rows.length;i++){
        if(rows[i].id===sectionId)return rows[i].avg;
    }
    return null;
}
function vrevFlagLabel(flag){
    var labels={
        delayed_crew_change:'delayed crew change',
        salary_delays:'salary delays',
        fake_rest_hours_pressure:'fake rest hours pressure',
        no_shore_leave:'no shore leave',
        poor_food:'poor food',
        no_spares:'no spares',
        unsafe_condition:'unsafe condition',
        bullying_harassment:'bullying / harassment',
        excessive_paperwork:'excessive paperwork',
        bad_internet:'bad internet',
        medical_support_denied:'medical support denied',
        vetting_overtime:'vetting overtime',
        inspection_panic_mode:'inspection panic mode',
        painted_for_inspection_only:'painted for inspection',
        shore_leave_cancelled_for_vetting:'shore leave cancelled',
        crew_blamed_for_deficiencies:'crew blamed',
        no_resources_for_vetting_prep:'no resources for prep'
    };
    return labels[flag]||String(flag||'').replace(/_/g,' ');
}
function vrevReviewCta(imo){
    return '<div class="vrev-cta"><a onclick="openReviewFromImo(\''+escAttr(imo)+'\')">Write your review</a></div>';
}
function renderVesselReviewProjection(entry,imo){
    if(!entry||entry.status==='error'){
        return '<div class="vrev-head"><span class="vrev-title">Vessel reviews</span><span class="badge badge-none">Unavailable</span></div>'+vrevReviewCta(imo);
    }
    if(entry.status==='not_found'||!entry.payload){
        return '<div class="vrev-head"><span class="vrev-title">Vessel reviews</span><span class="badge badge-none">No public reviews yet</span></div>'+vrevReviewCta(imo);
    }
    var data=entry.payload||{};
    var reviews=data.reviews||{};
    var byEpoch=reviews.by_epoch||[];
    var publicOverall=Number(data.average_overall);
    if(!byEpoch.length&&isFinite(publicOverall)){
        var publicCount=Number(data.review_count||0);
        var publicLowSample=vesselRatingLowSample(publicCount, data.rating_access&&data.rating_access.low_sample);
        var publicMeta=publicCount?publicCount+' review'+(publicCount===1?'':'s'):'review signal';
        var ph='<div class="vrev-head">';
        ph+='<span class="vrev-title">Vessel reviews</span>';
        ph+='<span class="vrev-rating"><span class="rating-starline '+(publicLowSample?'low-sample':'')+'">'+publicOverall.toFixed(1)+'&#9733;</span> <span class="vrev-muted">&middot; '+esc(publicMeta)+'</span>'+vesselRatingSampleHtml(publicCount,publicLowSample)+'</span>';
        ph+='</div>';
        ph+=vrevReviewCta(imo);
        return ph;
    }
    if(!byEpoch.length){
        return '<div class="vrev-head"><span class="vrev-title">Vessel reviews</span><span class="badge badge-none">No public reviews yet</span></div>'+vrevReviewCta(imo);
    }
    var currentEpochIds={};
    (data.manager_epochs||[]).forEach(function(ep){if(ep&&ep.is_current)currentEpochIds[ep.id]=true;});
    var epoch=byEpoch.find(function(x){return x&&x.manager_epoch_id&&currentEpochIds[x.manager_epoch_id];})||byEpoch[0];
    var indices=epoch.indices||{};
    var n=epoch.n||0;
    var overall=indices.overall;
    var overallText=(overall!==undefined&&overall!==null)?Number(overall).toFixed(1)+'&#9733;':'Rated';
    var metrics='';
    metrics+=vrevMetric('Workload',indices.workload);
    metrics+=vrevMetric('Company',indices.company);
    metrics+=vrevMetric('Life',indices.life_onboard);
    metrics+=vrevMetric('Inspection pressure',vrevSectionAvg(epoch,'vetting_pressure'));
    var flags=(reviews.warning_flag_prevalence||[]).slice(0,3);
    var risks='';
    flags.forEach(function(f){
        if(!f||!f.flag)return;
        risks+='<span>'+esc(vrevFlagLabel(f.flag))+' '+Math.round(Number(f.pct||0)*100)+'%</span>';
    });
    var h='<div class="vrev-head">';
    h+='<span class="vrev-title">Vessel reviews</span>';
    var epochLowSample=vesselRatingLowSample(n,data.rating_access&&data.rating_access.low_sample);
    h+='<span class="vrev-rating"><span class="rating-starline '+(epochLowSample?'low-sample':'')+'">'+overallText+'</span> <span class="vrev-muted">&middot; '+n+' review'+(n===1?'':'s')+'</span>'+vesselRatingSampleHtml(n,epochLowSample)+'</span>';
    h+='</div>';
    if(metrics)h+='<div class="vrev-metrics">'+metrics+'</div>';
    if(risks)h+='<div class="vrev-risk">'+risks+'</div>';
    h+=vrevReviewCta(imo);
    return h;
}
function renderVesselReviewLoading(){
    return '<div class="vrev-head"><span class="vrev-title">Vessel reviews</span><span class="badge badge-none">Checking</span></div>';
}
function renderRecentVesselReviews(items){
    items=items||[];
    var h='<div class="vdb-section"><h3>Latest vessel reviews</h3>';
    if(!items.length){
        h+='<div class="vdb-row"><div class="vdb-row-title">No public vessel reviews yet.</div><div class="vdb-row-meta">Reviewed vessels will appear here after seafarers submit approved reviews.</div></div>';
        h+='</div>';
        return h;
    }
    h+='<div class="vdb-list">';
    items.slice(0,10).forEach(function(item){
        var imo=normalizeImo(item.imo);
        if(!imo)return;
        var name=item.name_current||('IMO '+imo);
        var meta=[];
        if(item.vessel_type)meta.push(vdbLabel(item.vessel_type));
        if(item.flag_current)meta.push(item.flag_current);
        if(item.latest_review_at)meta.push('latest '+vdbDate(item.latest_review_at));
        meta.push((item.review_count||0)+' review'+(Number(item.review_count)===1?'':'s'));
        var rating='';
        if(item.average_overall!==undefined&&item.average_overall!==null){
            var n=Number(item.average_overall);
            if(isFinite(n))rating=' · '+n.toFixed(1)+'/5'+vesselRatingSampleText(item.review_count,item.low_sample);
        }else if(item.signals_available){
            rating=' · rating locked';
        }
        h+='<div class="vdb-row" role="button" tabindex="0" style="cursor:pointer;" onclick="openVesselFromRecentReview(\''+escAttr(imo)+'\')" onkeydown="if(event.key===\'Enter\')openVesselFromRecentReview(\''+escAttr(imo)+'\')">';
        h+='<div class="vdb-row-title">'+esc(name)+' <span style="color:var(--text2);font-weight:500;">IMO '+esc(imo)+'</span></div>';
        h+='<div class="vdb-row-meta">'+esc(meta.join(' · '))+rating+'</div>';
        h+='</div>';
    });
    h+='</div></div>';
    return h;
}
async function loadRecentVesselReviews(){
    var host=document.getElementById('vdb-recent-reviews');
    if(!host)return;
    host.innerHTML='<div class="vdb-section"><h3>Latest vessel reviews</h3><div class="vdb-row"><div class="vdb-row-title">Loading latest reviewed vessels...</div></div></div>';
    try{
        var items=await invoke('fetch_recent_vessel_reviews',{limit:10});
        host.innerHTML=renderRecentVesselReviews(items||[]);
        return;
    }catch(e){
        logError('recent_vessel_reviews_invoke',e);
    }
    try{
        var r=await apiFetch('/api/vessels/recent-reviews?limit=10',{},8000);
        if(!r.ok)throw new Error('server '+r.status);
        var data=await r.json();
        host.innerHTML=renderRecentVesselReviews(data.items||[]);
    }catch(e){
        logError('recent_vessel_reviews',e);
        host.innerHTML='<div class="vdb-section"><h3>Latest vessel reviews</h3><div class="vdb-row"><div class="vdb-row-title">Latest reviews unavailable.</div><div class="vdb-row-meta">'+esc(String(e))+'</div></div></div>';
    }
}
function openVesselFromRecentReview(imo){
    var norm=normalizeImo(imo);
    if(!norm)return;
    vesselDbPendingImo=norm;
    vesselDbJobContext=null;
    var input=document.getElementById('vdb-imo-input');
    if(input){
        input.value=norm;
        lookupVesselByImo(false);
    }else{
        showVesselDatabase();
    }
}
function vesselProjectionRatingSummary(data){
    data=data||{};
    var n=Number(data.average_overall);
    if(isFinite(n)){
        return {value:n,count:data.review_count||0,source:'public',low_sample:vesselRatingLowSample(data.review_count,data.rating_access&&data.rating_access.low_sample)};
    }
    var reviews=data.reviews||{};
    var byEpoch=reviews.by_epoch||[];
    if(byEpoch.length){
        var currentEpochIds={};
        (data.manager_epochs||[]).forEach(function(ep){if(ep&&ep.is_current)currentEpochIds[ep.id]=true;});
        var epoch=byEpoch.find(function(x){return x&&x.manager_epoch_id&&currentEpochIds[x.manager_epoch_id];})||byEpoch[0];
        var overall=epoch&&epoch.indices?Number(epoch.indices.overall):NaN;
        if(isFinite(overall)){
            return {value:overall,count:epoch.n||0,source:'review_projection',low_sample:vesselRatingLowSample(epoch.n,data.rating_access&&data.rating_access.low_sample)};
        }
    }
    return null;
}
function renderExperienceVesselRating(entry,imo,entryId,vesselName){
    entryId=entryId||'';
    vesselName=vesselName||'';
    if(!entry){
        return '<button type="button" class="exp-vessel-rating-link empty" onclick="openVesselFromExperience(\''+escAttr(entryId)+'\',\''+escAttr(imo)+'\',\''+escAttr(vesselName)+'\')" title="Open vessel database">'
            + '<span class="stars">☆☆☆☆☆</span><span class="meta">Checking vessel rating...</span></button>';
    }
    var data=entry.payload||{};
    var rating=(entry.status==='ok'&&data)?vesselProjectionRatingSummary(data):null;
    var cls=rating?'exp-vessel-rating-link':'exp-vessel-rating-link empty';
    if(rating&&rating.low_sample)cls+=' low-sample';
    var label=data.name_current||vesselName||'';
    var meta='';
    if(rating){
        meta=rating.value.toFixed(1)+'/5'+(rating.count?' · '+rating.count+' reviews':'')+vesselRatingSampleText(rating.count,rating.low_sample)+' · open vessel database';
        return '<button type="button" class="'+cls+'" onclick="openVesselFromExperience(\''+escAttr(entryId)+'\',\''+escAttr(imo)+'\',\''+escAttr(label)+'\')" title="Open vessel database">'
            + '<span class="stars">'+vdbStarLine(rating.value)+'</span><span class="meta">'+esc(meta)+'</span></button>';
    }
    if(entry.status==='not_found'){
        meta='No vessel rating yet · open vessel database';
    }else if(entry.status==='error'){
        meta='Vessel database unavailable · open cached/lookup view';
    }else{
        var access=data.rating_access||{};
        meta=access.signals_available?'Rating signals exist · open vessel database':'No vessel rating yet · open vessel database';
    }
    return '<button type="button" class="'+cls+'" onclick="openVesselFromExperience(\''+escAttr(entryId)+'\',\''+escAttr(imo)+'\',\''+escAttr(label)+'\')" title="Open vessel database">'
        + '<span class="stars">☆☆☆☆☆</span><span class="meta">'+esc(meta)+'</span></button>';
}

// --- extracted from seafarer dist/index.html:11608-11628 (groupVesselsFromWorkHistory) ---
function groupVesselsFromWorkHistory(entries){
    var map={};
    (entries||[]).forEach(function(e){
        var imo=normalizeImo(e.imo);
        if(!imo)return;
        if(!map[imo]){
            map[imo]={imo:imo,name:e.vessel_name||'',type:e.vessel_type||'',flag:e.flag||'',company:e.company||'',contracts:0,last:''};
        }
        var row=map[imo];
        row.contracts++;
        var marker=String(e.sign_off||e.sign_on||e.created_at||'');
        if(marker>=String(row.last||'')){
            row.last=marker;
            row.name=e.vessel_name||row.name;
            row.type=e.vessel_type||row.type;
            row.flag=e.flag||row.flag;
            row.company=e.company||row.company;
        }
    });
    return Object.keys(map).map(function(k){return map[k];}).sort(function(a,b){return String(b.last||'').localeCompare(String(a.last||''));});
}

// --- extracted from seafarer dist/index.html:11630-11639 (hydrateVesselDatabaseReviews) ---
async function hydrateVesselDatabaseReviews(vessels){
    (vessels||[]).forEach(function(v){
        var host=document.getElementById('vdb-vrev-'+v.imo);
        if(host)host.innerHTML=renderVesselReviewLoading();
        fetchVesselReviewProjection(v.imo,false).then(function(entry){
            var el=document.getElementById('vdb-vrev-'+v.imo);
            if(el)el.innerHTML=renderVesselReviewProjection(entry,v.imo);
        }).catch(function(e){logError('vessel_db_reviews:'+v.imo,e);});
    });
}

// --- extracted from seafarer dist/index.html:11641-11804 (vdbText,vdbNumber,vdbDate,vdbLabel,vdbKv,vdbScore,vdbStarLine,vesselRatingLowSample,vesselRatingSampleHtml,vesselRatingSampleText,renderVesselDbStars,vdbFactValue,renderVesselDbRatings,renderVesselDbManagers,renderVesselDbBiography,renderVesselDbSummary) ---
function vdbText(v){
    if(v===null||v===undefined||v==='')return '—';
    return String(v);
}
function vdbNumber(v){
    var n=Number(v);
    if(!isFinite(n))return vdbText(v);
    return n.toLocaleString();
}
function vdbDate(v){
    if(!v)return '—';
    return String(v).slice(0,10);
}
function vdbLabel(v){
    return String(v||'').replace(/_/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
}
function vdbKv(label,value){
    return '<div><span>'+esc(label)+'</span><strong>'+esc(vdbText(value))+'</strong></div>';
}
function vdbScore(label,value,suffix){
    if(value===null||value===undefined||value==='')return '';
    return '<div class="vdb-score"><span>'+esc(label)+'</span><strong>'+esc(vdbText(value))+(suffix||'')+'</strong></div>';
}
function vdbStarLine(value){
    var n=Number(value);
    var full=isFinite(n)?Math.max(0,Math.min(5,Math.round(n))):0;
    var out='';
    for(var i=1;i<=5;i++)out+=i<=full?'★':'☆';
    return out;
}
function vesselRatingLowSample(count, explicit){
    if(explicit===true)return true;
    var n=Number(count||0);
    return isFinite(n)&&n>0&&n<3;
}
function vesselRatingSampleHtml(count, explicit){
    return vesselRatingLowSample(count, explicit)?' <span class="rating-sample-note">small sample</span>':'';
}
function vesselRatingSampleText(count, explicit){
    return vesselRatingLowSample(count, explicit)?' · small sample':'';
}
function renderVesselDbStars(data){
    var access=data.rating_access||{};
    var n=Number(data.average_overall);
    if(isFinite(n)){
        var low=vesselRatingLowSample(data.review_count,access.low_sample);
        return '<div class="vdb-stars '+(low?'low-sample':'')+'"><div class="vdb-starline">'+vdbStarLine(n)+'</div><div class="vdb-star-meta">'+n.toFixed(1)+'/5'+(data.review_count?' · '+esc(data.review_count)+' reviews':'')+vesselRatingSampleHtml(data.review_count,low)+'</div></div>';
    }
    if(access.signals_available){
        return '<div class="vdb-stars locked"><div class="vdb-starline">☆☆☆☆☆</div><div class="vdb-star-meta">Rating signals exist · detailed view improves as verified seafarers contribute reviews</div></div>';
    }
    return '<div class="vdb-stars empty"><div class="vdb-starline">☆☆☆☆☆</div><div class="vdb-star-meta">No public rating yet · your Sea Service review can start it</div></div>';
}
function vdbFactValue(value){
    if(value===null||value===undefined||value==='')return '';
    if(typeof value!=='object')return String(value);
    var parts=[];
    Object.keys(value).forEach(function(k){
        var v=value[k];
        parts.push(vdbLabel(k)+': '+(typeof v==='object'?JSON.stringify(v):String(v)));
    });
    return parts.join(', ');
}
function renderVesselDbRatings(data){
    var h='<div class="vdb-section"><h3>Ratings and scores</h3>';
    h+=renderVesselDbStars(data);
    var scores='';
    scores+=vdbScore('Technical index',data.skipi_technical_index,'/100');
    scores+=vdbScore('Comfort score',data.skipi_comfort_score,'/100');
    scores+=vdbScore('Commercial reliability',data.skipi_commercial_reliability,'/100');
    scores+=vdbScore('Safety culture',data.skipi_safety_culture,'/100');
    scores+=vdbScore('Operational risk',data.skipi_operational_risk,'');
    scores+=vdbScore('Confidence',data.skipi_score_confidence,'');
    if(scores){
        h+='<div class="vdb-score-grid">'+scores+'</div>';
        if(data.review_count)h+='<div class="vdb-row-meta" style="margin-top:8px;">'+esc(data.review_count)+' approved review signals included'+vesselRatingSampleText(data.review_count,data.rating_access&&data.rating_access.low_sample)+'.</div>';
    }else{
        var access=data.rating_access||{};
        var text=access.signals_available?'Rating signals exist, but this client does not have rating access yet.':'No public rating signals are available for this IMO yet.';
        h+='<div class="vdb-row"><div class="vdb-row-title">'+esc(text)+'</div><div class="vdb-row-meta">Basic vessel data, manager history, facts and events stay visible.</div></div>';
    }
    h+='</div>';
    return h;
}
function renderVesselDbManagers(data){
    var rows=data.manager_epochs||[];
    var h='<div class="vdb-section"><h3>Management history</h3><div class="vdb-list">';
    if(rows.length){
        rows.forEach(function(ep){
            var dates=(ep.valid_from?vdbDate(ep.valid_from):'unknown')+' - '+(ep.valid_to?vdbDate(ep.valid_to):'current');
            h+='<div class="vdb-row"><div class="vdb-row-title">'+esc(vdbText(ep.manager_name))+'</div>';
            h+='<div class="vdb-row-meta">'+esc(vdbLabel(ep.manager_role))+' &middot; '+esc(dates);
            if(ep.confidence!==null&&ep.confidence!==undefined)h+=' &middot; confidence '+esc(ep.confidence);
            h+='</div></div>';
        });
    }else{
        var fallback=[];
        if(data.current_technical_manager_name)fallback.push(['Technical manager',data.current_technical_manager_name,data.current_technical_manager_country]);
        if(data.current_commercial_manager_name)fallback.push(['Commercial manager',data.current_commercial_manager_name,data.current_commercial_manager_country]);
        if(data.current_owner_name)fallback.push(['Owner',data.current_owner_name,data.current_owner_country]);
        if(fallback.length){
            fallback.forEach(function(r){h+='<div class="vdb-row"><div class="vdb-row-title">'+esc(r[1])+'</div><div class="vdb-row-meta">'+esc(r[0])+(r[2]?' &middot; '+esc(r[2]):'')+'</div></div>';});
        }else{
            h+='<div class="vdb-row"><div class="vdb-row-title">No management history recorded yet.</div></div>';
        }
    }
    h+='</div></div>';
    return h;
}
function renderVesselDbBiography(data){
    var facts=data.facts||[];
    var events=data.events||[];
    var sanctions=data.sanctions||[];
    var h='<div class="vdb-section"><h3>Biography facts</h3><div class="vdb-list">';
    if(!facts.length&&!events.length&&!sanctions.length){
        h+='<div class="vdb-row"><div class="vdb-row-title">No public facts or events recorded yet.</div></div>';
    }
    sanctions.forEach(function(s){
        h+='<div class="vdb-row"><div class="vdb-row-title">'+esc(vdbLabel(s.list_name))+' sanction: '+esc(vdbLabel(s.status))+'</div>';
        h+='<div class="vdb-row-meta">'+esc(vdbDate(s.designation_date))+(s.removal_date?' to '+esc(vdbDate(s.removal_date)):'')+(s.reason?' &middot; '+esc(s.reason):'')+'</div></div>';
    });
    events.forEach(function(ev){
        h+='<div class="vdb-row"><div class="vdb-row-title">'+esc(ev.title||vdbLabel(ev.event_type))+'</div>';
        h+='<div class="vdb-row-meta">'+esc(vdbDate(ev.occurred_at))+' &middot; '+esc(vdbLabel(ev.event_type))+(ev.severity?' &middot; '+esc(vdbLabel(ev.severity)):'')+'</div>';
        if(ev.summary)h+='<div style="margin-top:4px;">'+esc(ev.summary)+'</div>';
        h+='</div>';
    });
    facts.forEach(function(f){
        var value=vdbFactValue(f.value);
        h+='<div class="vdb-row"><div class="vdb-row-title">'+esc(vdbLabel(f.fact_type))+(value?': '+esc(value):'')+'</div>';
        h+='<div class="vdb-row-meta">'+(f.observed_at?'Observed '+esc(vdbDate(f.observed_at)):'Claim')+(f.confidence!==null&&f.confidence!==undefined?' &middot; confidence '+esc(f.confidence):'')+'</div></div>';
    });
    h+='</div></div>';
    return h;
}
function renderVesselDbSummary(data){
    var name=data.name_current||('IMO '+data.imo);
    var h='<div class="vdb-hero">';
    h+='<h2>'+esc(name)+'</h2>';
    h+='<div class="vdb-badges">';
    h+='<span class="badge badge-none">IMO '+esc(data.imo)+'</span>';
    if(data.status)h+='<span class="badge badge-valid">'+esc(vdbLabel(data.status))+'</span>';
    if(data.flag_current)h+='<span class="badge badge-none">'+esc(data.flag_current)+'</span>';
    if(data.vessel_type)h+='<span class="badge badge-none">'+esc(vdbLabel(data.vessel_type))+'</span>';
    h+='</div></div>';
    h+='<div class="review-impact-strip"><strong>'+esc(rvText('Как работает оценка','How ratings work'))+'</strong><br>'+esc(rvText('Базовые данные видны всем. Отзывы от моряков, у которых это судно есть в Sea Service, учитываются как подтверждённые и не раскрывают личность автора.','Basic vessel data is visible to everyone. Reviews from seafarers who have this vessel in Sea Service count as verified and do not disclose the author.'))+'</div>';
    h+='<div class="vdb-section"><h3>Vessel data</h3><div class="vdb-kv">';
    h+=vdbKv('Type',data.vessel_type? vdbLabel(data.vessel_type):'');
    h+=vdbKv('Subtype',data.vessel_subtype? vdbLabel(data.vessel_subtype):'');
    h+=vdbKv('Flag',data.flag_current);
    h+=vdbKv('Built year',data.built_year);
    h+=vdbKv('DWT',data.dwt!==null&&data.dwt!==undefined?vdbNumber(data.dwt):'');
    h+=vdbKv('Gross tonnage',data.gross_tonnage!==null&&data.gross_tonnage!==undefined?vdbNumber(data.gross_tonnage):'');
    h+=vdbKv('Class society',data.class_society);
    h+=vdbKv('Builder',[(data.builder_yard||''),(data.builder_origin||'')].filter(Boolean).join(', '));
    h+=vdbKv('Owner company',data.owner_company);
    h+=vdbKv('Operator company',data.operator_company);
    h+='</div></div>';
    h+=renderVesselDbRatings(data);
    h+=renderVesselDbManagers(data);
    h+=renderVesselDbBiography(data);
    h+='<div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-outline btn-sm" onclick="openReviewFromImo(\''+escAttr(data.imo)+'\')">Write review</button><button class="btn btn-outline btn-sm" onclick="lookupVesselByImo(true)">Refresh</button></div>';
    return h;
}

// --- extracted from seafarer dist/index.html:11807-12004 (VESSEL_DB_UI_DEMO_PREVIEW,vesselDbDemoSelectedId,vesselDbDemoAttachOpen,vesselDbDemoMobileStep,vesselDbDemoMobileSelectedId,vesselDbDemoAttachState,vesselDbDemoEnabled,vesselDbDemoFixture,vesselDbDemoSelected,vesselDbDemoKv,vesselDbDemoIdentityMismatch,vesselDbDemoSelect,vesselDbDemoShowAttach,vesselDbDemoCloseAttach,vesselDbDemoAttachPreview,vesselDbDemoHeader,vesselDbDemoResults,vesselDbDemoDetail,vesselDbDemoStateMatrix,vesselDbDemoModal,renderVesselDbDemo,mobileVesselDbDemoSet,mobileVesselDbDemoResult,mobileRenderVesselDbDemoSearch,mobileRenderVesselDbDemoDetail,mobileRenderVesselDbDemoAttach,renderMobileVesselDbDemo) ---
var VESSEL_DB_UI_DEMO_PREVIEW=false;
var vesselDbDemoSelectedId='pacific-aurora';
var vesselDbDemoAttachOpen=false;
var vesselDbDemoMobileStep='search';
var vesselDbDemoMobileSelectedId='pacific-aurora';
var vesselDbDemoAttachState='ready';
function vesselDbDemoEnabled(){
    try{
        if(localStorage.getItem('skipi.vesselDbUiDemo')==='on')return true;
        if(localStorage.getItem('skipi.vesselDbUiDemo')==='off')return false;
    }catch(_){}
    try{
        if(String(location.search||'').indexOf('vessel-db-demo=1')>=0)return true;
    }catch(_){}
    return !!VESSEL_DB_UI_DEMO_PREVIEW;
}
var vesselDbDemoFixture={
    query:'IMO 9837421 / PACIFIC AURORA',
    target:{label:'3/E vacancy SF-2026-014',context:'Seafarer application review',expected_imo:'9837421',expected_mmsi:'538009441',expected_call_sign:'V7A4412',expected_name:'PACIFIC AURORA'},
    results:[
        {id:'pacific-aurora',name:'PACIFIC AURORA',match:'Exact IMO',provenance:'Equasis + AIS',freshness:'Fresh 2h',confidence:98,imo:'9837421',mmsi:'538009441',call_sign:'V7A4412',flag:'Marshall Islands',type:'Bulk carrier',built:'2019',gt:'43,120 GT',dwt:'81,440 t',length:'229.0 m',beam:'32.2 m',risk:'Selected vessel matches IMO, MMSI, call sign and name.',status:'Verified identity'},
        {id:'pacific-aurora-ii',name:'PACIFIC AURORA II',match:'Similar name',provenance:'AIS only',freshness:'Stale 19d',confidence:71,imo:'9837429',mmsi:'538009419',call_sign:'V7B9120',flag:'Liberia',type:'Bulk carrier',built:'2015',gt:'41,880 GT',dwt:'78,100 t',length:'225.4 m',beam:'32.2 m',risk:'Name is close, but IMO and call sign do not match the expected vessel.',status:'Ambiguous'},
        {id:'aurora-pacific',name:'AURORA PACIFIC',match:'Ambiguous',provenance:'Registry',freshness:'Needs verify',confidence:64,imo:'9471120',mmsi:'636018882',call_sign:'D5MT7',flag:'Liberia',type:'Container ship',built:'2012',gt:'50,200 GT',dwt:'61,300 t',length:'294.1 m',beam:'32.3 m',risk:'Words are reversed and identifiers point to another vessel.',status:'Needs review'},
        {id:'pacific-arora',name:'PACIFIC ARORA',match:'Fuzzy typo',provenance:'AIS only',freshness:'Partial',confidence:58,imo:'9837420',mmsi:'538009440',call_sign:'V7A4402',flag:'Panama',type:'General cargo',built:'2008',gt:'12,430 GT',dwt:'18,990 t',length:'149.6 m',beam:'23.0 m',risk:'Typo candidate, but IMO checksum and call sign differ.',status:'Invalid vessel'}
    ],
    sources:[
        ['Equasis','98%','Fresh 2h'],
        ['AIS','93%','Fresh 7m'],
        ['Registry','Locked','Policy-limited'],
        ['Company fleet cache','87%','Synced 1d']
    ],
    states:[
        ['empty','No result yet'],
        ['partial','Record has limited public data'],
        ['stale','Source older than freshness policy'],
        ['offline','Uses last local fixture snapshot'],
        ['redacted','Some fields unavailable in this context'],
        ['locked','Role or license does not open more detail'],
        ['ambiguous','Multiple candidates need operator choice'],
        ['forbidden','Current context cannot attach this vessel'],
        ['invalid-vessel','Identity mismatch blocks attach'],
        ['invalid-context','Target context is missing or incompatible']
    ]
};
function vesselDbDemoSelected(){
    var rows=vesselDbDemoFixture.results;
    return rows.find(function(r){return r.id===vesselDbDemoSelectedId;})||rows[0];
}
function vesselDbDemoKv(label,value){
    return '<div><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></div>';
}
function vesselDbDemoIdentityMismatch(row){
    var t=vesselDbDemoFixture.target;
    return String(row.imo)!==t.expected_imo||String(row.mmsi)!==t.expected_mmsi||String(row.call_sign)!==t.expected_call_sign||String(row.name)!==t.expected_name;
}
function vesselDbDemoSelect(id){
    vesselDbDemoSelectedId=id||'pacific-aurora';
    vesselDbDemoAttachOpen=false;
    showVesselDatabase();
}
function vesselDbDemoShowAttach(){
    vesselDbDemoAttachOpen=true;
    vesselDbDemoAttachState='ready';
    showVesselDatabase();
}
function vesselDbDemoCloseAttach(){
    vesselDbDemoAttachOpen=false;
    showVesselDatabase();
}
function vesselDbDemoAttachPreview(){
    var row=vesselDbDemoSelected();
    vesselDbDemoAttachState=vesselDbDemoIdentityMismatch(row)?'invalid-vessel':'success';
    showVesselDatabase();
}
function vesselDbDemoHeader(){
    return '<div class="vdb-demo-head">'
        + '<div><h2 class="vdb-demo-title">Ship Database</h2><div class="vdb-demo-sub">Fixture-only preview for Seafarer. Network: none. Real vessel module is not loaded.</div></div>'
        + '<div class="vdb-demo-pills" data-qa="vessel-db-demo-scope-switcher"><span class="vdb-demo-pill live">Public registry</span><span class="vdb-demo-pill">My fleet</span><span class="vdb-demo-pill">Company scope</span><span class="vdb-demo-pill warn">Vacancy context</span><span class="vdb-demo-pill">Live sources</span></div>'
        + '</div>';
}
function vesselDbDemoResults(){
    var f=vesselDbDemoFixture;
    var h='<div class="vdb-demo-panel" data-qa="vessel-db-demo-search-pane">';
    h+='<div class="vdb-demo-pills"><span class="vdb-demo-pill">S</span><span class="vdb-demo-pill">V</span><span class="vdb-demo-pill">A</span><span class="vdb-demo-pill">P</span></div>';
    h+='<div class="vdb-demo-search"><input readonly value="'+escAttr(f.query)+'" aria-label="Find vessel"><button class="btn btn-accent btn-sm" type="button">Find vessel</button></div>';
    h+='<div class="vdb-demo-filters"><span class="vdb-demo-filter">IMO</span><span class="vdb-demo-filter">MMSI</span><span class="vdb-demo-filter">Call sign</span><span class="vdb-demo-filter">Name</span><span class="vdb-demo-filter">Flag</span><span class="vdb-demo-filter">Type</span></div>';
    f.results.forEach(function(row){
        var selected=row.id===vesselDbDemoSelectedId;
        h+='<button type="button" class="vdb-demo-result'+(selected?' selected':'')+'" onclick="vesselDbDemoSelect(\''+jsString(row.id)+'\')" data-qa="vessel-db-demo-result-row" data-vessel-id="'+escAttr(row.id)+'">';
        h+='<span class="vdb-demo-result-top"><span><span class="vdb-demo-result-name">'+esc(row.name)+'</span><span class="vdb-demo-result-meta">'+esc(row.match)+' · '+esc(row.provenance)+' · '+esc(row.freshness)+'</span></span><span class="vdb-demo-score">'+esc(row.confidence)+'%</span></span>';
        h+='</button>';
    });
    h+='<div class="vdb-demo-guardrail" data-qa="vessel-wrong-vessel-guardrail"><strong>Wrong-vessel guardrail</strong><p>Exact IMO stays selected. Similar-name vessels remain visible so a name match cannot silently override IMO, MMSI or call sign.</p></div>';
    h+='</div>';
    return h;
}
function vesselDbDemoDetail(){
    var row=vesselDbDemoSelected();
    var mismatch=vesselDbDemoIdentityMismatch(row);
    var h='<div class="vdb-demo-panel" data-qa="vessel-db-demo-detail-pane">';
    h+='<div class="vdb-demo-detail-head"><div><div class="vdb-demo-vessel">'+esc(row.name)+'</div><div class="vdb-demo-status"><span class="vdb-demo-pill live">'+esc(row.status)+'</span><span class="vdb-demo-pill">IMO '+esc(row.imo)+'</span><span class="vdb-demo-pill">'+esc(row.match)+'</span><span class="vdb-demo-pill">Some fields unavailable</span></div></div><button class="btn btn-accent" type="button" onclick="vesselDbDemoShowAttach()" data-qa="vessel-db-demo-attach-open">Attach to context</button></div>';
    if(mismatch){
        h+='<div class="vdb-demo-guardrail" data-qa="vessel-wrong-vessel-guardrail"><strong>Identity mismatch check</strong><p>'+esc(row.risk)+' Expected: IMO '+esc(vesselDbDemoFixture.target.expected_imo)+' · MMSI '+esc(vesselDbDemoFixture.target.expected_mmsi)+' · call sign '+esc(vesselDbDemoFixture.target.expected_call_sign)+'.</p></div>';
    }
    h+='<div class="vdb-demo-grid">';
    h+='<div class="vdb-demo-section"><h3>Identity</h3><div class="vdb-demo-kv">'+vesselDbDemoKv('IMO',row.imo)+vesselDbDemoKv('MMSI',row.mmsi)+vesselDbDemoKv('Call sign',row.call_sign)+vesselDbDemoKv('Flag',row.flag)+'</div></div>';
    h+='<div class="vdb-demo-section"><h3>Particulars</h3><div class="vdb-demo-kv">'+vesselDbDemoKv('Type',row.type)+vesselDbDemoKv('Built',row.built)+vesselDbDemoKv('Gross tonnage',row.gt)+vesselDbDemoKv('DWT',row.dwt)+vesselDbDemoKv('Length',row.length)+vesselDbDemoKv('Beam',row.beam)+'</div></div>';
    h+='<div class="vdb-demo-section"><h3>Registry-source confidence</h3>';
    vesselDbDemoFixture.sources.forEach(function(src){h+='<div class="vdb-demo-source"><strong>'+esc(src[0])+'</strong><span>'+esc(src[1])+'</span><span>'+esc(src[2])+'</span></div>';});
    h+='</div>';
    h+='<div class="vdb-demo-section vdb-demo-redacted" data-qa="vessel-db-demo-redaction"><h3>Unavailable context</h3><p>Some fields unavailable in this context. The interface does not reveal hidden field names; access depends on home, role, license, tenant and fleet context.</p></div>';
    h+='</div>';
    h+='<div class="vdb-demo-attach" data-qa="vessel-db-demo-attach-preview"><div><strong>Attach preview: '+esc(vesselDbDemoFixture.target.label)+'</strong><div class="vdb-demo-result-meta">Creates a Seafarer-owned association. Vessel source remains read-only.</div></div><span class="vdb-demo-pill '+(mismatch?'warn':'live')+'">'+(mismatch?'invalid-vessel':'ready')+'</span></div>';
    h+=vesselDbDemoStateMatrix();
    h+='</div>';
    return h;
}
function vesselDbDemoStateMatrix(){
    var h='<div class="vdb-demo-state-grid" data-qa="vessel-db-demo-state-matrix">';
    vesselDbDemoFixture.states.forEach(function(state){
        h+='<div class="vdb-demo-state" data-state="'+escAttr(state[0])+'"><strong>'+esc(state[0])+'</strong><span>'+esc(state[1])+'</span></div>';
    });
    h+='</div>';
    return h;
}
function vesselDbDemoModal(){
    if(!vesselDbDemoAttachOpen)return '';
    var row=vesselDbDemoSelected();
    var mismatch=vesselDbDemoIdentityMismatch(row);
    var state=vesselDbDemoAttachState;
    return '<div class="vdb-demo-modal" data-qa="vessel-db-demo-attach-modal">'
        + '<div class="vdb-demo-modal-card"><div class="vdb-demo-detail-head"><div><div class="vdb-demo-vessel" style="font-size:22px;">Confirm attachment</div><div class="vdb-demo-sub">Creates a Seafarer-owned association. Vessel source remains read-only.</div></div><span class="vdb-demo-pill '+(state==='success'?'live':(state==='ready'?'':'warn'))+'">'+esc(state)+'</span></div>'
        + '<div class="vdb-demo-confirm-row"><div class="vdb-demo-confirm-box"><span>Vessel</span><strong>'+esc(row.name)+'</strong><div class="vdb-demo-result-meta">IMO '+esc(row.imo)+' · MMSI '+esc(row.mmsi)+' · '+esc(row.call_sign)+'</div></div><div class="vdb-demo-confirm-box"><span>Target context</span><strong>'+esc(vesselDbDemoFixture.target.label)+'</strong><div class="vdb-demo-result-meta">'+esc(vesselDbDemoFixture.target.context)+'</div></div></div>'
        + '<div class="vdb-demo-guardrail" data-qa="vessel-wrong-vessel-guardrail"><strong>Identity mismatch check</strong><p>'+(mismatch?esc(row.risk):'IMO, MMSI, call sign and name match the expected target vessel.')+' Failure states remain typed: invalid-vessel, invalid-context, forbidden, ambiguous, offline queued.</p></div>'
        + '<div class="vdb-demo-modal-actions"><button class="btn btn-outline" type="button" onclick="vesselDbDemoCloseAttach()">Cancel</button><button class="btn btn-accent" type="button" onclick="vesselDbDemoAttachPreview()" data-qa="vessel-db-demo-attach-confirm">Attach</button></div></div></div>';
}
function renderVesselDbDemo(){
    var h='<div class="vdb-demo" data-qa="vessel-db-demo" data-demo-fixture="true" data-network="none">';
    h+=vesselDbDemoHeader();
    h+='<div class="vdb-demo-shell">'+vesselDbDemoResults()+vesselDbDemoDetail()+'</div>';
    h+=vesselDbDemoModal();
    h+='</div>';
    return h;
}
function mobileVesselDbDemoSet(step,id){
    vesselDbDemoMobileStep=step||'search';
    if(id)vesselDbDemoMobileSelectedId=id;
    vesselDbDemoSelectedId=vesselDbDemoMobileSelectedId;
    renderMobileVesselDbDemo();
}
function mobileVesselDbDemoResult(row){
    var selected=row.id===vesselDbDemoMobileSelectedId;
    return '<button class="mobile-vdb-demo-card '+(selected?'selected':'')+'" type="button" onclick="mobileVesselDbDemoSet(\'detail\',\''+jsString(row.id)+'\')" data-qa="vessel-db-demo-result-row"><div class="mobile-row"><div style="min-width:0;flex:1;"><div class="mobile-vdb-demo-title">'+mobileEsc(row.name)+'</div><div class="mobile-vdb-demo-meta">'+mobileEsc(row.match+' · '+row.provenance+' · '+row.freshness)+'</div><div class="mobile-vdb-demo-meta">IMO '+mobileEsc(row.imo)+' · MMSI '+mobileEsc(row.mmsi)+' · '+mobileEsc(row.call_sign)+'</div></div><span class="mobile-pill '+(selected?'ok':'')+'">'+mobileEsc(row.confidence+'%')+'</span></div></button>';
}
function mobileRenderVesselDbDemoSearch(){
    var f=vesselDbDemoFixture;
    var h='<div data-qa="vessel-db-demo-mobile" data-network="none">';
    h+='<div class="mobile-card"><div class="mobile-row"><div style="min-width:0;"><div class="mobile-card-title">Find vessel</div><div class="mobile-card-sub">Fixture-only Ship Database preview. Network: none.</div></div><span class="mobile-pill ok">Live</span></div></div>';
    h+='<div class="mobile-card"><div class="mobile-field"><label>Search</label><div class="mobile-vessel-search"><input readonly value="'+mobileEsc(f.query)+'"><button class="btn btn-accent" type="button" onclick="mobileVesselDbDemoSet(\'detail\',\'pacific-aurora\')">Open</button></div></div><div class="mobile-filter-row"><span class="mobile-filter-chip active">Public registry</span><span class="mobile-filter-chip">Company scope</span><span class="mobile-filter-chip">Broker view</span></div></div>';
    f.results.slice(0,3).forEach(function(row){h+=mobileVesselDbDemoResult(row);});
    h+='<div class="mobile-vdb-demo-guard" data-qa="vessel-wrong-vessel-guardrail"><strong>Wrong-vessel guardrail</strong><br>Similar-name vessels stay visible until IMO, MMSI and call sign match.</div>';
    h+='</div>';
    return h;
}
function mobileRenderVesselDbDemoDetail(){
    var row=vesselDbDemoFixture.results.find(function(r){return r.id===vesselDbDemoMobileSelectedId;})||vesselDbDemoFixture.results[0];
    var mismatch=vesselDbDemoIdentityMismatch(row);
    var h='<div data-qa="vessel-db-demo-mobile-detail" data-network="none">';
    h+='<button class="btn btn-outline btn-sm" type="button" onclick="mobileVesselDbDemoSet(\'search\')" style="margin-bottom:10px;">Back</button>';
    h+='<div class="mobile-card"><div class="mobile-row"><div style="min-width:0;"><div class="mobile-card-title">'+mobileEsc(row.name)+'</div><div class="mobile-card-sub">IMO '+mobileEsc(row.imo)+' · '+mobileEsc(row.status)+'</div></div><span class="mobile-pill '+(mismatch?'warn':'ok')+'">'+mobileEsc(mismatch?'Needs review':'Verified')+'</span></div></div>';
    if(mismatch)h+='<div class="mobile-vdb-demo-guard" data-qa="vessel-wrong-vessel-guardrail">'+mobileEsc(row.risk)+'</div>';
    h+='<div class="mobile-vdb-demo-card"><div class="mobile-card-title">Some fields unavailable</div><div class="mobile-card-sub">Some fields unavailable in this context.</div></div>';
    h+='<div class="mobile-vdb-demo-card"><div class="vdb-demo-kv">'+vesselDbDemoKv('IMO',row.imo)+vesselDbDemoKv('MMSI',row.mmsi)+vesselDbDemoKv('Flag',row.flag)+vesselDbDemoKv('Type',row.type)+vesselDbDemoKv('DWT',row.dwt)+vesselDbDemoKv('Built',row.built)+'</div></div>';
    h+='<div class="mobile-vdb-demo-card"><div class="mobile-card-title">Source confidence</div>';
    vesselDbDemoFixture.sources.forEach(function(src){h+='<div class="vdb-demo-source"><strong>'+mobileEsc(src[0])+'</strong><span>'+mobileEsc(src[1])+'</span><span>'+mobileEsc(src[2])+'</span></div>';});
    h+='</div>';
    h+='<button class="mobile-primary-action" type="button" onclick="mobileVesselDbDemoSet(\'attach\',\''+jsString(row.id)+'\')"><span class="mobile-action-icon">&#10003;</span><span class="mobile-action-copy"><span class="mobile-action-title">Attach to context</span><span class="mobile-action-sub">Open explicit confirmation with typed outcomes.</span></span></button>';
    h+='</div>';
    return h;
}
function mobileRenderVesselDbDemoAttach(){
    var row=vesselDbDemoFixture.results.find(function(r){return r.id===vesselDbDemoMobileSelectedId;})||vesselDbDemoFixture.results[0];
    var mismatch=vesselDbDemoIdentityMismatch(row);
    var h='<div data-qa="vessel-db-demo-mobile-attach" data-network="none">';
    h+='<button class="btn btn-outline btn-sm" type="button" onclick="mobileVesselDbDemoSet(\'detail\')" style="margin-bottom:10px;">Back</button>';
    h+='<div class="mobile-card"><div class="mobile-card-title">Confirm attachment</div><div class="mobile-card-sub">Seafarer-owned link. Read-only source.</div></div>';
    h+='<div class="mobile-vdb-demo-card"><div class="mobile-card-title">'+mobileEsc(row.name)+'</div><div class="mobile-vdb-demo-meta">IMO '+mobileEsc(row.imo)+' · MMSI '+mobileEsc(row.mmsi)+' · '+mobileEsc(row.call_sign)+'</div></div>';
    h+='<div class="mobile-vdb-demo-card"><div class="mobile-card-title">'+mobileEsc(vesselDbDemoFixture.target.label)+'</div><div class="mobile-vdb-demo-meta">'+mobileEsc(vesselDbDemoFixture.target.context)+'</div></div>';
    h+='<div class="mobile-vdb-demo-guard" data-qa="vessel-wrong-vessel-guardrail">'+mobileEsc(mismatch?row.risk:'IDs match. Typed outcomes are shown below.')+'</div>';
    h+='<div class="mobile-vdb-demo-card"><div class="mobile-card-title">State matrix</div>'+vesselDbDemoStateMatrix()+'</div>';
    h+='<div class="mobile-actions"><button class="btn btn-outline mobile-grow" type="button" onclick="mobileVesselDbDemoSet(\'detail\')">Cancel</button><button class="btn btn-accent mobile-grow" type="button" onclick="showToast(\''+(mismatch?'invalid-vessel':'Attach success')+'\',\''+(mismatch?'warn':'success')+'\')">Attach</button></div>';
    h+='</div>';
    return h;
}
function renderMobileVesselDbDemo(){
    var h=vesselDbDemoMobileStep==='attach'?mobileRenderVesselDbDemoAttach():(vesselDbDemoMobileStep==='detail'?mobileRenderVesselDbDemoDetail():mobileRenderVesselDbDemoSearch());
    mobileMainHtml(h);
}

// --- extracted from seafarer dist/index.html:12007-12009 (findJobById) ---
function findJobById(vacancyId){
    return (lastJobsItems||[]).find(function(x){return x.id===vacancyId;})||null;
}

// --- extracted from seafarer dist/index.html:12011-12032 (renderVesselDbJobContext) ---
function renderVesselDbJobContext(){
    var ctx=vesselDbJobContext;
    if(!ctx)return '';
    if(ctx.source==='experience'){
        var evessel=ctx.vessel_name||('IMO '+ctx.imo);
        return '<div class="vdb-context">'
            + '<div><div class="vdb-context-title">Opened from Sea Service</div>'
            + '<div class="vdb-context-meta">'+esc(evessel)+' · review the vessel database record, then return to your contract.</div></div>'
            + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
            + '<button class="btn btn-accent btn-sm" onclick="returnToExperienceFromVessel()">Back to sea service</button>'
            + '</div></div>';
    }
    if(ctx.source!=='jobs')return '';
    var title=ctx.title||'Job vacancy';
    var vessel=ctx.vessel_name||('IMO '+ctx.imo);
    return '<div class="vdb-context">'
        + '<div><div class="vdb-context-title">Opened from Jobs: '+esc(title)+'</div>'
        + '<div class="vdb-context-meta">'+esc(vessel)+' · review the vessel, then return to the vacancy to apply or continue the conversation.</div></div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
        + '<button class="btn btn-accent btn-sm" onclick="returnToJobFromVessel()">Back to vacancy</button>'
        + '</div></div>';
}

// --- extracted from seafarer dist/index.html:12034-12040 (returnToJobFromVessel) ---
function returnToJobFromVessel(){
    var vacancyId=vesselDbJobContext&&vesselDbJobContext.vacancyId;
    showView('jobs');
    if(vacancyId){
        setTimeout(function(){focusJobCard(vacancyId);},350);
    }
}

// --- extracted from seafarer dist/index.html:12042-12048 (returnToExperienceFromVessel) ---
function returnToExperienceFromVessel(){
    var entryId=vesselDbJobContext&&vesselDbJobContext.entryId;
    showView('experience');
    if(entryId){
        setTimeout(function(){focusWorkEntry(entryId);},350);
    }
}

// --- extracted from seafarer dist/index.html:12050-12056 (focusWorkEntry) ---
function focusWorkEntry(entryId){
    var el=document.getElementById('work-card-'+entryId);
    if(!el)return;
    el.scrollIntoView({block:'center',behavior:'smooth'});
    el.style.boxShadow='0 0 0 3px var(--accent-bg2)';
    setTimeout(function(){el.style.boxShadow='';},1800);
}

// --- extracted from seafarer dist/index.html:12058-12064 (focusJobCard) ---
function focusJobCard(vacancyId){
    var el=document.getElementById('vac-card-'+vacancyId);
    if(!el)return;
    el.scrollIntoView({block:'center',behavior:'smooth'});
    el.style.boxShadow='0 0 0 3px var(--accent-bg2)';
    setTimeout(function(){el.style.boxShadow='';},1800);
}

// --- extracted from seafarer dist/index.html:12066-12125 (lookupVesselByImo,showVesselDatabase) ---
async function lookupVesselByImo(force){
    var input=document.getElementById('vdb-imo-input');
    var result=document.getElementById('vdb-result');
    var btn=document.getElementById('vdb-search-btn');
    if(!input||!result)return;
    var imo=normalizeImo(input.value);
    if(!imo){
        result.innerHTML='<div class="sea-lock"><h3>Enter a valid IMO number</h3><p>IMO must contain exactly 7 digits.</p></div>';
        input.focus();
        return;
    }
    input.value=imo;
    if(btn)btn.disabled=true;
    result.innerHTML='<div class="sea-lock"><h3>Searching IMO '+esc(imo)+'</h3><p>Reading the vessel database...</p></div>';
    try{
        var entry=await fetchVesselReviewProjection(imo,!!force);
        if(entry.status==='ok'&&entry.payload){
            result.innerHTML=renderVesselDbSummary(entry.payload);
        }else if(entry.status==='not_found'){
            result.innerHTML='<div class="sea-lock"><h3>No vessel found</h3><p>Skipi does not have a public record for IMO '+esc(imo)+' yet.</p></div>';
        }else{
            result.innerHTML='<div class="sea-lock"><h3>Vessel database unavailable</h3><p>'+esc(entry.error||'Network error')+'</p></div>';
        }
        try{result.scrollIntoView({behavior:'smooth',block:'start'});}catch(e){}
    }finally{
        if(btn)btn.disabled=false;
    }
}
async function showVesselDatabase(){
    if(vesselDbDemoEnabled()){
        document.getElementById('scr-content').innerHTML=renderVesselDbDemo();
        show('scr-content');updateTabs('Vessel DB');
        return;
    }
    var visitCount=noteVesselDbVisit();
    var reviewStats=await loadVesselReviewContributionStats();
    window._vesselReviewStats=reviewStats;
    var h='<div class="editor-narrow vdb-lookup-shell">';
    h+=renderVesselDbJobContext();
    h+='<div class="vdb-lookup-row">';
    h+='<div class="field"><label>IMO number</label><input id="vdb-imo-input" inputmode="numeric" pattern="[0-9]*" maxlength="7" placeholder="e.g. 9855552" onkeydown="if(event.key===\'Enter\')lookupVesselByImo(false)"></div>';
    h+='<button class="btn btn-accent" id="vdb-search-btn" onclick="lookupVesselByImo(false)">Search</button>';
    h+='</div>';
    h+='<div class="vdb-result" id="vdb-result"></div>';
    h+=renderVesselDbReviewNudge(reviewStats,visitCount);
    h+='<div id="vdb-recent-reviews" style="margin-bottom:12px;"></div>';
    h+='</div>';
    document.getElementById('scr-content').innerHTML=h;show('scr-content');updateTabs('База судов');
    loadRecentVesselReviews();
    setTimeout(function(){
        var input=document.getElementById('vdb-imo-input');
        var pending=normalizeImo(vesselDbPendingImo||(vesselDbJobContext&&vesselDbJobContext.imo)||'');
        if(input&&pending){
            input.value=pending;
            lookupVesselByImo(false);
            return;
        }
        if(input)input.focus();
    },0);
}

// --- extracted from seafarer dist/index.html:12718-12739 (hydrateVesselReviews) ---
async function hydrateVesselReviews(entries){
    var imos={};
    (entries||[]).forEach(function(row){
        var imo=normalizeImo(row.imo);
        if(!imo)return;
        imos[imo]=true;
        var host=document.getElementById('vrev-'+row.id);
        if(host)host.innerHTML=renderVesselReviewLoading();
        var ratingHost=document.getElementById('exp-vdb-'+row.id);
        if(ratingHost)ratingHost.innerHTML=renderExperienceVesselRating(null,imo,row.id,row.vessel_name||'');
    });
    Object.keys(imos).forEach(function(imo){
        fetchVesselReviewProjection(imo,false).then(function(entry){
            document.querySelectorAll('[data-vrev-imo="'+imo+'"]').forEach(function(host){
                host.innerHTML=renderVesselReviewProjection(entry,imo);
            });
            document.querySelectorAll('[data-exp-vdb-imo="'+imo+'"]').forEach(function(host){
                host.innerHTML=renderExperienceVesselRating(entry,imo,host.dataset.expVdbEntry||'',host.dataset.expVdbVessel||'');
            });
        }).catch(function(e){logError('vessel_reviews:'+imo,e);});
    });
}

// --- extracted from seafarer dist/index.html:14194-14215 (openVesselFromJob) ---
function openVesselFromJob(vacancyId){
    var v=findJobById(vacancyId);
    if(!v){
        showToast('Vacancy not found in the current Jobs list','error');
        return;
    }
    var imo=normalizeImo(v.vessel_imo);
    if(!imo){
        showToast('This vacancy does not include a valid IMO number, so Skipi Seafarer cannot open the vessel database. Ask the crewing for the vessel IMO before applying.','warn');
        return;
    }
    vesselDbPendingImo=imo;
    vesselDbJobContext={
        source:'jobs',
        vacancyId:v.id,
        imo:imo,
        title:v.title || (v.rank+' · '+v.vessel_type),
        vessel_name:jobsVesselDisplayName(v),
        reply_to:v.reply_to||''
    };
    showView('vessels',{fromJob:true});
}

// --- extracted from seafarer dist/index.html:14217-14240 (openVesselFromExperience) ---
async function openVesselFromExperience(entryId, imo, vesselName){
    var target=normalizeImo(imo);
    if(!target){
        showToast('This Sea Service entry needs a valid IMO number to open the vessel database.','warn');
        return;
    }
    var label=String(vesselName||'').trim();
    if(!label){
        try{
            var entries=await invoke('get_work_history')||[];
            var row=entries.find(function(e){return e&&e.id===entryId;});
            label=row&&row.vessel_name?row.vessel_name:('IMO '+target);
        }catch(_){label='IMO '+target;}
    }
    vesselDbPendingImo=target;
    vesselDbJobContext={
        source:'experience',
        entryId:entryId||'',
        imo:target,
        title:'Sea Service',
        vessel_name:label
    };
    showView('vessels',{fromExperience:true});
}

