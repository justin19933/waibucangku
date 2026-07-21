const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'network-info.js'), 'utf8');
const chineseScript = fs.readFileSync(path.join(root, '网络信息.js'), 'utf8');
const liveScript = fs.readFileSync(path.join(root, 'network-info-live-v2.js'), 'utf8');
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ip-corpus.json'), 'utf8'));

if (chineseScript !== script) throw new Error('网络信息.js must match network-info.js');
if (liveScript.replaceAll('网络信息 Live', '网络信息') !== script) {
  throw new Error('network-info-live-v2.js may only differ by its panel title');
}

const LOCAL = {
  name: 'Local Sichuan Telecom',
  ip: '182.145.160.142',
  countryCode: 'CN',
  country: 'China',
  region: 'Sichuan',
  city: 'Mianyang',
  asn: 'AS4134',
  isp: '中国电信',
  rawIsp: 'China Telecom',
  rawOrg: 'CHINANET Sichuan province network',
  locations: ['四川', '绵阳'],
};

const ENTRY = corpus.find(item => item.ip === '47.102.107.249');
if (!ENTRY) throw new Error('Fixture must include transit entrance 47.102.107.249');
const GOMAMI_HK = corpus.find(item => item.ip === '191.101.132.8');
const PCCW_HK = corpus.find(item => item.ip === '116.48.39.172');
const CLOUDFLARE_LA = corpus.find(item => item.ip === '1.1.1.1');
const GOOGLE_MOUNTAIN_VIEW = corpus.find(item => item.ip === '8.8.8.8');
if (!GOMAMI_HK || !PCCW_HK) throw new Error('Fixture must include the Hong Kong same-metro regression pair');
if (!CLOUDFLARE_LA || !GOOGLE_MOUNTAIN_VIEW) throw new Error('Fixture must include the California different-city pair');

const byIP = new Map([[LOCAL.ip, LOCAL], ...corpus.map(item => [item.ip, item])]);

const flagOf = code => String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
const asnNumber = sample => Number(String(sample.asn || '').replace(/^AS/i, '')) || 0;
const rawISP = sample => sample.rawIsp || sample.rawOrg || sample.isp;
const rawOrg = sample => sample.rawOrg || sample.rawIsp || sample.isp;
const fail = (sample, message, content) => {
  const detail = [
    `Fixture failed: ${sample.ip} ${sample.name}`,
    `Category: ${sample.category}`,
    message,
    'Panel:',
    content,
  ].join('\n');
  throw new Error(detail);
};

function ipapi(sample) {
  return {
    status: 'success',
    query: sample.ip,
    country: sample.country,
    countryCode: sample.countryCode,
    regionName: sample.region,
    city: sample.city,
    isp: rawISP(sample),
    org: rawOrg(sample),
    asname: rawOrg(sample),
    as: `${sample.asn} ${rawOrg(sample)}`,
  };
}

function ipsb(sample) {
  return {
    ip: sample.ip,
    country: sample.country,
    country_code: sample.countryCode,
    region: sample.region,
    city: sample.city,
    isp: rawISP(sample),
    organization: rawOrg(sample),
    asn_organization: rawOrg(sample),
    asn: asnNumber(sample),
  };
}

function ipwho(sample) {
  return {
    success: true,
    ip: sample.ip,
    country: sample.country,
    country_code: sample.countryCode,
    region: sample.region,
    city: sample.city,
    connection: {
      asn: asnNumber(sample),
      isp: rawISP(sample),
      org: rawOrg(sample),
    },
  };
}

function ipinfo(sample) {
  return {
    ip: sample.ip,
    country: sample.countryCode,
    region: sample.region,
    city: sample.city,
    org: `${sample.asn} ${rawOrg(sample)}`,
  };
}

function iplocation(sample) {
  return {
    response_code: '200',
    ip: sample.ip,
    country_code2: sample.countryCode,
    country_name: sample.country,
    isp: rawOrg(sample),
  };
}

function ipapico(sample) {
  return {
    ip: sample.ip,
    country_code: sample.countryCode,
    country_name: sample.country,
    region: sample.region,
    city: sample.city,
    org: rawOrg(sample),
    asn: sample.asn,
  };
}

function ipipLocal() {
  return {
    ret: 'ok',
    data: {
      ip: LOCAL.ip,
      location: ['中国', '四川省', '绵阳市', '中国电信'],
    },
  };
}

function uaiLocal() {
  return {
    ip: LOCAL.ip,
    country: '中国',
    province: '四川省',
    city: '绵阳市',
    isp: '中国电信',
    net: '电信',
  };
}

