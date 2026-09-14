(function(){
"use strict";

/* ============================================================
   STAGE DEFINITIONS
   No sighter stage. Each record stage fires 10 shots; ending a
   stage early pads any remaining shot numbers with a "-" (did not
   fire) entry rather than leaving them unscored.
   ============================================================ */
const STAGES = [
  { key:"s1_prone_slow", name:"Stage 1: Prone Slow",   duration:600, shotCount:10 },
  { key:"s2_prone_rapid",name:"Stage 2: Prone Rapid",  duration:70,  shotCount:10 },
  { key:"s3_seated_rapid",name:"Stage 3: Seated Rapid",duration:60,  shotCount:10 },
  { key:"s4_standing",   name:"Stage 4: Standing Slow", duration:600, shotCount:10 }
];

const STORAGE_PREFIX = "targetLogger.stage.";
const SESSION_STAGES_KEY = "targetLogger.sessionStages"; // list of stage keys ever used
const NAV_KEY = "targetLogger.nav"; // {screen, stageKey} so a refresh resumes where you left off

/* ============================================================
   SR-1 TARGET RING GEOMETRY (100-yard reduction of 200-yd SR),
   simplified per shooter request: only X/10/9/8/7/6 are drawn and
   scored (the 5-ring is dropped). Anything outside the 6-ring is
   a Miss. Diameters are still true-to-scale relative to each other
   so pixel<->inch conversion is accurate for scoring/centroid math.
   The 6-ring's rendered radius now defines pixelsPerInch.

   Scoring is tap-only on the target diagram: tapping outside the
   6-ring automatically resolves to a Miss, so there is no need for
   a separate set of score buttons.
   ============================================================ */
const RING_DIAMETERS_IN = { X:1.35, 10:3.35, 9:6.35, 8:9.35, 7:12.35, 6:15.35 };
const RING_ORDER = ["X","10","9","8","7","6"]; // smallest (highest score) first
const OUTER_RING = "6";

const SVG_HALF = 100;
const OUTER_RING_RADIUS_PX = 90; // rendered radius (svg units) of the outer (6) ring
const pixelsPerInch = OUTER_RING_RADIUS_PX / (RING_DIAMETERS_IN[OUTER_RING] / 2);

/* ============================================================
   SIGN CONVENTION (documented per spec requirement):
   X (horizontal): positive = RIGHT of center, negative = LEFT.
   Y (vertical):   positive = HIGH (up) of center, negative = LOW (down).
   Screen/SVG pixel Y increases downward, so pixel->inch Y is negated.
   ============================================================ */

/* ============================================================
   STATE
   ============================================================ */
let currentStageKey = STAGES[0].key;
let state = null;          // current stage's persisted state object
let currentScreen = "competition"; // "competition" | "timer" | "scoring"
let timerInterval = null;
let audioCtx = null;
let activeShotNum = null;  // explicit user selection on the scoring screen; null = auto (lowest unscored)
let editingShotNum = null; // shot # currently in inline edit mode on the Log Shot screen, or null

function defaultStageState(stageKey){
  const def = STAGES.find(s=>s.key===stageKey);
  return {
    stageKey: stageKey,
    duration: def.duration,
    running: false,
    startEpoch: null,      // epoch ms when Start was last pressed (for elapsed calc while running)
    elapsedAtPause: 0,     // accumulated elapsed seconds when paused
    lastShotElapsed: null, // elapsed seconds at previous Log Shot press (for split calc)
    expired: false,
    finalized: false,      // true once "End Stage" has been pressed (dash-padding applied)
    shots: []              // {num, score, x, y, split, elapsed, notFired}
  };
}

function loadStage(stageKey){
  const raw = localStorage.getItem(STORAGE_PREFIX + stageKey);
  if(raw){
    try{ return JSON.parse(raw); }catch(e){ /* fall through */ }
  }
  return defaultStageState(stageKey);
}

function saveStage(){
  localStorage.setItem(STORAGE_PREFIX + currentStageKey, JSON.stringify(state));
  markStageUsed(currentStageKey);
}

function markStageUsed(stageKey){
  let list = [];
  try{ list = JSON.parse(localStorage.getItem(SESSION_STAGES_KEY) || "[]"); }catch(e){}
  if(!list.includes(stageKey)){ list.push(stageKey); }
  localStorage.setItem(SESSION_STAGES_KEY, JSON.stringify(list));
}

function saveNav(){
  localStorage.setItem(NAV_KEY, JSON.stringify({screen: currentScreen, stageKey: currentStageKey}));
}

/* ============================================================
   SCREEN SWITCHING
   The timer screen and the target screen are mutually exclusive
   by design: only one of #screenTimer / #screenScoring is ever
   visible, toggled by ending a stage or navigating stages. The
   scoring screen itself keeps the target diagram and the shot log
   table together on one page.
   ============================================================ */
function showScreen(name){
  currentScreen = name;
  document.getElementById("screenCompetition").hidden = (name !== "competition");
  document.getElementById("stageNavPanel").hidden = (name === "competition");
  document.getElementById("screenTimer").hidden = (name !== "timer");
  document.getElementById("screenScoring").hidden = (name !== "scoring");
  document.getElementById("sessionActionsPanel").hidden = (name === "competition");
  saveNav();
}

/* ============================================================
   TIMER
   ============================================================ */
function fmtTime(totalSeconds){
  totalSeconds = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(totalSeconds/60);
  const s = totalSeconds % 60;
  return String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
}

function currentElapsedSeconds(){
  if(state.running && state.startEpoch){
    return state.elapsedAtPause + (Date.now() - state.startEpoch)/1000;
  }
  return state.elapsedAtPause;
}

function currentRemainingSeconds(){
  return state.duration - currentElapsedSeconds();
}

function beep(){
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  }catch(e){ /* audio not available; ignore */ }
}

function tick(){
  const remaining = currentRemainingSeconds();
  const display = document.getElementById("timerDisplay");
  display.textContent = fmtTime(remaining);
  if(remaining <= 0 && !state.expired){
    state.expired = true;
    state.running = false;
    state.elapsedAtPause = state.duration;
    display.classList.add("expired");
    beep();
    stopTicking();
    saveStage();
    refreshLogButtonState();
  } else if(remaining > 0){
    display.classList.remove("expired");
  }
}

function startTicking(){
  stopTicking();
  timerInterval = setInterval(tick, 100);
}
function stopTicking(){
  if(timerInterval){ clearInterval(timerInterval); timerInterval = null; }
}

function startStage(){
  if(state.running || state.finalized) return;
  if(state.expired) return; // must reset first
  state.running = true;
  state.startEpoch = Date.now();
  document.getElementById("timerDisplay").classList.remove("expired");
  startTicking();
  saveStage();
  refreshLogButtonState();
}

function pauseStage(){
  if(!state.running) return;
  state.elapsedAtPause = currentElapsedSeconds();
  state.running = false;
  state.startEpoch = null;
  stopTicking();
  tick();
  saveStage();
  refreshLogButtonState();
}

function resetStage(){
  if(!confirm("Reset the timer and shot log for this stage? This cannot be undone.")) return;
  stopTicking();
  state = defaultStageState(currentStageKey);
  editingShotNum = null;
  document.getElementById("timerDisplay").classList.remove("expired");
  tick();
  saveStage();
  renderAll();
}

/* ============================================================
   PHASE 1 — LOG SHOT (no target interaction)
   Each press only records shot #, split, and elapsed time stamp.
   Scoring/location is deferred entirely to Phase 2.
   ============================================================ */
function refreshLogButtonState(){
  document.getElementById("logShotBtn").disabled = state.finalized;
  document.getElementById("endStageBtn").disabled = state.finalized;
}

function logShot(){
  if(state.finalized) return;
  const stageDef = STAGES.find(s=>s.key===currentStageKey);
  if(state.shots.length >= stageDef.shotCount) return; // already have a full string
  const elapsed = currentElapsedSeconds();
  const split = (state.lastShotElapsed === null) ? elapsed : (elapsed - state.lastShotElapsed);
  state.lastShotElapsed = elapsed;
  const shotNum = state.shots.length + 1;
  state.shots.push({
    num: shotNum,
    score: null,   // pending — scored in Phase 2
    x: null,
    y: null,
    split: split,
    elapsed: elapsed,
    notFired: false
  });
  saveStage();
  renderTimerLog();
}

/* ============================================================
   END STAGE — pads any un-fired shots with a "-" entry, then
   switches to the Phase 2 (target scoring) screen for this stage.
   ============================================================ */
function endStage(){
  const stageDef = STAGES.find(s=>s.key===currentStageKey);
  if(state.running) pauseStage();
  for(let i = state.shots.length + 1; i <= stageDef.shotCount; i++){
    state.shots.push({ num:i, score:"-", x:null, y:null, split:null, elapsed:null, notFired:true });
  }
  state.finalized = true;
  activeShotNum = null;
  editingShotNum = null;
  saveStage();
  showScreen("scoring");
  renderAll();
}

function backToLogShots(){
  state.shots = state.shots.filter(s => !s.notFired);
  state.finalized = false;
  saveStage();
  showScreen("timer");
  renderAll();
}

/* ============================================================
   PHASE 2 — TARGET RENDERING & SCORING
   Tap-only: tapping the target computes the ring from distance-to-
   center and records the score plus X/Y. There is no separate
   score-button row — a tap outside the 6-ring already resolves to
   a Miss automatically via inchesToScore().
   ============================================================ */
function buildTargetSvg(){
  const svg = document.getElementById("targetSvg");
  svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";

  const bg = document.createElementNS(ns,"circle");
  bg.setAttribute("cx",0); bg.setAttribute("cy",0);
  bg.setAttribute("r", SVG_HALF-2);
  bg.setAttribute("fill","#d7d2c7");
  bg.setAttribute("stroke","#333");
  bg.setAttribute("stroke-width","1");
  svg.appendChild(bg);

  // Draw rings largest (6) to smallest (X) so smaller rings sit on top.
  const drawOrder = [...RING_ORDER].reverse();
  drawOrder.forEach(ring=>{
    const diameterIn = RING_DIAMETERS_IN[ring];
    const radiusPx = (diameterIn/2) * pixelsPerInch;
    const circle = document.createElementNS(ns,"circle");
    circle.setAttribute("cx",0); circle.setAttribute("cy",0);
    circle.setAttribute("r", radiusPx);
    circle.setAttribute("fill", ring==="X" ? "#222" : "none");
    circle.setAttribute("stroke", "#222");
    circle.setAttribute("stroke-width", ring==="10" ? "1.5" : "1");
    svg.appendChild(circle);
  });

  RING_ORDER.forEach(ring=>{
    if(ring==="X") return;
    const diameterIn = RING_DIAMETERS_IN[ring];
    const radiusPx = (diameterIn/2) * pixelsPerInch;
    const label = document.createElementNS(ns,"text");
    const ang = Math.PI/4;
    label.setAttribute("x", Math.cos(ang)*radiusPx*0.98 - 4);
    label.setAttribute("y", -Math.sin(ang)*radiusPx*0.98);
    label.setAttribute("font-size","6");
    label.setAttribute("fill","#555");
    label.textContent = ring;
    svg.appendChild(label);
  });

  const markerGroup = document.createElementNS(ns,"g");
  markerGroup.setAttribute("id","markerGroup");
  svg.appendChild(markerGroup);

  svg.addEventListener("click", onTargetClick);
}

function pixelToInches(svgX, svgY){
  return { x: svgX / pixelsPerInch, y: -svgY / pixelsPerInch };
}

function inchesToScore(x,y){
  const distIn = Math.sqrt(x*x + y*y);
  for(const ring of RING_ORDER){
    if(distIn <= RING_DIAMETERS_IN[ring]/2) return ring;
  }
  return "M"; // outside the 6-ring = Miss
}

function onTargetClick(evt){
  const shot = getActiveShot();
  if(!shot){ return; }
  const svg = document.getElementById("targetSvg");
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const ctm = svg.getScreenCTM().inverse();
  const loc = pt.matrixTransform(ctm);
  const inches = pixelToInches(loc.x, loc.y);
  const score = inchesToScore(inches.x, inches.y);
  applyScoreToShot(shot, score, inches.x, inches.y);
}

function applyScoreToShot(shot, score, x, y){
  shot.score = score;
  shot.x = (x===undefined) ? null : round2(x);
  shot.y = (y===undefined) ? null : round2(y);
  saveStage();
  renderShotLog();
  renderStats();
  renderTargetMarkers();
  autoAdvanceActive();
}

function round2(n){ return Math.round(n*100)/100; }

function isScoreable(shot){
  return !shot.notFired; // dash (did-not-fire) entries never need scoring
}

function getActiveShot(){
  if(activeShotNum !== null){
    const s = state.shots.find(sh=>sh.num===activeShotNum);
    if(s && isScoreable(s)) return s;
  }
  return state.shots.find(sh=> isScoreable(sh) && sh.score===null) || null;
}

function setActiveShot(num){
  const shot = state.shots.find(sh=>sh.num===num);
  if(!shot || !isScoreable(shot)) return;
  activeShotNum = num;
  renderShotLog();
  renderActiveShotInfo();
}

function autoAdvanceActive(){
  const next = state.shots.find(sh=> isScoreable(sh) && sh.score===null);
  activeShotNum = next ? next.num : null;
  renderShotLog();
  renderActiveShotInfo();
}

function renderTargetMarkers(){
  const group = document.getElementById("markerGroup");
  if(!group) return;
  group.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";
  state.shots.forEach(shot=>{
    if(shot.x===null || shot.y===null) return; // not-fired shots have no location
    const svgX = shot.x * pixelsPerInch;
    const svgY = -shot.y * pixelsPerInch;
    const dot = document.createElementNS(ns,"circle");
    dot.setAttribute("cx",svgX); dot.setAttribute("cy",svgY);
    dot.setAttribute("r","5");
    dot.setAttribute("fill","#c0392b");
    dot.setAttribute("stroke","#fff");
    dot.setAttribute("stroke-width","1");
    group.appendChild(dot);
    const label = document.createElementNS(ns,"text");
    label.setAttribute("x", svgX+6);
    label.setAttribute("y", svgY-6);
    label.setAttribute("font-size","8");
    label.setAttribute("font-weight","bold");
    label.setAttribute("fill","#c0392b");
    label.textContent = shot.num;
    group.appendChild(label);
  });
}

function renderActiveShotInfo(){
  const info = document.getElementById("activeShotInfo");
  const shot = getActiveShot();
  if(!shot){
    const anyScoreable = state.shots.some(isScoreable);
    info.textContent = anyScoreable ? "All shots scored." : "No shots were fired this stage.";
  } else {
    info.innerHTML = "Active shot: <b>#" + shot.num + "</b> — tap the target to record it.";
  }
}

/* ============================================================
   SHOT LOG TABLES
   ============================================================ */
function renderTimerLog(){
  const body = document.getElementById("timerLogBody");
  body.innerHTML = "";
  state.shots.forEach(shot=>{
    const tr = document.createElement("tr");
    const tdNum = document.createElement("td");
    tdNum.textContent = shot.num;
    const tdSplit = document.createElement("td");
    const tdElapsed = document.createElement("td");
    const tdActions = document.createElement("td");

    if(editingShotNum === shot.num){
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.1";
      input.min = "0";
      input.value = shot.elapsed.toFixed(1);
      input.style.width = "80px";
      tdElapsed.appendChild(input);
      tdSplit.textContent = "—";

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", ()=>{
        const val = parseFloat(input.value);
        if(!isNaN(val) && val >= 0){
          shot.elapsed = val;
          recomputeSplits();
          saveStage();
        }
        editingShotNum = null;
        renderTimerLog();
      });
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.className = "link";
      cancelBtn.addEventListener("click", ()=>{ editingShotNum = null; renderTimerLog(); });
      tdActions.appendChild(saveBtn);
      tdActions.appendChild(cancelBtn);
    } else {
      tdSplit.textContent = shot.split.toFixed(1)+"s";
      tdElapsed.textContent = shot.elapsed.toFixed(1)+"s";

      const editBtn = document.createElement("button");
      editBtn.textContent = "Edit";
      editBtn.className = "link";
      editBtn.addEventListener("click", ()=>{ editingShotNum = shot.num; renderTimerLog(); });
      const delBtn = document.createElement("button");
      delBtn.textContent = "Delete";
      delBtn.className = "link";
      delBtn.addEventListener("click", ()=> deleteShot(shot.num));
      tdActions.appendChild(editBtn);
      tdActions.appendChild(delBtn);
    }

    tr.appendChild(tdNum);
    tr.appendChild(tdSplit);
    tr.appendChild(tdElapsed);
    tr.appendChild(tdActions);
    body.appendChild(tr);
  });
  document.getElementById("shotCountBig").textContent = "Shots fired this stage: " + state.shots.length;
}

