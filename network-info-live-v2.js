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
    // 每个数据源的最大重试次数（正式请求 + RETRIES 次重试）
    RETRIES:   1,
    // 一次面板刷新的总网络预算，需低于 Surge 模块的 20 秒超时
    REQUEST_BUDGET: 15000,
    // 首个数据源成功后，额外等待更优字段的时间（毫秒）
    SMART_GRACE: 900,
    // 节点变化会主动使缓存失效，无变化时减少频繁的外部 API 请求
    CACHE_TTL: 15000,
    // 刷新失败时最多沿用 1 小时内的旧结果，避免好面板被空结果覆盖
    STALE_TTL: 3600000,
  };

  // ══════════════════════════════════════════════════════
  //  KEYS  持久化存储键名
  // ══════════════════════════════════════════════════════
  const KEY = {
    CACHE:   'NI_CACHE_V4',    // 面板查询结果缓存
    ENT:     'NI_ENT_V4',      // 上次检测到的入口 IP（用于判断节点是否切换）
  };

  // ══════════════════════════════════════════════════════
  //  FETCHER  请求层
  //  封装 HTTP 请求、JSON 解析、重试逻辑
  // ══════════════════════════════════════════════════════

  /**
   * 基础 HTTP GET，返回响应体字符串；失败则抛出错误
   */
  const httpGet = (opt, deadline = Infinity) => new Promise((res, rej) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return rej(new Error('请求预算已用尽'));
    const timer = Number.isFinite(remaining)
      ? setTimeout(() => finish(rej, new Error('请求预算已用尽')), remaining)
      : null;
    $httpClient.get(opt, (err, _, body) =>
      err ? finish(rej, new Error(`网络请求失败: ${err}`)) : finish(res, body)
    );
  });

  /**
   * GET + JSON 解析
   * 网络错误或 JSON 解析失败均返回 null（不向上抛错）
   * 这样上层可以用 null 判断"此源不可用"
   *
   * 注意：ip-api.com 免费版仅支持 HTTP，无法改用 HTTPS（服务商限制）
   * 通过第三个本地源（ip.useragentinfo.com）和重试来弥补 HTTP 偶发劫持问题
   */
  const fetchJSON = async (url, opt = {}, timeout = CFG.T_DIRECT, deadline = Infinity) => {
    try {
      const started = Date.now();
      const body = await httpGet({ url, timeout, ...opt }, deadline);
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
  const fetchWithRetry = async (url, opt = {}, timeout = CFG.T_DIRECT, deadline = Infinity) => {
    for (let i = 0; i <= CFG.RETRIES; i++) {
      const result = await fetchJSON(url, opt, timeout, deadline);
      if (result !== null) return result;
      if (i < CFG.RETRIES && deadline - Date.now() > 500) await new Promise(r => setTimeout(r, 500));
    }
    return null; // 重试耗尽，确认失败
  };

  const smartFetch = (sources, merge, grace = CFG.SMART_GRACE, deadline = Infinity) => new Promise(resolve => {
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
      fetchWithRetry(url, opt, timeout, deadline)
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
    const alias = {
      CN: '中国', HK: '香港', MO: '澳门', TW: '台湾', JP: '日本', KR: '韩国',
      SG: '新加坡', MY: '马来西亚', US: '美国', CA: '加拿大', BR: '巴西',
      GB: '英国', DE: '德国', FR: '法国', NL: '荷兰', FI: '芬兰',
      LU: '卢森堡', RO: '罗马尼亚', CH: '瑞士',
    };
    if (alias[cc]) return alias[cc];
    try {
      return new Intl.DisplayNames(['zh-Hans-CN', 'zh-CN'], { type: 'region' }).of(cc) || cc;
    } catch {
      return cc;
    }
  };

  const countryCodeOf = (code, country = '') => {
    const cc = String(code || '').trim().toUpperCase();
    const s = String(country || '').trim().toLowerCase();
    if (/香港|hong\s*kong|\bhk\b/.test(s)) return 'HK';
    if (/台湾|taiwan|\btw\b/.test(s)) return 'TW';
    if (/澳门|macau|macao|\bmo\b/.test(s)) return 'MO';
    if (/日本|japan|\bjp\b/.test(s)) return 'JP';
    if (/新加坡|singapore|\bsg\b/.test(s)) return 'SG';
    if (/美国|united\s*states|usa|\bus\b/.test(s)) return 'US';
    if (/韩国|south\s*korea|korea|\bkr\b/.test(s)) return 'KR';
    if (/^[A-Z]{2}$/.test(cc)) return cc;
    if (/^(中国|中国大陆|china|mainland china|cn)$/.test(s)) return 'CN';
    return '';
  };

  const flagOf = code => {
    const cc = countryCodeOf(code);
    if (!cc) return '🏳️';
    return String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  };

  const GEO_ALIAS = {
    china: '中国',
    shanghai: '上海',
    pudong: '浦东',
    hangzhou: '杭州',
    shenzhen: '深圳',
    guangzhou: '广州',
    beijing: '北京',
    guangdong: '广东',
    sichuan: '四川',
    zhejiang: '浙江',
    anhui: '安徽',
    hubei: '湖北',
    chengdu: '成都',
    mianyang: '绵阳',
    'mian yang': '绵阳',
    'mian yang shi': '绵阳',
    hefei: '合肥',
    wuhan: '武汉',
    tokyo: '东京',
    yokohama: '横滨',
    kanagawa: '神奈川',
    minamishinagawa: '南品川',
    osaka: '大阪',
    sapporo: '札幌',
    seoul: '首尔',
    busan: '釜山',
    incheon: '仁川',
    singapore: '新加坡',
    hongkong: '香港',
    'hong kong': '香港',
    'quarry bay': '鲗鱼涌',
    '鰂魚涌': '鲗鱼涌',
    '鲫鱼涌': '鲗鱼涌',
    '鲗鱼涌': '鲗鱼涌',
    macau: '澳门',
    macao: '澳门',
    taiwan: '台湾',
    taipei: '台北',
    'los angeles': '洛杉矶',
    'san jose': '圣何塞',
    'san francisco': '旧金山',
    'mountain view': '山景城',
    ashburn: '阿什本',
    redmond: '雷德蒙德',
    piscataway: '皮斯卡塔韦',
    fremont: '弗里蒙特',
    seattle: '西雅图',
    chicago: '芝加哥',
    dallas: '达拉斯',
    'new york': '纽约',
    washington: '华盛顿',
    miami: '迈阿密',
    'kuala lumpur': '吉隆坡',
    london: '伦敦',
    frankfurt: '法兰克福',
    'frankfurt am main': '法兰克福',
    falkenstein: '法尔肯施泰因',
    nuremberg: '纽伦堡',
    roubaix: '鲁贝',
    gravelines: '格拉沃利讷',
    amsterdam: '阿姆斯特丹',
    paris: '巴黎',
    zurich: '苏黎世',
    helsinki: '赫尔辛基',
    luxembourg: '卢森堡',
    bucharest: '布加勒斯特',
    sydney: '悉尼',
    melbourne: '墨尔本',
    toronto: '多伦多',
    vancouver: '温哥华',
    montreal: '蒙特利尔',
    ottawa: '渥太华',
    'sao paulo': '圣保罗',
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
    const knownCountryCode = countryCodeOf('', country).toLowerCase();
    const countryLabel = hasCN(country) && (!knownCountryCode || knownCountryCode === code)
      ? country
      : countryName(code) || country || cc;
    const parts = code === 'cn'
      ? [tR, tC]
      : [countryLabel, tC || tR];
    return cleanParts(parts.filter(Boolean)).join(' ');
  };

  // ISP 格式化时过滤的英语停用词（防止 "of" / "the" / "in" 混入运营商名称）
  const STOP = /^(of|for|and|the|in|at|by|to|a|an|no)$/i;
  const CORP_RE = /\b(Technology|Technologies|Telecommunication|Telecommunications|Communication|Communications|Network|Networks|Internet|Service|Services|Telecom|Limited|Ltd|Corp|Corporation|Inc|Incorporated|Group|Global|International|Holdings|Solutions|Systems|Enterprise|Enterprises|Electric|Electron|Information|Data|Cloud|Digital|Media|Connect|Fiber|Co|Company|LLC|Pte|Pty)\b\.?/gi;
  const ISP_ALIAS = [
    [/china\s+telecom|chinanet|ct\s*net/i, '中国电信'],
    [/china\s+unicom|unicom/i, '中国联通'],
    [/china\s+mobile|cmcc|cmi/i, '中国移动'],
    [/cernet|china\s+education/i, '教育网'],
    [/china\s+tietong|tietong/i, '中国铁通'],
    [/aliyun|alibaba|ali\s*cloud/i, '阿里云'],
    [/tencent|qcloud/i, '腾讯云'],
    [/huawei|huaweicloud/i, '华为云'],
    [/baidu/i, '百度云'],
    [/ucloud/i, 'UCloud'],
    [/qing\s*cloud|qingcloud|青云/i, '青云'],
    [/kingsoft/i, '金山云'],
    [/jd\s*cloud|jingdong/i, '京东云'],
    [/volcengine|bytedance/i, '火山引擎'],
    [/ctyun|tianyi\s*cloud|天翼云|ecloud/i, '天翼云'],
    [/mobile\s*cloud|cm\s*cloud|移动云/i, '移动云'],
    [/unicom\s*cloud|wo\s*cloud|联通云/i, '联通云'],
    [/wangsu|chinanetcenter|quantil/i, '网宿科技'],
    [/netease/i, '网易云'],
    [/chinacache/i, '蓝汛'],
    [/21vianet|vianet/i, '世纪互联'],
    [/dr\.?\s*peng|peng\s*bo\s*shi|drcnet/i, '鹏博士'],
    [/baishan/i, '白山云'],
    [/qiniu/i, '七牛云'],
    [/upyun/i, '又拍云'],
    [/oriental\s+cable|shanghai\s+oriental/i, '东方有线'],
    [/gomami/i, 'GoMami'],
    [/dmit/i, 'DMIT'],
    [/bandwagon|it7/i, '搬瓦工'],
    [/xtom/i, 'xTom'],
    [/zenlayer/i, 'Zenlayer'],
    [/ctm/i, 'CTM'],
    [/hinet|chunghwa/i, '中华电信'],
    [/taiwan\s+mobile/i, '台湾大哥大'],
    [/seednet/i, 'Seednet'],
    [/chief\s+telecom/i, '是方电讯'],
    [/softbank/i, 'SoftBank'],
    [/kddi/i, 'KDDI'],
    [/\biij\b/i, 'IIJ'],
    [/sakura/i, 'Sakura'],
    [/ntt/i, 'NTT'],
    [/pccw|hkt/i, 'PCCW'],
    [/hgc/i, 'HGC'],
    [/hkbn/i, 'HKBN'],
    [/kinx/i, 'KINX'],
    [/korea\s+telecom|\bkt\b/i, 'KT'],
    [/sk\s*broadband/i, 'SK Broadband'],
    [/lg\s*u\+|lg\s+uplus/i, 'LG U+'],
    [/singtel/i, 'Singtel'],
    [/starhub/i, 'StarHub'],
    [/myrepublic/i, 'MyRepublic'],
    [/tmnet|telekom\s+malaysia/i, 'TMNet'],
    [/hetzner/i, 'Hetzner'],
    [/ovh/i, 'OVH'],
    [/leaseweb/i, 'Leaseweb'],
    [/digitalocean/i, 'DigitalOcean'],
    [/vultr|choopa/i, 'Vultr'],
    [/linode/i, 'Linode'],
    [/m247/i, 'M247'],
    [/cogent/i, 'Cogent'],
    [/g-?core/i, 'G-Core'],
    [/cdn77/i, 'CDN77'],
    [/cloudflare/i, 'Cloudflare'],
    [/akamai/i, 'Akamai'],
    [/fastly/i, 'Fastly'],
    [/hurricane\s+electric/i, 'Hurricane Electric'],
    [/amazon|aws/i, 'AWS'],
    [/google/i, 'Google'],
    [/microsoft|azure/i, 'Microsoft'],
    [/oracle/i, 'Oracle'],
    [/equinix/i, 'Equinix'],
    [/datacamp/i, 'DataCamp'],
    [/canonical/i, 'Canonical'],
    [/telegram/i, 'Telegram'],
    [/contabo/i, 'Contabo'],
    [/scaleway|online\s+s\.?a\.?s/i, 'Scaleway'],
    [/proton/i, 'Proton'],
  ];
  const TEXT_FIRST_ISP_ALIAS = [
    [/aliyun|alibaba|ali\s*cloud/i, '阿里云'],
    [/tencent|qcloud/i, '腾讯云'],
    [/huawei|huaweicloud/i, '华为云'],
    [/baidu/i, '百度云'],
    [/ucloud/i, 'UCloud'],
    [/kingsoft|ksyun/i, '金山云'],
    [/jd\s*cloud|jdcloud|jingdong/i, '京东云'],
    [/volcengine|bytedance/i, '火山引擎'],
    [/netease/i, '网易云'],
    [/ctyun|tianyi\s*cloud|天翼云|ecloud/i, '天翼云'],
    [/mobile\s*cloud|cm\s*cloud|移动云/i, '移动云'],
    [/unicom\s*cloud|wo\s*cloud|联通云/i, '联通云'],
    [/qing\s*cloud|qingcloud|青云/i, '青云'],
    [/wangsu|chinanetcenter|quantil/i, '网宿科技'],
    [/chinacache/i, '蓝汛'],
    [/21vianet|vianet/i, '世纪互联'],
    [/baishan/i, '白山云'],
    [/qiniu/i, '七牛云'],
    [/upyun/i, '又拍云'],
  ];
  const ASN_ALIAS = [
    [/AS4134\b/i, '中国电信'],
    [/AS4809\b/i, '中国电信 CN2'],
    [/AS4812\b|AS23724\b/i, '中国电信'],
    [/AS4837\b|AS4808\b|AS17621\b/i, '中国联通'],
    [/AS9929\b/i, '中国联通 9929'],
    [/AS9808\b|AS56040\b|AS56042\b|AS56046\b|AS56048\b|AS134810\b/i, '中国移动'],
    [/AS58453\b/i, '中国移动 CMI'],
    [/AS4538\b/i, '教育网'],
    [/AS9394\b/i, '中国铁通'],
    [/AS37963\b|AS45102\b/i, '阿里云'],
    [/AS45090\b|AS132203\b/i, '腾讯云'],
    [/AS55990\b|AS136907\b/i, '华为云'],
    [/AS38365\b|AS55967\b/i, '百度云'],
    [/AS135377\b/i, 'UCloud'],
    [/AS138407\b|AS58854\b/i, '青云'],
    [/AS59019\b/i, '金山云'],
    [/AS137702\b/i, '京东云'],
    [/AS137718\b/i, '火山引擎'],
    [/AS58542\b/i, '天翼云'],
    [/AS17430\b|AS24400\b/i, '网宿科技'],
    [/AS58519\b/i, '网易云'],
    [/AS23650\b/i, '蓝汛'],
    [/AS58593\b/i, '世纪互联'],
    [/AS4847\b/i, '鹏博士'],
    [/AS58879\b/i, '白山云'],
    [/AS134963\b/i, '七牛云'],
    [/AS134967\b/i, '又拍云'],
    [/AS132110\b/i, 'DMIT'],
    [/AS36002\b/i, 'GoMami'],
    [/AS9312\b/i, 'xTom'],
    [/AS3491\b|AS4760\b/i, 'PCCW'],
    [/AS9269\b/i, 'HKBN'],
    [/AS9304\b/i, 'HGC'],
    [/AS21859\b/i, 'Zenlayer'],
    [/AS25820\b/i, '搬瓦工'],
    [/AS4609\b/i, 'CTM'],
    [/AS3462\b/i, '中华电信'],
    [/AS24158\b/i, '台湾大哥大'],
    [/AS4780\b/i, 'Seednet'],
    [/AS17408\b/i, '是方电讯'],
    [/AS17676\b/i, 'SoftBank'],
    [/AS2516\b/i, 'KDDI'],
    [/AS2914\b/i, 'NTT'],
    [/AS2497\b/i, 'IIJ'],
    [/AS9371\b/i, 'Sakura'],
    [/AS9286\b/i, 'KINX'],
    [/AS4766\b/i, 'KT'],
    [/AS9318\b/i, 'SK Broadband'],
    [/AS3786\b/i, 'LG U+'],
    [/AS7473\b/i, 'Singtel'],
    [/AS4657\b/i, 'StarHub'],
    [/AS56300\b/i, 'MyRepublic'],
    [/AS4788\b/i, 'TMNet'],
    [/AS13335\b/i, 'Cloudflare'],
    [/AS8075\b/i, 'Microsoft'],
    [/AS15169\b|AS396982\b/i, 'Google'],
    [/AS16509\b|AS14618\b/i, 'AWS'],
    [/AS31898\b/i, 'Oracle'],
    [/AS14061\b/i, 'DigitalOcean'],
    [/AS20473\b/i, 'Vultr'],
    [/AS63949\b/i, 'Linode'],
    [/AS24940\b/i, 'Hetzner'],
    [/AS16276\b/i, 'OVH'],
    [/AS60781\b/i, 'Leaseweb'],
    [/AS9009\b/i, 'M247'],
    [/AS174\b/i, 'Cogent'],
    [/AS199524\b/i, 'G-Core'],
    [/AS60068\b/i, 'CDN77'],
    [/AS20940\b/i, 'Akamai'],
    [/AS54113\b/i, 'Fastly'],
    [/AS6939\b/i, 'Hurricane Electric'],
    [/AS54825\b/i, 'Equinix'],
    [/AS212238\b/i, 'DataCamp'],
    [/AS41231\b/i, 'Canonical'],
    [/AS62041\b/i, 'Telegram'],
    [/AS51167\b/i, 'Contabo'],
    [/AS12876\b/i, 'Scaleway'],
    [/AS62371\b/i, 'Proton'],
  ];
  const ispFromASN = raw => {
    const asn = fmtASN(raw);
    if (!asn) return '';
    const hit = ASN_ALIAS.find(([re]) => re.test(asn));
    return hit ? hit[1] : '';
  };

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
    const textFirstHit = TEXT_FIRST_ISP_ALIAS.find(([re]) => re.test(cl) || re.test(s));
    if (textFirstHit) return textFirstHit[1];
    const asnHit = ASN_ALIAS.find(([re]) => re.test(cl) || re.test(s));
    if (asnHit) return asnHit[1];
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
      source:   'ipip',
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
    const countryCode = countryCodeOf(d.countryCode, `${d.country || ''} ${d.regionName || ''} ${d.city || ''}`);
    const rawISP = `${d.isp || ''} ${d.org || ''} ${d.asname || ''} ${d.as || ''}`;
    const isp = fmtISP(rawISP);
    const inferred = inferGeoFromISP(rawISP);
    const region = geoName(d.regionName || inferred.region || '');
    const city = geoName(d.city || inferred.city || '');
    return {
      source:   'ipapi',
      ip:       d.query || '',
      countryCode,
      country:  hasCN(d.country) ? d.country : countryName(countryCode) || d.country || '',
      region,
      city,
      location: fmtLoc(countryCode, d.country, region, city),
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
      source:   'uai',
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
    const countryCode = countryCodeOf(d.country_code, `${d.country || ''} ${d.region || ''} ${d.city || ''}`);
    const rawISP = `${d.isp || ''} ${d.organization || ''} ${d.asn_organization || ''}`;
    const inferred = inferGeoFromISP(rawISP);
    const region = geoName(d.region || inferred.region || '');
    const city = geoName(d.city || inferred.city || '');
    return {
      source:   'ipsb',
      ip:       d.ip,
      countryCode,
      country:  hasCN(d.country) ? d.country : countryName(countryCode) || d.country || '',
      region,
      city,
      location: fmtLoc(countryCode, d.country, region, city),
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
    const countryCode = countryCodeOf(d.country_code, `${d.country || ''} ${d.region || ''} ${d.city || ''}`);
    const conn = d.connection || {};
    const rawISP = `${conn.org || ''} ${conn.isp || ''}`;
    const inferred = inferGeoFromISP(rawISP);
    const region = geoName(d.region || inferred.region || '');
    const city = geoName(d.city || inferred.city || '');
    return {
      source:   'ipwho',
      ip:       d.ip,
      countryCode,
      country:  hasCN(d.country) ? d.country : countryName(countryCode) || d.country || '',
      region,
      city,
      location: fmtLoc(countryCode, d.country, region, city),
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
    const countryCode = countryCodeOf(d.country, `${d.region || ''} ${d.city || ''}`);
    return {
      source:   'ipinfo',
      ip:       d.ip,
      countryCode,
      country:  countryName(countryCode),
      region:   geoName(d.region || ''),
      city:     geoName(d.city || ''),
      location: fmtLoc(countryCode, '', d.region, d.city),
      isp:      fmtISP(d.org || ''),
      asn:      fmtASN((d.org || '').match(/^AS\d+/i)?.[0]),
    };
  };

  /**
   * 解析 api.iplocation.net/?ip=<ip>
   * 用途：入口固定 IP 的国家/运营商兜底，尤其辅助判断香港/台湾/澳门等地区
   */
  const parseIPLocation = d => {
    if (String(d?.response_code || '') !== '200' || !d.ip) return null;
    const countryCode = countryCodeOf(d.country_code2, d.country_name);
    const country = hasCN(d.country_name) ? d.country_name : countryName(countryCode) || d.country_name || '';
    return {
      source:   'iplocation',
      ip:       d.ip,
      countryCode,
      country,
      region:   '',
      city:     '',
      location: fmtLoc(countryCode, country, '', ''),
      isp:      fmtISP(d.isp || ''),
      asn:      '',
    };
  };

  /**
   * 解析 ipapi.co
   * 用途：入口/落地的 HTTPS 备用源，补城市、ASN、组织名；限流或失败时自动忽略
   * 响应格式：{ ip, country_code, country_name, region, city, org, asn }
   */
  const parseIPAPICO = d => {
    if (!d?.ip || d.error) return null;
    const countryCode = countryCodeOf(d.country_code, `${d.country_name || ''} ${d.region || ''} ${d.city || ''}`);
    const rawISP = `${d.org || ''} ${d.asn || ''}`;
    const inferred = inferGeoFromISP(rawISP);
    const region = geoName(d.region || inferred.region || '');
    const city = geoName(d.city || inferred.city || '');
    return {
      source:   'ipapico',
      ip:       d.ip,
      countryCode,
      country:  hasCN(d.country_name) ? d.country_name : countryName(countryCode) || d.country_name || '',
      region,
      city,
      location: fmtLoc(countryCode, d.country_name, region, city),
      isp:      fmtISP(rawISP),
      asn:      fmtASN(d.asn),
    };
  };

  const mergeInfo = (...items) => {
    const all = items.filter(Boolean);
    if (!all.length) return null;
    const ipKey = value => String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    const sourceTrust = { ipwho: 100, ipsb: 95, ipapico: 90, ipinfo: 85, ipip: 80, uai: 80, ipapi: 70, iplocation: 65 };
    const groups = new Map();
    for (const item of all) {
      const key = ipKey(item.ip);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const list = [...groups.values()].sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      const trust = group => Math.max(...group.map(item => sourceTrust[item.source] || 0));
      return trust(b) - trust(a);
    })[0] || [];
    if (!list.length) return null;
    const pick = key => list.find(x => x?.[key])?.[key] || '';
    const SRC = {
      country: { ipwho: 100, iplocation: 90, ipinfo: 88, ipapico: 86, ipapi: 80, ipip: 78, uai: 78, ipsb: 55 },
      geo:     { ipwho: 100, ipip: 94, uai: 90, ipapico: 88, ipinfo: 86, ipapi: 82, ipsb: 58, iplocation: 42 },
      isp:     { ipwho: 96,  ipip: 92, uai: 88, ipapico: 86, ipsb: 84, ipapi: 80, iplocation: 78, ipinfo: 76 },
      asn:     { ipwho: 96,  ipsb: 92, ipapico: 90, ipapi: 86, ipinfo: 82, ipip: 0,  uai: 0, iplocation: 0 },
    };
    const srcScore = (item, type) => SRC[type]?.[item?.source] ?? 40;
    const joined = item => compact([item?.country, item?.region, item?.city, item?.location]).join(' ');
    const hkHint = item => item?.countryCode === 'HK' || /香港|hong\s*kong/i.test(joined(item));
    const locationScore = loc => {
      const s = String(loc || '');
      if (!s) return 0;
      const depth = s.split(/[ /·]+/).filter(Boolean).length;
      return (hasCN(s) ? 100 : 0) + depth * 10 + Math.min([...s].length, 20);
    };
    const bestBy = (filter, score) =>
      list.filter(filter).sort((a, b) => score(b) - score(a))[0] || {};
    const countryScore = item =>
      srcScore(item, 'country')
      + (hkHint(item) && item.countryCode === 'HK' ? 35 : 0)
      - (hkHint(item) && item.countryCode === 'CN' ? 45 : 0);
    const geoScore = item =>
      srcScore(item, 'geo')
      + locationScore(item.location)
      + (item.city ? 8 : 0)
      + (item.region ? 4 : 0);
    const ispScore = item => srcScore(item, 'isp') + (hasCN(item.isp) ? 8 : 0) + Math.min([...String(item.isp || '')].length, 16);
    const asnScore = item => srcScore(item, 'asn') + (/^AS\d+$/i.test(item.asn || '') ? 20 : 0);
    const ip = pick('ip');
    const times = list.map(x => x?.ms).filter(n => Number.isFinite(n) && n >= 0);
    const ms = times.length ? Math.max(...times) : NaN;
    if (!ip) return null;
    const countryItem = bestBy(x => x.countryCode || x.country, countryScore);
    const geoItem = bestBy(x => x.location || x.region || x.city, geoScore);
    const ispItem = bestBy(x => x.isp, ispScore);
    const asnItem = bestBy(x => x.asn, asnScore);
    const countryCode = countryItem.countryCode || geoItem.countryCode || pick('countryCode');
    const country = countryItem.country || countryName(countryCode) || geoItem.country || pick('country');
    const region = geoItem.region || pick('region');
    const city = geoItem.city || pick('city');
    const location = geoItem.location || fmtLoc(countryCode, country, region, city);
    const asn = asnItem.asn || pick('asn');
    const isp = ispItem.isp || pick('isp');
    const asnISP = ispFromASN(asn);
    const shouldUseASNISP = asnISP && (!isp || asnISP.includes(isp) || /^中国(电信|联通|移动)$/.test(isp) || /^(AWS|Microsoft|Google|Oracle|Akamai|Fastly|Cloudflare)$/.test(asnISP));
    return {
      ip,
      countryCode,
      country,
      region,
      city,
      location,
      isp:      shouldUseASNISP ? asnISP : isp,
      asn,
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
  async function queryLocal(deadline) {
    return smartFetch([
      ['https://myip.ipip.net/json', parseIPIP, { policy: 'DIRECT' }],
      ['http://ip-api.com/json/?lang=zh-CN&fields=status,query,country,countryCode,regionName,city,isp,org,asname,as', parseIPAPI, { policy: 'DIRECT' }],
      ['https://ip.useragentinfo.com/json', parseUAI, { policy: 'DIRECT' }],
      ['https://api-ipv4.ip.sb/geoip', parseIPSB, { policy: 'DIRECT' }],
      ['https://ipwho.is/', parseIPWHO, { policy: 'DIRECT' }],
      ['https://ipinfo.io/json', parseIPInfo, { policy: 'DIRECT' }],
    ], mergeInfo, CFG.SMART_GRACE, deadline);
  }

  /**
   * 查询落地 IP（通过代理，不指定 policy 则走 Surge 当前代理规则）
   *
   * 此处 ip.sb / ipinfo.io 都走代理路由，与 queryLocal 的直连查询完全独立
   */
  async function queryLanding(deadline) {
    return smartFetch([
      ['http://ip-api.com/json/?lang=zh-CN&fields=status,query,country,countryCode,regionName,city,isp,org,asname,as', parseIPAPI, {}, CFG.T_PROXY],
      ['https://api-ipv4.ip.sb/geoip', parseIPSB, {}, CFG.T_PROXY],
      ['https://ipwho.is/', parseIPWHO, {}, CFG.T_PROXY],
      ['https://ipinfo.io/json', parseIPInfo, {}, CFG.T_PROXY],
      ['https://ipapi.co/json/', parseIPAPICO, {}, CFG.T_PROXY],
    ], mergeInfo, CFG.SMART_GRACE, deadline);
  }

  /**
   * 查询入口 IP 的位置/运营商信息（直连，因为入口 IP 是代理服务器的公网 IP）
   * ip-api.com / ip.sb 并发查询，优先采用 ip-api 的中文化结果
   */
  async function queryEntranceInfo(ip, deadline) {
    const safeIP = encodeURIComponent(ip);
    return smartFetch([
      [`http://ip-api.com/json/${safeIP}?lang=zh-CN&fields=status,query,country,countryCode,regionName,city,isp,org,asname,as`, parseIPAPI, { policy: 'DIRECT' }],
      [`https://api-ipv4.ip.sb/geoip/${safeIP}`, parseIPSB, { policy: 'DIRECT' }],
      [`https://ipwho.is/${safeIP}`, parseIPWHO, { policy: 'DIRECT' }],
      [`https://ipinfo.io/${safeIP}/json`, parseIPInfo, { policy: 'DIRECT' }],
      [`https://ipapi.co/${safeIP}/json/`, parseIPAPICO, { policy: 'DIRECT' }],
      [`https://api.iplocation.net/?ip=${safeIP}`, parseIPLocation, { policy: 'DIRECT' }],
    ], mergeInfo, CFG.SMART_GRACE, deadline);
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

  const sameIP = (a, b) => {
    const norm = v => String(v || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    const x = norm(a), y = norm(b);
    return !!(x && y && x === y);
  };
  const sameMetroRoute = (entranceInfo, landingInfo) => {
    const e = normalizeInfo(entranceInfo);
    const l = normalizeInfo(landingInfo);
    const eCode = countryCodeOf(e?.countryCode, compact([e?.country, e?.location]).join(' '));
    const lCode = countryCodeOf(l?.countryCode, compact([l?.country, l?.location]).join(' '));
    if (!e?.ip || !l?.ip || !eCode || eCode !== lCode) return false;
    if (sameIP(e.ip, l.ip)) return true;
    const normPlace = v => geoName(v).replace(/\s+/g, '').toLowerCase();
    const eRegion = normPlace(e.region || '');
    const lRegion = normPlace(l.region || '');
    const eCity = normPlace(e.city || '');
    const lCity = normPlace(l.city || '');
    const regionSame = !!(eRegion && lRegion && eRegion === lRegion);
    const citySame = !!(eCity && lCity && eCity === lCity);
    if (/^(HK|MO|SG)$/.test(eCode)) return regionSame || citySame || /香港|澳门|新加坡/.test(`${e.location}${l.location}`);
    if (eCode === 'CN') return regionSame && (!eCity || !lCity || citySame);
    return citySame || (regionSame && !eCity && !lCity);
  };

  // ══════════════════════════════════════════════════════
  //  CACHE  缓存层
  //  结果缓存 15 秒，配合入口 IP 变化检测实现节点变化自动刷新
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
  const fillInfo = (primary, fallback) => {
    const p = normalizeInfo(primary);
    const f = normalizeInfo(fallback);
    if (!p) return f;
    if (!f) return p;
    return {
      ip:       p.ip || f.ip,
      countryCode: p.countryCode || f.countryCode,
      country:  p.country || f.country,
      region:   p.region || f.region,
      city:     p.city || f.city,
      location: p.location || f.location,
      isp:      p.isp || f.isp,
      asn:      p.asn || f.asn,
      ms:       Number.isFinite(p.ms) ? p.ms : f.ms,
    };
  };

  // ══════════════════════════════════════════════════════
  //  UI  渲染层
  //  将 {ip, location, isp, asn} 转成面板显示文本
  // ══════════════════════════════════════════════════════

  const compact = parts => parts.map(v => String(v || '').trim()).filter(Boolean);
  const clip = (value, max = 30) => {
    const chars = [...String(value || '').trim()];
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
  };
  const compactIP = ip => {
    const s = String(ip || '-').trim();
    return s.includes(':') ? clip(s, 20) : s;
  };
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
    const flag = flagOf(info?.countryCode);
    const place = clip(briefPlaceOf(info), 18);
    const isp = clip(info?.isp, 24);
    const asn = info?.asn || '';
    const detail = compact([place, isp, asn]).join(' · ');
    const lines = [`${label} ${flag}  ${ip}`];

    if (!detail) {
      lines.push('      暂无详情');
    } else if ([...detail].length <= 30) {
      lines.push(`      ${detail}`);
    } else {
      if (place) lines.push(`      ${place}`);
      lines.push(`      ${compact([isp, asn]).join(' · ') || '暂无运营商'}`);
    }
    return lines.join('\n');
  }

  const render = (data, now = new Date()) => {
    const pad = n => String(n).padStart(2, '0');
    const spin = ['◐', '◓', '◑', '◒'][Math.floor(now.getTime() / 1000) % 4];
    const showEntrance = !data.directRoute && !!(data.entrance?.info || data.entranceIP);
    const route = [
      routeNode('本地', data.local),
      showEntrance ? routeNode('入口', data.entrance, data.entranceIP) : '',
      routeNode('落地', data.landing),
    ].filter(Boolean).join(' → ');
    const sections = [
      `${spin} 路线  ${route}`,
      block('本地', data.local),
      showEntrance ? block('入口', data.entrance, data.entranceIP) : '',
      block('落地', data.landing),
      `更新  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    ];
    return sections.filter(Boolean).join('\n\n');
  };

  // ══════════════════════════════════════════════════════
  //  MAIN  主流程
  //  6 个步骤：读缓存 → 检测变化 → 命中返回 / 全量刷新 → 渲染输出
  // ══════════════════════════════════════════════════════

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

  // 本地查询、落地查询、入口预查询互相独立，并发执行缩短总时间
  const requestDeadline = Date.now() + CFG.REQUEST_BUDGET;
  const entranceGuess = curEnt ? queryEntranceInfo(curEnt, requestDeadline) : Promise.resolve(null);
  const [local, landing, guessedEntrance] = await Promise.all([
    queryLocal(requestDeadline),
    queryLanding(requestDeadline),
    entranceGuess,
  ]);

  // ── 步骤 5：落地查询完成后重读记录，提取入口 IP ────────────────
  // queryLanding 发出的代理查询最能代表当前节点；直连机时该 remoteAddress 会等于落地 IP
  // 即入口代理服务器的 IP，从而得到"入口"信息
  const reqs2    = await getSurgeReqs();
  const entIP    = findProxyIP(reqs2, { limit: 100, urlRE: /ip\.sb|ipinfo\.io|ipwho\.is|ip-api\.com/ });
  const entranceIP = entIP || curEnt || '';
  const entrance = entranceIP
    ? (entranceIP === curEnt ? guessedEntrance : await queryEntranceInfo(entranceIP, requestDeadline))
    : null;
  const sameAddressRoute = sameIP(entranceIP, landing?.ip);
  const sameMetroExitRoute = !sameAddressRoute && sameMetroRoute(entrance, landing);
  const directRoute = sameAddressRoute || sameMetroExitRoute;
  const landingFinal = sameAddressRoute ? mergeInfo(landing, entrance) : (sameMetroExitRoute ? fillInfo(landing, entrance) : landing);

  const old = cache.data || {};
  const sameEntrance = !directRoute && !!(entranceIP && old.entranceIP === entranceIP);
  const data = {
    local:     pickInfo(local, old.local, cacheStale),
    landing:   pickInfo(landingFinal, old.landing, !nodeChanged && cacheStale),
    entrance:  directRoute ? { info: null, cached: false } : pickInfo(entrance, old.entrance, sameEntrance && cacheStale),
    entranceIP: directRoute ? '' : (entranceIP || old.entranceIP || ''),
    directRoute,
  };

  // 兼容旧版只有 content、没有 data 的缓存
  if (!hasInfo(data.local) && !hasInfo(data.landing) && !hasInfo(data.entrance) && cacheStale) {
    $done({ title: '网络信息 Live', content: `${cache.content}\n\n刷新失败：已显示缓存` });
    return;
  }

  // ── 步骤 6：渲染面板内容，写入缓存，输出 ──────────────────────
  const content = render(data, new Date());
  writeCache({ content, data, ts: Date.now() });
  $done({ title: '网络信息 Live', content });

})().catch(e => $done({ title: '网络信息 Live', content: `组件异常：${e.message}` }));
