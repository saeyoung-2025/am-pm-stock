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

// 선별 기준
const RULE = {
  scanDrop: -3,     // 이 이하로 빠진 종목만 상세 확인
  minDrop: -5,      // 후보 하한 (−5% 이하)
  maxDrop: -15,     // 이보다 더 빠지면 제외 (급락 위험)
  volGood: 1.5,     // 거래량 20일 평균 대비 1.5배 이상이면 좋음
  volHot: 5,        // 5배 이상이면 과열 주의
  marketStop: -1.5, // 코스피 −1.5% 이하면 '쉬는 날' 권장
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
  if (!j.access_token) throw new Error("토큰 발급 실패: " + (j.error_description || j.msg1 || r.status));
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
  const { KIS_APP_KEY: key, KIS_APP_SECRET: secret, APP_PASSWORD: pass } = process.env;

  if (!key || !secret) return res.status(200).json({ status: "not_configured" });
  if (pass && req.headers["x-app-password"] !== pass) return res.status(401).json({ status: "unauthorized" });

  try {
    const auth = { key, secret, token: await getToken(key, secret) };

    // 1) 코스피 지수
    let market = null;
    try {
      const m = await kis("/uapi/domestic-stock/v1/quotations/inquire-index-price", "FHPUP02100000",
        { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: "0001" }, auth);
      market = { name: "코스피", value: num(m.output.bstp_nmix_prpr), change: num(m.output.bstp_nmix_prdy_ctrt) };
    } catch (e) { market = null; }

    // 2) 관심 우량주 현재가 (초당 호출 제한 때문에 8개씩 나눠서)
    const quotes = [];
    for (let i = 0; i < UNIVERSE.length; i += 8) {
      const batch = UNIVERSE.slice(i, i + 8);
      const got = await Promise.all(batch.map(async ([code, name]) => {
        try {
          const q = await kis("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100",
            { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code }, auth);
          const o = q.output;
          return { code, name, price: num(o.stck_prpr), change: num(o.prdy_ctrt), volume: num(o.acml_vol),
                   warn: o.mrkt_warn_cls_code && o.mrkt_warn_cls_code !== "00" };
        } catch (e) { return { code, name, error: true }; }
      }));
      quotes.push(...got);
      await sleep(450);
    }

    // 3) 많이 빠진 종목만 일봉으로 20일선·평균거래량 확인
    const dropped = quotes.filter(q => !q.error && q.change !== null && q.change <= RULE.scanDrop);
    for (const q of dropped) {
      try {
        const d = await kis("/uapi/domestic-stock/v1/quotations/inquire-daily-price", "FHKST01010400",
          { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: q.code, FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "1" }, auth);
        const past = (d.output || []).slice(1, 21); // 오늘 제외 최근 20거래일
        if (past.length >= 10) {
          const ma20 = past.reduce((s, x) => s + num(x.stck_clpr), 0) / past.length;
          const avgVol = past.reduce((s, x) => s + num(x.acml_vol), 0) / past.length;
          q.ma20Gap = +(((q.price / ma20) - 1) * 100).toFixed(2);
          q.volRatio = avgVol ? +(q.volume / avgVol).toFixed(2) : null;
        }
      } catch (e) { /* 일봉 실패 시 해당 값만 비움 */ }
      await sleep(120);
    }

    // 4) 신호등
    for (const q of dropped) {
      const why = [];
      let sig = "green";
      if (q.warn) { sig = "red"; why.push("투자경고·주의 종목"); }
      if (q.change < RULE.maxDrop) { sig = "red"; why.push(`${RULE.maxDrop}% 넘는 급락`); }
      if (q.change > RULE.minDrop) { sig = sig === "red" ? sig : "gray"; why.push(`하락폭 ${RULE.minDrop}% 미만`); }
      if (q.volRatio !== undefined && q.volRatio !== null) {
        if (q.volRatio >= RULE.volHot) { if (sig === "green") sig = "yellow"; why.push(`거래량 ${q.volRatio}배 과열`); }
        else if (q.volRatio < RULE.volGood) { if (sig === "green") sig = "yellow"; why.push(`거래량 약함(${q.volRatio}배)`); }
      } else { if (sig === "green") sig = "yellow"; why.push("거래량 정보 없음"); }
      if (q.ma20Gap !== undefined && q.ma20Gap !== null && q.ma20Gap < -5) {
        if (sig === "green") sig = "yellow"; why.push("20일선 크게 이탈");
      }
      q.signal = sig;
      q.why = why;
    }

    const rank = { green: 0, yellow: 1, red: 2, gray: 3 };
    dropped.sort((a, b) => rank[a.signal] - rank[b.signal] || a.change - b.change);

    res.status(200).json({
      status: "ok",
      asOf: new Date().toISOString(),
      market,
      marketStop: market && market.change !== null && market.change <= RULE.marketStop,
      scanned: quotes.filter(q => !q.error).length,
      total: UNIVERSE.length,
      candidates: dropped,
      rule: RULE,
    });
  } catch (e) {
    res.status(200).json({ status: "error", message: String(e.message || e) });
  }
};
