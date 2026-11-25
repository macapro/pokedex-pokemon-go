// 배포 후 본인의 Cloudflare Worker 주소로 바꾸세요.
const API_BASE = "https://pokedex-pokemon-go.gaiogaang16.workers.dev";
const $ = (id) => document.getElementById(id);
const dialog = $("adminDialog");
let adminItems = [];

function api(path, options = {}) {
  return fetch(API_BASE + path, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `요청 실패 (${r.status})`);
    return data;
  });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function card(p) {
  const image = p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.korean_name)}" loading="lazy" onerror="this.remove()">` : "";
  const types = [p.type1,p.type2].filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join("");
  return `<article class="pokemon-card"><div class="pokemon-art">${image}<span class="placeholder" ${p.image_url ? 'hidden' : ''}>?</span></div><div class="poke-number">No. ${String(p.national_number).padStart(4,"0")}</div><h3>${esc(p.korean_name)} <small>${esc(p.form_name || "")}</small></h3><div class="tags">${types}</div></article>`;
}
async function loadPublic() {
  const q = $("search").value.trim();
  const type = $("typeFilter").value;
  try {
    const data = await api(`/api/pokemon?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`);
    $("count").textContent = `${data.items.length}개 항목`;
    $("grid").innerHTML = data.items.length ? data.items.map(card).join("") : `<div class="empty">검색 결과가 없습니다. 공개된 도감 데이터가 아직 없을 수도 있습니다.</div>`;
    document.querySelectorAll(".pokemon-art img").forEach(img => img.addEventListener("error", () => { img.parentElement.querySelector(".placeholder").hidden = false; }));
  } catch (e) {
    $("count").textContent = "연결 필요";
    $("grid").innerHTML = `<div class="empty">도감 API에 연결할 수 없습니다.<br>${esc(e.message)}<br><br>배포 후 public/app.js의 API_BASE를 Worker 주소로 설정하세요.</div>`;
  }
}
function clearForm() {
  $("pokemonForm").reset(); $("editId").value = ""; $("formName").value = "기본폼";
}
function fillForm(p) {
  $("editId").value=p.id; $("number").value=p.national_number; $("koreanName").value=p.korean_name;
  $("englishName").value=p.english_name||""; $("slug").value=p.slug; $("formName").value=p.form_name||"기본폼";
  $("generation").value=p.generation||""; $("region").value=p.region||""; $("imageUrl").value=p.image_url||"";
  $("type1").value=p.type1||""; $("type2").value=p.type2||""; $("description").value=p.description||"";
  $("published").checked=!!p.is_published;
  $("pokemonForm").scrollIntoView({behavior:"smooth",block:"start"});
}
async function loadAdmin() {
  const data = await api("/api/admin/pokemon");
  adminItems = data.items;
  $("adminList").innerHTML = adminItems.map(p => `<div class="admin-row"><div><strong>No.${String(p.national_number).padStart(4,"0")} ${esc(p.korean_name)}</strong> <small>${esc(p.form_name)} · <span class="${p.is_published ? "status" : "status draft"}">${p.is_published ? "공개" : "초안"}</span></small></div><div><button class="outline" data-edit="${p.id}">수정</button><button class="outline" data-delete="${p.id}">삭제</button></div></div>`).join("") || `<p class="muted">등록된 데이터가 없습니다.</p>`;
  $("adminList").querySelectorAll("[data-edit]").forEach(b => b.onclick = () => fillForm(adminItems.find(p => p.id == b.dataset.edit)));
  $("adminList").querySelectorAll("[data-delete]").forEach(b => b.onclick = async () => {
    if (!confirm("이 도감 항목을 삭제할까요?")) return;
    try { await api(`/api/admin/pokemon/${b.dataset.delete}`, {method:"DELETE"}); await loadAdmin(); await loadPublic(); }
    catch(e) { $("adminMessage").textContent=e.message; }
  });
}
$("search").addEventListener("input", loadPublic);
$("typeFilter").addEventListener("change", loadPublic);
$("adminOpen").onclick = async () => {
  dialog.showModal();
  try {
    const me = await api("/api/admin/me");
    $("loginPanel").hidden = me.authenticated;
    $("adminPanel").hidden = !me.authenticated;
    if (me.authenticated) await loadAdmin();
  } catch(e) { $("loginMessage").textContent = e.message; }
};
$("adminClose").onclick = () => dialog.close();
$("loginForm").onsubmit = async e => {
  e.preventDefault(); $("loginMessage").textContent = "로그인 확인 중…";
  try {
    await api("/api/admin/login", {method:"POST",body:JSON.stringify({password:$("adminPassword").value})});
    $("loginPanel").hidden=true; $("adminPanel").hidden=false; $("loginMessage").textContent="";
    $("adminPassword").value=""; await loadAdmin();
  } catch(err) { $("loginMessage").textContent=err.message; }
};
$("logout").onclick = async () => {
  await api("/api/admin/logout",{method:"POST"}); $("adminPanel").hidden=true; $("loginPanel").hidden=false;
};
$("resetForm").onclick = clearForm;
$("pokemonForm").onsubmit = async e => {
  e.preventDefault();
  const p = {
    national_number:$("number").value, korean_name:$("koreanName").value,
    english_name:$("englishName").value, slug:$("slug").value,
    form_name:$("formName").value, generation:$("generation").value,
    region:$("region").value, image_url:$("imageUrl").value,
    type1:$("type1").value, type2:$("type2").value,
    description:$("description").value, is_published:$("published").checked
  };
  try {
    const id=$("editId").value;
    await api(id ? `/api/admin/pokemon/${id}` : "/api/admin/pokemon", {method:id?"PUT":"POST",body:JSON.stringify(p)});
    $("adminMessage").textContent="저장했습니다.";
    clearForm(); await loadAdmin(); await loadPublic();
  } catch(err) { $("adminMessage").textContent=err.message; }
};
loadPublic();
