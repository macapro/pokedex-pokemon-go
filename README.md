# POKÉDEX포켓몬고

독립형 포켓몬 도감 사이트의 첫 번째 실행 골격입니다.
- Cloudflare Pages: 웹 화면
- Cloudflare Workers: API 및 관리자 인증
- Cloudflare D1: 공유 도감 데이터베이스

## 1. 새 D1 데이터베이스 만들기
Cloudflare 대시보드에서 Workers & Pages → D1 SQL Database로 이동해 `pokedex-pokemon-go-db`를 생성합니다.

아래 명령은 프로젝트 루트에서 실행합니다.

```bash
npx wrangler d1 execute pokedex-pokemon-go-db --remote --file=./worker/schema.sql
```

생성한 D1 데이터베이스의 database_id를 `wrangler.toml`에 입력합니다.

## 2. 관리자 비밀값 설정
```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put AUTH_SECRET
```
- `ADMIN_PASSWORD`: 관리자 로그인 비밀번호
- `AUTH_SECRET`: 충분히 긴 무작위 문자열(최소 32자 권장)

두 값은 HTML/JavaScript에 넣지 않습니다.

## 3. Worker 배포
```bash
npm install
npx wrangler deploy
```

배포된 Worker URL을 `public/app.js`의 `API_BASE`에 입력합니다.
예: `https://pokedex-pokemon-go-api.<계정>.workers.dev`

## 4. Pages 배포
Cloudflare Pages에서 이 프로젝트의 `public` 폴더를 정적 사이트로 배포합니다.
빌드 명령은 비워두고 출력 디렉터리를 `public`으로 설정합니다.

## 현재 포함된 기능
- 공개된 포켓몬 목록 조회 및 검색
- 관리자 로그인/로그아웃
- 관리자 전용 포켓몬 추가·수정·삭제
- 초안/공개 상태 관리
- D1에 모든 이용자 공통 데이터 저장

## 다음 확장 단계
폼별 데이터, 타입 사전, Pokémon GO 일반/스페셜/엘리트 기술, 본가 기술, 진화 관계, 도감 설명, 이미지 업로드를 각각 관리하는 화면과 API를 추가합니다.
