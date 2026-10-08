# Crypto Volume Profile Dashboard

Binance USDT-M 무기한 선물의 확정 캔들을 기반으로 동적 POC와 기술 지표를 계산하는 단일 HTML 대시보드입니다.

## 주요 기능

- 코인 검색과 로컬 즐겨찾기
- 1시간, 4시간, 8시간, 12시간, 24시간, 주간, 월간 차트
- EMA, RSI, MACD, ATR, Bollinger Band
- POC, VAH, VAL과 1~3차 지지선·저항선
- 지역 매물대·다중 스윙·반복 접촉·최근성을 결합한 지지·저항 가격 구간과 강도 점수
- LONG·SHORT 관찰 타점과 변동성 게이트 고승률 필터(저변동 횡보장 신호 제외, 설정에서 ON/OFF)
- 비용 포함 40% 홀드아웃 백테스트와 거래 수·승률(Wilson 95% CI)·손익분기 승률·Profit Factor·기대 R·최대낙폭 표시
- 손절 가격 갭의 불리한 시가 체결과 지표별 신뢰도 감사 스크립트
- 마우스 휠 확대·축소와 차트 드래그 이동
- 모바일 반응형 화면
- PC 전체 폭 3열 카드와 스마트폰 1열 카드로 이어지는 라이트 모드 화면

## 실행

`index.html`을 정적 웹 서버로 열면 됩니다. 시장 데이터는 브라우저에서 Binance Futures 공개 API로 직접 요청합니다.

최신 25개 시장 조합의 지표 신뢰도와 후보 필터 성능은 `npm run audit:backtest`로 다시 검증할 수 있습니다. 상세 방법과 해석은 `BACKTEST_V2_REPORT.md`에 정리되어 있습니다. Wilson 신뢰구간·손익분기·S/R 바운스율·워크포워드 정의까지 포함한 신뢰도 감사는 `npm run audit:reliability`로 재현하며 결과와 해석은 `BACKTEST_V3_REPORT.md`와 `backtest-v3-results.json`에 정리되어 있습니다. 승률 개선 탐색(TRAIN 선택·HOLDOUT 확인, 변동성 게이트+손절 2 ATR 채택)은 `npm run search:winrate`로 재현하며 결과와 해석은 `BACKTEST_V4_REPORT.md`와 `winrate-search-results.json`에 정리되어 있습니다.

이 프로젝트는 학습용 분석 도구이며 투자 조언이 아닙니다.