/* ============================================================
   MANUAL SHOT EDITING (Phase 1 corrections)
   Elapsed time is the source of truth for each shot; split is
   always derived from the sequence of elapsed values. Editing,
   deleting, or manually adding a shot all funnel through
   recomputeSplits() so the split column stays internally
   consistent, and state.lastShotElapsed stays correct for the
   next Log Shot press.
   ============================================================ */
function recomputeSplits(){
  let prevElapsed = null;
  state.shots.forEach(shot=>{
    shot.split = (prevElapsed === null) ? shot.elapsed : (shot.elapsed - prevElapsed);
    prevElapsed = shot.elapsed;
  });
  state.lastShotElapsed = prevElapsed;
}

function deleteShot(num){
  if(!confirm("Delete shot #"+num+"? Remaining shots will be renumbered.")) return;
  state.shots = state.shots.filter(s => s.num !== num);
  state.shots.forEach((s,i)=>{ s.num = i+1; });
  recomputeSplits();
  saveStage();
  renderTimerLog();
}

function addManualShot(){
  const stageDef = STAGES.find(s=>s.key===currentStageKey);
  if(state.shots.length >= stageDef.shotCount){
    alert("This stage already has all "+stageDef.shotCount+" shots logged.");
    return;
  }
  const input = document.getElementById("manualElapsedInput");
  const val = parseFloat(input.value);
  if(isNaN(val) || val < 0){
    alert("Enter a valid elapsed time in seconds.");
    return;
  }
  state.shots.push({
    num: state.shots.length + 1,
    score: null, x: null, y: null,
    split: 0, elapsed: val, notFired: false
  });
  recomputeSplits();
  saveStage();
  input.value = "";
  renderTimerLog();
}

