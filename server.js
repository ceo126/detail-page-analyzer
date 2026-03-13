const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sharp = require('sharp');
const multer = require('multer');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8150;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 디렉토리 생성
const DIRS = {
  screenshots: path.join(__dirname, 'screenshots'),
  output: path.join(__dirname, 'output'),
  uploads: path.join(__dirname, 'uploads'),
  history: path.join(__dirname, 'history')
};
Object.values(DIRS).forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 정적 파일 서빙
app.use('/output', express.static(DIRS.output));
app.use('/screenshots', express.static(DIRS.screenshots));
app.use('/uploads', express.static(DIRS.uploads));

// 브라우저 관리 (싱글톤 브라우저 + 스텔스)
let browser = null;
let browserLaunching = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browserLaunching) return browserLaunching;
  browserLaunching = (async () => {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--window-size=1400,900',
    ];
    try {
      const b = await chromium.launch({ headless: true, channel: 'chrome', args });
      console.log('브라우저: 시스템 Chrome (headless)');
      return b;
    } catch {
      const b = await chromium.launch({ headless: true, args });
      console.log('브라우저: Playwright Chromium (headless)');
      return b;
    }
  })().then(b => {
    browser = b;
    browserLaunching = null;
    return b;
  }).catch(err => {
    browserLaunching = null;
    throw err;
  });
  return browserLaunching;
}

async function createStealthContext(b, opts = {}) {
  const context = await b.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    ...opts,
  });
  await context.addInitScript(STEALTH_SCRIPTS.join('\n'));
  return context;
}

