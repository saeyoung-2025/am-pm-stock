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

// 선별 기준 (0~4단계)
const RULE = {
  marketStop: -1.5,   // 0단계: 코스피가 이 이하면 '쉬는 날'
  dropMin: -2,        // 1단계: 오늘 −2% 이하로 빠졌고
  dropMax: -7,        //        −7%보다는 덜 빠진 종목 (그보다 깊으면 '과대 급락'으로 제외)
  minAmount: 200e8,   //        거래대금 200억 원 이상
  recGood: 0.5,       // 2단계: 저점에서 빠진 폭의 50% 이상 회복하면 좋음
  recWeak: 0.2,       //        20% 미만이면 '아직 저점 근처'
  posGood: 0.5,       //        오늘 고가~저가 중 위쪽 절반에 있으면 좋음
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

async function kis(path, trId, params, auth) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const r = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${auth.token}`,
      appkey: auth.key, appsecret: auth.secret, tr_id: trId, custtype: "P",
    },
  });
  const j = await r.json();
  if (j.rt_cd !== "0") throw new Error(j.msg1 || "조회 실패");
  return j;
}

const num = v => (v === undefined || v === null || v === "" ? null : Number(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const clean = v => (v || "").replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, "");
  const key = clean(process.env.KIS_APP_KEY);
  const secret = clean(process.env.KIS_APP_SECRET);
  const pass = (process.env.APP_PASSWORD || "").trim();

  if (!key || !secret) return res.status(200).json({ status: "not_configured" });
  if (pass && (req.headers["x-app-password"] || "").trim() !== pass) return res.status(401).json({ status: "unauthorized" });

  try {
    const auth = { key, secret, token: await getToken(key, secret) };

    const qv = k => (req.query && req.query[k]) ? String(req.query[k]) : "";

    // ⭐ 일봉 30일: /api/closing?daily=005930
    if (/^\d{6}$/.test(qv("daily"))) {
      const d = await kis("/uapi/domestic-stock/v1/quotations/inquire-daily-price", "FHKST01010400",
        { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: qv("daily"), FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "1" }, auth);
      const rows = (d.output || []).map(x => ({ date: x.stck_bsop_date, open: num(x.stck_oprc), high: num(x.stck_hgpr),
        low: num(x.stck_lwpr), close: num(x.stck_clpr), vol: num(x.acml_vol) }));
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

    // ⭐ 관심종목 현재가: /api/closing?codes=005930,000660
    if (qv("codes")) {
      const codes = qv("codes").split(",").filter(c => /^\d{6}$/.test(c)).slice(0, 20);
      const out = {}, errs = {};
      const queue = [...codes];
      const worker = async () => {
        while (queue.length) {
          const code = queue.shift();
          for (let t = 0; t < 2; t++) {
            try {
              const o = (await kis("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100",
                { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code }, auth)).output;
              out[code] = { price: num(o.stck_prpr), change: num(o.prdy_ctrt), open: num(o.stck_oprc),
                high: num(o.stck_hgpr), low: num(o.stck_lwpr), prev: num(o.stck_sdpr), vol: num(o.acml_vol),
                w52low: num(o.w52_lwpr), w52high: num(o.w52_hgpr), foreign: num(o.frgn_ntby_qty) };
              break;
            } catch (e) { const m = String(e.message).slice(0, 60); errs[m] = (errs[m] || 0) + 1; await sleep(400); }
          }
          await sleep(180);
        }
      };
      await Promise.all([worker(), worker()]);
      return res.status(200).json({ status: "ok", quotes: out, errors: errs });
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
    await sleep(150);
    const kosdaq = await idx("1001", "코스닥");

    // ── 1단계 · 후보 모으기: 거래대금 상위(코스피·코스닥) = 사람들이 많이 거래하는 종목 ──
    let pool = new Map(), source = "rank";
    const rank = async (iscd) => {
      const d = await kis("/uapi/domestic-stock/v1/quotations/volume-rank", "FHPST01710000", {
        FID_COND_MRKT_DIV_CODE: "J", FID_COND_SCR_DIV_CODE: "20171", FID_INPUT_ISCD: iscd,
        FID_DIV_CLS_CODE: "0", FID_BLNG_CLS_CODE: "3", FID_TRGT_CLS_CODE: "111111111",
        FID_TRGT_EXLS_CLS_CODE: "0000000000", FID_INPUT_PRICE_1: "", FID_INPUT_PRICE_2: "",
        FID_VOL_CNT: "", FID_INPUT_DATE_1: "" }, auth);
      (d.output || []).forEach(x => {
        const code = x.mksc_shrn_iscd || x.stck_shrn_iscd;
        if (!/^\d{6}$/.test(code || "")) return;
        pool.set(code, { code, name: x.hts_kor_isnm, price: num(x.stck_prpr), change: num(x.prdy_ctrt),
          amount: num(x.acml_tr_pbmn), vol: num(x.acml_vol) });
      });
    };
    try { await rank("0001"); await sleep(200); await rank("1001"); }
    catch (e) { note(e); }
    // 우리 우량주 목록도 함께 (순위 조회가 안 되면 이것만으로)
    if (pool.size < 10) source = "universe";
    const universeMissing = UNIVERSE.filter(([c]) => !pool.has(c));

    // 우량주 목록 중 순위에 없는 종목은 현재가로 확인 (시간 예산 안에서)
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
        try { await fn(it); } catch (e) { note(e); } await sleep(200); } };
      await Promise.all(Array.from({ length: workers }, w));
      return q.length;   // 시간 부족으로 못 본 개수
    };
    let skipped = await runPool(universeMissing, async ([code, name]) => {
      pool.set(code, { code, name, ...(await quote(code)), detailed: true });
    }, 3, 4500);

    const all = [...pool.values()].filter(x => x.change != null);
    const stage1 = all.filter(x => x.change <= RULE.dropMin && x.change >= RULE.dropMax
                                && (x.amount == null || x.amount >= RULE.minAmount));
    const tooDeep = all.filter(x => x.change < RULE.dropMax && (x.amount == null || x.amount >= RULE.minAmount))
                       .sort((a, b) => a.change - b.change).slice(0, 5)
                       .map(x => ({ code: x.code, name: x.name, change: x.change }));

    // ── 2·3단계 · 1단계 통과 종목만 장중 고가·저가·외국인 확인 ──
    stage1.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    const top = stage1.slice(0, 15);
    skipped += await runPool(top.filter(x => !x.detailed), async (x) => {
      Object.assign(x, await quote(x.code), { detailed: true });
    }, 2, 7500);

    const mkt = market && market.change != null ? market.change : 0;
    for (const x of top) {
      // 2단계 · 회복력
      if (x.prev && x.low != null && x.low < x.prev) x.recovery = +(((x.price - x.low) / (x.prev - x.low))).toFixed(2);
      if (x.high != null && x.low != null && x.high > x.low) x.position = +(((x.price - x.low) / (x.high - x.low))).toFixed(2);
      // 3단계 · 수급 점수
      let score = 0; const why3 = [];
      if (x.foreign != null) { if (x.foreign > 0) { score++; why3.push("외국인 순매수"); } else if (x.foreign < 0) { score--; why3.push("외국인 순매도"); } }
      const rel = +(x.change - mkt).toFixed(2); x.relMarket = rel;
      if (rel >= -1) { score++; why3.push("시장만큼만 빠짐"); } else if (rel <= -4) { score--; why3.push("시장보다 많이 빠짐(개별 악재 가능)"); }
      x.score = score; x.why3 = why3;
      // 신호
      const why = [];
      let sig;
      if (x.warn) { sig = "red"; why.push("투자경고·주의 종목"); }
      else if (x.recovery == null) { sig = "gray"; why.push("장중 저점 정보 없음"); }
      else if (x.recovery < RULE.recWeak) { sig = "gray"; why.push("아직 저점 근처 (회복 없음)"); }
      else if (x.recovery >= RULE.recGood && (x.position == null || x.position >= RULE.posGood) && score >= 0) { sig = "green"; why.push("저점에서 회복 중"); }
      else { sig = "yellow"; why.push(x.recovery >= RULE.recGood ? "회복은 했지만 수급이 약함" : "회복이 아직 약함"); }
      x.signal = sig; x.why = why;
    }
    const rk = { green: 0, yellow: 1, gray: 2, red: 3 };
    top.sort((a, b) => rk[a.signal] - rk[b.signal] || b.score - a.score || (b.recovery || 0) - (a.recovery || 0));

    res.status(200).json({
      status: "ok", asOf: new Date().toISOString(), source,
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