function renderShotLog(){
  const body = document.getElementById("shotLogBody");
  body.innerHTML = "";
  const active = getActiveShot();
  state.shots.forEach(shot=>{
    const tr = document.createElement("tr");
    if(shot.notFired){ tr.classList.add("notfired"); }
    else if(shot.score===null){ tr.classList.add("pending"); }
    if(active && shot.num===active.num) tr.classList.add("active");
    const loc = (shot.x!==null && shot.y!==null) ? (shot.x.toFixed(2)+", "+shot.y.toFixed(2)) : "—";
    const scoreText = shot.notFired ? "-" : (shot.score===null ? "pending" : shot.score);
    const splitText = shot.split===null ? "—" : shot.split.toFixed(1)+"s";
    const elapsedText = shot.elapsed===null ? "—" : shot.elapsed.toFixed(1)+"s";
    tr.innerHTML =
      "<td>"+shot.num+"</td>" +
      "<td>"+scoreText+"</td>" +
      "<td>"+splitText+"</td>" +
      "<td>"+elapsedText+"</td>" +
      "<td>"+loc+"</td>";
    tr.addEventListener("click", ()=> setActiveShot(shot.num));
    body.appendChild(tr);
  });
}

/* ============================================================
   STATS
   Total score sums numeric ring values (X counts as 10 toward
   score, tallied separately as X-count). Misses count as 0.
   Did-not-fire ("-") shots are excluded from split-time averages
   and from the centroid. Centroid uses only shots with recorded
   X/Y, per spec.
   ============================================================ */