// 자동화 흔적 제거 스크립트
const STEALTH_SCRIPTS = [
  // navigator.webdriver 숨기기
  `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
  // Chrome runtime 위장
  `window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };`,
  // permissions 위장
  `const originalQuery = window.navigator.permissions.query;
   window.navigator.permissions.query = (parameters) =>
     parameters.name === 'notifications'
       ? Promise.resolve({ state: Notification.permission })
       : originalQuery(parameters);`,
  // plugins 위장
  `Object.defineProperty(navigator, 'plugins', {
    get: () => [1,2,3,4,5].map(() => ({
      0: { type: 'application/x-google-chrome-pdf' },
      length: 1, item: () => null, namedItem: () => null
    }))
  });`,
  // languages 위장
  `Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });`,
];

// Gemini API 호출 (자동 재시도)
async function callGemini(prompt, imageParts = [], maxRetries = 2) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const parts = imageParts.length > 0 ? [prompt, ...imageParts] : [prompt];
      const result = await model.generateContent(parts);
      return result.response.text();
    } catch (err) {
      lastError = err;
      console.error(`Gemini API 오류 (시도 ${i + 1}/${maxRetries + 1}):`, err.message);
      if (i < maxRetries) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastError;
}

// ============================================================
// 1) URL에서 상세페이지 크롤링 + 스크린샷
// ============================================================
app.post('/api/crawl', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다' });

  // URL 유효성 검사
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: '올바른 URL 형식이 아닙니다' });
    }
    // 내부 네트워크 접근 차단
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1' ||
        hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('169.254.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
      return res.status(400).json({ error: '내부 네트워크 URL은 접근할 수 없습니다' });
    }
  } catch {
    return res.status(400).json({ error: '올바른 URL 형식이 아닙니다' });
  }

  let context = null;
  try {
    const b = await getBrowser();
    context = await createStealthContext(b);
    const page = await context.newPage();

    // 추가 헤더 설정
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'sec-ch-ua': '"Chromium";v="134", "Google Chrome";v="134", "Not:A-Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });

    // 팝업/다이얼로그 자동 닫기
    page.on('dialog', async dialog => {
      await dialog.dismiss().catch(() => {});
    });

    // ============================================================
    // 네트워크 인터셉트: goto 전에 등록하여 모든 이미지 URL 수집
    // ============================================================
    const networkImages = new Set();
    page.on('response', async (response) => {
      try {
        const ct = response.headers()['content-type'] || '';
        const respUrl = response.url();
        if (ct.startsWith('image/') && response.status() === 200) {
          const contentLength = parseInt(response.headers()['content-length'] || '0');
          if (contentLength > 5000 || contentLength === 0) {
            if (!respUrl.includes('icon') && !respUrl.includes('logo') && !respUrl.includes('pixel') &&
                !respUrl.includes('tracker') && !respUrl.includes('beacon') && !respUrl.includes('.svg')) {
              networkImages.add(respUrl);
            }
          }
        }
      } catch {}
    });

    // 페이지 로딩
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);

    // 봇 탐지 체크
    const isBlocked = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return text.includes('Access Denied') || text.includes('보안 확인') ||
             text.includes('captcha') || text.includes('robot') ||
             text.includes('차단') || text.includes('접근이 거부');
    });
    if (isBlocked) {
      const pageTitle = await page.title();
      console.log(`봇 탐지됨 (${pageTitle}), 대기 후 재시도...`);
      await page.waitForTimeout(5000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(3000);
    }

    // 플랫폼 감지
    const platform = detectPlatform(url);

    // 쿠키/팝업 자동 닫기
    await dismissPopups(page);

    // "더보기"/"상세정보" 버튼 클릭하여 숨겨진 콘텐츠 펼치기
    await expandDetailContent(page, platform);

    // iframe 내 상세 이미지가 있으면 메인 페이지에 펼치기
    await expandIframeContent(page);

    // ============================================================
    // 1단계: 전체 스크롤하여 lazy-load 콘텐츠 모두 로딩
    // ============================================================
    await autoScroll(page);
    await page.waitForTimeout(2000);

    // ============================================================
    // 전체 스크롤 가능 높이 파악 (auto-scroll 후 측정)
    // ============================================================
    const scrollInfo = await page.evaluate(() => {
      let scrollHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
      let scrollContainer = null;

      // body가 뷰포트와 같으면 → 내부 스크롤 컨테이너 탐색
      if (scrollHeight <= window.innerHeight + 100) {
        const candidates = document.querySelectorAll('div, main, section, article');
        let maxH = 0;
        for (const el of candidates) {
          if (el.scrollHeight > el.clientHeight + 100 && el.scrollHeight > maxH) {
            maxH = el.scrollHeight;
            scrollContainer = el.id ? '#' + el.id :
              el.className ? '.' + el.className.split(' ')[0] : null;
            scrollHeight = maxH;
          }
        }
      }

      return { scrollHeight, scrollContainer, viewportHeight: window.innerHeight };
    });

    console.log(`스크롤 정보: 높이=${scrollInfo.scrollHeight}px, 컨테이너=${scrollInfo.scrollContainer || 'body'}`);

    // ============================================================
    // 2단계: 맨 위로 돌아가서 뷰포트 단위 스크린샷 캡처
    // ============================================================
    const sessionId = Date.now().toString();
    const screenshotDir = path.join(DIRS.screenshots, sessionId);
    fs.mkdirSync(screenshotDir, { recursive: true });

    const containerSel = scrollInfo.scrollContainer;

    // 맨 위로 이동
    await page.evaluate((sel) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (el) { el.scrollTop = 0; return; }
      }
      window.scrollTo(0, 0);
    }, containerSel);
    await page.waitForTimeout(500);

    // 페이지가 짧으면 fullPage 스크린샷 한 장으로 처리
    const useFullPage = scrollInfo.scrollHeight <= scrollInfo.viewportHeight * 3 && !containerSel;
    let numChunks = 0;

    if (useFullPage) {
      const chunkPath = path.join(screenshotDir, 'screenshot_0.jpg');
      await page.screenshot({ type: 'jpeg', quality: 80, path: chunkPath, fullPage: true });
      numChunks = 1;
    } else {
      const scrollStep = 700;
      let scrollY = 0;
      let chunkIndex = 0;
      const maxChunks = 30;
      let lastScrollTop = -1;
      let staleCount = 0;

      while (chunkIndex < maxChunks) {
        // 현재 뷰포트 이미지 로딩 대기
        await page.evaluate(() => {
          return Promise.all(
            Array.from(document.querySelectorAll('img')).filter(img => {
              const rect = img.getBoundingClientRect();
              return rect.top < window.innerHeight + 200 && rect.bottom > -200;
            }).map(img => {
              if (img.complete && img.naturalWidth > 0) return Promise.resolve();
              return new Promise(resolve => {
                img.onload = resolve;
                img.onerror = resolve;
                setTimeout(resolve, 3000);
              });
            })
          );
        }).catch(() => {});
        await page.waitForTimeout(300);

        // 스크린샷
        const chunkPath = path.join(screenshotDir, `screenshot_${chunkIndex}.jpg`);
        await page.screenshot({ type: 'jpeg', quality: 80, path: chunkPath });
        chunkIndex++;

        // 스크롤
        scrollY += scrollStep;
        const scrollResult = await page.evaluate(({ sel, y }) => {
          if (sel) {
            const el = document.querySelector(sel);
            if (el) {
              el.scrollTop = y;
              return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
            }
          }
          window.scrollTo(0, y);
          return {
            scrollTop: window.scrollY || document.documentElement.scrollTop,
            scrollHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
            clientHeight: window.innerHeight
          };
        }, { sel: containerSel, y: scrollY });
        await page.waitForTimeout(200);

        if (scrollResult.scrollTop === lastScrollTop) {
          staleCount++;
          if (staleCount >= 2) break;
        } else {
          staleCount = 0;
        }
        lastScrollTop = scrollResult.scrollTop;

        if (scrollResult.scrollTop + scrollResult.clientHeight >= scrollResult.scrollHeight - 50) {
          await page.waitForTimeout(400);
          const lastPath = path.join(screenshotDir, `screenshot_${chunkIndex}.jpg`);
          await page.screenshot({ type: 'jpeg', quality: 80, path: lastPath });
          chunkIndex++;
          break;
        }
      }
      numChunks = chunkIndex;
    }

    const totalHeight = scrollInfo.scrollHeight;

    // ============================================================
    // 텍스트 + 이미지 URL 추출
    // ============================================================
    await page.evaluate((sel) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (el) { el.scrollTop = 0; return; }
      }
      window.scrollTo(0, 0);
    }, containerSel);

    const pageData = await page.evaluate((platform) => {
      const data = {
        title: document.title,
        texts: [],
        images: [],
        platform: platform
      };

      // 제목 추출
      const titleSelectors = [
        '[class*="CampaignTitle"]', '[class*="campaign-title"]', '[class*="FundingTitle"]',
        '[class*="campaignTitle"]', '.wd-detail h2', '.wd-detail h1',
        'h1', '.prod-buy-header__title', '.topArea_headingArea__*',
        '._22kNQuEXmb', '.item_tit', '#fundingTitle',
        '[class*="product-name"]', '[class*="productName"]', '[class*="item-name"]',
        '[class*="product_title"]', '[class*="goods_name"]',
      ];
      for (const sel of titleSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) {
            data.productName = el.textContent.trim().substring(0, 200);
            break;
          }
        } catch {}
      }
      if (!data.productName) {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) data.productName = ogTitle.content?.substring(0, 200);
      }
      if (!data.productName && document.title) {
        data.productName = document.title.replace(/[-|].*$/, '').trim().substring(0, 200);
      }

      // 가격 추출
      const priceSelectors = [
        '.total-price strong', '._1LY7DqCnwR', '.lowestPrice',
        '[class*="price"]', '[class*="sale"]', '.prod-sale-price'
      ];
      for (const sel of priceSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) {
            data.price = el.textContent.trim().substring(0, 50);
            break;
          }
        } catch {}
      }

      // 본문 텍스트 (메인 + iframe)
      function extractTexts(doc) {
        const texts = [];
        const textEls = doc.querySelectorAll('p, h1, h2, h3, h4, li, span, td, th, div');
        textEls.forEach(el => {
          if (el.children.length > 3) return; // 컨테이너 div 건너뛰기
          const t = el.textContent.trim();
          if (t.length > 5 && t.length < 500) texts.push(t);
        });
        return texts;
      }
      data.texts = extractTexts(document);
      // iframe 텍스트도 추출
      document.querySelectorAll('iframe').forEach(iframe => {
        try {
          if (iframe.contentDocument) {
            data.texts.push(...extractTexts(iframe.contentDocument));
          }
        } catch {}
      });
      data.texts = [...new Set(data.texts)].slice(0, 200);

      // 이미지 수집 (DOM에서 — 메인 + iframe)
      function extractImages(doc) {
        const imgs = [];
        doc.querySelectorAll('img, [style*="background-image"]').forEach(el => {
          let src = '';
          if (el.tagName === 'IMG') {
            src = el.src || el.dataset?.src || el.dataset?.lazySrc ||
                  el.dataset?.originalSrc || el.dataset?.lazyload ||
                  el.dataset?.original || el.getAttribute('data-src') || '';
          } else {
            const bg = el.style.backgroundImage || '';
            const m = bg.match(/url\(['"]?(.*?)['"]?\)/);
            if (m) src = m[1];
          }
          if (src && src.startsWith('http') &&
              !src.includes('icon') && !src.includes('logo') && !src.includes('.svg') &&
              !src.includes('pixel') && !src.includes('spacer') && !src.includes('blank') &&
              !src.includes('loading') && !src.includes('placeholder')) {
            imgs.push(src);
          }
        });
        return imgs;
      }
      data.images = extractImages(document);
      document.querySelectorAll('iframe').forEach(iframe => {
        try {
          if (iframe.contentDocument) {
            data.images.push(...extractImages(iframe.contentDocument));
          }
        } catch {}
      });
      data.images = [...new Set(data.images)].slice(0, 100);

      return data;
    }, platform);

    // 네트워크에서 수집된 이미지 URL 병합 (DOM에서 못 잡은 것 포함)
    const allImages = [...new Set([...pageData.images, ...networkImages])];
    pageData.images = allImages.slice(0, 100);

    // ============================================================
    // 실제 이미지 다운로드 (스크린샷과 별도로)
    // ============================================================
    const downloadedImages = [];
    const imageDir = path.join(screenshotDir, 'images');
    fs.mkdirSync(imageDir, { recursive: true });

    // 페이지에서 직접 이미지를 fetch (같은 세션 쿠키 공유)
    const downloadPromises = pageData.images.slice(0, 30).map(async (imgUrl, idx) => {
      try {
        const result = await page.evaluate(async (url) => {
          try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const blob = await res.blob();
            if (blob.size < 10000) return null;
            const reader = new FileReader();
            return new Promise(resolve => {
              reader.onload = () => resolve({ data: reader.result.split(',')[1], size: blob.size, type: blob.type });
              reader.readAsDataURL(blob);
            });
          } catch { return null; }
        }, imgUrl);

        if (result) {
          const ext = result.type.includes('png') ? 'png' : result.type.includes('webp') ? 'webp' : 'jpg';
          const imgPath = path.join(imageDir, `img_${idx}.${ext}`);
          fs.writeFileSync(imgPath, Buffer.from(result.data, 'base64'));
          downloadedImages.push({
            index: idx,
            url: imgUrl,
            localPath: `/screenshots/${sessionId}/images/img_${idx}.${ext}`,
            size: result.size
          });
        }
      } catch {}
    });
    await Promise.all(downloadPromises);

    console.log(`크롤링 완료: 스크린샷 ${numChunks}장, 이미지 ${downloadedImages.length}개 다운로드, 전체 높이 ${totalHeight}px`);

    res.json({
      success: true,
      sessionId,
      platform,
      pageData,
      screenshotCount: numChunks,
      totalHeight,
      downloadedImages
    });
  } catch (err) {
    console.error('크롤링 오류:', err);
    const msg = err.message?.includes('timeout') ? '페이지 로딩 시간 초과. 다시 시도해주세요.' : '크롤링 중 오류가 발생했습니다.';
    res.status(500).json({ error: msg });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

// ============================================================
// 2) Gemini Vision으로 상세페이지 분석
// ============================================================
app.post('/api/analyze', async (req, res) => {
  const { sessionId, pageData } = req.body;
  if (!sessionId || !isValidSessionId(sessionId)) return res.status(400).json({ error: '유효하지 않은 sessionId' });

  try {
    const screenshotDir = path.join(DIRS.screenshots, sessionId);
    if (!fs.existsSync(screenshotDir)) {
      return res.status(400).json({ error: '스크린샷을 찾을 수 없습니다. 다시 크롤링해주세요.' });
    }

    const files = fs.readdirSync(screenshotDir)
      .filter(f => f.startsWith('screenshot_'))
      .sort()
      .slice(0, 10);

    // 이미지를 base64로 변환 (병렬 처리)
    const imageParts = await Promise.all(files.map(async (file) => {
      const filePath = path.join(screenshotDir, file);
      const buffer = fs.readFileSync(filePath);
      const resized = await sharp(buffer)
        .resize(1000, null, { withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      return {
        inlineData: {
          data: resized.toString('base64'),
          mimeType: 'image/jpeg'
        }
      };
    }));

    const prompt = `당신은 10년 경력의 쇼핑몰 상세페이지 마케팅 분석 전문가입니다.
