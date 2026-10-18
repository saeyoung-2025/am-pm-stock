// 종가베팅 후보 조회 — Vercel 서버 함수
// 필요한 환경변수 (Vercel > Settings > Environment Variables):
//   KIS_APP_KEY, KIS_APP_SECRET  : 한국투자증권 KIS Developers 실전투자 키
//   APP_PASSWORD                 : 앱 비밀번호 (남이 주소를 알아도 못 쓰게)
// 키가 없으면 { status: "not_configured" } 를 돌려주고, 앱은 '연결 대기 중'으로 표시합니다.
// 이 함수는 시세 '조회'만 합니다. 주문 기능은 없습니다.

const BASE = "https://openapi.koreainvestment.com:9443";

// 관심 우량주 (자유롭게 추가/삭제)
const UNIVERSE = [
  ["005930","삼성전자"],["000660","SK하이닉스"],["373220","LG에너지솔루션"],["207940","삼성바이오로직스"],
  ["005380","현대차"],["000270","기아"],["068270","셀트리온"],["035420","NAVER"],["035720","카카오"],
  ["005490","POSCO홀딩스"],["051910","LG화학"],["006400","삼성SDI"],["105560","KB금융"],["055550","신한지주"],
  ["086790","하나금융지주"],["316140","우리금융지주"],["012330","현대모비스"],["028260","삼성물산"],
  ["066570","LG전자"],["003550","LG"],["032830","삼성생명"],["000810","삼성화재"],["015760","한국전력"],
  ["034020","두산에너빌리티"],["012450","한화에어로스페이스"],["329180","HD현대중공업"],["009540","HD한국조선해양"],
  ["042660","한화오션"],["402340","SK스퀘어"],["017670","SK텔레콤"],["030200","KT"],["010130","고려아연"],
  ["009150","삼성전기"],["018260","삼성에스디에스"],["259960","크래프톤"],["352820","하이브"],["011200","HMM"],
  ["096770","SK이노베이션"],["247540","에코프로비엠"],["086520","에코프로"],["196170","알테오젠"],["028300","HLB"],
];

// ★ 선별 기준 (0~4단계) — 숫자는 여기 한 곳만 바꾸면 화면 설명까지 같이 바뀝니다
const RULE = {
  marketStop: -1.5,   // 0단계: 코스피가 이 이하면 '쉬는 날'
  dropMin: -2,        // 1단계: 오늘 −2% 이하로 빠졌고
  dropMax: -7,        //        −7%보다는 덜 빠진 종목 (그보다 깊으면 '과대 급락'으로 제외)
  minAmount: 100e8,   //        거래대금 100억 원 이상 (조용한 우량주도 포함되게)
  recGood: 0.5,       // 2단계: 저점에서 빠진 폭의 50% 이상 회복하면 좋음
  recWeak: 0.2,       //        20% 미만이면 '아직 저점 근처'
  posGood: 0.5,       //        오늘 고가~저가 중 위쪽 절반에 있으면 좋음
  relGood: -1,        // 3단계: 시장보다 1%p 이내로만 더 빠지면 +1
  relBad: -3,         //        시장보다 3%p 이상 더 빠지면 −1 (우량주엔 3%p도 큰 차이)
};

let tokenCache = { token: null, exp: 0 };

async function getToken(key, secret) {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const r = await fetch(`${BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: key, appsecret: secret }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("토큰 발급 실패: " + (j.error_description || j.msg1 || r.status)
    + ` (키 ${key.length}자 · 시크릿 ${secret.length}자 / 정상: 36자 · 180자)`);
  tokenCache = { token: j.access_token, exp: Date.now() + 20 * 3600 * 1000 };
  return j.access_token;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isRateErr = j => /EGW00201|초당/.test(`${j.msg_cd || ""} ${j.msg1 || ""}`);

// 초당 조회 제한에 걸리면 잠깐 쉬었다가 최대 2번 다시 시도
async function kis(path, trId, params, auth) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  for (let t = 0; ; t++) {
    const r = await fetch(url, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${auth.token}`,
        appkey: auth.key, appsecret: auth.secret, tr_id: trId, custtype: "P",
      },
    });
    let j;
    try { j = await r.json(); } catch (e) { throw new Error(`응답 해석 실패 (${r.status})`); }
    if (j.rt_cd === "0") return j;
    if (t < 2 && isRateErr(j)) { await sleep(500 + t * 400); continue; }
    throw new Error(j.msg1 || "조회 실패");
  }
}

