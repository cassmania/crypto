const assert=require('node:assert/strict');
const {resolveTradeExit,aggregateRows}=require('../scripts/backtest-v2-audit.js');
const {wilsonInterval,breakevenWinRate,twoSidedPvs50}=require('../scripts/backtest-v3-reliability.js');
const candles=[100,101,102,500].map((close,i)=>({time:i,closeTime:i,open:close,close,high:close+1,low:close-1}));
const signal={type:'LONG',entryIndex:0,price:100,invalidation:90,target:110};
const bounded=resolveTradeExit(candles,signal,3);
assert.deepEqual(bounded,{exitIndex:2,exitPrice:102,exitReason:'BOUNDARY'});
assert.deepEqual(resolveTradeExit(candles.slice(0,3),signal),bounded);
const rows=[{trades:[{exitTime:1,netR:-2},{exitTime:3,netR:3}]},{trades:[{exitTime:2,netR:-2}]}];
assert.equal(aggregateRows(rows).maxDrawdownR,4);
assert.equal(aggregateRows([...rows].reverse()).maxDrawdownR,4);
// V3 신뢰도 헬퍼: Wilson CI는 50% 표본에서 50%를 포함하고, 손익분기식은 무비용 33.33%를 반환한다.
const ci = wilsonInterval(50, 100);
assert.ok(ci.lower < 50 && 50 < ci.upper, 'Wilson CI는 50/100에서 50%를 포함해야 한다');
assert.ok(Math.abs(breakevenWinRate(3, 1.5, 0) - 33.3333) < 0.01, '무비용 손익분기 승률은 33.33%여야 한다');
assert.ok(breakevenWinRate(3, 1.5, 0.054) > 34 && breakevenWinRate(3, 1.5, 0.054) < 35, '비용 포함 분기는 약 34.5%여야 한다');
assert.ok(twoSidedPvs50(50, 100) > 0.9, '50/100의 p값은 1에 가까워야 한다');
assert.ok(twoSidedPvs50(30, 100) < 0.05, '30/100의 p값은 유의해야 한다');
console.log('감사 경계 청산·미래 차단·시장 합산 시간순 테스트 통과');
