const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra }
  });
async function saveImportProgress(
  env,
  task,
  generation,
  nextOffset,
  total,
  status = "running"
) {
  await env.DB.prepare(`
    INSERT INTO import_progress (
      task,
      generation,
      next_offset,
      total,
      status,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(task) DO UPDATE SET
      generation = excluded.generation,
      next_offset = excluded.next_offset,
      total = excluded.total,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    task,
    generation,
    nextOffset,
    total,
    status
  ).run();
}
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
// 포켓몬 전국도감 데이터 가져오기
const TYPE_KO = {
  normal: "노말",
  fire: "불꽃",
  water: "물",
  electric: "전기",
  grass: "풀",
  ice: "얼음",
  fighting: "격투",
  poison: "독",
  ground: "땅",
  flying: "비행",
  psychic: "에스퍼",
  bug: "벌레",
  rock: "바위",
  ghost: "고스트",
  dragon: "드래곤",
  dark: "악",
  steel: "강철",
  fairy: "페어리"
};

const GENERATION_NUMBER = {
  "generation-i": 1,
  "generation-ii": 2,
  "generation-iii": 3,
  "generation-iv": 4,
  "generation-v": 5,
  "generation-vi": 6,
  "generation-vii": 7,
  "generation-viii": 8,
  "generation-ix": 9
};

const GENERATION_REGION = {
  1: "관동",
  2: "성도",
  3: "호연",
  4: "신오",
  5: "하나",
  6: "칼로스",
  7: "알로라",
  8: "가라르",
  9: "팔데아"
};

fetchPokeApi(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("PokéAPI 요청 실패: " + response.status);
  }
  return response.json();
}

fetchPokemonImportItem(id) {
  const species = await fetchPokeApi(
    `https://pokeapi.co/api/v2/pokemon-species/${id}/`
  );

  const koreanName =
    species.names?.find(n => n.language.name === "ko")?.name || "";

  const englishName = species.name;

  const defaultVariety = species.varieties?.find(v => v.is_default);
  if (!defaultVariety?.pokemon?.url) {
    throw new Error(`기본 포켓몬 정보를 찾을 수 없습니다: ${id}`);
  }

  const pokemon = await fetchPokeApi(defaultVariety.pokemon.url);

  const types = (pokemon.types || [])
    .sort((a, b) => a.slot - b.slot)
    .map(t => TYPE_KO[t.type.name] || t.type.name);

  const generation = GENERATION_NUMBER[species.generation?.name] || null;

  const imageUrl =
    pokemon.sprites?.other?.["official-artwork"]?.front_default ||
    pokemon.sprites?.front_default ||
    "";

  return {
    national_number: species.id,
    slug: species.name,
    korean_name: koreanName || englishName,
    english_name: englishName,
    form_name: "기본폼",
    generation,
    region: GENERATION_REGION[generation] || "",
    image_url: imageUrl,
    type1: types[0] || "",
    type2: types[1] || "",
    description: "",
    is_published: 1,
    sort_order: species.id
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
            // 공개 포켓몬 GO 능력치 조회
      if (path === "/api/pokemon/go-stats" && request.method === "GET") {
        const result = await env.DB.prepare(`
          SELECT
            s.*,
            p.national_number,
            p.slug,
            p.korean_name,
            p.english_name,
            p.image_url,
            p.type1,
            p.type2
          FROM pokemon_go_stats s
          JOIN pokemon p ON p.id = s.pokemon_id
          WHERE p.is_published = 1
          ORDER BY p.national_number
        `).all();

        return json({ items: result.results || [] }, 200, cors);
      }
            // 공개 포켓몬 GO 기술 조회
      if (path === "/api/pokemon/go-moves" && request.method === "GET") {
        const result = await env.DB.prepare(`
          SELECT *
          FROM pokemon_go_moves
          ORDER BY move_type, name_ko
        `).all();

        return json({ items: result.results || [] }, 200, cors);
      }

      // 공개 포켓몬 GO 추천 기술 조회
      if (path === "/api/pokemon/go-recommendations" && request.method === "GET") {
        const pokemonId = url.searchParams.get("pokemon_id");
        const battleMode = cleanString(url.searchParams.get("battle_mode"), 30);

        let sql = `
          SELECT
            r.*,
            p.national_number,
            p.korean_name,
            p.english_name,
            m.name_ko AS move_name_ko,
            m.name_en AS move_name_en,
            m.move_type,
            m.category AS move_category,
            m.power,
            m.energy
          FROM pokemon_go_recommendations r
          JOIN pokemon p ON p.id = r.pokemon_id
          JOIN pokemon_go_moves m ON m.id = r.move_id
          WHERE p.is_published = 1
        `;

        const args = [];

        if (pokemonId !== null) {
          const id = Number(pokemonId);
          if (!Number.isInteger(id) || id < 1) {
            return json({ error: "포켓몬 ID가 올바르지 않습니다." }, 400, cors);
          }
          sql += " AND r.pokemon_id = ?";
          args.push(id);
        }

        if (battleMode) {
          sql += " AND r.battle_mode = ?";
          args.push(battleMode);
        }

        sql += " ORDER BY p.national_number, r.recommendation_order";

        const result = await env.DB.prepare(sql).bind(...args).all();

        return json({ items: result.results || [] }, 200, cors);
      }
            // 공개 본가 기술 목록 조회
      if (path === "/api/pokemon/main-moves" && request.method === "GET") {
        const type = cleanString(url.searchParams.get("type"), 30);
        const category = cleanString(url.searchParams.get("category"), 30);
        const q = cleanString(url.searchParams.get("q"), 100);

        let sql = `
          SELECT *
          FROM main_series_moves
          WHERE 1=1
        `;

        const args = [];

        if (type) {
          sql += " AND move_type = ?";
          args.push(type);
        }

        if (category) {
          sql += " AND category = ?";
          args.push(category);
        }

        if (q) {
          sql += " AND (name_ko LIKE ? OR name_en LIKE ?)";
          args.push(`%${q}%`, `%${q}%`);
        }

        sql += " ORDER BY move_type, name_ko";

        const result = await env.DB.prepare(sql).bind(...args).all();

        return json({ items: result.results || [] }, 200, cors);
      }

      // 공개 포켓몬별 본가 기술 습득 정보 조회
      if (path === "/api/pokemon/main-learnsets" && request.method === "GET") {
        const pokemonId = url.searchParams.get("pokemon_id");
        const generation = url.searchParams.get("generation");

        if (pokemonId !== null &&
            (!Number.isInteger(Number(pokemonId)) || Number(pokemonId) < 1)) {
          return json({ error: "포켓몬 ID가 올바르지 않습니다." }, 400, cors);
        }

        if (generation !== null &&
            (!Number.isInteger(Number(generation)) || Number(generation) < 1)) {
          return json({ error: "세대 값이 올바르지 않습니다." }, 400, cors);
        }

        let sql = `
          SELECT
            l.*,
            p.national_number,
            p.korean_name,
            p.english_name,
            m.name_ko AS move_name_ko,
            m.name_en AS move_name_en,
            m.move_type,
            m.category,
            m.power
          FROM pokemon_main_moves l
          JOIN pokemon p ON p.id = l.pokemon_id
          JOIN main_series_moves m ON m.id = l.move_id
          WHERE p.is_published = 1
        `;

        const args = [];

        if (pokemonId !== null) {
          sql += " AND l.pokemon_id = ?";
          args.push(Number(pokemonId));
        }

        if (generation !== null) {
          sql += " AND l.generation = ?";
          args.push(Number(generation));
        }

        sql += " ORDER BY p.national_number, l.generation, l.level";

        const result = await env.DB.prepare(sql).bind(...args).all();

        return json({ items: result.results || [] }, 200, cors);
      }
            // 공개 리전폼 및 특수폼 조회
      if (path === "/api/pokemon/forms" && request.method === "GET") {
        const pokemonId = url.searchParams.get("pokemon_id");
        const category = cleanString(url.searchParams.get("category"), 50);

        let sql = `
          SELECT f.*, p.national_number, p.korean_name, p.english_name
          FROM pokemon_forms f
          JOIN pokemon p ON p.id = f.pokemon_id
          WHERE p.is_published = 1
          AND f.is_published = 1
        `;

        const args = [];

        if (pokemonId !== null) {
          const id = Number(pokemonId);
          if (!Number.isInteger(id) || id < 1) {
            return json({ error: "포켓몬 ID가 올바르지 않습니다." }, 400, cors);
          }
          sql += " AND f.pokemon_id = ?";
          args.push(id);
        }

        if (category) {
          sql += " AND f.form_category = ?";
          args.push(category);
        }

        sql += " ORDER BY p.national_number, f.form_name";

        const result = await env.DB.prepare(sql).bind(...args).all();
        return json({ items: result.results || [] }, 200, cors);
      }
            // 공개 코스튬 포켓몬 조회
      if (path === "/api/pokemon/costumes" && request.method === "GET") {
        const pokemonId = url.searchParams.get("pokemon_id");
        const eventName = cleanString(url.searchParams.get("event"), 150);

        let sql = `
          SELECT c.*, p.national_number, p.korean_name, p.english_name
          FROM pokemon_costumes c
          JOIN pokemon p ON p.id = c.pokemon_id
          WHERE p.is_published = 1
          AND c.is_published = 1
        `;

        const args = [];

        if (pokemonId !== null) {
          const id = Number(pokemonId);
          if (!Number.isInteger(id) || id < 1) {
            return json({ error: "포켓몬 ID가 올바르지 않습니다." }, 400, cors);
          }
          sql += " AND c.pokemon_id = ?";
          args.push(id);
        }

        if (eventName) {
          sql += " AND c.event_name LIKE ?";
          args.push(`%${eventName}%`);
        }

        sql += " ORDER BY p.national_number, c.costume_name";

        const result = await env.DB.prepare(sql).bind(...args).all();
        return json({ items: result.results || [] }, 200, cors);
      }
            // 공개 메가진화 및 원시회귀 조회
      if (path === "/api/pokemon/transformations" && request.method === "GET") {
        const pokemonId = url.searchParams.get("pokemon_id");
        const type = cleanString(url.searchParams.get("type"), 50);

        let sql = `
          SELECT t.*, p.national_number, p.korean_name, p.english_name
          FROM pokemon_transformations t
          JOIN pokemon p ON p.id = t.pokemon_id
          WHERE p.is_published = 1
          AND t.is_published = 1
        `;

        const args = [];

        if (pokemonId !== null) {
          const id = Number(pokemonId);
          if (!Number.isInteger(id) || id < 1) {
            return json({ error: "포켓몬 ID가 올바르지 않습니다." }, 400, cors);
          }
          sql += " AND t.pokemon_id = ?";
          args.push(id);
        }

        if (type) {
          sql += " AND t.transformation_type = ?";
          args.push(type);
        }

        sql += " ORDER BY p.national_number, t.transformation_name";

        const result = await env.DB.prepare(sql).bind(...args).all();
        return json({ items: result.results || [] }, 200, cors);
      }
            // 공개 본가 게임별 도감 설명 조회
      if (path === "/api/pokemon/descriptions" && request.method === "GET") {
        const pokemonId = url.searchParams.get("pokemon_id");
        const generation = url.searchParams.get("generation");
        const language = cleanString(url.searchParams.get("language"), 10) || "ko";

        let sql = `
          SELECT d.*, p.national_number, p.korean_name, p.english_name
          FROM pokemon_descriptions d
          JOIN pokemon p ON p.id = d.pokemon_id
          WHERE p.is_published = 1
          AND d.language = ?
        `;

        const args = [language];

        if (pokemonId !== null) {
          const id = Number(pokemonId);
          if (!Number.isInteger(id) || id < 1) {
            return json({ error: "포켓몬 ID가 올바르지 않습니다." }, 400, cors);
          }
          sql += " AND d.pokemon_id = ?";
          args.push(id);
        }

        if (generation !== null) {
          const gen = Number(generation);
          if (!Number.isInteger(gen) || gen < 1) {
            return json({ error: "세대 값이 올바르지 않습니다." }, 400, cors);
          }
          sql += " AND d.generation = ?";
          args.push(gen);
        }

        sql += " ORDER BY p.national_number, d.generation, d.game_title";

        const result = await env.DB.prepare(sql).bind(...args).all();
        return json({ items: result.results || [] }, 200, cors);
      }
            // 포켓몬 통합 상세 정보 조회
      if (path === "/api/pokemon/detail" && request.method === "GET") {
        const pokemonId = Number(url.searchParams.get("id"));

        if (!Number.isInteger(pokemonId) || pokemonId < 1) {
          return json({ error: "포켓몬 ID가 올바르지 않습니다." }, 400, cors);
        }

        const pokemon = await env.DB.prepare(`
          SELECT * FROM pokemon
          WHERE id = ? AND is_published = 1
        `).bind(pokemonId).first();

        if (!pokemon) {
          return json({ error: "포켓몬을 찾을 수 없습니다." }, 404, cors);
        }

        const queries = await Promise.all([
          env.DB.prepare("SELECT * FROM pokemon_go_stats WHERE pokemon_id = ?")
            .bind(pokemonId).all(),

          env.DB.prepare(`
            SELECT r.*, m.name_ko, m.name_en, m.move_type,
                   m.category, m.power, m.energy
            FROM pokemon_go_recommendations r
            JOIN pokemon_go_moves m ON m.id = r.move_id
            WHERE r.pokemon_id = ?
            ORDER BY r.recommendation_order
          `).bind(pokemonId).all(),

          env.DB.prepare(`
            SELECT l.*, m.name_ko, m.name_en, m.move_type, m.category, m.power
            FROM pokemon_main_moves l
            JOIN main_series_moves m ON m.id = l.move_id
            WHERE l.pokemon_id = ?
            ORDER BY l.generation, l.level
          `).bind(pokemonId).all(),

          env.DB.prepare("SELECT * FROM pokemon_forms WHERE pokemon_id = ? AND is_published = 1")
            .bind(pokemonId).all(),

          env.DB.prepare("SELECT * FROM pokemon_costumes WHERE pokemon_id = ? AND is_published = 1")
            .bind(pokemonId).all(),

          env.DB.prepare("SELECT * FROM pokemon_transformations WHERE pokemon_id = ? AND is_published = 1")
            .bind(pokemonId).all(),

          env.DB.prepare("SELECT * FROM pokemon_descriptions WHERE pokemon_id = ?")
            .bind(pokemonId).all()
        ]);

        return json({
          pokemon,
          go_stats: queries[0].results || [],
          go_recommendations: queries[1].results || [],
          main_moves: queries[2].results || [],
          forms: queries[3].results || [],
          costumes: queries[4].results || [],
          transformations: queries[5].results || [],
          descriptions: queries[6].results || []
        }, 200, cors);
      }









      if (path === "/api/admin/me" && request.method === "GET") {
        return json({ authenticated: admin }, 200, cors);
      }

      if (path.startsWith("/api/admin/")) {
        if (!admin) return json({ error: "관리자 로그인이 필요합니다." }, 401, cors);
        // 수집 진행 상태 조회
if (
  request.method === "GET" &&
  path === "/api/admin/import/progress"
) {
  const result = await env.DB.prepare(`
    SELECT task, generation, next_offset, total, status, updated_at
    FROM import_progress
    ORDER BY generation ASC
  `).all();

  return json({
    ok: true,
    progress: result.results || []
  }, 200, cors);
}
        // 전국도감 포켓몬 데이터 일괄 가져오기
if (path === "/api/admin/import/pokemon" && request.method === "POST") {
  let body = {};

  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const offset = Number(body.offset ?? 0);
  const limit = Number(body.limit ?? 10);

  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1024 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10
  ) {
    return json({
      error: "offset은 0~1024, limit은 1~10으로 입력해 주세요."
    }, 400, cors);
  }

  const end = Math.min(offset + limit, 1025);
  const imported = [];
  const failed = [];

  for (let id = offset + 1; id <= end; id++) {
    try {
      const pokemon = await fetchPokemonImportItem(id);
      imported.push(pokemon);
    } catch (error) {
      failed.push({
        national_number: id,
        error: String(error.message || error)
      });
    }
  }

  const statements = imported.map(p =>
    env.DB.prepare(`
      INSERT INTO pokemon (
        national_number,
        slug,
        korean_name,
        english_name,
        form_name,
        generation,
        region,
        image_url,
        type1,
        type2,
        description,
        is_published,
        sort_order,
        updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
      WHERE NOT EXISTS (
        SELECT 1
        FROM pokemon
        WHERE national_number = ?
          AND form_name = ?
      )
    `).bind(
      p.national_number,
      p.slug,
      p.korean_name,
      p.english_name,
      p.form_name,
      p.generation,
      p.region,
      p.image_url,
      p.type1,
      p.type2,
      p.description,
      p.is_published,
      p.sort_order,
      p.national_number,
      p.form_name
    )
  );

  let inserted = 0;

  if (statements.length > 0) {
    const results = await env.DB.batch(statements);
    inserted = results.reduce(
      (sum, result) => sum + (result.meta?.changes || 0),
      0
    );
  }

  return json({
    ok: true,
    requested: end - offset,
    fetched: imported.length,
    inserted,
    skipped: imported.length - inserted,
    failed,
    next_offset: end,
    completed: end >= 1025
  }, 200, cors);
}
  // 본가 기술 정보 분할 수집
if (path === "/api/admin/import/main-moves" && request.method === "POST") {
  const body = await request.json().catch(() => ({}));

  const offset = Number(body.offset ?? 0);
  const limit = Number(body.limit ?? 10);

  if (
    !Number.isInteger(offset) || offset < 0 ||
    !Number.isInteger(limit) || limit < 1 || limit > 10
  ) {
    return json({ error: "입력값을 확인해 주세요." }, 400, cors);
  }

  const list = await fetchPokeApi(
    `https://pokeapi.co/api/v2/move/?offset=${offset}&limit=${limit}`
  );

  const imported = [];
  const failed = [];

  for (const item of list.results || []) {
    try {
      const move = await fetchPokeApi(item.url);

      imported.push({
        name_ko: move.names?.find(
          n => n.language.name === "ko"
        )?.name || move.name,
        name_en: move.name,
        move_type: TYPE_KO[move.type?.name] || move.type?.name || "",
        category: move.damage_class?.name || "",
        power: move.power
      });
    } catch (e) {
      failed.push({
        move: item.name,
        error: String(e.message || e)
      });
    }
  }

  const statements = imported.map(m =>
    env.DB.prepare(`
      INSERT INTO main_series_moves
      (name_ko, name_en, move_type, category, power)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name_en) DO UPDATE SET
        name_ko=excluded.name_ko,
        move_type=excluded.move_type,
        category=excluded.category,
        power=excluded.power
    `).bind(
      m.name_ko,
      m.name_en,
      m.move_type,
      m.category,
      m.power
    )
  );

  if (statements.length) {
    await env.DB.batch(statements);
  }

  return json({
    ok: true,
    fetched: imported.length,
    failed,
    next_offset: offset + limit,
    completed: offset + limit >= list.count
  }, 200, cors);
}      
// 본가 포켓몬별 습득 기술 분할 수집
if (path === "/api/admin/import/main-learnsets" && request.method === "POST") {
  const body = await request.json().catch(() => ({}));

 const limit = Number(body.limit ?? 1);
const generation = Number(body.generation ?? 9);

const task = `main-learnsets-gen-${generation}`;

const savedProgress = await env.DB.prepare(`
  SELECT next_offset
  FROM import_progress
  WHERE task = ?
`).bind(task).first();

const offset = Number(
  body.resume === false
    ? (body.offset ?? 0)
    : (savedProgress?.next_offset ?? body.offset ?? 0)
);

  if (
    !Number.isInteger(offset) || offset < 0 ||
    !Number.isInteger(limit) || limit < 1 || limit > 5 ||
    !Number.isInteger(generation) || generation < 1 || generation > 9
  ) {
    return json({ error: "입력값을 확인해 주세요." }, 400, cors);
  }

  // 세대별 버전 그룹
  const generationVersionGroups = {
    1: ["red-blue", "yellow"],
    2: ["gold-silver", "crystal"],
    3: ["ruby-sapphire", "emerald", "firered-leafgreen"],
    4: ["diamond-pearl", "platinum", "heartgold-soulsilver"],
    5: ["black-white", "black-2-white-2"],
    6: ["x-y", "omega-ruby-alpha-sapphire"],
    7: [
      "sun-moon",
      "ultra-sun-ultra-moon",
      "lets-go-pikachu-lets-go-eevee"
    ],
    8: [
      "sword-shield",
      "brilliant-diamond-shining-pearl",
      "legends-arceus"
    ],
    9: ["scarlet-violet"]
  };

  const allowedGroups = new Set(
    generationVersionGroups[generation]
  );

  // DB에 저장된 기술 정보 가져오기
  const moveRows = await env.DB.prepare(`
    SELECT id, name_en
    FROM main_series_moves
  `).all();

  const moveIds = new Map(
    (moveRows.results || []).map(m => [m.name_en, m.id])
  );

  const pokemonList = await env.DB.prepare(`
    SELECT id, national_number, slug
    FROM pokemon
    WHERE is_published = 1
    ORDER BY national_number
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const learnsets = [];
  const failed = [];
  const missingMoves = new Set();

  for (const p of pokemonList.results || []) {
    try {
      const response = await fetch(
        `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(p.slug)}/`
      );

      if (!response.ok) {
        throw new Error(`PokéAPI ${response.status}`);
      }

      const data = await response.json();

      for (const move of data.moves || []) {
        const moveName = move.move.name;
        const moveId = moveIds.get(moveName);

        // 기술 정보가 DB에 없으면 습득 기술 저장을 건너뜀
        if (!moveId) {
          missingMoves.add(moveName);
          continue;
        }

        for (const detail of move.version_group_details || []) {
          const vg = detail.version_group.name;

          if (!allowedGroups.has(vg)) continue;

          learnsets.push({
            pokemon_id: p.id,
            move_id: moveId,
            generation,
            version_group: vg,
            learn_method: detail.move_learn_method.name,
            level: detail.level_learned_at
          });
        }
      }
    } catch (e) {
      failed.push({
        pokemon: p.slug,
        error: String(e.message || e)
      });
    }
  }

  // 습득 기술 중복 방지
  const statements = learnsets.map(l =>
    env.DB.prepare(`
      INSERT INTO pokemon_main_moves
      (
        pokemon_id,
        move_id,
        generation,
        version_group,
        learn_method,
        level
      )
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1
        FROM pokemon_main_moves
        WHERE pokemon_id = ?
          AND move_id = ?
          AND generation = ?
          AND version_group = ?
          AND learn_method = ?
          AND COALESCE(level, -1) = COALESCE(?, -1)
      )
    `).bind(
      l.pokemon_id,
      l.move_id,
      l.generation,
      l.version_group,
      l.learn_method,
      l.level,
      l.pokemon_id,
      l.move_id,
      l.generation,
      l.version_group,
      l.learn_method,
      l.level
    )
  );

  let inserted = 0;

  for (let i = 0; i < statements.length; i += 50) {
    const result = await env.DB.batch(
      statements.slice(i, i + 50)
    );

    inserted += result.reduce(
      (sum, r) => sum + (r.meta?.changes || 0),
      0
    );
  }

  const totalResult = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM pokemon
    WHERE is_published = 1
  `).first();

  const processed = pokemonList.results?.length || 0;
  const nextOffset = offset + processed;
  const total = totalResult?.total || 0;
await saveImportProgress(
  env,
  task,
  generation,
  failed.length > 0 ? offset : nextOffset,
  total,
  failed.length > 0 ? "error" :
    nextOffset >= total ? "completed" : "running"
);
  return json({
    ok: true,
    generation,
    pokemon_count: processed,
    available_moves: moveIds.size,
    learnsets_found: learnsets.length,
    learnsets: inserted,
    missing_moves: [...missingMoves],
    failed,
    next_offset: nextOffset,
    total_pokemon: total,
    completed: nextOffset >= total
  }, 200, cors);
}


                // 포켓몬 GO 능력치 조회
        if (path === "/api/admin/go-stats" && request.method === "GET") {
          const result = await env.DB.prepare(`
            SELECT s.*, p.korean_name, p.national_number
            FROM pokemon_go_stats s
            JOIN pokemon p ON p.id = s.pokemon_id
            ORDER BY p.national_number
          `).all();

          return json({ items: result.results || [] }, 200, cors);
        }

        // 포켓몬 GO 능력치 등록 및 수정
        if (path === "/api/admin/go-stats" && request.method === "POST") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          if (!Number.isInteger(pokemonId) || pokemonId < 1) {
            return json({ error: "포켓몬 ID가 올바르지 않습니다." }, 400, cors);
          }

          const values = [
            pokemonId,
            body.attack == null ? null : Number(body.attack),
            body.defense == null ? null : Number(body.defense),
            body.stamina == null ? null : Number(body.stamina),
            body.max_cp == null ? null : Number(body.max_cp),
            body.max_hp == null ? null : Number(body.max_hp),
            body.buddy_distance == null ? null : Number(body.buddy_distance)
          ];

          if (values.slice(1).some(v => v !== null && (!Number.isFinite(v) || v < 0))) {
            return json({ error: "능력치 값이 올바르지 않습니다." }, 400, cors);
          }

          await env.DB.prepare(`
            INSERT INTO pokemon_go_stats
            (pokemon_id, attack, defense, stamina, max_cp, max_hp, buddy_distance)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(pokemon_id) DO UPDATE SET
              attack=excluded.attack,
              defense=excluded.defense,
              stamina=excluded.stamina,
              max_cp=excluded.max_cp,
              max_hp=excluded.max_hp,
              buddy_distance=excluded.buddy_distance
          `).bind(...values).run();

          return json({ ok: true }, 200, cors);
        }
                // 포켓몬 GO 기술 목록 조회
        if (path === "/api/admin/go-moves" && request.method === "GET") {
          const result = await env.DB.prepare(`
            SELECT * FROM pokemon_go_moves ORDER BY move_type, name_ko
          `).all();

          return json({ items: result.results || [] }, 200, cors);
        }

        // 포켓몬 GO 기술 등록
        if (path === "/api/admin/go-moves" && request.method === "POST") {
          const body = await request.json();

          const nameKo = cleanString(body.name_ko, 100);
          const nameEn = cleanString(body.name_en, 100);
          const moveType = cleanString(body.move_type, 30);
          const category = cleanString(body.category, 30);
          const power = body.power == null ? null : Number(body.power);
          const energy = body.energy == null ? null : Number(body.energy);

          if (!nameKo || !nameEn || !category) {
            return json({ error: "기술명과 기술 구분을 입력해 주세요." }, 400, cors);
          }

          if ([power, energy].some(v => v !== null && (!Number.isFinite(v) || v < 0))) {
            return json({ error: "위력 또는 에너지 값이 올바르지 않습니다." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO pokemon_go_moves
            (name_ko, name_en, move_type, category, power, energy)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(nameKo, nameEn, moveType, category, power, energy).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201, cors);
        }
                // 포켓몬 GO 기술 수정
        const goMoveEdit = path.match(/^\/api\/admin\/go-moves\/(\d+)$/);

        if (goMoveEdit && request.method === "PUT") {
          const body = await request.json();

          const id = Number(goMoveEdit[1]);
          const nameKo = cleanString(body.name_ko, 100);
          const nameEn = cleanString(body.name_en, 100);
          const moveType = cleanString(body.move_type, 30);
          const category = cleanString(body.category, 30);
          const power = body.power == null ? null : Number(body.power);
          const energy = body.energy == null ? null : Number(body.energy);

          if (!nameKo || !nameEn || !category) {
            return json({ error: "기술 정보를 확인해 주세요." }, 400, cors);
          }

          if ([power, energy].some(v =>
            v !== null && (!Number.isFinite(v) || v < 0)
          )) {
            return json({ error: "위력 또는 에너지 값이 올바르지 않습니다." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            UPDATE pokemon_go_moves
            SET name_ko=?, name_en=?, move_type=?,
                category=?, power=?, energy=?
            WHERE id=?
          `).bind(
            nameKo, nameEn, moveType,
            category, power, energy, id
          ).run();

          if (!result.meta.changes) {
            return json({ error: "해당 기술을 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

        // 포켓몬 GO 기술 삭제
        if (goMoveEdit && request.method === "DELETE") {
          const result = await env.DB.prepare(`
            DELETE FROM pokemon_go_moves WHERE id=?
          `).bind(Number(goMoveEdit[1])).run();

          if (!result.meta.changes) {
            return json({ error: "해당 기술을 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

                // 포켓몬 GO 추천 기술 목록 조회
        if (path === "/api/admin/go-recommendations" && request.method === "GET") {
          const result = await env.DB.prepare(`
            SELECT
              r.*,
              p.korean_name,
              p.english_name,
              m.name_ko AS move_name_ko,
              m.name_en AS move_name_en,
              m.move_type,
              m.category AS move_category
            FROM pokemon_go_recommendations r
            LEFT JOIN pokemon p ON p.id = r.pokemon_id
            LEFT JOIN pokemon_go_moves m ON m.id = r.move_id
            ORDER BY p.national_number, r.battle_mode, r.move_slot, r.recommendation_order
          `).all();

          return json({ items: result.results || [] }, 200, cors);
        }

        // 포켓몬 GO 추천 기술 등록
        if (path === "/api/admin/go-recommendations" && request.method === "POST") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const moveId = Number(body.move_id);
          const battleMode = cleanString(body.battle_mode, 30);
          const moveSlot = cleanString(body.move_slot, 30);
          const recommendationOrder = Number(body.recommendation_order ?? 1);
          const source = cleanString(body.source, 200);

          if (
            !Number.isInteger(pokemonId) || pokemonId <= 0 ||
            !Number.isInteger(moveId) || moveId <= 0 ||
            !battleMode || !moveSlot
          ) {
            return json({ error: "포켓몬, 기술, 배틀 모드, 기술 구분을 입력해 주세요." }, 400, cors);
          }

          if (!Number.isInteger(recommendationOrder) || recommendationOrder < 1) {
            return json({ error: "추천 순서는 1 이상의 정수여야 합니다." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO pokemon_go_recommendations
            (pokemon_id, move_id, battle_mode, move_slot, recommendation_order, source)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            pokemonId,
            moveId,
            battleMode,
            moveSlot,
            recommendationOrder,
            source
          ).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201, cors);
        }
                // 포켓몬 GO 추천 기술 수정
        const goRecommendEdit = path.match(/^\/api\/admin\/go-recommendations\/(\d+)$/);

        if (goRecommendEdit && request.method === "PUT") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const moveId = Number(body.move_id);
          const battleMode = cleanString(body.battle_mode, 30);
          const moveSlot = cleanString(body.move_slot, 30);
          const order = Number(body.recommendation_order ?? 1);
          const source = cleanString(body.source, 200);

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !Number.isInteger(moveId) || moveId < 1 ||
            !battleMode || !moveSlot ||
            !Number.isInteger(order) || order < 1
          ) {
            return json({ error: "추천 기술 정보를 확인해 주세요." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            UPDATE pokemon_go_recommendations
            SET pokemon_id=?, move_id=?, battle_mode=?,
                move_slot=?, recommendation_order=?, source=?,
                updated_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).bind(
            pokemonId, moveId, battleMode,
            moveSlot, order, source,
            Number(goRecommendEdit[1])
          ).run();

          if (!result.meta.changes) {
            return json({ error: "추천 기술을 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

        // 포켓몬 GO 추천 기술 삭제
        if (goRecommendEdit && request.method === "DELETE") {
          const result = await env.DB.prepare(`
            DELETE FROM pokemon_go_recommendations WHERE id=?
          `).bind(Number(goRecommendEdit[1])).run();

          if (!result.meta.changes) {
            return json({ error: "추천 기술을 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

                // 본가 기술 목록 조회
        if (path === "/api/admin/main-moves" && request.method === "GET") {
          const result = await env.DB.prepare(`
            SELECT * FROM main_series_moves
            ORDER BY move_type, name_ko
          `).all();

          return json({ items: result.results || [] }, 200, cors);
        }

        // 본가 기술 등록
        if (path === "/api/admin/main-moves" && request.method === "POST") {
          const body = await request.json();

          const nameKo = cleanString(body.name_ko, 100);
          const nameEn = cleanString(body.name_en, 100);
          const moveType = cleanString(body.move_type, 30);
          const category = cleanString(body.category, 30);
          const power = body.power == null ? null : Number(body.power);

          if (!nameKo || !nameEn || !moveType || !category) {
            return json({ error: "기술명, 타입, 분류를 입력해 주세요." }, 400, cors);
          }

          if (power !== null && (!Number.isFinite(power) || power < 0)) {
            return json({ error: "기술 위력이 올바르지 않습니다." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO main_series_moves
            (name_ko, name_en, move_type, category, power)
            VALUES (?, ?, ?, ?, ?)
          `).bind(nameKo, nameEn, moveType, category, power).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201, cors);
        }
                // 본가 기술 수정 및 삭제
        const mainMoveEdit = path.match(/^\/api\/admin\/main-moves\/(\d+)$/);

        if (mainMoveEdit && request.method === "PUT") {
          const body = await request.json();
          const nameKo = cleanString(body.name_ko, 100);
          const nameEn = cleanString(body.name_en, 100);
          const moveType = cleanString(body.move_type, 30);
          const category = cleanString(body.category, 30);
          const power = body.power === null || body.power === "" ? null : Number(body.power);

          if (!nameKo || !nameEn || !moveType || !category ||
              (power !== null && (!Number.isFinite(power) || power < 0))) {
            return json({ error: "본가 기술 정보를 확인해 주세요." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            UPDATE main_series_moves
            SET name_ko=?, name_en=?, move_type=?, category=?, power=?
            WHERE id=?
          `).bind(nameKo, nameEn, moveType, category, power,
                  Number(mainMoveEdit[1])).run();

          if (!result.meta.changes) return json({ error: "본가 기술을 찾을 수 없습니다." }, 404, cors);
          return json({ ok: true }, 200, cors);
        }

        if (mainMoveEdit && request.method === "DELETE") {
          const result = await env.DB.prepare(`
            DELETE FROM main_series_moves WHERE id=?
          `).bind(Number(mainMoveEdit[1])).run();

          if (!result.meta.changes) return json({ error: "본가 기술을 찾을 수 없습니다." }, 404, cors);
          return json({ ok: true }, 200, cors);
        }

 
                // 본가 기술 습득 정보 조회
        if (path === "/api/admin/main-learnsets" && request.method === "GET") {
          const result = await env.DB.prepare(`
            SELECT
              l.*,
              p.korean_name,
              p.national_number,
              m.name_ko AS move_name_ko,
              m.name_en AS move_name_en,
              m.move_type,
              m.category,
              m.power
            FROM pokemon_main_moves l
            LEFT JOIN pokemon p ON p.id = l.pokemon_id
            LEFT JOIN main_series_moves m ON m.id = l.move_id
            ORDER BY p.national_number, l.generation, l.version_group
          `).all();

          return json({ items: result.results || [] }, 200, cors);
        }

        // 본가 기술 습득 정보 등록
        if (path === "/api/admin/main-learnsets" && request.method === "POST") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const moveId = Number(body.move_id);
          const generation = Number(body.generation);
          const versionGroup = cleanString(body.version_group, 100);
          const learnMethod = cleanString(body.learn_method, 50);
          const level = body.level == null ? null : Number(body.level);
          const machineName = cleanString(body.machine_name, 100);
          const note = cleanString(body.note, 500);

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !Number.isInteger(moveId) || moveId < 1 ||
            !Number.isInteger(generation) || generation < 1 ||
            !versionGroup || !learnMethod
          ) {
            return json({ error: "포켓몬, 기술, 세대, 게임 버전, 습득 방법을 확인해 주세요." }, 400, cors);
          }

          if (level !== null && (!Number.isInteger(level) || level < 0)) {
            return json({ error: "습득 레벨이 올바르지 않습니다." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO pokemon_main_moves
            (pokemon_id, move_id, generation, version_group, learn_method, level, machine_name, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            pokemonId, moveId, generation, versionGroup,
            learnMethod, level, machineName, note
          ).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201, cors);
        }
                // 본가 기술 습득 정보 수정
        const learnsetEdit = path.match(/^\/api\/admin\/main-learnsets\/(\d+)$/);

        if (learnsetEdit && request.method === "PUT") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const moveId = Number(body.move_id);
          const generation = Number(body.generation);
          const versionGroup = cleanString(body.version_group, 100);
          const learnMethod = cleanString(body.learn_method, 50);
          const level = body.level == null || body.level === ""
            ? null : Number(body.level);
          const machineName = cleanString(body.machine_name, 100);
          const note = cleanString(body.note, 500);

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !Number.isInteger(moveId) || moveId < 1 ||
            !Number.isInteger(generation) || generation < 1 ||
            !versionGroup || !learnMethod ||
            (level !== null && (!Number.isInteger(level) || level < 0))
          ) {
            return json({ error: "기술 습득 정보를 확인해 주세요." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            UPDATE pokemon_main_moves
            SET pokemon_id=?, move_id=?, generation=?,
                version_group=?, learn_method=?, level=?,
                machine_name=?, note=?
            WHERE id=?
          `).bind(
            pokemonId, moveId, generation, versionGroup,
            learnMethod, level, machineName, note,
            Number(learnsetEdit[1])
          ).run();

          if (!result.meta.changes) {
            return json({ error: "기술 습득 정보를 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

        // 본가 기술 습득 정보 삭제
        if (learnsetEdit && request.method === "DELETE") {
          const result = await env.DB.prepare(`
            DELETE FROM pokemon_main_moves WHERE id=?
          `).bind(Number(learnsetEdit[1])).run();

          if (!result.meta.changes) {
            return json({ error: "기술 습득 정보를 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

                // 리전폼 및 특수폼 조회
        if (path === "/api/admin/forms" && request.method === "GET") {
          const result = await env.DB.prepare(`
            SELECT f.*, p.korean_name, p.national_number
            FROM pokemon_forms f
            LEFT JOIN pokemon p ON p.id = f.pokemon_id
            ORDER BY p.national_number, f.form_name
          `).all();

          return json({ items: result.results || [] }, 200, cors);
        }

        // 리전폼 및 특수폼 등록
        if (path === "/api/admin/forms" && request.method === "POST") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const formName = cleanString(body.form_name, 100);
          const formNameEn = cleanString(body.form_name_en, 100);
          const formCategory = cleanString(body.form_category, 50);
          const region = cleanString(body.region, 80);
          const type1 = cleanString(body.type1, 30);
          const type2 = cleanString(body.type2, 30);
          const imageUrl = cleanString(body.image_url, 1000);
          const description = cleanString(body.description, 2000);
          const isPublished = body.is_published ? 1 : 0;

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !formName || !formCategory
          ) {
            return json({ error: "포켓몬 ID, 폼 이름, 폼 종류를 입력해 주세요." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO pokemon_forms
            (pokemon_id, form_name, form_name_en, form_category,
             region, type1, type2, image_url, description, is_published)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            pokemonId, formName, formNameEn, formCategory,
            region, type1, type2, imageUrl, description, isPublished
          ).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201, cors);
        }
                // 리전폼 및 특수폼 수정
        const formEdit = path.match(/^\/api\/admin\/forms\/(\d+)$/);

        if (formEdit && request.method === "PUT") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const formName = cleanString(body.form_name, 100);
          const formNameEn = cleanString(body.form_name_en, 100);
          const formCategory = cleanString(body.form_category, 50);
          const region = cleanString(body.region, 80);
          const type1 = cleanString(body.type1, 30);
          const type2 = cleanString(body.type2, 30);
          const imageUrl = cleanString(body.image_url, 1000);
          const description = cleanString(body.description, 2000);
          const isPublished = body.is_published ? 1 : 0;

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !formName || !formCategory
          ) {
            return json({ error: "폼 정보를 확인해 주세요." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            UPDATE pokemon_forms
            SET pokemon_id=?, form_name=?, form_name_en=?,
                form_category=?, region=?, type1=?, type2=?,
                image_url=?, description=?, is_published=?
            WHERE id=?
          `).bind(
            pokemonId, formName, formNameEn, formCategory,
            region, type1, type2, imageUrl, description,
            isPublished, Number(formEdit[1])
          ).run();

          if (!result.meta.changes) {
            return json({ error: "폼 정보를 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

        // 리전폼 및 특수폼 삭제
        if (formEdit && request.method === "DELETE") {
          const result = await env.DB.prepare(`
            DELETE FROM pokemon_forms WHERE id=?
          `).bind(Number(formEdit[1])).run();

          if (!result.meta.changes) {
            return json({ error: "폼 정보를 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

                // 코스튬 포켓몬 목록 조회
        if (path === "/api/admin/costumes" && request.method === "GET") {
          const result = await env.DB.prepare(`
            SELECT c.*, p.korean_name, p.national_number
            FROM pokemon_costumes c
            LEFT JOIN pokemon p ON p.id = c.pokemon_id
            ORDER BY p.national_number, c.costume_name
          `).all();

          return json({ items: result.results || [] }, 200, cors);
        }

        // 코스튬 포켓몬 등록
        if (path === "/api/admin/costumes" && request.method === "POST") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const costumeName = cleanString(body.costume_name, 100);
          const costumeNameEn = cleanString(body.costume_name_en, 100);
          const eventName = cleanString(body.event_name, 150);
          const releaseDate = cleanString(body.release_date, 30);
          const imageUrl = cleanString(body.image_url, 1000);
          const isShinyAvailable = body.is_shiny_available ? 1 : 0;
          const isPublished = body.is_published ? 1 : 0;
          const description = cleanString(body.description, 2000);

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !costumeName
          ) {
            return json({ error: "포켓몬 ID와 코스튬 이름을 입력해 주세요." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO pokemon_costumes
            (pokemon_id, costume_name, costume_name_en, event_name,
             release_date, image_url, is_shiny_available, is_published, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            pokemonId, costumeName, costumeNameEn, eventName,
            releaseDate, imageUrl, isShinyAvailable, isPublished, description
          ).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201, cors);
        }
                // 코스튬 포켓몬 수정
        const costumeEdit = path.match(/^\/api\/admin\/costumes\/(\d+)$/);

        if (costumeEdit && request.method === "PUT") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const costumeName = cleanString(body.costume_name, 100);
          const costumeNameEn = cleanString(body.costume_name_en, 100);
          const eventName = cleanString(body.event_name, 150);
          const releaseDate = cleanString(body.release_date, 30);
          const imageUrl = cleanString(body.image_url, 1000);
          const isShinyAvailable = body.is_shiny_available ? 1 : 0;
          const isPublished = body.is_published ? 1 : 0;
          const description = cleanString(body.description, 2000);

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !costumeName
          ) {
            return json({ error: "코스튬 정보를 확인해 주세요." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            UPDATE pokemon_costumes
            SET pokemon_id=?, costume_name=?, costume_name_en=?,
                event_name=?, release_date=?, image_url=?,
                is_shiny_available=?, is_published=?, description=?
            WHERE id=?
          `).bind(
            pokemonId, costumeName, costumeNameEn,
            eventName, releaseDate, imageUrl,
            isShinyAvailable, isPublished, description,
            Number(costumeEdit[1])
          ).run();

          if (!result.meta.changes) {
            return json({ error: "코스튬 정보를 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

        // 코스튬 포켓몬 삭제
        if (costumeEdit && request.method === "DELETE") {
          const result = await env.DB.prepare(`
            DELETE FROM pokemon_costumes WHERE id=?
          `).bind(Number(costumeEdit[1])).run();

          if (!result.meta.changes) {
            return json({ error: "코스튬 정보를 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

                // 메가진화 및 원시회귀 조회
        if (path === "/api/admin/transformations" && request.method === "GET") {
          const result = await env.DB.prepare(`
            SELECT t.*, p.korean_name, p.national_number
            FROM pokemon_transformations t
            LEFT JOIN pokemon p ON p.id = t.pokemon_id
            ORDER BY p.national_number, t.transformation_name
          `).all();

          return json({ items: result.results || [] }, 200, cors);
        }

        // 메가진화 및 원시회귀 등록
        if (path === "/api/admin/transformations" && request.method === "POST") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const transformationType = cleanString(body.transformation_type, 50);
          const transformationName = cleanString(body.transformation_name, 100);
          const targetFormName = cleanString(body.target_form_name, 100);
          const type1 = cleanString(body.type1, 30);
          const type2 = cleanString(body.type2, 30);
          const imageUrl = cleanString(body.image_url, 1000);
          const requiredEnergy = body.required_energy == null
            ? null : Number(body.required_energy);
          const description = cleanString(body.description, 2000);
          const isPublished = body.is_published ? 1 : 0;

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !transformationType || !transformationName
          ) {
            return json({ error: "포켓몬 ID, 변신 종류, 변신 이름을 입력해 주세요." }, 400, cors);
          }

          if (requiredEnergy !== null &&
              (!Number.isFinite(requiredEnergy) || requiredEnergy < 0)) {
            return json({ error: "필요 에너지 값이 올바르지 않습니다." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO pokemon_transformations
            (pokemon_id, transformation_type, transformation_name,
             target_form_name, type1, type2, image_url,
             required_energy, description, is_published)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            pokemonId, transformationType, transformationName,
            targetFormName, type1, type2, imageUrl,
            requiredEnergy, description, isPublished
          ).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201, cors);
        }
                // 메가진화 및 원시회귀 수정
        const transformationEdit = path.match(/^\/api\/admin\/transformations\/(\d+)$/);

        if (transformationEdit && request.method === "PUT") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const transformationType = cleanString(body.transformation_type, 50);
          const transformationName = cleanString(body.transformation_name, 100);
          const targetFormName = cleanString(body.target_form_name, 100);
          const type1 = cleanString(body.type1, 30);
          const type2 = cleanString(body.type2, 30);
          const imageUrl = cleanString(body.image_url, 1000);
          const requiredEnergy = body.required_energy == null || body.required_energy === ""
            ? null : Number(body.required_energy);
          const description = cleanString(body.description, 2000);
          const isPublished = body.is_published ? 1 : 0;

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !transformationType || !transformationName
          ) {
            return json({ error: "진화 정보를 확인해 주세요." }, 400, cors);
          }

          if (requiredEnergy !== null &&
              (!Number.isFinite(requiredEnergy) || requiredEnergy < 0)) {
            return json({ error: "필요 에너지 값이 올바르지 않습니다." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            UPDATE pokemon_transformations
            SET pokemon_id=?, transformation_type=?, transformation_name=?,
                target_form_name=?, type1=?, type2=?, image_url=?,
                required_energy=?, description=?, is_published=?
            WHERE id=?
          `).bind(
            pokemonId, transformationType, transformationName,
            targetFormName, type1, type2, imageUrl,
            requiredEnergy, description, isPublished,
            Number(transformationEdit[1])
          ).run();

          if (!result.meta.changes) {
            return json({ error: "진화 정보를 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

        // 메가진화 및 원시회귀 삭제
        if (transformationEdit && request.method === "DELETE") {
          const result = await env.DB.prepare(`
            DELETE FROM pokemon_transformations WHERE id=?
          `).bind(Number(transformationEdit[1])).run();

          if (!result.meta.changes) {
            return json({ error: "진화 정보를 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

                // 본가 게임별 도감 설명 조회
        if (path === "/api/admin/descriptions" && request.method === "GET") {
          const result = await env.DB.prepare(`
            SELECT d.*, p.korean_name, p.national_number
            FROM pokemon_descriptions d
            LEFT JOIN pokemon p ON p.id = d.pokemon_id
            ORDER BY p.national_number, d.generation, d.game_title
          `).all();

          return json({ items: result.results || [] }, 200, cors);
        }

        // 본가 게임별 도감 설명 등록
        if (path === "/api/admin/descriptions" && request.method === "POST") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const gameTitle = cleanString(body.game_title, 100);
          const generation = body.generation == null
            ? null : Number(body.generation);
          const description = cleanString(body.description, 5000);
          const language = cleanString(body.language, 10) || "ko";

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !gameTitle || !description
          ) {
            return json({ error: "포켓몬 ID, 게임 이름, 도감 설명을 입력해 주세요." }, 400, cors);
          }

          if (generation !== null &&
              (!Number.isInteger(generation) || generation < 1)) {
            return json({ error: "세대 값이 올바르지 않습니다." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO pokemon_descriptions
            (pokemon_id, game_title, generation, description, language)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            pokemonId, gameTitle, generation, description, language
          ).run();

          return json({ ok: true, id: result.meta.last_row_id }, 201, cors);
        }
                // 본가 게임별 도감 설명 수정
        const descriptionEdit = path.match(/^\/api\/admin\/descriptions\/(\d+)$/);

        if (descriptionEdit && request.method === "PUT") {
          const body = await request.json();

          const pokemonId = Number(body.pokemon_id);
          const gameTitle = cleanString(body.game_title, 100);
          const generation = body.generation == null || body.generation === ""
            ? null : Number(body.generation);
          const description = cleanString(body.description, 5000);
          const language = cleanString(body.language, 10) || "ko";

          if (
            !Number.isInteger(pokemonId) || pokemonId < 1 ||
            !gameTitle || !description ||
            (generation !== null &&
              (!Number.isInteger(generation) || generation < 1))
          ) {
            return json({ error: "도감 설명 정보를 확인해 주세요." }, 400, cors);
          }

          const result = await env.DB.prepare(`
            UPDATE pokemon_descriptions
            SET pokemon_id=?, game_title=?, generation=?,
                description=?, language=?
            WHERE id=?
          `).bind(
            pokemonId, gameTitle, generation,
            description, language,
            Number(descriptionEdit[1])
          ).run();

          if (!result.meta.changes) {
            return json({ error: "도감 설명을 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

        // 본가 게임별 도감 설명 삭제
        if (descriptionEdit && request.method === "DELETE") {
          const result = await env.DB.prepare(`
            DELETE FROM pokemon_descriptions WHERE id=?
          `).bind(Number(descriptionEdit[1])).run();

          if (!result.meta.changes) {
            return json({ error: "도감 설명을 찾을 수 없습니다." }, 404, cors);
          }

          return json({ ok: true }, 200, cors);
        }

        








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