function lookupIP(url) {
  const decoded = decodeURIComponent(url);
  const m = decoded.match(/(?:json|geoip|ipwho\.is|ipinfo\.io)\/(\d{1,3}(?:\.\d{1,3}){3})/)
    || decoded.match(/\/(\d{1,3}(?:\.\d{1,3}){3})(?:\/|$)/)
    || decoded.match(/[?&]ip=(\d{1,3}(?:\.\d{1,3}){3})/);
  return m ? m[1] : '';
}

function responseFor(opt, landing, entrance) {
  const url = typeof opt === 'string' ? opt : opt.url;
  const direct = opt && opt.policy === 'DIRECT';

  if (url === 'https://myip.ipip.net/json') return ipipLocal();
  if (url === 'https://ip.useragentinfo.com/json') return uaiLocal();

  if (url.startsWith('http://ip-api.com/json/?')) return direct ? ipapi(LOCAL) : ipapi(landing);
  if (url === 'https://api-ipv4.ip.sb/geoip') return direct ? ipsb(LOCAL) : ipsb(landing);
  if (url === 'https://ipwho.is/') return direct ? ipwho(LOCAL) : ipwho(landing);
  if (url === 'https://ipinfo.io/json') return direct ? ipinfo(LOCAL) : ipinfo(landing);
  if (url === 'https://ipapi.co/json/') return ipapico(landing);

  const ip = lookupIP(url);
  const sample = byIP.get(ip) || (ip === entrance.ip ? entrance : null);
  if (!sample) throw new Error(`No mock response for ${url}`);

  if (url.startsWith('http://ip-api.com/json/')) return ipapi(sample);
  if (url.startsWith('https://api-ipv4.ip.sb/geoip/')) return ipsb(sample);
  if (url.startsWith('https://ipwho.is/')) return ipwho(sample);
  if (url.startsWith('https://ipinfo.io/')) return ipinfo(sample);
  if (url.startsWith('https://ipapi.co/')) return ipapico(sample);
  if (url.startsWith('https://api.iplocation.net/')) return iplocation(sample);

  throw new Error(`Unhandled URL ${url}`);
}

