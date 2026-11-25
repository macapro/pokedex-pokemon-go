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
  const image = p.image_url
    ? `<img src="${esc(p.image_url)}" alt="${esc(p.korean_name)}" loading="lazy" onerror="this.remove()">`
    : "";

  const types = [p.type1,p.type2]
    .filter(Boolean)
    .map(t => `<span class="tag">${esc(t)}</span>`)
    .join("");

  return `
    <article class="pokemon-card"
      data-pokemon-id="${p.id}"
      role="button"
      tabindex="0">
      <div class="pokemon-art">
        ${image}
        <span class="placeholder" ${p.image_url ? "hidden" : ""}>?</span>
      </div>
      <div class="poke-number">
        No. ${String(p.national_number).padStart(4,"0")}
      </div>
      <h3>
        ${esc(p.korean_name)}
        <small>${esc(p.form_name || "")}</small>
      </h3>
      <div class="tags">${types}</div>
    </article>
  `;
}
// 포켓몬 상세 정보 불러오기
async function openPokemonDetail(id) {
  const detailDialog = $("pokemonDetailDialog");
  const detailContent = $("detailContent");

  detailDialog.showModal();
  $("detailTitle").textContent = "포켓몬 정보";
  detailContent.innerHTML = `<div class="detail-loading">정보를 불러오는 중입니다...</div>`;

  try {
    const data = await api(`/api/pokemon/detail?id=${encodeURIComponent(id)}`);
    const p = data.pokemon;
    const stats = data.go_stats?.[0];

    $("detailTitle").textContent = p.korean_name;

    const image = p.image_url
      ? `<img src="${esc(p.image_url)}" alt="${esc(p.korean_name)}">`
      : "";

    const info = (label, value) => `
      <div>
        <small>${esc(label)}</small>
        <strong>${esc(value ?? "-")}</strong>
      </div>
    `;

    const section = (title, items, render) => {
      if (!items?.length) return "";
      return `
        <section class="detail-section">
          <h3>${esc(title)}</h3>
          <div class="detail-list">
            ${items.map(render).join("")}
          </div>
        </section>
      `;
    };

    const item = (title, description) => `
      <div class="detail-item">
        <strong>${esc(title)}</strong>
        <small>${esc(description || "-")}</small>
      </div>
    `;

    detailContent.innerHTML = `
      <div class="detail-hero">
        ${image}
        <div class="detail-info">
          ${info("도감 번호", `No. ${String(p.national_number).padStart(4, "0")}`)}
          ${info("영문 이름", p.english_name)}
          ${info("타입", [p.type1, p.type2].filter(Boolean).join(" / "))}
          ${info("폼", p.form_name)}
          ${info("세대", p.generation)}
          ${info("지역", p.region)}
        </div>
      </div>

      ${p.description ? `
        <section class="detail-section">
          <h3>도감 설명</h3>
          <p>${esc(p.description)}</p>
        </section>
      ` : ""}

      ${stats ? `
        <section class="detail-section">
          <h3>포켓몬 GO 능력치</h3>
          <div class="detail-info">
            ${info("공격", stats.attack)}
            ${info("방어", stats.defense)}
            ${info("체력", stats.stamina)}
            ${info("최대 CP", stats.max_cp)}
            ${info("최대 HP", stats.max_hp)}
            ${info("파트너 거리", stats.buddy_distance)}
          </div>
        </section>
      ` : ""}

      ${section("포켓몬 GO 추천 기술", data.go_recommendations,
        m => item(
          `${m.name_ko || m.name_en} (${m.move_slot || "-"})`,
          `${m.move_type || "-"} · ${m.category || "-"} · 위력 ${m.power ?? "-"} · 에너지 ${m.energy ?? "-"}`
        )
      )}

      ${section("본가 기술", data.main_moves,
        m => item(
          m.name_ko || m.name_en,
          `${m.generation || "-"}세대 · ${m.learn_method || "-"} · 레벨 ${m.level ?? "-"}`
        )
      )}

      ${section("폼", data.forms,
        f => item(
          f.form_name || f.form_name_en,
          `${f.region || "-"} · ${[f.type1, f.type2].filter(Boolean).join(" / ")}`
        )
      )}

      ${section("코스튬", data.costumes,
        c => item(
          c.costume_name || c.costume_name_en,
          `${c.event_name || "-"} · ${c.release_date || "-"}`
        )
      )}

      ${section("변신", data.transformations,
        t => item(
          t.transformation_name || t.target_form_name,
          t.description || t.transformation_type
        )
      )}

      ${section("게임별 설명", data.descriptions,
        d => item(
          d.game_title || `${d.generation || ""}세대`,
          d.description
        )
      )}
    `;
  } catch (e) {
    detailContent.innerHTML = `
      <div class="detail-error">
        상세 정보를 불러오지 못했습니다.<br>
        ${esc(e.message)}
      </div>
    `;
  }
}

// 포켓몬 카드 클릭 및 키보드 실행
$("grid").addEventListener("click", e => {
  const cardElement = e.target.closest("[data-pokemon-id]");
  if (!cardElement) return;

  openPokemonDetail(cardElement.dataset.pokemonId);
});

$("grid").addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;

  const cardElement = e.target.closest("[data-pokemon-id]");
  if (!cardElement) return;

  e.preventDefault();
  openPokemonDetail(cardElement.dataset.pokemonId);
});

// 상세 창 닫기
$("detailClose").onclick = () => {
  $("pokemonDetailDialog").close();
};
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