아래 스크린샷은 하나의 상품 상세페이지를 위에서부터 순서대로 캡처한 것입니다.
이미지 속에 보이는 모든 텍스트, 숫자, 문구를 빠짐없이 읽고 분석하세요.

${pageData ? `\n추가 추출 텍스트:\n- 제품명: ${pageData.productName || '알 수 없음'}\n- 가격: ${pageData.price || '알 수 없음'}\n- 본문: ${(pageData.texts || []).slice(0, 50).join(' / ')}` : ''}

## 분석 지침
1. 이미지에 보이는 **모든 텍스트를 정확히 읽어서** 각 항목에 반영하세요
2. 가격은 할인가/원가 모두 이미지에서 직접 읽어주세요
3. 셀링포인트는 이미지에서 강조된 문구를 **그대로 인용**하세요
4. 각 섹션의 실제 내용(헤드라인, 본문 텍스트)을 **구체적으로** 적어주세요
5. structure의 각 섹션마다 실제 텍스트 내용을 description에 포함하세요
6. 최소 5개 이상의 섹션을 분석하세요

**반드시 아래 JSON 형식으로만** 응답하세요 (설명 텍스트 없이 JSON만):

{
  "product": {
    "name": "이미지에서 읽은 정확한 제품명",
    "price": "할인가 (이미지에서 읽은 그대로)",
    "originalPrice": "원래 가격 (이미지에서 읽은 그대로, 없으면 null)",
    "discountRate": "할인율 (예: 30%, 없으면 null)",
    "category": "카테고리",
    "brand": "브랜드명",
    "options": "옵션/사이즈/색상 등 (이미지에서 확인된 것)"
  },
  "design": {
    "tone": "전체적인 디자인 톤 2-3문장으로 상세히",
    "mainColors": ["#hex1", "#hex2", "#hex3", "#hex4"],
    "backgroundColor": "#배경색",
    "fontStyle": "제목 폰트, 본문 폰트 스타일 각각 설명",
    "imageStyle": "이미지 스타일 상세 설명 (구도, 배경, 모델 유무 등)",
    "overallQuality": "디자인 완성도 평가 2-3문장"
  },
  "structure": [
    {
      "section": "섹션명",
      "description": "이 섹션에 실제로 적혀있는 텍스트 내용을 구체적으로 서술",
      "layout": "레이아웃 설명",
      "visualElements": "사용된 시각 요소 (아이콘, 일러스트, 사진 등)"
    }
  ],
  "copywriting": {
    "headlineStyle": "헤드라인 스타일 분석",
    "headlines": ["이미지에서 읽은 실제 헤드라인 문구1", "문구2", "문구3"],
    "toneOfVoice": "어조 상세 분석",
    "keyPhrases": ["이미지에서 강조된 실제 핵심 문구를 그대로 5개 이상"],
    "sellingPoints": ["실제 셀링 포인트 문구를 그대로 5개 이상"],
    "callToAction": "CTA 문구 (구매하기, 지금 펀딩 등)"
  },
  "target": {
    "audience": "타겟 고객층 상세 분석",
    "ageRange": "추정 연령대",
    "painPoints": ["해결하는 고객 고민 3개 이상"],
    "benefits": ["핵심 혜택 3개 이상"],
    "useCases": ["사용 시나리오 2-3개"]
  },
  "socialProof": {
    "reviews": "후기/리뷰 관련 정보 (개수, 평점 등)",
    "salesCount": "판매량/펀딩금액 등",
    "certifications": "인증/수상/미디어 노출 등",
    "trustElements": ["신뢰를 주는 요소들"]
  },
  "overall": {
    "strengths": ["이 상세페이지의 구체적 장점 3개 이상"],
    "weaknesses": ["구체적 개선점 3개 이상"],
    "score": 85,
    "summary": "전체 상세페이지에 대한 종합 평가 3-5줄로 상세히",
    "improvementSuggestions": ["구체적인 개선 제안 3개 이상"]
  }
}`;

    const text = await callGemini(prompt, imageParts);

    // JSON 추출
    let analysis;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        analysis = JSON.parse(jsonMatch[0]);
      } catch {
        analysis = { raw: text };
      }
    } else {
      analysis = { raw: text };
    }

    // 분석 히스토리 저장
    const historyFile = path.join(DIRS.history, `${sessionId}.json`);
    fs.writeFileSync(historyFile, JSON.stringify({
      sessionId,
      url: pageData?.url || '',
      platform: pageData?.platform || '',
      productName: analysis.product?.name || pageData?.productName || '',
      analysis,
      createdAt: new Date().toISOString()
    }, null, 2));

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('분석 오류:', err);
    res.status(500).json({ error: 'AI 분석 중 오류가 발생했습니다. 다시 시도해주세요.' });
  }
});

// ============================================================
// 3) 분석 결과 기반 상세페이지 HTML 생성
// ============================================================
app.post('/api/generate', async (req, res) => {
  const { analysis, userEdits, keyword, sessionId: reqSessionId } = req.body;
  if (!analysis) return res.status(400).json({ error: '분석 데이터 필요' });
  if (keyword && keyword.length > 200) return res.status(400).json({ error: '키워드는 200자 이하로 입력하세요' });
  if (userEdits && userEdits.length > 1000) return res.status(400).json({ error: '추가 요청사항은 1000자 이하로 입력하세요' });

  try {
    const editInstructions = userEdits ? `\n\n추가 요청사항:\n${userEdits}` : '';

    // 원본 스크린샷을 Vision에 같이 전달 (구조 복제 정확도 향상)
    let imageParts = [];
    if (reqSessionId && isValidSessionId(reqSessionId)) {
      const screenshotDir = path.join(DIRS.screenshots, reqSessionId);
      if (fs.existsSync(screenshotDir)) {
        const files = fs.readdirSync(screenshotDir)
          .filter(f => f.startsWith('screenshot_'))
          .sort()
          .slice(0, 6);
        imageParts = await Promise.all(files.map(async (file) => {
          const buffer = fs.readFileSync(path.join(screenshotDir, file));
          const resized = await sharp(buffer)
            .resize(800, null, { withoutEnlargement: true })
            .jpeg({ quality: 65 })
            .toBuffer();
          return { inlineData: { data: resized.toString('base64'), mimeType: 'image/jpeg' } };
        }));
      }
    }

    // 키워드 모드 vs 일반 모드
    const keywordSection = keyword
      ? `\n## 핵심 지시: 키워드 기반 새 상세페이지 생성
