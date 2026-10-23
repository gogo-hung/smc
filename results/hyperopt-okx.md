# Hyperopt（Optuna TPE，800 組，train < 2026-06-20 ≤ test，分數＝t 值，筆數 < 60 扣分）

| 設定 | train 筆數 | train 勝率 | train R | train 分數 | test 筆數 | test 勝率 | test R | test 每筆 | test 回撤 |
|---|---|---|---|---|---|---|---|---|---|
| B 你改的版本（基準） | 72 | 40% | +0.8 | 0.09 | 54 | 41% | +6.2 | +0.11 | -4.2 |
| 第 1 名 #790 | 142 | 54% | +84.1 | 4.55 | 113 | 35% | +8.3 | +0.07 | -14.9 |
| 第 2 名 #265 | 255 | 49% | +107.3 | 4.23 | 198 | 31% | -7.6 | -0.04 | -31.7 |
| 第 3 名 #690 | 146 | 54% | +74.9 | 4.18 | 120 | 32% | -4.7 | -0.04 | -28.6 |
| 第 4 名 #514 | 129 | 54% | +70.3 | 4.13 | 110 | 35% | +3.8 | +0.03 | -17.3 |
| 第 5 名 #678 | 220 | 50% | +97.6 | 4.11 | 174 | 34% | +3.0 | +0.02 | -31.2 |
| 第 6 名 #744 | 180 | 53% | +80.0 | 4.09 | 143 | 35% | -0.9 | -0.01 | -24.6 |
| 第 7 名 #445 | 264 | 50% | +98.8 | 4.07 | 199 | 34% | -4.5 | -0.02 | -31.9 |
| 第 8 名 #781 | 214 | 54% | +81.9 | 4.06 | 172 | 38% | -2.8 | -0.02 | -26.8 |
| 第 9 名 #663 | 155 | 53% | +75.9 | 4.05 | 119 | 34% | +3.3 | +0.03 | -21.6 |
| 第 10 名 #749 | 177 | 51% | +78.4 | 3.95 | 133 | 38% | +11.8 | +0.09 | -18.6 |
| 第 11 名 #653 | 116 | 53% | +65.5 | 3.94 | 98 | 33% | +0.4 | +0.00 | -18.4 |
| 第 12 名 #780 | 175 | 54% | +72.9 | 3.93 | 131 | 37% | +3.4 | +0.03 | -20.3 |
| 第 13 名 #207 | 316 | 53% | +92.8 | 3.91 | 232 | 38% | -9.2 | -0.04 | -35.5 |
| 第 14 名 #706 | 139 | 51% | +71.9 | 3.90 | 115 | 34% | +4.9 | +0.04 | -16.9 |
| 第 15 名 #506 | 169 | 50% | +77.5 | 3.89 | 131 | 32% | -6.3 | -0.05 | -25.8 |
| 第 16 名 #571 | 260 | 47% | +106.7 | 3.89 | 185 | 29% | -28.6 | -0.15 | -34.8 |
| 第 17 名 #254 | 276 | 52% | +89.4 | 3.87 | 209 | 38% | -6.5 | -0.03 | -29.3 |
| 第 18 名 #549 | 338 | 49% | +105.5 | 3.86 | 251 | 36% | -4.8 | -0.02 | -31.1 |
| 第 19 名 #197 | 389 | 47% | +115.6 | 3.86 | 275 | 33% | -21.1 | -0.08 | -53.5 |
| 第 20 名 #687 | 208 | 44% | +104.6 | 3.84 | 163 | 24% | -33.8 | -0.21 | -54.0 |

train 前 10 名裡 test 賺錢的：5/10；前 20 名：8/20；全部 800 組 train 分數和 test R 的相關：0.17

## 前 5 名參數

1. `{"mtfFib": 0.715, "mtfBand": 0.57, "mtfEntry": "f618", "mtfReLo": 0.3, "stopBuf": 2.3, "mtfMinRR": 1.3, "mtfWait": 72, "mtfSweep": "off", "mtfReact": "off", "mtfReactBars": 15, "mtfBe": "off", "mtfTarget": "htf", "mtfTp2": "off", "mtfSwing": 2, "htfSwing": 2, "mtfDisp": 0.0, "btcFilter": "block", "mtfPoiSrc": "choch"}`
2. `{"mtfFib": 0.7, "mtfBand": 0.635, "mtfEntry": "f618", "mtfReLo": 0, "stopBuf": 1.9, "mtfMinRR": 1.0, "mtfWait": 16, "mtfSweep": "on", "mtfReact": "on", "mtfReactBars": 12, "mtfBe": "off", "mtfTarget": "htf", "mtfTp2": "off", "mtfSwing": 2, "htfSwing": 2, "mtfDisp": 0.0, "btcFilter": "block", "mtfPoiSrc": "all"}`
3. `{"mtfFib": 0.705, "mtfBand": 0.56, "mtfEntry": "edge", "mtfReLo": 0.236, "stopBuf": 2.4, "mtfMinRR": 1.1, "mtfWait": 24, "mtfSweep": "off", "mtfReact": "off", "mtfReactBars": 15, "mtfBe": "off", "mtfTarget": "htf", "mtfTp2": "off", "mtfSwing": 2, "htfSwing": 2, "mtfDisp": 0.0, "btcFilter": "block", "mtfPoiSrc": "choch"}`
4. `{"mtfFib": 0.67, "mtfBand": 0.5, "mtfEntry": "edge", "mtfReLo": 0.236, "stopBuf": 2.4, "mtfMinRR": 1.2, "mtfWait": 40, "mtfSweep": "off", "mtfReact": "on", "mtfReactBars": 15, "mtfBe": "off", "mtfTarget": "htf", "mtfTp2": "off", "mtfSwing": 2, "htfSwing": 2, "mtfDisp": 0.0, "btcFilter": "block", "mtfPoiSrc": "choch"}`
5. `{"mtfFib": 0.695, "mtfBand": 0.625, "mtfEntry": "edge", "mtfReLo": 0.5, "stopBuf": 1.9, "mtfMinRR": 1.0, "mtfWait": 40, "mtfSweep": "off", "mtfReact": "on", "mtfReactBars": 18, "mtfBe": "off", "mtfTarget": "htf", "mtfTp2": "on", "mtfSwing": 2, "htfSwing": 2, "mtfDisp": 0.0, "btcFilter": "block", "mtfPoiSrc": "choch"}`

## 參數重要性（對 train 分數）

- mtfTarget: 0.82
- mtfDisp: 0.07
- mtfMinRR: 0.02
- htfSwing: 0.02
- btcFilter: 0.01
- mtfEntry: 0.01
- mtfBand: 0.01
- mtfReactBars: 0.01
- stopBuf: 0.01
- mtfReLo: 0.00