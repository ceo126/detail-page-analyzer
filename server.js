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

// 브라우저 관리
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

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
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
      return res.status(400).json({ error: '내부 네트워크 URL은 접근할 수 없습니다' });
    }
  } catch {
    return res.status(400).json({ error: '올바른 URL 형식이 아닙니다' });
  }

  let context = null;
  try {
    const b = await getBrowser();
    context = await b.newContext({
      viewport: { width: 1400, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-platform': '"Windows"',
      }
    });
    const page = await context.newPage();

    // 팝업/다이얼로그 자동 닫기
    page.on('dialog', async dialog => {
      await dialog.dismiss().catch(() => {});
    });

    // domcontentloaded로 먼저 로드 후, networkidle 대기 시도 (실패해도 진행)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);

    // 플랫폼 감지
    const platform = detectPlatform(url);

    // 쿠키/팝업 자동 닫기
    await dismissPopups(page);

    // 자동 스크롤 (lazy load 이미지 로딩)
    await autoScroll(page);

    // HTML 텍스트 추출
    const pageData = await page.evaluate((platform) => {
      const data = {
        title: document.title,
        texts: [],
        images: [],
        platform: platform
      };

      // 제목 추출
      const titleSelectors = [
        'h1', '.prod-buy-header__title', '.topArea_headingArea__*',
        '._22kNQuEXmb', '.item_tit', '#fundingTitle',
        '[class*="product-name"]', '[class*="productName"]', '[class*="item-name"]'
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

      // 본문 텍스트
      const textEls = document.querySelectorAll('p, h1, h2, h3, h4, li, span, td, th');
      textEls.forEach(el => {
        const t = el.textContent.trim();
        if (t.length > 5 && t.length < 500) data.texts.push(t);
      });
      data.texts = [...new Set(data.texts)].slice(0, 100);

      // 상세 이미지 수집
      const imgs = document.querySelectorAll('img');
      imgs.forEach(img => {
        const src = img.src || img.dataset?.src || img.dataset?.lazySrc || '';
        if (src && !src.includes('icon') && !src.includes('logo') && !src.includes('svg') &&
            img.naturalWidth > 200) {
          data.images.push(src);
        }
      });
      data.images = [...new Set(data.images)].slice(0, 50);

      return data;
    }, platform);

    // 전체 페이지 스크린샷 (분할) - 갭 없이
    const sessionId = Date.now().toString();
    const screenshotDir = path.join(DIRS.screenshots, sessionId);
    fs.mkdirSync(screenshotDir, { recursive: true });

    // 풀페이지 스크린샷
    const fullPath = path.join(screenshotDir, 'full_page.jpg');
    await page.screenshot({ path: fullPath, fullPage: true, type: 'jpeg', quality: 70 });

    // 풀페이지 이미지를 sharp로 분할 (갭 없음 보장)
    const fullBuffer = fs.readFileSync(fullPath);
    const metadata = await sharp(fullBuffer).metadata();
    const totalHeight = metadata.height;
    const chunkHeight = 1200;
    const numChunks = Math.min(Math.ceil(totalHeight / chunkHeight), 15);

    for (let i = 0; i < numChunks; i++) {
      const top = i * chunkHeight;
      const height = Math.min(chunkHeight, totalHeight - top);
      if (height <= 0) break;

      const chunkPath = path.join(screenshotDir, `screenshot_${i}.jpg`);
      await sharp(fullBuffer)
        .extract({ left: 0, top, width: metadata.width, height })
        .jpeg({ quality: 80 })
        .toFile(chunkPath);
    }

    await context.close();
    context = null;

    res.json({
      success: true,
      sessionId,
      platform,
      pageData,
      screenshotCount: numChunks,
      totalHeight
    });
  } catch (err) {
    console.error('크롤링 오류:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

// ============================================================
// 2) Gemini Vision으로 상세페이지 분석
// ============================================================
app.post('/api/analyze', async (req, res) => {
  const { sessionId, pageData } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId 필요' });

  try {
    const screenshotDir = path.join(DIRS.screenshots, sessionId);
    if (!fs.existsSync(screenshotDir)) {
      return res.status(400).json({ error: '스크린샷을 찾을 수 없습니다. 다시 크롤링해주세요.' });
    }

    const files = fs.readdirSync(screenshotDir)
      .filter(f => f.startsWith('screenshot_'))
      .sort()
      .slice(0, 10);

    // 이미지를 base64로 변환
    const imageParts = [];
    for (const file of files) {
      const filePath = path.join(screenshotDir, file);
      const buffer = fs.readFileSync(filePath);
      const resized = await sharp(buffer)
        .resize(1000, null, { withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      imageParts.push({
        inlineData: {
          data: resized.toString('base64'),
          mimeType: 'image/jpeg'
        }
      });
    }

    const prompt = `당신은 쇼핑몰 상세페이지 분석 전문가입니다.
아래 스크린샷은 하나의 상품 상세페이지를 위에서부터 순서대로 캡처한 것입니다.
${pageData ? `\n추출된 텍스트 정보:\n- 제품명: ${pageData.productName || '알 수 없음'}\n- 가격: ${pageData.price || '알 수 없음'}\n- 본문 텍스트: ${(pageData.texts || []).slice(0, 30).join(' / ')}` : ''}

다음 항목을 분석하여 **반드시 아래 JSON 형식으로만** 응답하세요:

{
  "product": {
    "name": "제품명",
    "price": "가격",
    "originalPrice": "원래 가격 (할인 전)",
    "category": "카테고리",
    "brand": "브랜드명"
  },
  "design": {
    "tone": "전체적인 디자인 톤 (예: 미니멀, 고급스러운, 귀여운 등)",
    "mainColors": ["#hex1", "#hex2", "#hex3"],
    "backgroundColor": "#배경색",
    "fontStyle": "폰트 스타일 설명",
    "imageStyle": "이미지 스타일 (제품컷, 라이프스타일, 일러스트 등)"
  },
  "structure": [
    {
      "section": "섹션명 (예: 히어로 배너, 특징 나열, 비교표 등)",
      "description": "해당 섹션에 어떤 내용이 들어가 있는지",
      "layout": "레이아웃 설명 (가로 배치, 세로 나열 등)"
    }
  ],
  "copywriting": {
    "headlineStyle": "헤드라인 스타일 (질문형, 숫자 강조 등)",
    "toneOfVoice": "어조 (친근한, 전문적인, 유머러스 등)",
    "keyPhrases": ["핵심 문구1", "핵심 문구2"],
    "sellingPoints": ["셀링 포인트1", "셀링 포인트2", "셀링 포인트3"]
  },
  "target": {
    "audience": "타겟 고객층",
    "painPoints": ["해결하는 고객 고민1", "고민2"],
    "benefits": ["핵심 혜택1", "혜택2"]
  },
  "overall": {
    "strengths": ["이 상세페이지의 장점1", "장점2"],
    "weaknesses": ["개선할 점1", "개선할 점2"],
    "score": 85,
    "summary": "전체 상세페이지에 대한 종합 평가 2-3줄"
  }
}`;

    const text = await callGemini(prompt, imageParts);

    // JSON 추출
    let analysis;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysis = JSON.parse(jsonMatch[0]);
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
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 3) 분석 결과 기반 상세페이지 HTML 생성
// ============================================================
app.post('/api/generate', async (req, res) => {
  const { analysis, userEdits } = req.body;
  if (!analysis) return res.status(400).json({ error: '분석 데이터 필요' });

  try {
    const editInstructions = userEdits ? `\n\n사용자 수정 요청:\n${userEdits}` : '';

    const prompt = `당신은 쇼핑몰 상세페이지 전문 디자이너입니다.
아래 분석 결과를 바탕으로 자사몰용 상세페이지 HTML을 생성하세요.

분석 결과:
${JSON.stringify(analysis, null, 2)}
${editInstructions}

요구사항:
1. 폭 860px (자사몰 상세페이지 표준 너비)
2. 세로로 긴 단일 페이지 형태
3. 분석된 구조(structure)를 따르되, 더 효과적인 배치로 개선
4. 분석된 디자인 톤과 컬러를 반영
5. 분석된 카피라이팅 스타일을 반영하여 텍스트 작성
6. 셀링 포인트를 효과적으로 강조
7. 이미지 영역은 플레이스홀더로 표시 (회색 박스 + "이미지 영역" 텍스트, 각 플레이스홀더에 data-placeholder-id="1", "2"... 속성 추가)
8. 모든 텍스트는 한국어
9. inline CSS만 사용 (외부 CSS 없음)
10. 배경색, 구분선, 아이콘(이모지 활용) 등으로 시각적으로 풍성하게

반드시 완전한 HTML 코드만 출력하세요. \`\`\`html 태그로 감싸세요.
<html>부터 </html>까지 포함.`;

    const text = await callGemini(prompt);

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
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4) HTML → 긴 JPG 이미지 변환
// ============================================================
app.post('/api/export-jpg', async (req, res) => {
  const { html, outputId } = req.body;
  if (!html) return res.status(400).json({ error: 'HTML 필요' });

  let context = null;
  try {
    const b = await getBrowser();
    context = await b.newContext({
      viewport: { width: 860, height: 900 }
    });
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
    res.status(500).json({ error: err.message });
  } finally {
    if (context) await context.close().catch(() => {});
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

    const history = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(DIRS.history, f), 'utf-8'));
      return {
        sessionId: data.sessionId,
        productName: data.productName,
        platform: data.platform,
        createdAt: data.createdAt
      };
    });

    res.json({ success: true, history });
  } catch (err) {
    res.json({ success: true, history: [] });
  }
});

app.get('/api/history/:sessionId', (req, res) => {
  try {
    const filePath = path.join(DIRS.history, `${req.params.sessionId}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '히스토리 없음' });
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 7) 분석 결과 JSON 내보내기
// ============================================================
app.post('/api/export-analysis', (req, res) => {
  const { analysis, sessionId } = req.body;
  if (!analysis) return res.status(400).json({ error: '분석 데이터 필요' });

  const fileName = `analysis_${sessionId || Date.now()}.json`;
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
    try {
      fs.readdirSync(dir).forEach(name => {
        const fullPath = path.join(dir, name);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && (now - stat.mtimeMs) > maxAge) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          console.log(`정리됨: ${fullPath}`);
        }
      });
    } catch {}
  });
}

// 서버 시작 시 + 6시간마다 정리
cleanupOldSessions();
setInterval(cleanupOldSessions, 6 * 60 * 60 * 1000);

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
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight || totalHeight > 30000) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 200);
    });
  });
}

// 서버 시작
app.listen(PORT, () => {
  console.log(`상세페이지 분석기 서버 실행중: http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit();
});