사용자가 입력한 키워드/상품: "${keyword}"

이 키워드의 상품을 위한 **완전히 새로운 상세페이지**를 만들어야 합니다.
단, 원본 상세페이지의 아래 요소를 **최대한 똑같이** 복제하세요:
- 전체 레이아웃 구조 (섹션 순서, 배치 방식)
- 디자인 톤 & 컬러 팔레트 (배경색, 강조색, 폰트 스타일)
- 각 섹션의 시각적 레이아웃 (가로배치, 아이콘+텍스트, 비교표 등)
- 카피라이팅 스타일 (어조, 헤드라인 방식, 강조 패턴)
- CTA 버튼 스타일, 구분선, 여백 패턴

바꿔야 할 것:
- 제품명, 가격, 브랜드 → "${keyword}" 관련 내용으로 변경
- 제품 설명, 셀링포인트, 혜택 → "${keyword}"에 맞게 새로 작성
- 후기/수치 → "${keyword}"에 맞는 그럴듯한 내용으로 생성
`
      : '';

    const prompt = `당신은 쇼핑몰 상세페이지 전문 디자이너 겸 카피라이터입니다.
${keyword ? '아래 첨부된 스크린샷은 **참고할 원본 상세페이지**입니다. 이 페이지의 디자인/구조를 최대한 똑같이 따라하되, 새로운 키워드로 내용을 교체하세요.' : '아래 분석 결과를 바탕으로 자사몰용 상세페이지 HTML을 생성하세요.'}
${keywordSection}