function runPanel({ landing, entrance, initialEntrance = entrance, responseTransform = null }) {
  return new Promise((resolve, reject) => {
    const store = new Map();
    let apiCalls = 0;
    const timer = setTimeout(() => reject(new Error(`Timed out for ${landing.ip}`)), 4000);
    const requestsFor = () => {
      apiCalls += 1;
      return {
        requests: [{
          URL: apiCalls === 1 ? 'https://example.test/bootstrap' : 'https://api-ipv4.ip.sb/geoip',
          remoteAddress: `${(apiCalls === 1 ? initialEntrance : entrance).ip}:443 (Proxy)`,
        }],
      };
    };
    const context = {
      console,
      Date,
      Intl,
      Promise,
      setTimeout,
      clearTimeout,
      $persistentStore: {
        read: key => store.get(key) || '',
        write: (value, key) => { store.set(key, value); return true; },
      },
      $httpAPI: (_method, _path, _body, cb) => cb(requestsFor()),
      $httpClient: {
        get: (opt, cb) => {
          try {
            const response = responseFor(opt, landing, entrance);
            cb(null, { status: 200 }, JSON.stringify(responseTransform ? responseTransform(opt, response) : response));
          } catch (error) {
            cb(error);
          }
        },
      },
      $done: value => {
        clearTimeout(timer);
        resolve(value);
      },
    };
    vm.createContext(context);
    try {
      vm.runInContext(script, context, { filename: 'network-info.js', timeout: 1000 });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function assertClean(sample, content) {
  const banned = [/状态/, /探测/, /查\d+ms/, /直连\s*\d+ms?/, /代理\s*\d+ms?/, /总\s*\d/];
  for (const re of banned) {
    if (re.test(content)) fail(sample, `Banned latency/status text matched ${re}`, content);
  }
}

function assertLanding(sample, content) {
  const expectedFlag = flagOf(sample.countryCode);
  if (!content.includes(`${expectedFlag}落地`) && !content.includes(`落地 ${expectedFlag}`)) {
    fail(sample, `Expected landing flag ${expectedFlag}`, content);
  }
  if (!content.includes(sample.asn)) fail(sample, `Expected ASN ${sample.asn}`, content);
  if (!content.includes(sample.isp)) fail(sample, `Expected ISP ${sample.isp}`, content);
  if (!sample.locations.some(place => content.includes(place))) {
    fail(sample, `Expected one location from ${sample.locations.join(', ')}`, content);
  }
  if (['HK', 'TW', 'MO'].includes(sample.countryCode)) {
    if (content.includes(`🇨🇳落地`) || /中国[ /·]*(香港|台湾|澳门)/.test(content)) {
      fail(sample, 'Region node must not be displayed as mainland China', content);
    }
  }
}

async function testDirect(sample) {
  const result = await runPanel({ landing: sample, entrance: sample });
  const content = result && result.content || '';
  assertClean(sample, content);
  assertLanding(sample, content);
  if (content.includes('入口')) fail(sample, 'Direct route must fold entrance', content);
  if (!content.includes(`${flagOf(LOCAL.countryCode)}本地 → ${flagOf(sample.countryCode)}落地`)) {
    fail(sample, 'Direct route should be 本地 -> 落地', content);
  }
}

async function testDirectWithStaleRecent(sample) {
  const result = await runPanel({ landing: sample, entrance: sample, initialEntrance: ENTRY });
  const content = result && result.content || '';
  assertClean(sample, content);
  assertLanding(sample, content);
  if (content.includes('入口')) fail(sample, 'Direct route must ignore stale recent entrance and fold entrance', content);
  if (!content.includes(`${flagOf(LOCAL.countryCode)}本地 → ${flagOf(sample.countryCode)}落地`)) {
    fail(sample, 'Stale-recent direct route should still be 本地 -> 落地', content);
  }
}

async function testTransit(sample) {
  const result = await runPanel({ landing: sample, entrance: ENTRY });
  const content = result && result.content || '';
  assertClean(sample, content);
  assertLanding(sample, content);
  if (!content.includes('入口')) fail(sample, 'Transit route must include entrance', content);
  if (!content.includes(ENTRY.asn) || !content.includes(ENTRY.isp) || !content.includes('上海')) {
    fail(sample, 'Transit entrance should show Shanghai Aliyun AS37963', content);
  }
  const route = `${flagOf(LOCAL.countryCode)}本地 → ${flagOf(ENTRY.countryCode)}入口 → ${flagOf(sample.countryCode)}落地`;
  if (!content.includes(route)) fail(sample, `Transit route should be ${route}`, content);
}

async function testSameMetroExitPair() {
  const result = await runPanel({ landing: PCCW_HK, entrance: GOMAMI_HK });
  const content = result && result.content || '';
  assertClean(PCCW_HK, content);
  assertLanding(PCCW_HK, content);
  if (content.includes('入口')) fail(PCCW_HK, 'Same-metro Hong Kong connection/exit pair should fold entrance', content);
  if (!content.includes(`${flagOf(LOCAL.countryCode)}本地 → ${flagOf(PCCW_HK.countryCode)}落地`)) {
    fail(PCCW_HK, 'Same-metro Hong Kong pair should route 本地 -> 落地', content);
  }
  if (!content.includes('PCCW') || !content.includes('AS4760')) {
    fail(PCCW_HK, 'Folded landing should preserve PCCW AS4760 exit details', content);
  }
}

async function testDifferentCityPair() {
  const result = await runPanel({ landing: GOOGLE_MOUNTAIN_VIEW, entrance: CLOUDFLARE_LA });
  const content = result && result.content || '';
  assertClean(GOOGLE_MOUNTAIN_VIEW, content);
  assertLanding(GOOGLE_MOUNTAIN_VIEW, content);
  if (!content.includes('入口')) {
    fail(GOOGLE_MOUNTAIN_VIEW, '同州不同城市不能折叠入口', content);
  }
}

async function testConflictingSourceIP() {
  const result = await runPanel({
    landing: GOOGLE_MOUNTAIN_VIEW,
    entrance: GOOGLE_MOUNTAIN_VIEW,
    responseTransform: (opt, response) => {
      const url = typeof opt === 'string' ? opt : opt.url;
      const direct = opt && opt.policy === 'DIRECT';
      return url === 'https://ipwho.is/' && !direct ? ipwho(ENTRY) : response;
    },
  });
  const content = result && result.content || '';
  assertLanding(GOOGLE_MOUNTAIN_VIEW, content);
  if (content.includes(ENTRY.asn) || content.includes('上海')) {
    fail(GOOGLE_MOUNTAIN_VIEW, '其他 IP 的数据源结果不得污染落地信息', content);
  }
}

(async () => {
  if (corpus.length < 110) throw new Error(`Expected a broad corpus, got ${corpus.length}`);
  for (const sample of corpus) await testDirect(sample);
  const staleDirectSamples = corpus
    .filter(sample => sample.ip !== ENTRY.ip && /cn-cloud|hk-|asia-cloud/.test(sample.category))
    .slice(0, 24);
  for (const sample of staleDirectSamples) await testDirectWithStaleRecent(sample);
  const transitSamples = corpus
    .filter(sample => sample.ip !== ENTRY.ip)
    .filter(sample => sample.countryCode !== ENTRY.countryCode || sample.region !== ENTRY.region || sample.city !== ENTRY.city)
    .slice(0, 16);
  for (const sample of transitSamples) await testTransit(sample);
  await testSameMetroExitPair();
  await testDifferentCityPair();
  await testConflictingSourceIP();
  console.log(`PASS ${corpus.length} direct samples, ${staleDirectSamples.length} stale-direct samples, ${transitSamples.length} transit samples, 3 regressions`);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
