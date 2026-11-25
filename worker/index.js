const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra }
  });

const encoder = new TextEncoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
async function makeSession(secret) {
  const payload = b64url(encoder.encode(JSON.stringify({ role: "admin", exp: Date.now() + 8 * 60 * 60 * 1000 })));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}
async function isAdmin(request, secret) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)pokedex_admin=([^;]+)/);
  if (!match) return false;
  const token = match[1];
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expected = await hmac(secret, parts[0]);
  const actual = fromB64url(parts[1]);
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  if (diff !== 0) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    return payload.role === "admin" && payload.exp > Date.now();
  } catch { return false; }
}
function cookie(value, maxAge) {
  return `pokedex_admin=${value}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`;
}
function cleanString(v, max = 5000) {
  return String(v ?? "").trim().slice(0, max);
}
function validPokemon(body) {
  const number = Number(body.national_number);
  const name = cleanString(body.korean_name, 80);
  const slug = cleanString(body.slug, 100).toLowerCase();
  if (!Number.isInteger(number) || number < 1 || number > 99999 || !name || !/^[a-z0-9-]+$/.test(slug)) return null;
  return {
    national_number: number, slug, korean_name: name,
    english_name: cleanString(body.english_name, 100),
    form_name: cleanString(body.form_name, 100) || "기본폼",
    generation: body.generation ? Number(body.generation) : null,
    region: cleanString(body.region, 80),
    image_url: cleanString(body.image_url, 1000),
    type1: cleanString(body.type1, 30), type2: cleanString(body.type2, 30),
    description: cleanString(body.description, 5000),
    is_published: body.is_published ? 1 : 0,
    sort_order: Number(body.sort_order) || 0
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.SITE_ORIGIN || "";
    const cors = {
      "Access-Control-Allow-Origin": origin === allowed ? origin : allowed,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/health" && request.method === "GET") return json({ ok: true, service: "pokedex-pokemon-go-api" }, 200, cors);

      if (path === "/api/admin/login" && request.method === "POST") {
        const body = await request.json();
        if (!env.ADMIN_PASSWORD || !env.AUTH_SECRET) return json({ error: "서버 관리자 비밀값이 설정되지 않았습니다." }, 503, cors);
        const supplied = encoder.encode(String(body.password || ""));
        const expected = encoder.encode(env.ADMIN_PASSWORD);
        let diff = supplied.length ^ expected.length;
        const n = Math.max(supplied.length, expected.length);
        for (let i = 0; i < n; i++) diff |= (supplied[i] || 0) ^ (expected[i] || 0);
        if (diff !== 0) return json({ error: "비밀번호가 올바르지 않습니다." }, 401, cors);
        const token = await makeSession(env.AUTH_SECRET);
        return json({ ok: true }, 200, { ...cors, "Set-Cookie": cookie(token, 8 * 60 * 60) });
      }

      if (path === "/api/admin/logout" && request.method === "POST") {
        return json({ ok: true }, 200, { ...cors, "Set-Cookie": cookie("", 0) });
      }

      const admin = await isAdmin(request, env.AUTH_SECRET || "");
      if (path === "/api/pokemon" && request.method === "GET") {
        const q = cleanString(url.searchParams.get("q"), 100);
        const type = cleanString(url.searchParams.get("type"), 30);
        let sql = "SELECT * FROM pokemon WHERE is_published = 1";
        const args = [];
        if (q) { sql += " AND (korean_name LIKE ? OR english_name LIKE ? OR CAST(national_number AS TEXT) LIKE ?)"; args.push(`%${q}%`,`%${q}%`,`%${q}%`); }
        if (type) { sql += " AND (type1 = ? OR type2 = ?)"; args.push(type, type); }
        sql += " ORDER BY national_number, sort_order, id";
        const result = await env.DB.prepare(sql).bind(...args).all();
        return json({ items: result.results || [] }, 200, cors);
      }

      if (path === "/api/admin/me" && request.method === "GET") {
        return json({ authenticated: admin }, 200, cors);
      }

      if (path.startsWith("/api/admin/")) {
        if (!admin) return json({ error: "관리자 로그인이 필요합니다." }, 401, cors);

        if (path === "/api/admin/pokemon" && request.method === "GET") {
          const result = await env.DB.prepare("SELECT * FROM pokemon ORDER BY national_number, sort_order, id").all();
          return json({ items: result.results || [] }, 200, cors);
        }
        if (path === "/api/admin/pokemon" && request.method === "POST") {
          const body = await request.json();
          const p = validPokemon(body);
          if (!p) return json({ error: "도감 번호, 이름, 영문 소문자 slug를 확인해 주세요." }, 400, cors);
          const result = await env.DB.prepare(`
            INSERT INTO pokemon (national_number,slug,korean_name,english_name,form_name,generation,region,image_url,type1,type2,description,is_published,sort_order,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          `).bind(p.national_number,p.slug,p.korean_name,p.english_name,p.form_name,p.generation,p.region,p.image_url,p.type1,p.type2,p.description,p.is_published,p.sort_order).run();
          return json({ ok: true, id: result.meta.last_row_id }, 201, cors);
        }
        const edit = path.match(/^\/api\/admin\/pokemon\/(\d+)$/);
        if (edit && request.method === "PUT") {
          const p = validPokemon(await request.json());
          if (!p) return json({ error: "입력값을 확인해 주세요." }, 400, cors);
          await env.DB.prepare(`
            UPDATE pokemon SET national_number=?,slug=?,korean_name=?,english_name=?,form_name=?,generation=?,region=?,image_url=?,type1=?,type2=?,description=?,is_published=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
          `).bind(p.national_number,p.slug,p.korean_name,p.english_name,p.form_name,p.generation,p.region,p.image_url,p.type1,p.type2,p.description,p.is_published,p.sort_order,Number(edit[1])).run();
          return json({ ok: true }, 200, cors);
        }
        if (edit && request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM pokemon WHERE id=?").bind(Number(edit[1])).run();
          return json({ ok: true }, 200, cors);
        }
      }
      return json({ error: "요청한 경로를 찾을 수 없습니다." }, 404, cors);
    } catch (e) {
      return json({ error: "서버 처리 중 오류가 발생했습니다.", detail: String(e.message || e) }, 500, cors);
    }
  }
};