분석 결과 (원본 페이지):
${JSON.stringify(analysis, null, 2)}
${editInstructions}

## HTML 생성 요구사항:
1. 폭 860px (자사몰 상세페이지 표준)
2. 세로로 긴 단일 페이지 형태
3. 원본의 구조(structure)를 **동일한 순서와 레이아웃**으로 재현
4. 원본의 디자인 톤, 컬러, 폰트 스타일을 **정확히** 반영
5. ${keyword ? `"${keyword}" 상품에 맞는 매력적인 카피라이팅` : '분석된 카피라이팅 스타일 반영'}
6. 셀링 포인트를 시각적으로 효과적으로 강조
7. 이미지 영역은 플레이스홀더 (회색 박스 + "이미지 영역", data-placeholder-id="1","2"... 속성)
8. 모든 텍스트 한국어
9. inline CSS만 사용 (외부 CSS 없음)
10. 배경색, 구분선, 그라데이션, 아이콘(이모지) 등으로 시각적으로 풍성하게
11. 원본에서 발견된 약점(weaknesses)은 개선하여 반영

반드시 완전한 HTML 코드만 출력하세요. \`\`\`html 태그로 감싸세요.
<html>부터 </html>까지 포함.`;

    const text = await callGemini(prompt, imageParts);

    // HTML 추출
    let html = '';
    const htmlMatch = text.match(/```html\s*([\s\S]*?)```/);
    if (htmlMatch) {
      html = htmlMatch[1].trim();
    } else if (text.includes('<html') || text.includes('<!DOCTYPE')) {
      html = text;
    } else {
      return res.status(500).json({ error: 'HTML 생성에 실패했습니다. 다시 시도해주세요.' });
    }

    // HTML 파일 저장
    const outputId = Date.now().toString();
    const htmlPath = path.join(DIRS.output, `page_${outputId}.html`);
    fs.writeFileSync(htmlPath, html);

    res.json({
      success: true,
      outputId,
      html,
      htmlPath: `/output/page_${outputId}.html`
    });
  } catch (err) {
    console.error('생성 오류:', err);
    res.status(500).json({ error: 'HTML 생성 중 오류가 발생했습니다. 다시 시도해주세요.' });
  }
});