const num = v => (v === undefined || v === null || v === "" ? null : Number(v));

// 여러 종목 시세를 한 번에 (최대 30종목/1회) — FHKST11300006
// 외국인 수급·투자경고 여부는 여기 없어서, 후보로 좁힌 뒤 개별 조회로 확인합니다.
async function multiQuote(codes, mkt, auth) {
  const out = {};
  for (let i = 0; i < codes.length; i += 30) {
    const batch = codes.slice(i, i + 30), params = {};
    batch.forEach((c, k) => { params[`FID_COND_MRKT_DIV_CODE_${k + 1}`] = mkt; params[`FID_INPUT_ISCD_${k + 1}`] = c; });
    const d = await kis("/uapi/domestic-stock/v1/quotations/intstock-multprice", "FHKST11300006", params, auth);
    (Array.isArray(d.output) ? d.output : []).forEach(x => {
      const code = x.inter_shrn_iscd;
      const price = num(x.inter2_prpr);
      if (!/^\d{6}$/.test(code || "") || !price) return;
      let change = num(x.prdy_ctrt);
      if (change != null && change > 0 && (x.prdy_vrss_sign === "4" || x.prdy_vrss_sign === "5")) change = -change;
      let prev = num(x.inter2_sdpr);
      const diff = num(x.inter2_prdy_vrss);
      if (!prev && diff != null) prev = price - (change < 0 ? -Math.abs(diff) : Math.abs(diff));
      out[code] = { name: x.inter_kor_isnm, price, change, amount: num(x.acml_tr_pbmn), vol: num(x.acml_vol),
        open: num(x.inter2_oprc), high: num(x.inter2_hgpr), low: num(x.inter2_lwpr), prev };
    });
    if (i + 30 < codes.length) await sleep(150);
  }
  return out;
}

// ── VKOSPI: 코드가 공개 문서에 없어서, KIS가 배포하는 지수 목록 파일에서 '변동성' 이름으로 찾음 ──
const zlib = require("zlib");
let vkCode = null;
async function findVkospiCode() {
  if (vkCode) return vkCode;
  const r = await fetch("https://new.real.download.dws.co.kr/common/master/idxcode.mst.zip");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("지수 목록 파일 형식 다름");
  const method = buf.readUInt16LE(8), csize = buf.readUInt32LE(18);
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  const body = buf.slice(start, start + csize);
  const raw = method === 8 ? zlib.inflateRawSync(body) : body;
  let text;
  try { text = new TextDecoder("euc-kr").decode(raw); } catch (e) { text = raw.toString("latin1"); }
  const line = text.split(/\r?\n/).find(l => /변동성/.test(l) && /200/.test(l)) || text.split(/\r?\n/).find(l => /변동성/.test(l));
  if (!line) throw new Error("목록에 변동성지수 없음");
  const m = line.match(/(\d{4,5})/);           // 줄 앞쪽 숫자: [구분 1자리] + 코드 4자리
  if (!m) throw new Error("코드 해석 실패");
  vkCode = m[1].slice(-4);
  return vkCode;
}
async function getVkospi(auth) {
  const code = await findVkospiCode();
  const m = await kis("/uapi/domestic-stock/v1/quotations/inquire-index-price", "FHPUP02100000",
    { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: code }, auth);
  const value = num(m.output.bstp_nmix_prpr);
  if (!value || value < 3 || value > 200) throw new Error("값 확인 필요 (" + code + ")");
  return { code, value, change: num(m.output.bstp_nmix_prdy_ctrt) };
}

