(function(){
"use strict";

/* ============================================================
   SHOT CALL PRACTICE
   A separate practice mode from the CMP match logger: no timer,
   no stages. Two ways to work through a string:

   1) Alternating (default): tap the target twice per shot — once
      for where you THINK you hit (the call), then again for where
      a spotting scope shows you ACTUALLY hit.

   2) Batch Mode: tap the target once per shot to log ONLY the
      call, all the way through the string. Add each shot's actual
      result afterward — either by tapping the target (e.g. once
      you can see the target) or by attaching a photo of the shot
      from an e-target, when you don't have a precise coordinate to
      tap and just want the visual record. Photo-only shots have no
      X/Y, so they're excluded from the numeric error/bias stats,
      the same way score-only entries work in the match logger.

   Either way, the distance between call and actual is your calling
   error, so you can see how accurate your calls are over a session.
   ============================================================ */

const STORAGE_KEY = "shotCallPractice.session";
const PHOTO_MAX_DIMENSION = 480; // downscaled before storing, to keep localStorage small

/* ============================================================
   SR-1 TARGET RING GEOMETRY — same simplified rings (X/10/9/8/7/6,
   5-ring dropped, outside 6 = Miss) and the same pixelsPerInch
   derivation as the main target logger, so distances/scores here
   are directly comparable to match sessions.
   ============================================================ */
const RING_DIAMETERS_IN = { X:1.35, 10:3.35, 9:6.35, 8:9.35, 7:12.35, 6:15.35 };
const RING_ORDER = ["X","10","9","8","7","6"];
const OUTER_RING = "6";
const SVG_HALF = 100;
const OUTER_RING_RADIUS_PX = 90;
const pixelsPerInch = OUTER_RING_RADIUS_PX / (RING_DIAMETERS_IN[OUTER_RING] / 2);

/* ============================================================
   SIGN CONVENTION (same as the match logger):
   X: positive = RIGHT of center, negative = LEFT.
   Y: positive = HIGH (up) of center, negative = LOW (down).
   Call bias below is computed as (call - actual): a positive mean
   X means calls tend to land to the RIGHT of where the shot really
   hit; a positive mean Y means calls tend to be called HIGH of the
   actual impact.
   ============================================================ */

/* ============================================================
   STATE
   shots: {num, callX, callY, callScore,
           actualX, actualY, actualScore, actualPhoto, errorIn}
   A shot is "pending" while actualScore is null and actualPhoto is
   not set; it becomes "scored" once a tap fills actualX/Y/score,
   or "photo-only" once a photo is attached (no numeric location).
   pendingCall: the call marker for an in-progress alternating-mode
   shot, or null.
   batchMode: when true, plain taps only ever log new calls; actual
   results are added afterward per row.
   ============================================================ */
let state = loadSession();
let mode = state.pendingCall ? "actual" : "call"; // alternating-mode sub-state: "call" | "actual"
let armedActualShotNum = null; // shot # waiting for the next tap to supply its actual location

function defaultSession(){
  return { shots: [], pendingCall: null, batchMode: false };
}

function loadSession(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(raw){
    try{
      const parsed = JSON.parse(raw);
      if(typeof parsed.batchMode !== "boolean") parsed.batchMode = false;
      return parsed;
    }catch(e){ /* fall through */ }
  }
  return defaultSession();
}

function saveSession(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){
    alert("Could not save — local storage is full. Try removing a photo from an older shot.");
  }
}

/* ============================================================
   TARGET RENDERING
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
  return "M";
}

function round2(n){ return Math.round(n*100)/100; }

function isPending(shot){ return shot.actualScore === null && !shot.actualPhoto; }
function isPhotoOnly(shot){ return !!shot.actualPhoto && shot.actualScore === null; }

/* ============================================================
   TAP HANDLING
   Precedence: an armed "mark via tap" request always wins (it can
   fire in either mode); otherwise Batch Mode logs a new call-only
   shot; otherwise the alternating call/actual flow applies.
   ============================================================ */
function onTargetClick(evt){
  const svg = document.getElementById("targetSvg");
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const ctm = svg.getScreenCTM().inverse();
  const loc = pt.matrixTransform(ctm);
  const inches = pixelToInches(loc.x, loc.y);
  const score = inchesToScore(inches.x, inches.y);

  if(armedActualShotNum !== null){
    const shot = state.shots.find(s=>s.num === armedActualShotNum);
    if(shot){
      fillActual(shot, round2(inches.x), round2(inches.y), score);
    }
    armedActualShotNum = null;
    saveSession();
    renderAll();
    return;
  }

  if(state.batchMode){
    state.shots.push({
      num: state.shots.length + 1,
      callX: round2(inches.x), callY: round2(inches.y), callScore: score,
      actualX: null, actualY: null, actualScore: null, actualPhoto: null, errorIn: null
    });
    saveSession();
    renderAll();
    return;
  }

  if(mode === "call"){
    state.pendingCall = { x: round2(inches.x), y: round2(inches.y), score: score };
    mode = "actual";
  } else {
    const call = state.pendingCall;
    const actualX = round2(inches.x), actualY = round2(inches.y);
    const errorIn = round2(Math.sqrt(Math.pow(actualX-call.x,2) + Math.pow(actualY-call.y,2)));
    state.shots.push({
      num: state.shots.length + 1,
      callX: call.x, callY: call.y, callScore: call.score,
      actualX: actualX, actualY: actualY, actualScore: score, actualPhoto: null,
      errorIn: errorIn
    });
    state.pendingCall = null;
    mode = "call";
  }
  saveSession();
  renderAll();
}

function fillActual(shot, x, y, score){
  shot.actualX = x;
  shot.actualY = y;
  shot.actualScore = score;
  shot.actualPhoto = null;
  shot.errorIn = round2(Math.sqrt(Math.pow(x-shot.callX,2) + Math.pow(y-shot.callY,2)));
}

/* ============================================================
   PER-SHOT ACTUAL-RESULT ACTIONS (batch/e-target workflow)
   ============================================================ */
function armMarkViaTap(num){
  armedActualShotNum = num;
  renderStatus();
}

function attachPhoto(num, file){
  const reader = new FileReader();
  reader.onload = function(){
    const img = new Image();
    img.onload = function(){
      const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);

      const shot = state.shots.find(s=>s.num === num);
      if(shot){
        shot.actualPhoto = dataUrl;
        shot.actualX = null; shot.actualY = null; shot.actualScore = null; shot.errorIn = null;
        saveSession();
        renderAll();
      }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function clearActual(num){
  const shot = state.shots.find(s=>s.num === num);
  if(!shot) return;
  shot.actualX = null; shot.actualY = null; shot.actualScore = null;
  shot.actualPhoto = null; shot.errorIn = null;
  if(armedActualShotNum === num) armedActualShotNum = null;
  saveSession();
  renderAll();
}

/* ============================================================
   MARKERS — call markers are gold, actual markers are rust; a
   thin line connects each pair so the miss-distance is visible
   at a glance. Pending/photo-only shots draw only the call marker.
   ============================================================ */
function renderMarkers(){
  const group = document.getElementById("markerGroup");
  if(!group) return;
  group.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";

  function addDot(x, y, color, label){
    const svgX = x * pixelsPerInch, svgY = -y * pixelsPerInch;
    const dot = document.createElementNS(ns,"circle");
    dot.setAttribute("cx",svgX); dot.setAttribute("cy",svgY);
    dot.setAttribute("r","5");
    dot.setAttribute("fill",color);
    dot.setAttribute("stroke","#fff");
    dot.setAttribute("stroke-width","1");
    group.appendChild(dot);
    const text = document.createElementNS(ns,"text");
    text.setAttribute("x", svgX+6);
    text.setAttribute("y", svgY-6);
    text.setAttribute("font-size","7");
    text.setAttribute("font-weight","bold");
    text.setAttribute("fill",color);
    text.textContent = label;
    group.appendChild(text);
    return {svgX, svgY};
  }

  state.shots.forEach(shot=>{
    const callPt = addDot(shot.callX, shot.callY, "#c9a227", "C"+shot.num);
    if(shot.actualX !== null && shot.actualY !== null){
      const actualPt = addDot(shot.actualX, shot.actualY, "#a13d2f", "A"+shot.num);
      const line = document.createElementNS(ns,"line");
      line.setAttribute("x1", callPt.svgX); line.setAttribute("y1", callPt.svgY);
      line.setAttribute("x2", actualPt.svgX); line.setAttribute("y2", actualPt.svgY);
      line.setAttribute("stroke", "#555");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "3,2");
      group.appendChild(line);
    }
  });

  if(state.pendingCall){
    addDot(state.pendingCall.x, state.pendingCall.y, "#c9a227", "C"+(state.shots.length+1));
  }
}

/* ============================================================
   STATUS LINE
   ============================================================ */
function renderStatus(){
  const el = document.getElementById("statusLine");
  const nextNum = state.shots.length + 1;

  if(armedActualShotNum !== null){
    el.innerHTML = "Tap the target to mark shot <b>#"+armedActualShotNum+"</b>'s actual hit.";
  } else if(state.batchMode){
    el.innerHTML = "Batch Mode: tap the target to log a call for shot <b>#"+nextNum+"</b>. Add actual results per row below once you have them.";
  } else if(mode === "call"){
    el.innerHTML = "Tap the target where you think shot <b>#"+nextNum+"</b> will land.";
  } else {
    el.innerHTML = "Called. Now tap where shot <b>#"+nextNum+"</b> actually hit (via spotting scope).";
  }
}

/* ============================================================
   SHOT LOG TABLE
   Built with DOM methods (not innerHTML) so per-row action buttons
   and file inputs can carry real event listeners.
   ============================================================ */
function renderTable(){
  const body = document.getElementById("shotLogBody");
  body.innerHTML = "";

  state.shots.forEach(shot=>{
    const tr = document.createElement("tr");
    if(armedActualShotNum === shot.num) tr.classList.add("active");

    const tdNum = document.createElement("td");
    tdNum.textContent = shot.num;

    const tdCall = document.createElement("td");
    tdCall.textContent = shot.callScore + " (" + shot.callX.toFixed(2) + ", " + shot.callY.toFixed(2) + ")";

    const tdActual = document.createElement("td");
    if(isPending(shot)){
      const tapBtn = document.createElement("button");
      tapBtn.textContent = armedActualShotNum === shot.num ? "Tap the target…" : "Mark via Tap";
      tapBtn.disabled = armedActualShotNum === shot.num;
      tapBtn.addEventListener("click", ()=> armMarkViaTap(shot.num));

      const photoLabel = document.createElement("label");
      photoLabel.className = "photoInputLabel";
      photoLabel.textContent = "Attach Photo";
      const photoInput = document.createElement("input");
      photoInput.type = "file";
      photoInput.accept = "image/*";
      photoInput.hidden = true;
      photoInput.addEventListener("change", (e)=>{
        if(e.target.files && e.target.files[0]) attachPhoto(shot.num, e.target.files[0]);
      });
      photoLabel.appendChild(photoInput);

      tdActual.appendChild(tapBtn);
      tdActual.appendChild(photoLabel);
    } else if(isPhotoOnly(shot)){
      const thumb = document.createElement("img");
      thumb.src = shot.actualPhoto;
      thumb.className = "actualThumb";
      thumb.alt = "Actual hit photo for shot "+shot.num;
      const clearBtn = document.createElement("button");
      clearBtn.textContent = "Clear";
      clearBtn.className = "link";
      clearBtn.addEventListener("click", ()=> clearActual(shot.num));
      tdActual.appendChild(thumb);
      tdActual.appendChild(clearBtn);
    } else {
      const scoreText = document.createElement("span");
      scoreText.textContent = shot.actualScore + " (" + shot.actualX.toFixed(2) + ", " + shot.actualY.toFixed(2) + ")";
      const clearBtn = document.createElement("button");
      clearBtn.textContent = "Clear";
      clearBtn.className = "link";
      clearBtn.addEventListener("click", ()=> clearActual(shot.num));
      tdActual.appendChild(scoreText);
      tdActual.appendChild(document.createElement("br"));
      tdActual.appendChild(clearBtn);
    }

    const tdError = document.createElement("td");
    tdError.textContent = shot.errorIn !== null ? shot.errorIn.toFixed(2)+" in" : "—";

    tr.appendChild(tdNum);
    tr.appendChild(tdCall);
    tr.appendChild(tdActual);
    tr.appendChild(tdError);
    body.appendChild(tr);
  });
}

/* ============================================================
   STATS
   Average call error and call bias are computed only over shots
   with a numeric actual location (errorIn !== null) — pending and
   photo-only shots have no coordinates to measure.
   ============================================================ */
function renderStats(){
  const scored = state.shots.filter(s => s.errorIn !== null);
  document.getElementById("statShots").textContent = state.shots.length;

  if(scored.length === 0){
    document.getElementById("statAvgError").textContent = "--";
    document.getElementById("statBias").textContent = "--";
    return;
  }

  let errSum = 0, biasXSum = 0, biasYSum = 0;
  scored.forEach(shot=>{
    errSum += shot.errorIn;
    biasXSum += (shot.callX - shot.actualX);
    biasYSum += (shot.callY - shot.actualY);
  });
  const n = scored.length;
  document.getElementById("statAvgError").textContent = (errSum/n).toFixed(2) + " in";

  const meanBiasX = biasXSum/n, meanBiasY = biasYSum/n;
  const parts = [];
  if(Math.abs(meanBiasY) > 0.005) parts.push(Math.abs(meanBiasY).toFixed(2)+"in "+(meanBiasY>=0?"High":"Low"));
  if(Math.abs(meanBiasX) > 0.005) parts.push(Math.abs(meanBiasX).toFixed(2)+"in "+(meanBiasX>=0?"Right":"Left"));
  document.getElementById("statBias").textContent = parts.length ? parts.join(" / ") : "Accurate";
}

/* ============================================================
   BATCH MODE TOGGLE
   ============================================================ */
function onBatchModeToggle(evt){
  state.batchMode = evt.target.checked;
  // Switching modes cancels any in-progress alternating call and any armed tap.
  state.pendingCall = null;
  mode = "call";
  armedActualShotNum = null;
  saveSession();
  renderAll();
}

/* ============================================================
   UNDO — clears an armed "mark via tap" request, or cancels an
   in-progress alternating call, or removes the last shot row.
   ============================================================ */
function undoLast(){
  if(armedActualShotNum !== null){
    armedActualShotNum = null;
  } else if(state.pendingCall){
    state.pendingCall = null;
    mode = "call";
  } else if(state.shots.length > 0){
    state.shots.pop();
  } else {
    return;
  }
  saveSession();
  renderAll();
}

/* ============================================================
   CLEAR SESSION
   ============================================================ */
function clearSession(){
  const first = confirm("Clear this practice session? This deletes every call/actual pair and cannot be undone.");
  if(!first) return;
  const second = confirm("Are you absolutely sure? This is your final confirmation to erase the session.");
  if(!second) return;
  const keepBatchMode = state.batchMode;
  state = defaultSession();
  state.batchMode = keepBatchMode;
  mode = "call";
  armedActualShotNum = null;
  saveSession();
  renderAll();
}

/* ============================================================
   EXPORT — Excel-compatible .xls, same offline approach as the
   match logger (an HTML table saved with an .xls extension).
   Photos aren't embedded in the spreadsheet; a shot with a photo
   attached is flagged in its own column instead.
   ============================================================ */
function htmlEscape(v){
  return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function exportXls(){
  const headers = ["Shot#","Call Score","Call X(in)","Call Y(in)","Actual Score","Actual X(in)","Actual Y(in)","Call Error(in)","Actual Photo"];
  let html = "<table><thead><tr>" +
    headers.map(h=>"<th>"+htmlEscape(h)+"</th>").join("") + "</tr></thead><tbody>";
  state.shots.forEach(shot=>{
    html += "<tr>" +
      "<td>"+shot.num+"</td>" +
      "<td>"+htmlEscape(shot.callScore)+"</td>" +
      "<td>"+shot.callX.toFixed(2)+"</td>" +
      "<td>"+shot.callY.toFixed(2)+"</td>" +
      "<td>"+(shot.actualScore===null ? "" : htmlEscape(shot.actualScore))+"</td>" +
      "<td>"+(shot.actualX===null ? "" : shot.actualX.toFixed(2))+"</td>" +
      "<td>"+(shot.actualY===null ? "" : shot.actualY.toFixed(2))+"</td>" +
      "<td>"+(shot.errorIn===null ? "" : shot.errorIn.toFixed(2))+"</td>" +
      "<td>"+(shot.actualPhoto ? "Yes" : "")+"</td>" +
      "</tr>";
  });
  html += "</tbody></table>";

  const blob = new Blob([html], {type:"application/vnd.ms-excel"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "shot_call_practice_" + new Date().toISOString().slice(0,19).replace(/[:T]/g,"-") + ".xls";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ============================================================
   EXPORT — target diagram as a JPG (offline, no library).
   ============================================================ */
function exportTargetJpg(){
  const svg = document.getElementById("targetSvg");
  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(svg);
  const svgBlob = new Blob([svgStr], {type:"image/svg+xml;charset=utf-8"});
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = function(){
    const size = 720;
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#d7d2c7";
    ctx.fillRect(0,0,size,size);
    ctx.drawImage(img, 0, 0, size, size);
    URL.revokeObjectURL(url);
    canvas.toBlob(function(blob){
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "shot_call_practice_target.jpg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, "image/jpeg", 0.92);
  };
  img.src = url;
}

/* ============================================================
   RENDER ALL / INIT
   ============================================================ */
function renderAll(){
  renderStatus();
  renderMarkers();
  renderTable();
  renderStats();
}

function init(){
  buildTargetSvg();
  document.getElementById("batchModeToggle").checked = state.batchMode;
  document.getElementById("batchModeToggle").addEventListener("change", onBatchModeToggle);
  document.getElementById("undoBtn").addEventListener("click", undoLast);
  document.getElementById("clearBtn").addEventListener("click", clearSession);
  document.getElementById("exportBtn").addEventListener("click", exportXls);
  document.getElementById("saveJpgBtn").addEventListener("click", exportTargetJpg);
  renderAll();
  window.addEventListener("beforeunload", saveSession);
}

init();
})();