function scoreValue(score){
  if(score===null || score==="-") return 0;
  if(score==="X") return 10;
  if(score==="M") return 0;
  return Number(score);
}

function renderStats(){
  let totalScore = 0, xCount = 0, splitSum = 0, splitCount = 0;
  let sumX=0, sumY=0, locCount=0;
  state.shots.forEach(shot=>{
    if(shot.notFired) return;
    if(shot.score!==null){
      totalScore += scoreValue(shot.score);
      if(shot.score==="X") xCount++;
    }
    if(shot.split!==null){ splitSum += shot.split; splitCount++; }
    if(shot.x!==null && shot.y!==null){ sumX += shot.x; sumY += shot.y; locCount++; }
  });
  document.getElementById("statScore").textContent = totalScore;
  document.getElementById("statX").textContent = xCount;
  document.getElementById("statSplit").textContent = splitCount ? (splitSum/splitCount).toFixed(2) : "--";

  const centroidEl = document.getElementById("statCentroid");
  if(locCount===0){
    centroidEl.textContent = "--";
  } else {
    const meanX = sumX/locCount, meanY = sumY/locCount;
    const vParts = [];
    if(Math.abs(meanY) > 0.005) vParts.push(Math.abs(meanY).toFixed(2)+"in "+(meanY>=0?"High":"Low"));
    if(Math.abs(meanX) > 0.005) vParts.push(Math.abs(meanX).toFixed(2)+"in "+(meanX>=0?"Right":"Left"));
    centroidEl.textContent = vParts.length ? vParts.join(" / ") : "Centered";
  }
}

