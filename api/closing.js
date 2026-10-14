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
