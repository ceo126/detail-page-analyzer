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
let browserLaunching = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browserLaunching) return browserLaunching;
  browserLaunching = chromium.launch({ headless: true }).then(b => {
    browser = b;
    browserLaunching = null;
    return b;
  }).catch(err => {
    browserLaunching = null;
    throw err;
  });
  return browserLaunching;
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
        // 와디즈
        '[class*="CampaignTitle"]', '[class*="campaign-title"]', '[class*="FundingTitle"]',
        '[class*="campaignTitle"]', '.wd-detail h2', '.wd-detail h1',
        // 쿠팡/네이버/일반
        'h1', '.prod-buy-header__title', '.topArea_headingArea__*',
        '._22kNQuEXmb', '.item_tit', '#fundingTitle',
        '[class*="product-name"]', '[class*="productName"]', '[class*="item-name"]',
        // 무신사/오늘의집
        '[class*="product_title"]', '[class*="goods_name"]',
        // meta og:title fallback
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
      // fallback: og:title 또는 document.title
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
    const fullBuffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 70 });
    fs.writeFileSync(fullPath, fullBuffer);
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
    res.status(500).json({ error: 'JPG 변환 중 오류가 발생했습니다.' });
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

async function shutdown() {
  if (browser) await browser.close();
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