/* ============================================================
   STAGE NAV
   Jumping stages shows the Log Shot screen if that stage hasn't
   been finalized yet, or the Score Target screen if it has.
   ============================================================ */
function buildStageSelect(){
  const sel = document.getElementById("stageSelect");
  sel.innerHTML = "";
  STAGES.forEach(s=>{
    const opt = document.createElement("option");
    opt.value = s.key;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
  sel.value = currentStageKey;
  sel.addEventListener("change", onStageChange);
}

function onStageChange(evt){
  const newKey = evt.target.value;
  if(newKey === currentStageKey){ return; }
  saveStage(); // flush current stage before switching
  stopTicking();
  currentStageKey = newKey;
  state = loadStage(currentStageKey);
  activeShotNum = null;
  editingShotNum = null;
  showScreen(state.finalized ? "scoring" : "timer");
  renderAll();
  if(state.running){ startTicking(); }
}

function goToNextStage(){
  const idx = STAGES.findIndex(s=>s.key===currentStageKey);
  if(idx < 0 || idx >= STAGES.length-1){
    alert("This is the last stage.");
    return;
  }
  saveStage();
  stopTicking();
  currentStageKey = STAGES[idx+1].key;
  state = loadStage(currentStageKey);
  activeShotNum = null;
  editingShotNum = null;
  document.getElementById("stageSelect").value = currentStageKey;
  showScreen(state.finalized ? "scoring" : "timer");
  renderAll();
}

/* ============================================================
   EXPORT — Excel-compatible .xls (an HTML table with an .xls
   extension opens directly in Excel/Sheets; no library needed,
   fully offline) covering every stage shot in the session.
   ============================================================ */
function buildSessionRows(){
  let usedKeys = [];
  try{ usedKeys = JSON.parse(localStorage.getItem(SESSION_STAGES_KEY) || "[]"); }catch(e){}
  if(!usedKeys.includes(currentStageKey)) usedKeys.push(currentStageKey);

  const rows = [];
  usedKeys.forEach(key=>{
    const st = (key===currentStageKey) ? state : loadStage(key);
    const stageDef = STAGES.find(s=>s.key===key);
    const stageName = stageDef ? stageDef.name : key;
    st.shots.forEach(shot=>{
      rows.push({
        stage: stageName,
        num: shot.num,
        score: shot.notFired ? "-" : (shot.score===null ? "" : shot.score),
        split: shot.split===null ? "" : shot.split.toFixed(2),
        elapsed: shot.elapsed===null ? "" : shot.elapsed.toFixed(2),
        x: shot.x===null ? "" : shot.x.toFixed(2),
        y: shot.y===null ? "" : shot.y.toFixed(2)
      });
    });
  });
  return rows;
}

function htmlEscape(v){
  return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function exportXls(){
  const rows = buildSessionRows();
  const headers = ["Stage","Shot#","Score","Split(s)","Elapsed(s)","X(in)","Y(in)"];
  let html = "<table><thead><tr>" +
    headers.map(h=>"<th>"+htmlEscape(h)+"</th>").join("") + "</tr></thead><tbody>";
  rows.forEach(r=>{
    html += "<tr>" +
      "<td>"+htmlEscape(r.stage)+"</td>" +
      "<td>"+htmlEscape(r.num)+"</td>" +
      "<td>"+htmlEscape(r.score)+"</td>" +
      "<td>"+htmlEscape(r.split)+"</td>" +
      "<td>"+htmlEscape(r.elapsed)+"</td>" +
      "<td>"+htmlEscape(r.x)+"</td>" +
      "<td>"+htmlEscape(r.y)+"</td>" +
      "</tr>";
  });
  html += "</tbody></table>";

  const blob = new Blob([html], {type:"application/vnd.ms-excel"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cmp_m1_session_" + new Date().toISOString().slice(0,19).replace(/[:T]/g,"-") + ".xls";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ============================================================
   EXPORT — per-stage target diagram as a JPG (offline, no
   library: serialize the SVG, draw it to a canvas, then export
   the canvas as image/jpeg).
   ============================================================ */
function exportTargetJpg(){
  const svg = document.getElementById("targetSvg");
  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(svg);
  const svgBlob = new Blob([svgStr], {type:"image/svg+xml;charset=utf-8"});
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = function(){
    const size = 720; // upscale for a clearer JPG than the on-screen 360px render
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#d7d2c7"; // JPG has no transparency; match target face color
    ctx.fillRect(0,0,size,size);
    ctx.drawImage(img, 0, 0, size, size);
    URL.revokeObjectURL(url);
    canvas.toBlob(function(blob){
      const stageDef = STAGES.find(s=>s.key===currentStageKey);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (stageDef ? stageDef.key : "target") + "_target.jpg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, "image/jpeg", 0.92);
  };
  img.src = url;
}

/* ============================================================
   CLEAR SESSION
   ============================================================ */
function clearSession(){
  const first = confirm("Clear ALL stages and start a new session? This deletes every logged shot and cannot be undone.");
  if(!first) return;
  const second = confirm("Are you absolutely sure? This is your final confirmation to erase all session data.");
  if(!second) return;

  let usedKeys = [];
  try{ usedKeys = JSON.parse(localStorage.getItem(SESSION_STAGES_KEY) || "[]"); }catch(e){}
  usedKeys.forEach(key=> localStorage.removeItem(STORAGE_PREFIX+key));
  localStorage.removeItem(SESSION_STAGES_KEY);
  localStorage.removeItem(NAV_KEY);

  stopTicking();
  currentStageKey = STAGES[0].key;
  state = defaultStageState(currentStageKey);
  activeShotNum = null;
  document.getElementById("stageSelect").value = currentStageKey;
  document.getElementById("timerDisplay").classList.remove("expired");
  showScreen("competition");
  renderAll();
}

/* ============================================================
   RENDER ALL / INIT
   ============================================================ */
function renderAll(){
  document.getElementById("stageLabel").textContent = STAGES.find(s=>s.key===currentStageKey).name;
  tick();
  refreshLogButtonState();
  renderTimerLog();
  renderShotLog();
  renderStats();
  renderTargetMarkers();
  renderActiveShotInfo();
}

function beginCompetition(){
  currentStageKey = STAGES[0].key;
  state = loadStage(currentStageKey);
  document.getElementById("stageSelect").value = currentStageKey;
  showScreen(state.finalized ? "scoring" : "timer");
  renderAll();
  if(state.running){ startTicking(); }
}

function init(){
  buildStageSelect();
  buildTargetSvg();

  document.getElementById("beginBtn").addEventListener("click", beginCompetition);
  document.getElementById("startBtn").addEventListener("click", startStage);
  document.getElementById("pauseBtn").addEventListener("click", pauseStage);
  document.getElementById("resetBtn").addEventListener("click", resetStage);
  document.getElementById("logShotBtn").addEventListener("click", logShot);
  document.getElementById("addManualShotBtn").addEventListener("click", addManualShot);
  document.getElementById("endStageBtn").addEventListener("click", endStage);
  document.getElementById("backToLogBtn").addEventListener("click", backToLogShots);
  document.getElementById("nextStageBtn").addEventListener("click", goToNextStage);
  document.getElementById("saveJpgBtn").addEventListener("click", exportTargetJpg);
  document.getElementById("exportBtn").addEventListener("click", exportXls);
  document.getElementById("clearBtn").addEventListener("click", clearSession);

  // Resume where the shooter left off, if there's a session in progress.
  let nav = null;
  try{ nav = JSON.parse(localStorage.getItem(NAV_KEY) || "null"); }catch(e){}
  if(nav && nav.stageKey && STAGES.some(s=>s.key===nav.stageKey)){
    currentStageKey = nav.stageKey;
    state = loadStage(currentStageKey);
    document.getElementById("stageSelect").value = currentStageKey;
    showScreen(nav.screen==="scoring" ? "scoring" : (nav.screen==="timer" ? "timer" : "competition"));
    renderAll();
    if(state.running){ startTicking(); }
  } else {
    state = loadStage(currentStageKey);
    showScreen("competition");
  }

  window.addEventListener("beforeunload", saveStage);
}

init();
})();