// ── 📱 휴대폰 알림: 저장소(Upstash Redis, Vercel Storage에서 무료 생성) + ntfy(무료 알림 앱) ──
//   환경변수: KV_REST_API_URL / KV_REST_API_TOKEN (또는 UPSTASH_REDIS_REST_URL / _TOKEN) · NTFY_TOPIC · ALERT_TOKEN
const R_URL = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const R_TOK = () => (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
async function redis(...cmd) {
  if (!R_URL() || !R_TOK()) throw new Error("저장소 미설정");
  const r = await fetch(R_URL(), { method: "POST", headers: { authorization: `Bearer ${R_TOK()}`, "content-type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error("저장소: " + j.error);
  return j.result;
}
async function ntfy(title, message, opt = {}) {
  const topic = (process.env.NTFY_TOPIC || "").trim();
  if (!topic) throw new Error("NTFY_TOPIC 미설정");
  const r = await fetch("https://ntfy.sh/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, title, message, priority: opt.priority || 4, tags: opt.tags || [], click: opt.click || "https://am-pm-stock.vercel.app/" }) });
  if (!r.ok) throw new Error("ntfy " + r.status);
}
const kstNow = () => { const d = new Date(Date.now() + 9 * 3600e3); return { ymd: d.toISOString().slice(0, 10).replace(/-/g, ""), min: d.getUTCHours() * 60 + d.getUTCMinutes(), wd: d.getUTCDay() }; };

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const clean = v => (v || "").replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, "");
  const key = clean(process.env.KIS_APP_KEY);
  const secret = clean(process.env.KIS_APP_SECRET);
  const pass = (process.env.APP_PASSWORD || "").trim();

  if (!key || !secret) return res.status(200).json({ status: "not_configured" });
  const alertTok = (process.env.ALERT_TOKEN || "").trim();
  const isCron = !!(alertTok && req.query && String(req.query.alert || "") === alertTok);
  if (!isCron && pass && (req.headers["x-app-password"] || "").trim() !== pass) return res.status(401).json({ status: "unauthorized" });

  try {
    const auth = { key, secret, token: await getToken(key, secret) };

    const qv = k => (req.query && req.query[k]) ? String(req.query[k]) : "";

    // 날짜 (한국 시간) — 오늘과 160일 전 (거래일로 약 100일)
    const kstYmd = d => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
    const today = kstYmd(new Date()), from = kstYmd(new Date(Date.now() - 160 * 86400e3));

    // ⭐ 일봉 약 100일: /api/closing?daily=005930  (60일선·변동폭 계산용. 실패하면 30일짜리로)
    if (/^\d{6}$/.test(qv("daily"))) {
      let rows = [];
      try {
        const d = await kis("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", "FHKST03010100",
          { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: qv("daily"), FID_INPUT_DATE_1: from, FID_INPUT_DATE_2: today,
            FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "0" }, auth);
        rows = (d.output2 || []).filter(x => x.stck_bsop_date && num(x.stck_clpr)).map(x => ({ date: x.stck_bsop_date,
          open: num(x.stck_oprc), high: num(x.stck_hgpr), low: num(x.stck_lwpr), close: num(x.stck_clpr), vol: num(x.acml_vol) }));
      } catch (e) {}
      if (rows.length < 30) {
        const d = await kis("/uapi/domestic-stock/v1/quotations/inquire-daily-price", "FHKST01010400",
          { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: qv("daily"), FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "1" }, auth);
        rows = (d.output || []).map(x => ({ date: x.stck_bsop_date, open: num(x.stck_oprc), high: num(x.stck_hgpr),
          low: num(x.stck_lwpr), close: num(x.stck_clpr), vol: num(x.acml_vol) }));
      }
      rows.sort((a, b) => b.date.localeCompare(a.date));   // 최신 날짜가 맨 앞
      return res.status(200).json({ status: "ok", rows });
    }

    // ⭐ 📱 휴대폰 알림 상태: /api/closing?push=status
    if (qv("push") === "status") {
      const st = { status: "ok", store: !!(R_URL() && R_TOK()), ntfy: !!(process.env.NTFY_TOPIC || "").trim(), cron: !!alertTok, topic: (process.env.NTFY_TOPIC || "").trim() || null };
      try { if (st.store) { st.count = JSON.parse((await redis("GET", "amp:watch")) || "[]").length; st.lastRun = await redis("GET", "amp:lastrun"); } } catch (e) { st.storeError = String(e.message).slice(0, 60); }
      return res.status(200).json(st);
    }
    // ⭐ 📱 보유·관심 목록 서버에 저장 (앱이 자동으로 보냄): POST /api/closing?push=sync
    if (qv("push") === "sync") {
      const list = (Array.isArray(req.body && req.body.watch) ? req.body.watch : []).filter(w => /^\d{6}$/.test(w.code)).slice(0, 30)
        .map(w => ({ code: w.code, name: String(w.name || w.code).slice(0, 20), on: w.on !== false, th: +w.th || 5, dir: w.dir || "both",
          buy: +w.buy || null, stop: +w.stop || -7, take: +w.take || 10 }));
      await redis("SET", "amp:watch", JSON.stringify(list));
      return res.status(200).json({ status: "ok", saved: list.length });
    }
    // ⭐ 📱 테스트 알림: /api/closing?push=test
    if (qv("push") === "test") {
      await ntfy("am-pm 테스트 알림 ✅", "휴대폰 알림이 잘 연결됐어요. 장중(09:00~15:30)에 손절·목표·등락 기준에 닿으면 이렇게 알려 드려요.", { tags: ["white_check_mark"] });
      return res.status(200).json({ status: "ok" });
    }
    // ⭐ 📱 예약 확인 (cron-job.org 가 10분마다 호출): /api/closing?alert=<ALERT_TOKEN>
    if (isCron) {
      const k = kstNow();
      if (k.wd === 0 || k.wd === 6 || k.min < 540 || k.min > 935) return res.status(200).json({ status: "ok", skipped: "장 시간 아님" });
      const list = JSON.parse((await redis("GET", "amp:watch")) || "[]").filter(w => w.on);
      if (!list.length) return res.status(200).json({ status: "ok", skipped: "목록 없음" });
      const q = await multiQuote(list.map(w => w.code), "J", auth);
      const sent = [];
      for (const w of list) {
        const x = q[w.code]; if (!x || !x.price) continue;
        const hits = [];
        if (w.buy) {
          const my = (x.price / w.buy - 1) * 100;
          if (my <= w.stop) hits.push(["stop", `🚨 손절선 ${w.stop}% 도달`, `지금 ${x.price.toLocaleString()}원 · 내 수익률 ${my.toFixed(1)}%\n'지금 이 가격에 새로 사겠나?' 아니라면 정리할 때예요.`, 5]);
          else if (my <= w.stop / 2) hits.push(["warn", `⚠️ 손절선 절반`, `지금 ${x.price.toLocaleString()}원 · 내 수익률 ${my.toFixed(1)}%\n왜 빠지는지 뉴스·공시를 확인해 두세요.`, 4]);
          if (my >= w.take) hits.push(["take", `🎯 목표 +${w.take}% 도달`, `지금 ${x.price.toLocaleString()}원 · 내 수익률 +${my.toFixed(1)}%\n전부 또는 절반 팔아 수익 지키기.`, 4]);
        }
        const ch = x.change;
        if (ch != null && Math.abs(ch) >= w.th && (w.dir === "both" || (w.dir === "up" && ch > 0) || (w.dir === "down" && ch < 0)))
          hits.push(["th", `🔔 오늘 ${ch > 0 ? "+" : ""}${ch.toFixed(2)}%`, `지금 ${x.price.toLocaleString()}원 · 하루 기준 ${w.th}%를 넘었어요.`, 3]);
        for (const [kind, title, msg, pr] of hits) {
          const ok = await redis("SET", `amp:sent:${k.ymd}:${w.code}:${kind}`, "1", "NX", "EX", 90000);   // 같은 종목·같은 신호는 하루 한 번
          if (ok !== "OK") continue;
          await ntfy(`${w.name} · ${title}`, msg, { priority: pr, click: `https://m.stock.naver.com/domestic/stock/${w.code}/total` });
          sent.push(`${w.name}:${kind}`);
        }
      }
      await redis("SET", "amp:lastrun", `${k.ymd.slice(4,6)}/${k.ymd.slice(6)} ${String(Math.floor(k.min / 60)).padStart(2,"0")}:${String(k.min % 60).padStart(2,"0")} · ${list.length}종목 확인 · 알림 ${sent.length}건`);
      return res.status(200).json({ status: "ok", checked: list.length, sent });
    }

    // ⭐ 자동 아침 메모 재료: /api/closing?memo=1
    //    ① 간밤 미국 ETF 4개 (KIS 해외주식 현재가)  ② 이번 주 미국 '중요' 경제 발표 일정 (Forex Factory 공개 캘린더)
    if (qv("memo")) {
      const US = [["SPY", "AMS", "S&P500"], ["QQQ", "NAS", "나스닥100"], ["SOXX", "NAS", "반도체"], ["EWY", "AMS", "한국 ETF"]];
      const us = {}, errs = [];
      for (const [sym, ex, name] of US) {
        try {
          const o = (await kis("/uapi/overseas-price/v1/quotations/price", "HHDFS00000300", { AUTH: "", EXCD: ex, SYMB: sym }, auth)).output || {};
          const last = num(o.last), base = num(o.base);
          if (last && base) us[sym] = { name, last, change: +(((last / base) - 1) * 100).toFixed(2) };
        } catch (e) { errs.push(sym + ": " + String(e.message).slice(0, 30)); }
        await sleep(120);
      }
      let events = [];
      try {
        const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
        const list = await r.json();
        events = (Array.isArray(list) ? list : []).filter(e => e.country === "USD" && e.impact === "High")
          .map(e => ({ title: e.title, date: e.date, forecast: e.forecast || "", previous: e.previous || "" }));
      } catch (e) { errs.push("일정: " + String(e.message).slice(0, 30)); }
      return res.status(200).json({ status: "ok", us, events, errors: errs });
    }

    // ⭐ 빚투 현황 (금융투자협회 FreeSIS, 일별 · 1~2 영업일 늦게 발표): /api/closing?debt=1
    //    ① 신용거래융자 잔고  ② 위탁매매 미수금 · 반대매매 금액 (증시자금추이)
    //    열 순서가 공개 문서에 없어서, 합계·비율이 맞는지 스스로 검산한 뒤에만 이름을 붙임
    if (qv("debt")) {
      const from1y = kstYmd(new Date(Date.now() - 400 * 86400e3));
      const freesis = async (obj) => {
        const r = await fetch("http://freesis.kofia.or.kr/meta/getMetaDataList.do", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dmSearch: { OBJ_NM: obj, tmpV1: "D", tmpV40: "1000000", tmpV41: "1", tmpV45: from1y, tmpV46: today } }),
        });
        const j = await r.json();
        return (j.ds1 || []).map(x => {
          const o = { date: String(x.TMPV1 || "").replace(/\D/g, "") };
          for (let k = 2; k <= 12; k++) { const v = x["TMPV" + k]; if (v != null && v !== "") o["v" + k] = Number(String(v).replace(/,/g, "")); }
          return o;
        }).filter(o => /^\d{8}$/.test(o.date)).sort((a, b) => b.date.localeCompare(a.date));
      };
      const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= Math.max(Math.abs(b) * tol, 1);
      const out = { status: "ok", credit: null, fund: null, notes: [] };
      // ① 신용거래융자: v2 = 합계, v3 + v4 = 유가증권 + 코스닥 (합이 맞으면 시장별 이름도 붙임)
      try {
        const rows = await freesis("STATSCU0100000070BO");
        if (rows.length) {
          const split = rows.slice(0, 5).every(r => near(r.v3 + r.v4, r.v2, 0.002));
          out.credit = rows.map(r => ({ date: r.date, total: r.v2, kospi: split ? r.v3 : null, kosdaq: split ? r.v4 : null }));
          if (!split) out.notes.push("신용융자 시장별 열 확인 안 됨 → 합계만 표시");
        }
      } catch (e) { out.notes.push("신용융자: " + String(e.message).slice(0, 50)); }
      // ② 증시자금추이: [예탁금, 파생예수금, RP, 미수금, 반대매매, 반대매매 비중%] 순서로 추정 → 비중 검산
      try {
        const rows = await freesis("STATSCU0100000060BO");
        if (rows.length) {
          // 어떤 열 조합이 '반대매매 ÷ 미수금 × 100 = 비중(%)' 을 만족하는지 찾기
          let pick = null;
          const keys = Object.keys(rows[0]).filter(k => k !== "date");
          for (const m of keys) for (const f of keys) for (const pc of keys) {
            if (m === f || f === pc || m === pc || pick) continue;
            const ok = rows.slice(0, 5).filter(r => r[m] > 0).every(r => near(r[f] / r[m] * 100, r[pc], 0.02) && r[pc] < 100 && r[f] < r[m]);
            if (ok && rows.slice(0, 5).some(r => r[m] > 0)) pick = { m, f, pc };
          }
          if (pick) out.fund = rows.map(r => ({ date: r.date, deposit: r.v2 ?? null, misu: r[pick.m], forced: r[pick.f], ratio: r[pick.pc] }));
          else out.notes.push("미수금·반대매매 열 검산 실패 → 표시 안 함");
        }
      } catch (e) { out.notes.push("증시자금: " + String(e.message).slice(0, 50)); }
      return res.status(200).json(out);
    }

    // ⭐ 아침 계기판 '한국 시장 체온': /api/closing?market=1
    //    코스피 일별 약 330거래일 (200일선 그래프·7거래일 등락) + VKOSPI(코스피200 변동성지수) 현재값
    if (qv("market")) {
      const rows = [];
      let end = today;
      for (let k = 0; k < 10 && rows.length < 330; k++) {   // 120일 그래프에 200일선을 끝까지 그리려면 약 320일
        const start = kstYmd(new Date(Date.UTC(+end.slice(0,4), +end.slice(4,6) - 1, +end.slice(6)) - 150 * 86400e3));
        let d;
        try {
          d = await kis("/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice", "FHKUP03500100",
            { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: "0001", FID_INPUT_DATE_1: start, FID_INPUT_DATE_2: end, FID_PERIOD_DIV_CODE: "D" }, auth);
        } catch (e) { break; }
        const got = (d.output2 || []).filter(x => x.stck_bsop_date && num(x.bstp_nmix_prpr))
          .map(x => ({ date: x.stck_bsop_date, close: num(x.bstp_nmix_prpr), high: num(x.bstp_nmix_hgpr), low: num(x.bstp_nmix_lwpr) }));
        const fresh = got.filter(x => !rows.some(r => r.date === x.date));
        if (!fresh.length) break;
        rows.push(...fresh);
        const oldest = fresh.map(x => x.date).sort()[0];
        end = kstYmd(new Date(Date.UTC(+oldest.slice(0,4), +oldest.slice(4,6) - 1, +oldest.slice(6)) - 86400e3 - 9 * 3600e3 + 9 * 3600e3));
        await sleep(120);
      }
      rows.sort((a, b) => b.date.localeCompare(a.date));
      // 오늘 장중이면 현재 지수도 맨 앞에
      let now = null;
      try {
        const m = await kis("/uapi/domestic-stock/v1/quotations/inquire-index-price", "FHPUP02100000",
          { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: "0001" }, auth);
        now = { value: num(m.output.bstp_nmix_prpr), change: num(m.output.bstp_nmix_prdy_ctrt) };
      } catch (e) {}
      let vkospi = null;
      try { vkospi = await getVkospi(auth); } catch (e) { vkospi = { error: String(e.message).slice(0, 60) }; }
      return res.status(200).json({ status: "ok", rows, now, vkospi });
    }

    // ⭐ 코스피 일별 지수 (시장 대비 강도 계산용): /api/closing?index=0001
    if (/^\d{4}$/.test(qv("index"))) {
      const d = await kis("/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice", "FHKUP03500100",
        { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: qv("index"), FID_INPUT_DATE_1: from, FID_INPUT_DATE_2: today,
          FID_PERIOD_DIV_CODE: "D" }, auth);
      const rows = (d.output2 || []).filter(x => x.stck_bsop_date && num(x.bstp_nmix_prpr))
        .map(x => ({ date: x.stck_bsop_date, close: num(x.bstp_nmix_prpr) }))
        .sort((a, b) => b.date.localeCompare(a.date));
      return res.status(200).json({ status: "ok", rows });
    }

    // ⭐ 투자자별 매매: /api/closing?investor=005930
    if (/^\d{6}$/.test(qv("investor"))) {
      const d = await kis("/uapi/domestic-stock/v1/quotations/inquire-investor", "FHKST01010900",
        { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: qv("investor") }, auth);
      const rows = (d.output || []).slice(0, 5).map(x => ({ date: x.stck_bsop_date,
        person: num(x.prsn_ntby_qty), foreign: num(x.frgn_ntby_qty), inst: num(x.orgn_ntby_qty) }));
      return res.status(200).json({ status: "ok", rows });
    }

    // ⭐ 관심종목 현재가: /api/closing?codes=005930,000660  (&after=1 이면 NXT 애프터마켓 가격도)
    if (qv("codes")) {
      const codes = qv("codes").split(",").filter(c => /^\d{6}$/.test(c)).slice(0, 20);
      const out = {}, errs = {};
      const queue = [...codes];
      const worker = async () => {
        while (queue.length) {
          const code = queue.shift();
          try {
            const o = (await kis("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100",
              { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code }, auth)).output;
            out[code] = { price: num(o.stck_prpr), change: num(o.prdy_ctrt), open: num(o.stck_oprc),
              high: num(o.stck_hgpr), low: num(o.stck_lwpr), prev: num(o.stck_sdpr), vol: num(o.acml_vol),
              w52low: num(o.w52_lwpr), w52high: num(o.w52_hgpr), foreign: num(o.frgn_ntby_qty) };
          } catch (e) { const m = String(e.message).slice(0, 60); errs[m] = (errs[m] || 0) + 1; }
          await sleep(180);
        }
      };
      await Promise.all([worker(), worker()]);
      let after = null;
      if (qv("after") === "1") {
        try {
          const nx = await multiQuote(codes, "NX", auth);
          after = {};
          Object.entries(nx).forEach(([c, q]) => {
            const krx = out[c] && out[c].price;
            after[c] = { price: q.price, vsClose: krx ? +(((q.price / krx) - 1) * 100).toFixed(2) : null };
          });
        } catch (e) { errs["애프터마켓: " + String(e.message).slice(0, 40)] = 1; }
      }
      return res.status(200).json({ status: "ok", quotes: out, after, errors: errs });
    }

    const t0 = Date.now();
    const errs = {};
    const note = e => { const m = String(e.message || e).slice(0, 60); errs[m] = (errs[m] || 0) + 1; };

    // ── 0단계 · 시장 필터 ──
    const idx = async (code, name) => {
      try {
        const m = await kis("/uapi/domestic-stock/v1/quotations/inquire-index-price", "FHPUP02100000",
          { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: code }, auth);
        return { name, value: num(m.output.bstp_nmix_prpr), change: num(m.output.bstp_nmix_prdy_ctrt) };
      } catch (e) { note(e); return null; }
    };
    const market = await idx("0001", "코스피");
    await sleep(120);
    const kosdaq = await idx("1001", "코스닥");

    // ── 1단계 · 후보 모으기: 거래대금 상위(코스피·코스닥) ──
    const pool = new Map();
    const rankInfo = {};   // 시장별로 몇 개 받았는지 / 왜 실패했는지 (화면에 표시)
    const rank = async (iscd, label) => {
      try {
        const d = await kis("/uapi/domestic-stock/v1/quotations/volume-rank", "FHPST01710000", {
          FID_COND_MRKT_DIV_CODE: "J", FID_COND_SCR_DIV_CODE: "20171", FID_INPUT_ISCD: iscd,
          FID_DIV_CLS_CODE: "0", FID_BLNG_CLS_CODE: "3", FID_TRGT_CLS_CODE: "111111111",
          FID_TRGT_EXLS_CLS_CODE: "0000000000", FID_INPUT_PRICE_1: "", FID_INPUT_PRICE_2: "",
          FID_VOL_CNT: "", FID_INPUT_DATE_1: "" }, auth);
        let n = 0;
        (Array.isArray(d.output) ? d.output : []).forEach(x => {
          const code = x.mksc_shrn_iscd || x.stck_shrn_iscd;
          if (!/^\d{6}$/.test(code || "")) return;
          pool.set(code, { code, name: x.hts_kor_isnm, price: num(x.stck_prpr), change: num(x.prdy_ctrt),
            amount: num(x.acml_tr_pbmn), vol: num(x.acml_vol) });
          n++;
        });
        rankInfo[label] = n ? n : "0개 (빈 응답)";
      } catch (e) { rankInfo[label] = "실패: " + String(e.message).slice(0, 40); }
    };
    await sleep(120);
    await rank("0001", "코스피");      // 하나가 실패해도 나머지는 따로 시도
    await sleep(150);
    await rank("1001", "코스닥");
    const rankCount = pool.size;

    // 우량주 목록 중 순위에 없는 종목 → 한 번에 30종목씩 조회 (42개 = 2번)
    const universeMissing = UNIVERSE.filter(([c]) => !pool.has(c));
    let skipped = 0, uniMode = "multi";
    try {
      const mq = await multiQuote(universeMissing.map(([c]) => c), "J", auth);
      universeMissing.forEach(([code, name]) => { if (mq[code]) pool.set(code, { code, ...mq[code], name }); });
    } catch (e) {
      note(e); uniMode = "single";
    }

    const quote = async (code) => {
      const o = (await kis("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100",
        { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code }, auth)).output;
      return { price: num(o.stck_prpr), change: num(o.prdy_ctrt), amount: num(o.acml_tr_pbmn), vol: num(o.acml_vol),
        high: num(o.stck_hgpr), low: num(o.stck_lwpr), open: num(o.stck_oprc), prev: num(o.stck_sdpr),
        foreign: num(o.frgn_ntby_qty), warn: !!(o.mrkt_warn_cls_code && o.mrkt_warn_cls_code !== "00") };
    };
    const runPool = async (items, fn, workers, budget) => {
      const q = [...items];
      const w = async () => { while (q.length && Date.now() - t0 < budget) { const it = q.shift();
        try { await fn(it); } catch (e) { note(e); } await sleep(150); } };
      await Promise.all(Array.from({ length: workers }, w));
      return q.length;   // 시간 부족으로 못 본 개수
    };
    // 한꺼번에 조회가 안 되면 예전처럼 하나씩 (시간 예산 안에서)
    if (uniMode === "single") {
      skipped += await runPool(universeMissing, async ([code, name]) => {
        pool.set(code, { code, name, ...(await quote(code)), detailed: true });
      }, 3, 4500);
    }

    const all = [...pool.values()].filter(x => x.change != null);
    const stage1 = all.filter(x => x.change <= RULE.dropMin && x.change >= RULE.dropMax
                                && (x.amount == null || x.amount >= RULE.minAmount));
    const tooDeep = all.filter(x => x.change < RULE.dropMax && (x.amount == null || x.amount >= RULE.minAmount))
                       .sort((a, b) => a.change - b.change).slice(0, 5)
                       .map(x => ({ code: x.code, name: x.name, change: x.change }));

    // ── 2·3단계 · 1단계 통과 종목만 개별 조회 (고가·저가·외국인·투자경고) ──
    stage1.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    const top = stage1.slice(0, 15);
    skipped += await runPool(top.filter(x => !x.detailed), async (x) => {
      Object.assign(x, await quote(x.code), { detailed: true });
    }, 2, 8000);

    const mkt = market && market.change != null ? market.change : 0;
    for (const x of top) {
      // 2단계 · 회복력
      if (x.prev && x.low != null && x.low < x.prev) x.recovery = +(((x.price - x.low) / (x.prev - x.low))).toFixed(2);
      if (x.high != null && x.low != null && x.high > x.low) x.position = +(((x.price - x.low) / (x.high - x.low))).toFixed(2);
      // 3단계 · 수급 점수
      let score = 0; const why3 = [];
      if (x.foreign != null) { if (x.foreign > 0) { score++; why3.push("외국인 순매수"); } else if (x.foreign < 0) { score--; why3.push("외국인 순매도"); } }
      const rel = +(x.change - mkt).toFixed(2); x.relMarket = rel;
      if (rel >= RULE.relGood) { score++; why3.push("시장만큼만 빠짐"); } else if (rel <= RULE.relBad) { score--; why3.push("시장보다 많이 빠짐(개별 악재 가능)"); }
      x.score = score; x.why3 = why3;
      // 신호
      const why = [];
      let sig;
      if (x.warn) { sig = "red"; why.push("투자경고·주의 종목"); }
      else if (x.recovery == null) { sig = "gray"; why.push("장중 저점 정보 없음"); }
      else if (x.recovery < RULE.recWeak) { sig = "gray"; why.push("아직 저점 근처 (회복 없음)"); }
      else if (x.recovery >= RULE.recGood && (x.position == null || x.position >= RULE.posGood) && score >= 0) { sig = "green"; why.push("저점에서 회복 중"); }
      else { sig = "yellow"; why.push(x.recovery >= RULE.recGood ? "회복은 했지만 수급이 약함" : "회복이 아직 약함"); }
      if (!x.detailed) why.push("세부 확인 못 함");
      x.signal = sig; x.why = why;
    }
    const rk = { green: 0, yellow: 1, gray: 2, red: 3 };
    top.sort((a, b) => rk[a.signal] - rk[b.signal] || b.score - a.score || (b.recovery || 0) - (a.recovery || 0));

    res.status(200).json({
      status: "ok", asOf: new Date().toISOString(),
      source: rankCount >= 10 ? "rank" : "universe", rankInfo, rankCount, uniMode,
      market, kosdaq, marketStop: market && market.change != null && market.change <= RULE.marketStop,
      scanned: all.length, stage1Count: stage1.length, skipped,
      candidates: top.map(x => ({ code: x.code, name: x.name, price: x.price, change: x.change, amount: x.amount,
        high: x.high, low: x.low, prev: x.prev, recovery: x.recovery, position: x.position, foreign: x.foreign,
        relMarket: x.relMarket, score: x.score, why3: x.why3, signal: x.signal, why: x.why })),
      tooDeep, rule: RULE, errors: errs, ms: Date.now() - t0,
    });
  } catch (e) {
    res.status(200).json({ status: "error", message: String(e.message || e) });
  }
};
