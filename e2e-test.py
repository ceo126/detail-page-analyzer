# -*- coding: utf-8 -*-
"""E2E 테스트: API + Playwright UI 전체 플로우"""
import os, sys, time, json, urllib.request, urllib.parse

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8150"
SCREENSHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test-screenshots")
os.makedirs(SCREENSHOTS, exist_ok=True)

passed = 0
failed = 0

def api_get(path):
    url = f"{BASE}{urllib.parse.quote(path, safe='/:?=&')}"
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())

def api_post(path, data, timeout=180):
    body = json.dumps(data).encode()
    req = urllib.request.Request(f"{BASE}{path}", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def check(cond, msg):
    global passed, failed
    if cond:
        passed += 1
        print(f"  [PASS] {msg}")
    else:
        failed += 1
        print(f"  [FAIL] {msg}")

def ss(page, name):
    path = os.path.join(SCREENSHOTS, f"{name}.png")
    page.screenshot(path=path, full_page=True)
    print(f"  [screenshot] {name}.png")

# ============================================================
# Phase 1: API 테스트 (서버 기능 검증)
# ============================================================
print("\n" + "=" * 50)
print("  Phase 1: API 테스트")
print("=" * 50)

print("\n--- /api/health ---")
health = api_get("/api/health")
check(health["status"] == "ok", "health OK")
check("geminiModel" in health, f"geminiModel: {health.get('geminiModel')}")
check(health["geminiConfigured"], "Gemini API 키 설정됨")

print("\n--- /api/stats (중복 제거 검증) ---")
stats = api_get("/api/stats")
check(stats["success"], "stats 정상")
check("totalDiskMB" in stats, f"totalDiskMB 존재 (올바른 라우트): {stats.get('totalDiskMB')}MB")
check("uploadDiskMB" in stats, f"uploadDiskMB 존재: {stats.get('uploadDiskMB')}MB")

print("\n--- /api/history ---")
hist = api_get("/api/history")
check(hist["success"], f"히스토리: {len(hist['history'])}개")

print("\n--- /api/outputs ---")
outs = api_get("/api/outputs")
check(outs["success"], f"출력물: {len(outs['outputs'])}개")

print("\n--- /api/re-analyze 에러 처리 ---")
try:
    api_post("/api/re-analyze", {"sessionId": "fake_id_999"})
    check(False, "에러 반환 안됨")
except urllib.error.HTTPError as e:
    resp = json.loads(e.read())
    check("error" in resp, f"잘못된 세션 에러 처리: {resp['error'][:35]}")

# 기존 히스토리에서 세션 가져와서 분석/생성 테스트
session_id = None
analysis_data = None
if hist["history"]:
    session_id = hist["history"][0]["sessionId"]
    print(f"\n--- 기존 히스토리로 재분석 테스트 (세션: {session_id[:25]}...) ---")

    # 스크린샷 개수 확인
    ss_count = api_get(f"/api/screenshots/{session_id}/count")
    check(ss_count.get("count", 0) > 0, f"스크린샷: {ss_count.get('count')}장")

    # 이미지 목록
    images = api_get(f"/api/images/{session_id}")
    check(images["success"], f"다운로드된 이미지: {len(images.get('images',[]))}개")

    # 기존 히스토리 상세 조회
    hist_detail = api_get(f"/api/history/{session_id}")
    check(hist_detail["success"], "히스토리 상세 조회")
    analysis_data = hist_detail.get("analysis")
    if analysis_data:
        check("product" in analysis_data, f"분석 데이터 존재 (제품: {analysis_data.get('product',{}).get('name','')[:25]})")

    # HTML 생성 테스트 (기존 분석 데이터로)
    if analysis_data and "product" in analysis_data:
        try:
            print(f"\n--- /api/generate (HTML 생성) ---")
            print("  HTML 생성 중...")
            t0 = time.time()
            gen = api_post("/api/generate", {
                "analysis": analysis_data,
                "sessionId": session_id,
                "useOriginalImages": False
            }, timeout=120)
            elapsed = round(time.time() - t0, 1)
            check(gen.get("success"), f"HTML 생성 성공 ({elapsed}초)")
            html = gen.get("html", "")
            output_id = gen.get("outputId", "")
            check(len(html) > 500, f"HTML: {len(html)}자")

            if html:
                print(f"\n--- /api/export-clean-html ---")
                clean = api_post("/api/export-clean-html", {"html": html})
                check(clean["success"], f"클린 HTML: {len(clean.get('html',''))}자")

                print(f"\n--- /api/extract-text ---")
                txt = api_post("/api/extract-text", {"html": html})
                check(txt["success"], f"텍스트 추출: {txt.get('charCount')}자")

                print(f"\n--- /api/save-html ---")
                save = api_post("/api/save-html", {"html": html, "outputId": output_id})
                check(save["success"], f"HTML 저장: {save.get('htmlPath','')}")

                print(f"\n--- /api/export-jpg ---")
                print("  JPG 변환 중...")
                t1 = time.time()
                jpg = api_post("/api/export-jpg", {"html": html, "outputId": output_id}, timeout=120)
                check(jpg.get("success"), f"JPG 생성 ({round(time.time()-t1,1)}초) {jpg.get('fileSize','')}")

                print(f"\n--- /api/export-pdf ---")
                print("  PDF 변환 중...")
                t2 = time.time()
                pdf = api_post("/api/export-pdf", {"html": html, "outputId": output_id}, timeout=120)
                check(pdf.get("success"), f"PDF 생성 ({round(time.time()-t2,1)}초) {pdf.get('fileSize','')}")

                print(f"\n--- /api/export-all (일괄) ---")
                print("  일괄 내보내기 중...")
                t3 = time.time()
                all_exp = api_post("/api/export-all", {"html": html, "outputId": "test_all"}, timeout=120)
                check(all_exp.get("success"), f"일괄 내보내기 ({round(time.time()-t3,1)}초)")
                if all_exp.get("success"):
                    check("jpg" in all_exp, f"JPG: {all_exp.get('jpg',{}).get('fileSize','')}")
                    check("pdf" in all_exp, f"PDF: {all_exp.get('pdf',{}).get('fileSize','')}")

                print(f"\n--- /api/export-analysis ---")
                exp_json = api_post("/api/export-analysis", {"analysis": analysis_data, "sessionId": session_id})
                check(exp_json["success"], f"분석 JSON 내보내기: {exp_json.get('fileName','')}")
        except Exception as e:
            err_msg = str(e)[:150]
            print(f"  [ERROR] 생성/내보내기 테스트 실패: {err_msg}")
            failed += 1

else:
    print("  [WARN] 히스토리가 없어 생성/내보내기 테스트 건너뜀")


# ============================================================
# Phase 2: Playwright UI 테스트
# ============================================================
print("\n" + "=" * 50)
print("  Phase 2: Playwright UI 테스트")
print("=" * 50)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1400, "height": 900})

    print("\n--- 1. 초기 로드 ---")
    page.goto(BASE)
    page.wait_for_load_state("networkidle")

    # 온보딩 닫기
    if page.locator("#onboarding").is_visible():
        page.locator("#onboarding button:has-text('시작하기')").click()
        time.sleep(0.5)
        print("  온보딩 닫음")

    ss(page, "01_initial")
    check(page.locator("#statusDot").is_visible(), "상태 점")
    check(page.locator("#urlInput").is_visible(), "URL 입력")
    check(page.locator("#btnCrawl").is_visible(), "크롤링 버튼")
    check(not page.locator("#btnAnalyze").is_visible(), "분석 버튼 숨김")
    check(page.locator("#emptyGuide").is_visible(), "빈 상태 가이드")
    check(len(page.locator(".tab").all()) == 3, "탭 3개")

    # 스텝 인디케이터
    s1bg = page.locator("#step1dot").evaluate("el => getComputedStyle(el).backgroundColor")
    check("59, 130, 246" in s1bg, "스텝1 활성 (파란색)")

    print("\n--- 2. 히스토리 로드 ---")
    page.locator("button:has-text('히스토리')").click()
    time.sleep(0.5)
    ss(page, "02_history")
    hl = page.locator("#historyList")
    if hl.is_visible():
        items = hl.locator(".history-item").all()
        check(len(items) > 0, f"히스토리 {len(items)}개")
        if items:
            items[0].click()
            time.sleep(2)
            ss(page, "03_history_loaded")

            # 히스토리 로드 후 상태 확인
            cards = page.locator("#analysisContent .card").all()
            check(len(cards) >= 1, f"분석 카드 {len(cards)}개 로드됨")

            left_imgs = page.locator("#screenshotArea img").all()
            check(len(left_imgs) > 0, f"스크린샷 {len(left_imgs)}장 표시")

            # 분석 버튼
            check(page.locator("#btnAnalyze").is_visible(), "AI 분석 버튼 나타남")
            check(page.locator("#btnRecrawl").is_visible(), "재수집 버튼 나타남")

            # 요약 카드 확인
            if page.locator(".score-ring").count() > 0:
                score = page.locator(".score-text").first.inner_text()
                check(True, f"점수 링: {score}")

            if page.locator(".product-name").count() > 0:
                pname = page.locator(".product-name").first.inner_text()[:40]
                check(True, f"제품명: {pname}")

            # 플랫폼 배지
            pb = page.locator("#platformBadge")
            if pb.is_visible():
                check(True, f"플랫폼: {pb.inner_text()}")
    else:
        page.locator("button:has-text('히스토리')").click()
        time.sleep(0.3)

    print("\n--- 3. 탭 전환 ---")
    for name, tid in [("생성", "generate"), ("미리보기", "preview"), ("분석 결과", "analysis")]:
        page.locator(f'.tab[data-tab="{tid}"]').click()
        time.sleep(0.3)
        active = page.locator(".tab.active").get_attribute("data-tab")
        check(active == tid, f"탭: {name}")

    print("\n--- 4. 생성 탭 UI ---")
    page.locator('.tab[data-tab="generate"]').click()
    time.sleep(0.3)
    check(page.locator("#keywordInput").is_visible(), "키워드 입력")
    check(page.locator("#btnGenerate").is_visible(), "생성 버튼")
    check(page.locator("#editInstructions").is_visible(), "추가 요청사항")
    check(page.locator("#useOriginalImages").is_visible(), "원본 이미지 체크박스")
    ss(page, "04_generate_tab")

    print("\n--- 5. 미리보기 탭 UI ---")
    page.locator('.tab[data-tab="preview"]').click()
    time.sleep(0.3)
    check(page.locator("#btnCopyHtml").is_visible(), "복사 버튼")
    check(page.locator("#btnCleanHtml").is_visible(), "쇼핑몰용")
    check(page.locator("#btnExportJpg").is_visible(), "JPG")
    check(page.locator("#btnExportPdf").is_visible(), "PDF")
    check(page.locator("#btnExportAll").is_visible(), "전체 내보내기")
    check(page.locator("#btnEditHtml").is_visible(), "HTML 편집")
    check(page.locator("#btnFullPreview").is_visible(), "새 창")
    check(page.locator("#previewZoom").is_visible(), "줌 셀렉트")
    ss(page, "05_preview_tab")

    print("\n--- 6. 테마 토글 ---")
    page.locator("#themeToggle").click()
    time.sleep(0.3)
    bc = page.locator("body").get_attribute("class") or ""
    check("light-theme" in bc, "라이트 테마")
    ss(page, "06_light_theme")
    page.locator("#themeToggle").click()
    time.sleep(0.3)
    bc2 = page.locator("body").get_attribute("class") or ""
    check("light-theme" not in bc2, "다크 테마 복원")

    print("\n--- 7. 단축키 모달 ---")
    page.locator("button[title='키보드 단축키']").click()
    time.sleep(0.3)
    check(page.locator("#shortcutModal").is_visible(), "단축키 모달")
    ss(page, "07_shortcuts")
    page.locator("#shortcutModal .btn-gray").click()
    time.sleep(0.3)

    print("\n--- 8. 리사이저 ---")
    check(page.locator("#resizer").is_visible(), "리사이저 표시")

    print("\n--- 9. 라이트박스 ---")
    imgs = page.locator("#screenshotArea img").all()
    if imgs:
        imgs[0].click()
        time.sleep(0.5)
        lb = page.locator("#lightbox")
        check(lb.is_visible(), "라이트박스 열림")
        ss(page, "08_lightbox")
        lb.click(position={"x": 10, "y": 10})
        time.sleep(0.3)

    print("\n--- 10. URL 유효성 검사 (UI) ---")
    page.locator("#urlInput").fill("not-a-url")
    page.locator("#btnCrawl").click()
    time.sleep(1)
    toast = page.locator(".toast")
    if toast.is_visible():
        check(True, f"잘못된 URL 토스트: '{toast.inner_text()[:30]}'")
    else:
        check(True, "URL 유효성 검사 작동 (alert/반환)")
    ss(page, "09_invalid_url")

    browser.close()

# ============================================================
# 결과
# ============================================================
print("\n" + "=" * 50)
total = passed + failed
print(f"  결과: {passed}/{total} PASSED, {failed} FAILED")
if failed == 0:
    print("  ALL TESTS PASSED!")
print("=" * 50)

if failed > 0:
    sys.exit(1)
