// 网络信息.js
// 面板显示：本地 / 入口 / 落地 三段 IP 信息
// 架构：配置 → 请求 → 智能格式化 → 查询 → 入口识别 → 缓存 → 渲染 → 主流程

!(async () => {

  // ══════════════════════════════════════════════════════
  //  CONFIG  配置区
  //  所有可调参数集中在此，方便日后修改
  // ══════════════════════════════════════════════════════
  const CFG = {
    // 直连请求超时（秒）。调高可以减少弱网下多源同时超时的概率
    T_DIRECT:  5,
    // 代理请求超时（秒）。落地查询走代理，适当给长些
    T_PROXY:   5,
    // 探测请求超时（秒），用于显示直连 / 代理体感耗时
    T_PROBE:   3,
    // 轻量探测地址：只用来估算 HTTP 访问耗时，不参与 IP 信息判断
    PROBE_URL: 'https://www.apple.com/library/test/success.html',
    // 每个数据源的最大重试次数（正式请求 + RETRIES 次重试）
    RETRIES:   1,
    // 首个数据源成功后，额外等待更优字段的时间（毫秒）
    SMART_GRACE: 900,
    // 查询结果缓存有效期：2.5 秒；配合面板刷新显示近实时延迟
    CACHE_TTL: 2500,
    // 刷新失败时最多沿用 1 小时内的旧结果，避免好面板被空结果覆盖
    STALE_TTL: 3600000,
  };

  // ══════════════════════════════════════════════════════
  //  KEYS  持久化存储键名
  // ══════════════════════════════════════════════════════
  const KEY = {
    CACHE:   'NI_CACHE_V3',    // 面板查询结果缓存
    ENT:     'NI_ENT_V3',      // 上次检测到的入口 IP（用于判断节点是否切换）
  };

  // ══════════════════════════════════════════════════════
  //  FETCHER  请求层
  //  封装 HTTP 请求、JSON 解析、重试逻辑
  // ══════════════════════════════════════════════════════

  /**
   * 基础 HTTP GET，返回响应体字符串；失败则抛出错误
   */
  const httpGet = opt => new Promise((res, rej) =>
    $httpClient.get(opt, (err, _, body) =>
      err ? rej(new Error(`网络请求失败: ${err}`)) : res(body)
    )
  );

  /**
   * GET + JSON 解析
   * 网络错误或 JSON 解析失败均返回 null（不向上抛错）
   * 这样上层可以用 null 判断"此源不可用"
   *
   * 注意：ip-api.com 免费版仅支持 HTTP，无法改用 HTTPS（服务商限制）
   * 通过第三个本地源（ip.useragentinfo.com）和重试来弥补 HTTP 偶发劫持问题
   */
  const fetchJSON = async (url, opt = {}, timeout = CFG.T_DIRECT) => {
    try {
      const started = Date.now();
      const body = await httpGet({ url, timeout, ...opt });
      return { data: JSON.parse(body), ms: Date.now() - started };
    } catch {
      return null; // 网络错误 / 解析错误 / 内容异常，统一返回 null
    }
  };

  /**
   * 带重试的 JSON 请求
   * 单次失败后等 500ms 再试，最多重试 CFG.RETRIES 次
   * 弱网下单次超时较常见，一次重试可显著提升成功率
   */
  const fetchWithRetry = async (url, opt = {}, timeout = CFG.T_DIRECT) => {
    for (let i = 0; i <= CFG.RETRIES; i++) {
      const result = await fetchJSON(url, opt, timeout);
      if (result !== null) return result;
      if (i < CFG.RETRIES) await new Promise(r => setTimeout(r, 500));
    }
    return null; // 重试耗尽，确认失败
  };

  const smartFetch = (sources, merge, grace = CFG.SMART_GRACE) => new Promise(resolve => {
    const results = [];
    let left = sources.length;
    let done = false;
    let timer = null;

    const latinRE = /[A-Za-z]/;
    const locQuality = info => {
      const loc = String(info?.location || '');
      if (!loc) return 0;
      if (hasCN(loc) && !latinRE.test(loc)) return 3;
      if (hasCN(loc)) return 2;
      return 1;
    };
    const locDepth = info => String(info?.location || '').split(/[ /·]+/).filter(Boolean).length;
    const complete = info => !!(info?.ip && info?.location && info?.isp && info?.asn);
    const ready = info => complete(info) && locQuality(info) >= 2 && (info.countryCode !== 'CN' || locDepth(info) >= 2);

    const finish = force => {
      if (done) return;
      const best = merge(...results);
      if (!best && !force && left > 0) return;
      if (!force && best && !ready(best) && left > 0) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(best || null);
    };

    if (!left) return resolve(null);
    const settled = () => {
      left -= 1;
      if (left === 0) finish(true);
    };
    sources.forEach(([url, parser, opt = {}, timeout = CFG.T_DIRECT]) => {
      fetchWithRetry(url, opt, timeout)
        .then(d => {
          const parsed = d ? parser(d.data) : null;
          if (parsed) {
            parsed.ms = d.ms;
            results.push(parsed);
            if (!timer) timer = setTimeout(() => finish(true), grace);
            finish(false);
          }
          settled();
        })
        .catch(() => {
          settled();
        });
    });
  });

  /**
   * 读取 Surge 本地请求历史记录
   * 用于检测节点变化和提取入口 IP
   */
  const getSurgeReqs = async () => {
    try {
      const { requests = [] } = await new Promise(r => $httpAPI('GET', '/v1/requests/recent', null, r));
      return requests;
    } catch { return []; }
  };

  const probeLatency = async (label, opt = {}) => {
    const started = Date.now();
    try {
      await httpGet({ url: CFG.PROBE_URL, timeout: CFG.T_PROBE, ...opt });
      return { label, ms: Date.now() - started };
    } catch {
      return { label, ms: '' };
    }
  };

  const queryProbe = async () => {
    const [direct, proxy] = await Promise.all([
      probeLatency('direct', { policy: 'DIRECT' }),
      probeLatency('proxy', {}),
    ]);
    return { direct: direct.ms, proxy: proxy.ms };
  };

  // ══════════════════════════════════════════════════════
  //  FORMATTER  格式化层
  //  不再依赖映射库：优先使用数据源中文字段 + Intl 国家名 + 规则化清洗
  // ══════════════════════════════════════════════════════

  const hasCN = s => /[\u4e00-\u9fff]/.test(String(s || ''));

  /**
   * 剥除行政区后缀
   * 例："广东省" → "广东"，"新疆维吾尔自治区" → "新疆"
   * 剥后不足 2 个字则保留原值（防止剥空）
   */
  const SFX_RE = /(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|自治县|地区|盟|省|州|市|区|县)$/;
  const stripSfx = str => {
    const s = String(str || '').trim();
    const m = s.match(SFX_RE);
    if (m) { const c = s.slice(0, -m[0].length).trim(); if (c.length >= 2) return c; }
    return s;
  };

  /**
   * 国家名优先交给 JS 运行时 Intl；不支持时保留国家代码
   */
  const countryName = code => {
    const cc = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return '';
    try {
      return new Intl.DisplayNames(['zh-Hans-CN', 'zh-CN'], { type: 'region' }).of(cc) || cc;
    } catch {
      return cc;
    }
  };

  const countryCodeOf = (code, country = '') => {
    const cc = String(code || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) return cc;
    const s = String(country || '').trim().toLowerCase();
    if (/^(中国|china|cn)$/.test(s)) return 'CN';
    if (/^(香港|hong kong|hk)$/.test(s)) return 'HK';
    if (/^(台湾|taiwan|tw)$/.test(s)) return 'TW';
    if (/^(澳门|macau|macao|mo)$/.test(s)) return 'MO';
    return '';
  };

  const flagOf = code => {
    const cc = countryCodeOf(code);
    if (!cc) return '🏳️';
    return String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  };

  const GEO_ALIAS = {
    shanghai: '上海',
    pudong: '浦东',
    beijing: '北京',
    guangdong: '广东',
    sichuan: '四川',
    chengdu: '成都',
    mianyang: '绵阳',
    'mian yang': '绵阳',
    'mian yang shi': '绵阳',
    tokyo: '东京',
    minamishinagawa: '南品川',
    osaka: '大阪',
    singapore: '新加坡',
    hongkong: '香港',
    'hong kong': '香港',
  };

  const geoName = value => {
    const s = stripSfx(String(value || '').replace(/\bshi\b/ig, '').replace(/\s+/g, ' ').trim());
    if (!s) return '';
    return GEO_ALIAS[s.toLowerCase()] || s;
  };

  const inferGeoFromISP = raw => {
    const s = String(raw || '').toLowerCase();
    if (/oriental\s+cable|东方有线/.test(s)) return { region: '上海', city: '' };
    if (/chinanet\s+sichuan|sctel|四川电信/.test(s)) return { region: '四川', city: '' };
    return {};
  };

  const cleanParts = parts => {
    const seen = new Set();
    return parts
      .map(p => String(p || '').trim())
      .filter(Boolean)
      .filter(p => { if (!p || seen.has(p)) return false; seen.add(p); return true; });
  };

  /**
   * 格式化位置字段
   * - 中国 IP：省 + 市（各自剥除行政区后缀）
   * - 海外 IP：国家 + 城市；数据源若给中文则直接使用，否则保留原文
   */
  const fmtLoc = (cc, country, region, city) => {
    const code = countryCodeOf(cc, country).toLowerCase();
    const tR = geoName(region); // 省/州
    const tC = geoName(city);   // 城市
    const parts = code === 'cn'
      ? [tR, tC]
      : [hasCN(country) ? country : countryName(code) || country || cc,
         tC || tR];
    return cleanParts(parts.filter(Boolean)).join(' ');
  };

  // ISP 格式化时过滤的英语停用词（防止 "of" / "the" / "in" 混入运营商名称）
  const STOP = /^(of|for|and|the|in|at|by|to|a|an|no)$/i;
  const CORP_RE = /\b(Technology|Technologies|Telecommunication|Telecommunications|Communication|Communications|Network|Networks|Internet|Service|Services|Telecom|Limited|Ltd|Corp|Corporation|Inc|Incorporated|Group|Global|International|Holdings|Solutions|Systems|Enterprise|Enterprises|Electric|Electron|Information|Data|Cloud|Digital|Media|Connect|Fiber|Co|Company|LLC|Pte|Pty)\b\.?/gi;
  const ISP_ALIAS = [
    [/china\s+telecom|chinanet|ct\s*net/i, '中国电信'],
    [/china\s+unicom|unicom/i, '中国联通'],
    [/china\s+mobile|cmcc|cmi/i, '中国移动'],
    [/oriental\s+cable|shanghai\s+oriental/i, '东方有线'],
    [/cloudflare/i, 'Cloudflare'],
    [/akamai/i, 'Akamai'],
    [/amazon|aws/i, 'AWS'],
    [/google/i, 'Google'],
    [/microsoft|azure/i, 'Microsoft'],
    [/oracle/i, 'Oracle'],
  ];

  /**
   * 格式化运营商名称
   * 流程：
   *  1. 去掉开头的 ASN 编号（如 "AS12345 ..."）
   *  2. 常见运营商/云厂商用规则归一
   *  3. 未命中则：剥通名 → 去重 → 过滤 ASN/停用词 → 取前 3 词
   */
  const fmtISP = (raw = '') => {
    let s = String(raw || '').replace(/^AS\d+\s*/i, '').trim(); // 去掉 "AS12345" 开头
    if (!s) return '';
    // 去括号 / 逗号 / 多余空格
    const cl  = s.replace(/\s*[\(\（][^\)\）]{0,30}[\)\）]\s*/g, ' ')
                  .replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const hit = ISP_ALIAS.find(([re]) => re.test(cl) || re.test(s));
    if (hit) return hit[1];
    // 未命中：兜底清洗逻辑
    s = cl.replace(CORP_RE, ' ').replace(/\s+/g, ' ').replace(/[,\-.\s]+$/, '').trim();
    const words = [], seen = new Set();
    for (const w of s.split(/\s+/).filter(Boolean)) {
      const wl = w.toLowerCase();
      if (!seen.has(wl)) { seen.add(wl); words.push(w); }
    }
    // 过滤 ASN 编号（如 AS5650）和停用词，最多取 3 个词
    return words.filter(w => !/^AS\d+$/i.test(w) && !STOP.test(w)).slice(0, 3).join(' ');
  };

  /**
   * 格式化 ASN：统一输出 "AS12345" 格式
   * 兼容输入为数字（如 45090）或字符串（如 "AS45090"）两种格式
   */
  const fmtASN = raw => {
    if (raw == null || raw === '') return '';
    const s = String(raw).trim();
    const m = s.match(/\b(AS\d+)\b/i);
    if (m) return m[1].toUpperCase();      // "AS45090" 或 "as45090 ..." → "AS45090"
    return /^\d+$/.test(s) ? `AS${s}` : ''; // 纯数字 → 补前缀
  };

  // ══════════════════════════════════════════════════════
  //  PARSER  解析层
  //  将各数据源的原始 JSON 转成统一的 {ip, location, isp, asn}
  //  每个解析函数：成功返回对象，失败（字段缺失/格式不符）返回 null
  // ══════════════════════════════════════════════════════

  /**
   * 解析 myip.ipip.net/json
   * 强项：精确到市级的中文地名，中文运营商名
   * 弱项：不提供 ASN
   */
  const parseIPIP = d => {
    if (d?.ret !== 'ok' || !d.data?.ip) return null;
    const L = d.data.location || [];
    const country = L[0] || '';
    const region = geoName(L[1] || '');
    const city = geoName(L[2] || '');
    // L[0]=国家, L[1]=省, L[2]=市, L[3]=运营商, L[4]=邮编, L[5]=时区 ...
    return {
      ip:       d.data.ip,
      countryCode: countryCodeOf('', country),
      country:  hasCN(country) ? country : countryName(countryCodeOf('', country)) || country,
      region,
      city,
      location: cleanParts([region, city].filter(Boolean)).join(' '),
      isp:      fmtISP(L[3] || ''),
      asn:      '', // IPIP 不提供 ASN
    };
  };

  /**
   * 解析 ip-api.com/json
   * 强项：提供 ASN，国际覆盖好
   * 弱项：免费版仅 HTTP（无法规避运营商偶发劫持），通过重试和第三源补偿
   */
  const parseIPAPI = d => {
    if (d?.status !== 'success') return null;
    const countryCode = countryCodeOf(d.countryCode, d.country);
    const rawISP = `${d.isp || ''} ${d.org || ''} ${d.asname || ''} ${d.as || ''}`;
    const isp = fmtISP(rawISP);
    const inferred = inferGeoFromISP(rawISP);
    const region = geoName(d.regionName || inferred.region || '');
    const city = geoName(d.city || inferred.city || '');
    return {
      ip:       d.query || '',
      countryCode,
      country:  hasCN(d.country) ? d.country : countryName(countryCode) || d.country || '',
      region,
      city,
      location: fmtLoc(d.countryCode, d.country, region, city),
      isp,
      asn:      fmtASN((d.as || '').match(/\b(AS\d+)\b/i)?.[1]),
    };
  };

  /**
   * 解析 ip.useragentinfo.com/json
   * 定位：国内备用直连源，HTTPS，直接返回中文，弥补 ip-api 被劫持时的缺口
   * 弱项：不提供 ASN
   * 响应格式：{ ip, country, province, city, district, isp, net }
   */
  const parseUAI = d => {
    if (!d?.ip) return null;
    const province = d.province ? geoName(d.province) : '';
    const city     = d.city     ? geoName(d.city)     : '';
    const countryCode = countryCodeOf('', d.country || '中国');
    return {
      ip:       d.ip,
      countryCode,
      country:  hasCN(d.country) ? d.country : countryName(countryCode),
      region:   province,
      city,
      location: cleanParts([province, city].filter(Boolean)).join(' '),
      isp:      fmtISP(d.isp || d.net || ''), // isp 字段比 net 更完整
      asn:      '', // 此源不提供 ASN
    };
  };

  /**
   * 解析 api-ipv4.ip.sb/geoip（或 /geoip/<ip>）
   * 强项：HTTPS，提供 ASN，国际覆盖好
   * 用途：落地 IP 查询（通过代理）、入口 IP 详情（直连）
   */
  const parseIPSB = d => {
    if (!d?.ip) return null;
    const countryCode = countryCodeOf(d.country_code, d.country);
    const rawISP = `${d.isp || ''} ${d.organization || ''} ${d.asn_organization || ''}`;
    const inferred = inferGeoFromISP(rawISP);
    const region = geoName(d.region || inferred.region || '');
    const city = geoName(d.city || inferred.city || '');
    return {
      ip:       d.ip,
      countryCode,
      country:  hasCN(d.country) ? d.country : countryName(countryCode) || d.country || '',
      region,
      city,
      location: fmtLoc(d.country_code, d.country, region, city),
      isp:      fmtISP(rawISP),
      asn:      fmtASN(d.asn),
    };
  };

  /**
   * 解析 ipwho.is
   * 强项：HTTPS，能同时给出城市、ASN、运营商；对入口 IP 补城市很有用
   * 响应格式：{ ip, success, country, country_code, region, city, connection:{ asn, org, isp } }
   */
  const parseIPWHO = d => {
    if (!d?.success || !d.ip) return null;
    const countryCode = countryCodeOf(d.country_code, d.country);
    const conn = d.connection || {};
    const rawISP = `${conn.org || ''} ${conn.isp || ''}`;
    const inferred = inferGeoFromISP(rawISP);
    const region = geoName(d.region || inferred.region || '');
    const city = geoName(d.city || inferred.city || '');
    return {
      ip:       d.ip,
      countryCode,
      country:  hasCN(d.country) ? d.country : countryName(countryCode) || d.country || '',
      region,
      city,
      location: fmtLoc(d.country_code, d.country, region, city),
      isp:      fmtISP(rawISP),
      asn:      fmtASN(conn.asn),
    };
  };

  /**
   * 解析 ipinfo.io/json
   * 用途：落地 IP 查询（ip.sb 失败时的降级）
   * 响应格式：{ ip, country, region, city, org("AS12345 ISP名") }
   */
  const parseIPInfo = d => {
    if (!d?.ip) return null;
    const countryCode = countryCodeOf(d.country, '');
    return {
      ip:       d.ip,
      countryCode,
      country:  countryName(countryCode),
      region:   geoName(d.region || ''),
      city:     geoName(d.city || ''),
      location: fmtLoc(d.country, '', d.region, d.city),
      isp:      fmtISP(d.org || ''),
      asn:      fmtASN((d.org || '').match(/^AS\d+/i)?.[0]),
    };
  };

  const mergeInfo = (...items) => {
    const list = items.filter(Boolean);
    if (!list.length) return null;
    const pick = key => list.find(x => x?.[key])?.[key] || '';
    const locationScore = loc => {
      const s = String(loc || '');
      if (!s) return 0;
      const depth = s.split(/[ /·]+/).filter(Boolean).length;
      return (hasCN(s) ? 100 : 0) + depth * 10 + Math.min([...s].length, 20);
    };
    const bestLocation = () => {
      const locs = list.map(x => x?.location).filter(Boolean);
      return locs.sort((a, b) => locationScore(b) - locationScore(a))[0] || '';
    };
    const ip = pick('ip');
    const times = list.map(x => x?.ms).filter(n => Number.isFinite(n) && n >= 0);
    const ms = times.length ? Math.max(...times) : NaN;
    if (!ip) return null;
    return {
      ip,
      countryCode: pick('countryCode'),
      country:  pick('country'),
      region:   pick('region'),
      city:     pick('city'),
      location: bestLocation(),
      isp:      pick('isp'),
      asn:      pick('asn'),
      ms:       Number.isFinite(ms) ? ms : '',
    };
  };

  // ══════════════════════════════════════════════════════
  //  QUERY  查询层
  //  三个核心查询：本地 IP / 落地 IP / 入口 IP 详情
  // ══════════════════════════════════════════════════════

  /**
   * 查询本地 IP（全部走直连，policy: 'DIRECT'）
   *
   * 使用多个并发来源，解决原来两源同时失败导致本地信息缺失的问题：
   *   源 A — myip.ipip.net  → 精确中文地名 + 中文运营商（无 ASN）
   *   源 B — ip-api.com     → ASN + 国际地名（免费版 HTTP，偶尔被劫持）
   *   源 C — ip.useragentinfo.com → 中文备用源，HTTPS，弥补 B 被劫持的情况（无 ASN）
   *   源 D — ip.sb / ipwho.is → HTTPS 补 ASN、城市、运营商
   *
   * 字段级最优合并策略（不是整体二选一）：
   *   ip       → A > B > C（取第一个非空）
   *   location → A > C > B（中文源优先，精确度：A ≥ C > B）
   *   isp      → A > C > B（中文源优先，已是中文无需字典翻译）
   *   asn      → B / D 择优；HTTP 源被劫持时仍有 HTTPS 兜底
   *
   * 容错：只要有 1 个来源成功，就能保证至少显示 IP；多个来源会字段级补全
   *        只有所有来源全部失败才返回 null（概率极低）
   */
  async function queryLocal() {
    return smartFetch([
      ['https://myip.ipip.net/json', parseIPIP, { policy: 'DIRECT' }],
      ['http://ip-api.com/json/?lang=zh-CN&fields=status,query,country,countryCode,regionName,city,isp,org,asname,as', parseIPAPI, { policy: 'DIRECT' }],
      ['https://ip.useragentinfo.com/json', parseUAI, { policy: 'DIRECT' }],
      ['https://api-ipv4.ip.sb/geoip', parseIPSB, { policy: 'DIRECT' }],
      ['https://ipwho.is/', parseIPWHO, { policy: 'DIRECT' }],
    ], mergeInfo);
  }

  /**
   * 查询落地 IP（通过代理，不指定 policy 则走 Surge 当前代理规则）
   *
   * 此处 ip.sb / ipinfo.io 都走代理路由，与 queryLocal 的直连查询完全独立
   */
  async function queryLanding() {
    return smartFetch([
      ['http://ip-api.com/json/?lang=zh-CN&fields=status,query,country,countryCode,regionName,city,isp,org,asname,as', parseIPAPI, {}, CFG.T_PROXY],
      ['https://api-ipv4.ip.sb/geoip', parseIPSB, {}, CFG.T_PROXY],
      ['https://ipwho.is/', parseIPWHO, {}, CFG.T_PROXY],
      ['https://ipinfo.io/json', parseIPInfo, {}, CFG.T_PROXY],
    ], mergeInfo);
  }

  /**
   * 查询入口 IP 的位置/运营商信息（直连，因为入口 IP 是代理服务器的公网 IP）
   * ip-api.com / ip.sb 并发查询，优先采用 ip-api 的中文化结果
   */
  async function queryEntranceInfo(ip) {
    const safeIP = encodeURIComponent(ip);
    return smartFetch([
      [`http://ip-api.com/json/${safeIP}?lang=zh-CN&fields=status,query,country,countryCode,regionName,city,isp,org,asname,as`, parseIPAPI, { policy: 'DIRECT' }],
      [`https://api-ipv4.ip.sb/geoip/${safeIP}`, parseIPSB, { policy: 'DIRECT' }],
      [`https://ipwho.is/${safeIP}`, parseIPWHO, { policy: 'DIRECT' }],
    ], mergeInfo);
  }

  // ══════════════════════════════════════════════════════
  //  ENTRANCE  入口 IP 提取工具
  // ══════════════════════════════════════════════════════

  /**
   * 从 Surge 请求记录的 remoteAddress 字段提取纯 IP 地址
   * 原始格式示例："1.2.3.4:443 (Proxy)" 或 "[2001:db8::1]:443 (Proxy)"
   */
  const extractIP = addr => {
    const s = String(addr || '')
      .replace(/\s*\(Proxy\)\s*/gi, '') // 去掉 "(Proxy)" 标记
      .trim();
    const bracket = s.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracket) return bracket[1];
    const ipv4 = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
    if (ipv4) return ipv4[1];
    return (s.match(/:/g) || []).length > 1 ? s : s.replace(/:\d+$/, '');
  };

  const isProxyReq = r => /\(Proxy\)/i.test(r.remoteAddress || '');

  const findProxyIP = (requests, { limit = 100, urlRE = null, excludeIP = '' } = {}) => {
    for (const r of (requests || []).slice(0, limit)) {
      if (!isProxyReq(r)) continue;
      if (urlRE && !urlRE.test(r.URL || '')) continue;
      const ip = extractIP(r.remoteAddress);
      if (ip && ip !== excludeIP) return ip;
    }
    return '';
  };

  // ══════════════════════════════════════════════════════
  //  CACHE  缓存层
  //  结果缓存 30 秒，配合入口 IP 变化检测实现节点变化自动刷新
  //  - 缓存有效且节点未变：直接返回缓存，零网络请求（毫秒级响应）
  //  - 缓存过期或节点变化：触发全量刷新，更新缓存
  // ══════════════════════════════════════════════════════

  const readCache  = () => { try { return JSON.parse($persistentStore.read(KEY.CACHE) || '{}'); } catch { return {}; } };
  const writeCache = o  => { try { $persistentStore.write(JSON.stringify(o), KEY.CACHE); } catch {} };
  const cacheAge   = c  => Date.now() - (c.ts || 0);
  const rawInfo    = o  => o?.info || o;
  const hasInfo    = o  => {
    const v = rawInfo(o);
    return !!(v && (v.ip || v.location || v.isp || v.asn));
  };

  const normalizeInfo = o => {
    const v = rawInfo(o);
    if (!hasInfo(v)) return null;
    return {
      ip:       String(v.ip || '').trim(),
      countryCode: String(v.countryCode || '').trim().toUpperCase(),
      country:  String(v.country || '').trim(),
      region:   String(v.region || '').trim(),
      city:     String(v.city || '').trim(),
      location: String(v.location || '').trim(),
      isp:      String(v.isp || '').trim(),
      asn:      String(v.asn || '').trim(),
      ms:       Number.isFinite(v.ms) ? v.ms : '',
    };
  };

  const pickInfo = (fresh, cached, allowCache) => {
    const live = normalizeInfo(fresh);
    if (live) return { info: live, cached: false };
    const old = allowCache ? normalizeInfo(cached) : null;
    return old ? { info: old, cached: true } : { info: null, cached: false };
  };

  // ══════════════════════════════════════════════════════
  //  UI  渲染层
  //  将 {ip, location, isp, asn} 转成面板显示文本
  // ══════════════════════════════════════════════════════

  const compact = parts => parts.map(v => String(v || '').trim()).filter(Boolean);
  const stateOf = section => section?.cached ? '缓存' : (section?.info ? '实时' : '缺失');
  const clip = (value, max = 30) => {
    const chars = [...String(value || '').trim()];
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
  };
  const compactIP = ip => {
    const s = String(ip || '-').trim();
    return s.includes(':') ? clip(s, 20) : s;
  };
  const fmtMS = value => Number.isFinite(value) ? `${value}ms` : '';
  const queryMSOf = info => Number.isFinite(info?.ms) ? `查${info.ms}ms` : '';
  const regionCityOf = info => {
    const region = info?.region || '';
    const city = info?.city || '';
    if (region && city && region !== city) {
      if (hasCN(city) && !hasCN(region)) return city;
      if (hasCN(region) && !hasCN(city)) return region;
      return `${region}/${city}`;
    }
    return city || region;
  };
  const briefPlaceOf = info => info?.location || compact([info?.country, regionCityOf(info)]).join(' ');
  const routeNode = (label, section, fallbackIP = '') => {
    const info = section?.info || {};
    const flag = flagOf(info.countryCode);
    return `${flag}${label}`;
  };

  /**
   * 两行一组的小面板：
   *   本地 🇨🇳  1.2.3.4
   *        广东 深圳 · 中国电信 · AS4134
   */
  function block(label, section, fallbackIP = '') {
    const info = section?.info || null;
    const ip = compactIP(info?.ip || fallbackIP || '-');
    const badge = compact([section?.cached ? '缓存' : '', queryMSOf(info)]).join(' ') || stateOf(section);
    const detail = compact([
      clip(briefPlaceOf(info), 14),
      clip(info?.isp, 11),
      info?.asn,
    ]).join(' · ');

    return `${label} ${flagOf(info?.countryCode)}  ${ip} · ${badge}\n      ${detail || '暂无详情'}`;
  }

  const render = (data, now = new Date(), elapsed = 0) => {
    const pad = n => String(n).padStart(2, '0');
    const cost = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`;
    const spin = ['◐', '◓', '◑', '◒'][Math.floor(now.getTime() / 1000) % 4];
    const local = data.local?.info || {};
    const entrance = data.entrance?.info || {};
    const landing = data.landing?.info || {};
    const countryMode = local.countryCode && landing.countryCode
      ? (local.countryCode === landing.countryCode ? '同国' : '跨境')
      : '';
    const hopMode = data.entranceIP && landing.ip
      ? (data.entranceIP === landing.ip ? '直落' : '中转')
      : '';
    const probe = data.probe || {};
    const status = compact([countryMode, hopMode, `总${cost}`]).join(' · ');
    const probeLine = compact([
      fmtMS(probe.direct) ? `直连${fmtMS(probe.direct)}` : '',
      fmtMS(probe.proxy) ? `代理${fmtMS(probe.proxy)}` : '',
    ]).join(' · ');
    const sections = [
      `${spin} 路线  ${routeNode('本地', data.local)} → ${routeNode('入口', data.entrance, data.entranceIP)} → ${routeNode('落地', data.landing)}`,
      `状态  ${status || cost}`,
      probeLine ? `探测  ${probeLine}` : '',
      block('本地', data.local),
      block('入口', data.entrance, data.entranceIP),
      block('落地', data.landing),
      `更新  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    ];
    return sections.filter(Boolean).join('\n\n');
  };

  // ══════════════════════════════════════════════════════
  //  MAIN  主流程
  //  6 个步骤：读缓存 → 检测变化 → 命中返回 / 全量刷新 → 渲染输出
  // ══════════════════════════════════════════════════════
  const startedAt = Date.now();

  // ── 步骤 1：读取缓存状态 ─────────────────────────────
  const cache      = readCache();
  const cacheValid = cacheAge(cache) < CFG.CACHE_TTL && !!cache.content;
  const cacheStale = cacheAge(cache) < CFG.STALE_TTL && !!cache.content;

  // ── 步骤 2：快速检测节点变化（仅调用本地 Surge API，无网络请求） ──
  // 取最近 20 条请求记录中，任意一条走代理的请求，提取其代理服务器 IP
  // 与上次记录的 IP 对比——如果不同，说明节点已切换
  const reqs1       = await getSurgeReqs();
  const curEnt      = findProxyIP(reqs1, { limit: 20 });
  const lastEnt     = $persistentStore.read(KEY.ENT) || '';
  const nodeChanged = !!(curEnt && lastEnt && curEnt !== lastEnt);

  // ── 步骤 3：缓存命中且节点未切换 → 直接返回，不发任何网络请求 ──
  if (cacheValid && !nodeChanged) {
    $done({ title: '网络信息 Live', content: cache.content });
    return; // 提前退出，防止后续代码执行
  }

  // ── 步骤 4：需要刷新 → 记录当前入口，并发查询本地 + 落地 ──────
  // 保存当前入口 IP，供下次步骤 2 比对
  if (curEnt) $persistentStore.write(curEnt, KEY.ENT);

  // 本地查询、落地查询、入口预查询、体感探测互相独立，并发执行缩短总时间
  const entranceGuess = curEnt ? queryEntranceInfo(curEnt) : Promise.resolve(null);
  const [local, landing, probe, guessedEntrance] = await Promise.all([
    queryLocal(),
    queryLanding(),
    queryProbe(),
    entranceGuess,
  ]);

  // ── 步骤 5：落地查询完成后重读记录，提取入口 IP ────────────────
  // queryLanding 向 ip.sb 发了一条代理请求，此时再读记录可以找到该请求的 remoteAddress
  // 即入口代理服务器的 IP，从而得到"入口"信息
  const reqs2    = await getSurgeReqs();
  const entIP    = findProxyIP(reqs2, { limit: 100, urlRE: /ip\.sb|ipinfo\.io/, excludeIP: landing?.ip || '' });
  const entranceIP = entIP || curEnt || '';
  const entrance = entranceIP
    ? (entranceIP === curEnt ? guessedEntrance : await queryEntranceInfo(entranceIP))
    : null;

  const old = cache.data || {};
  const sameEntrance = !!(entranceIP && old.entranceIP === entranceIP);
  const data = {
    local:     pickInfo(local, old.local, cacheStale),
    landing:   pickInfo(landing, old.landing, !nodeChanged && cacheStale),
    entrance:  pickInfo(entrance, old.entrance, sameEntrance && cacheStale),
    entranceIP: entranceIP || old.entranceIP || '',
    probe: {
      direct: Number.isFinite(probe?.direct) ? probe.direct : old.probe?.direct,
      proxy:  Number.isFinite(probe?.proxy)  ? probe.proxy  : old.probe?.proxy,
    },
  };

  // 兼容旧版只有 content、没有 data 的缓存
  if (!hasInfo(data.local) && !hasInfo(data.landing) && !hasInfo(data.entrance) && cacheStale) {
    $done({ title: '网络信息 Live', content: `${cache.content}\n\n刷新失败：已显示缓存` });
    return;
  }

  // ── 步骤 6：渲染面板内容，写入缓存，输出 ──────────────────────
  const content = render(data, new Date(), Date.now() - startedAt);
  writeCache({ content, data, ts: Date.now() });
  $done({ title: '网络信息 Live', content });

})().catch(e => $done({ title: '网络信息 Live', content: `组件异常：${e.message}` }));