// ============================================================
// 4) HTML → 긴 JPG 이미지 변환
// ============================================================
app.post('/api/export-jpg', async (req, res) => {
  const { html, outputId } = req.body;
  if (!html) return res.status(400).json({ error: 'HTML 필요' });
  if (outputId && !/^[\w\-]+$/.test(outputId)) return res.status(400).json({ error: '유효하지 않은 outputId' });

  let context = null;
  try {
    const b = await getBrowser();
    context = await b.newContext({ viewport: { width: 860, height: 900 } });
    const page = await context.newPage();

    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const totalHeight = await page.evaluate(() => document.body.scrollHeight);

    // 풀페이지 스크린샷 (PNG) → JPG 변환
    const pngBuffer = await page.screenshot({ fullPage: true, type: 'png' });

    await context.close();
    context = null;

    const jpgFileName = `detail_${outputId || Date.now()}.jpg`;
    const jpgPath = path.join(DIRS.output, jpgFileName);

    await sharp(pngBuffer)
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(jpgPath);

    const stats = fs.statSync(jpgPath);

    res.json({
      success: true,
      fileName: jpgFileName,
      filePath: `/output/${jpgFileName}`,
      fileSize: (stats.size / 1024 / 1024).toFixed(2) + 'MB',
      dimensions: `860 x ${totalHeight}px`
    });
  } catch (err) {
    console.error('JPG 변환 오류:', err);
    res.status(500).json({ error: 'JPG 변환 중 오류가 발생했습니다.' });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// ============================================================
// 5) 이미지 업로드 (플레이스홀더 교체용)
// ============================================================
const uploadStorage = multer.diskStorage({
  destination: DIRS.uploads,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const uploadHandler = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능합니다'));
  }
});

app.post('/api/upload-image', uploadHandler.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '이미지 필요' });
  res.json({
    success: true,
    url: `/uploads/${req.file.filename}`,
    filename: req.file.filename
  });
});

// ============================================================
// 6) 분석 히스토리
// ============================================================
app.get('/api/history', (req, res) => {
  try {
    const files = fs.readdirSync(DIRS.history)
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 20);

    const history = files.flatMap(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DIRS.history, f), 'utf-8'));
        return [{
          sessionId: data.sessionId,
          productName: data.productName,
          platform: data.platform,
          createdAt: data.createdAt
        }];
      } catch {
        return [];
      }
    });

    res.json({ success: true, history });
  } catch (err) {
    res.json({ success: true, history: [] });
  }
});

app.get('/api/history/:sessionId', (req, res) => {
  if (!isValidSessionId(req.params.sessionId)) return res.status(400).json({ error: '유효하지 않은 sessionId' });
  try {
    const filePath = path.join(DIRS.history, `${req.params.sessionId}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '히스토리 없음' });
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('히스토리 조회 오류:', err);
    res.status(500).json({ error: '히스토리 조회 중 오류가 발생했습니다.' });
  }
});

// ============================================================
// 7) 분석 결과 JSON 내보내기
// ============================================================
app.post('/api/export-analysis', (req, res) => {
  const { analysis, sessionId } = req.body;
  if (!analysis) return res.status(400).json({ error: '분석 데이터 필요' });

  const safeId = (sessionId && isValidSessionId(sessionId)) ? sessionId : Date.now();
  const fileName = `analysis_${safeId}.json`;
  const filePath = path.join(DIRS.output, fileName);
  fs.writeFileSync(filePath, JSON.stringify(analysis, null, 2));

  res.json({ success: true, filePath: `/output/${fileName}`, fileName });
});

// ============================================================
// 8) 오래된 세션 자동 정리 (24시간 이상)
// ============================================================
function cleanupOldSessions() {
  const maxAge = 24 * 60 * 60 * 1000; // 24시간
  const now = Date.now();

  [DIRS.screenshots].forEach(dir => {
    fs.readdir(dir, (err, names) => {
      if (err) return;
      names.forEach(name => {
        const fullPath = path.join(dir, name);
        fs.stat(fullPath, (err, stat) => {
          if (err) return;
          if (stat.isDirectory() && (now - stat.mtimeMs) > maxAge) {
            fs.rm(fullPath, { recursive: true, force: true }, () => {
              console.log(`정리됨: ${fullPath}`);
            });
          }
        });
      });
    });
  });
}

// 서버 시작 시 + 6시간마다 정리 (비동기로 실행하여 서버 시작 차단 방지)
setTimeout(cleanupOldSessions, 5000);
setInterval(cleanupOldSessions, 6 * 60 * 60 * 1000);

// sessionId 검증 (Path Traversal 방지)
function isValidSessionId(id) {
  return /^\d+$/.test(id);
}

// ============================================================
// 유틸리티 함수
// ============================================================
function detectPlatform(url) {
  const platforms = [
    ['coupang.com', 'coupang'],
    ['smartstore.naver.com', 'naver'], ['shopping.naver.com', 'naver'], ['brand.naver.com', 'naver'],
    ['wadiz.kr', 'wadiz'],
    ['11st.co.kr', '11st'],
    ['gmarket.co.kr', 'gmarket'],
    ['auction.co.kr', 'auction'],
    ['tmon.co.kr', 'tmon'],
    ['wemakeprice.com', 'wemakeprice'],
    ['aliexpress.com', 'aliexpress'],
    ['ohou.se', 'ohouse'], ['ohouse.com', 'ohouse'],
    ['idus.com', 'idus'],
    ['musinsa.com', 'musinsa'],
  ];
  for (const [domain, name] of platforms) {
    if (url.includes(domain)) return name;
  }
  return 'other';
}

async function dismissPopups(page) {
  const popupSelectors = [
    '[class*="popup"] [class*="close"]',
    '[class*="modal"] [class*="close"]',
    '[class*="cookie"] button',
    '[class*="banner"] [class*="close"]',
    '.layer-close', '.btn-close-layer',
    '[aria-label="닫기"]', '[aria-label="Close"]',
  ];
  for (const sel of popupSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click();
        await page.waitForTimeout(300);
      }
    } catch {}
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      let lastScrollHeight = 0;
      let sameHeightCount = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        const currentScrollHeight = document.body.scrollHeight;
        // 스크롤이 더 이상 늘어나지 않으면 종료
        if (currentScrollHeight === lastScrollHeight) {
          sameHeightCount++;
        } else {
          sameHeightCount = 0;
        }
        lastScrollHeight = currentScrollHeight;
        if (sameHeightCount >= 5 || totalHeight > 100000) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 300);
    });
  });
}

// "더보기"/"상세정보" 버튼 클릭하여 접힌 콘텐츠 펼치기
async function expandDetailContent(page, platform) {
  const expandSelectors = [
    // 공통 더보기/펼치기 버튼
    '[class*="more"]', '[class*="expand"]', '[class*="unfold"]',
    '[class*="view-more"]', '[class*="viewMore"]', '[class*="showMore"]',
    'button[class*="detail"]', '[class*="detail-view"]',
    // 쿠팡
    '.product-detail-content-inside .btn-detail-more',
    '.product-detail__btn--more',
    // 네이버 스마트스토어
    '._27fBte5Cxe', '.more-btn', '._1r13ylLJbY',
    'a[class*="viewMoreBtn"]', 'button[class*="viewMoreBtn"]',
    // 11번가
    '.c_product_view_more button', '#productDescription .more',
    // 와디즈
    '[class*="campaign-detail"] [class*="more"]',
    // 일반 "상세정보 더보기"
    '[data-action="view-more"]', '[data-toggle="detail"]',
  ];

  for (const sel of expandSelectors) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        if (await el.isVisible()) {
          const text = await el.textContent().catch(() => '');
          if (/더보기|펼치기|상세|more|expand|view/i.test(text) || els.length === 1) {
            await el.click().catch(() => {});
            await page.waitForTimeout(500);
          }
        }
      }
    } catch {}
  }

  // 상세정보 탭 클릭 (탭 기반 상세페이지)
  const tabSelectors = [
    '[class*="tab"] a', '[class*="tab"] button', '[role="tab"]',
    '.product-tab li', '.detail-tab li',
  ];
  for (const sel of tabSelectors) {
    try {
      const tabs = await page.$$(sel);
      for (const tab of tabs) {
        const text = await tab.textContent().catch(() => '');
        if (/상세|설명|detail|description|정보/i.test(text)) {
          await tab.click().catch(() => {});
          await page.waitForTimeout(1000);
          break;
        }
      }
    } catch {}
  }
}

// iframe 내 상세 콘텐츠를 메인 페이지에 펼치기
async function expandIframeContent(page) {
  try {
    // iframe 찾기 (쿠팡 vendorItemContentFrame 등)
    const iframeSelectors = [
      'iframe[id*="detail"]', 'iframe[id*="content"]', 'iframe[id*="vendor"]',
      'iframe[name*="detail"]', 'iframe[src*="detail"]',
      'iframe[class*="detail"]', 'iframe[class*="product"]',
    ];
    for (const sel of iframeSelectors) {
      const iframeEl = await page.$(sel);
      if (!iframeEl) continue;

      const frame = await iframeEl.contentFrame();
      if (!frame) continue;

      // iframe 높이를 콘텐츠에 맞게 확장
      await page.evaluate((selector) => {
        const iframe = document.querySelector(selector);
        if (iframe) {
          iframe.style.height = 'auto';
          iframe.style.maxHeight = 'none';
          iframe.style.overflow = 'visible';
          // 부모 컨테이너도 펼치기
          let parent = iframe.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            parent.style.maxHeight = 'none';
            parent.style.overflow = 'visible';
            parent.style.height = 'auto';
            parent = parent.parentElement;
          }
        }
      }, sel);

      // iframe 내부 스크롤하여 lazy-load 트리거
      await frame.evaluate(async () => {
        const distance = 500;
        let total = 0;
        while (total < document.body.scrollHeight && total < 50000) {
          window.scrollBy(0, distance);
          total += distance;
          await new Promise(r => setTimeout(r, 200));
        }
      }).catch(() => {});

      // iframe 높이를 실제 콘텐츠 높이로 설정
      await page.evaluate((selector) => {
        const iframe = document.querySelector(selector);
        if (iframe && iframe.contentDocument) {
          const h = iframe.contentDocument.body.scrollHeight;
          iframe.style.height = h + 'px';
        }
      }, sel).catch(() => {});

      await page.waitForTimeout(1000);
      break; // 첫 번째 상세 iframe만 처리
    }
  } catch {}
}

// 서버 시작
app.listen(PORT, () => {
  console.log(`상세페이지 분석기 서버 실행중: http://localhost:${PORT}`);
});

async function shutdown() {
  if (browser) await browser.close().catch(() => {});
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
