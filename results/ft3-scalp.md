# 網路短線策略回測（freqtrade、OKX 合約 5 分鐘、30 個主流幣、2025/1 ～ 現在、同時最多 5 筆、每筆 100U、初始 1000U、手續費 0.022%）

| 策略 | 筆數 | 勝率 | 2025 | 2026 | 全部（U） | 多單 | 空單 | 最大單筆虧 | 最長連虧 | 止損出場 | 平均抱幾小時 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| NostalgiaForInfinityX8 | 364 | 99% | +1029U | +280U | +1309U | 291 筆 +1269U（勝率 99%） | 73 筆 +40U（勝率 99%） | -17.7% | 1 | 0 筆 +0U | 50.9 |

## NostalgiaForInfinityX8

**出場原因**

| 原因 | 筆數 | 合計 |
|---|---|---|
| exit_profit_long_scalp_t_0_1_m ( 173 ) | 64 | +65U |
| exit_profit_long_tc_t_0_1_m ( 145 ) | 15 | +12U |
| exit_profit_long_tc_t_0_1_m ( 142 ) | 13 | +14U |
| exit_profit_long_scalp_t_1_1_m ( 173 ) | 12 | +39U |
| exit_profit_long_tc_t_0_1_m ( 141 ) | 10 | +14U |
| exit_short_rapid_rpd_6 ( 605 ) | 10 | +34U |
| exit_profit_short_rebuy_t_0_1_m ( 562 ) | 9 | +3U |
| exit_long_tc_d_5_1 ( 142 ) | 8 | +95U |
| exit_long_tc_u_1 ( 141 ) | 7 | +21U |
| exit_profit_long_tc_t_0_1_m ( 144 ) | 6 | +4U |
| exit_short_rapid_rpd_2 ( 605 ) | 6 | +14U |
| exit_short_rapid_rpd_3 ( 605 ) | 6 | +10U |
| exit_profit_long_rebuy_t_0_1_m ( 64 ) | 6 | +3U |
| exit_profit_long_tc_t_1_1_m ( 142 ) | 4 | +12U |
| exit_profit_long_tc_t_0_1_m ( 141 142 ) | 4 | +5U |
| exit_short_rebuy_1_1_1 ( 562 ) | 4 | +15U |
| exit_short_rapid_rpd_8 ( 605 ) | 4 | +6U |
| exit_short_rebuy_2_1_1 ( 562 ) | 4 | +10U |
| exit_profit_long_scalp_t_2_1_m ( 173 ) | 4 | +22U |
| exit_long_tc_d_5_1 ( 145 ) | 4 | +49U |
| exit_long_scalp_2_1_1 ( 173 ) | 4 | +34U |
| exit_long_rebuy_d_6_1 ( 63 ) | 4 | +20U |
| exit_long_tc_u_1 ( 142 ) | 3 | +7U |
| exit_profit_long_tc_t_0_1_m ( 143 ) | 3 | +3U |
| exit_long_tc_d_6_1 ( 142 ) | 3 | +42U |
| exit_long_tc_d_5_1 ( 141 ) | 3 | +37U |
| exit_short_rapid_rpd_7 ( 605 ) | 3 | +10U |
| exit_profit_short_rebuy_t_1_1_m ( 562 ) | 3 | +3U |
| exit_profit_long_tc_t_2_1_m ( 145 ) | 3 | +19U |
| exit_long_grind_g ( 120 ) | 3 | +45U |
| exit_long_scalp_d_3_1 ( 173 ) | 3 | +24U |
| exit_profit_short_rebuy_t_2_1_m ( 562 ) | 3 | +6U |
| exit_long_tc_d_6_1 ( 145 ) | 3 | +44U |
| exit_long_tc_u_1 ( 143 ) | 3 | +8U |
| exit_long_tc_d_4_1 ( 145 ) | 2 | +20U |
| exit_long_rebuy_e_r ( 65 ) | 2 | +4U |
| exit_profit_short_rebuy_t_3_1_m ( 562 ) | 2 | +5U |
| exit_long_tc_d_6_1 ( 144 ) | 2 | +29U |
| exit_long_tc_d_5_1 ( 62 144 ) | 2 | +23U |
| exit_long_tc_d_5_1 ( 144 ) | 2 | +24U |
| exit_profit_long_tc_t_2_1_m ( 144 ) | 2 | +10U |
| exit_long_tc_d_3_1 ( 145 ) | 2 | +16U |
| exit_profit_long_rebuy_t_0_1_m ( 62 ) | 2 | +0U |
| exit_short_rapid_rpd_9 ( 605 ) | 2 | +3U |
| exit_long_normal_u_1 ( 2 ) | 2 | +6U |
| exit_profit_long_scalp_t_0_1_m ( 163 ) | 2 | +1U |
| exit_short_rebuy_o_1 ( 562 ) | 2 | +3U |
| exit_long_tc_u_2 ( 141 ) | 2 | +11U |
| exit_long_tc_3_1_1 ( 143 ) | 2 | +8U |
| exit_long_tc_d_3_1 ( 141 ) | 2 | +16U |
| exit_profit_long_tc_t_1_1_m ( 145 ) | 2 | +8U |
| exit_long_tc_u_1 ( 141 142 ) | 2 | +5U |
| exit_long_tc_d_3_2 ( 145 ) | 1 | +7U |
| exit_long_tc_d_9_1 ( 142 ) | 1 | +21U |
| exit_long_rapid_rpd_2 ( 102 ) | 1 | +11U |
| exit_profit_long_tc_t_2_1_m ( 142 ) | 1 | +5U |
| exit_short_rebuy_o_5 ( 562 ) | 1 | +4U |
| exit_long_tc_d_4_2 ( 141 ) | 1 | +10U |
| exit_long_quick_q_3 ( 46 ) | 1 | +9U |
| exit_profit_long_quick_t_0_1_m ( 46 ) | 1 | +2U |
| exit_long_normal_d_6_1 ( 1 ) | 1 | +16U |
| exit_long_normal_d_5_1 ( 4 43 63 ) | 1 | +12U |
| exit_profit_long_normal_t_0_1_m ( 2 4 5 63 143 ) | 1 | +1U |
| exit_long_rebuy_d_5_1 ( 63 ) | 1 | +4U |
| exit_long_scalp_d_6_1 ( 163 ) | 1 | +15U |
| exit_profit_long_tc_t_2_1_m ( 141 ) | 1 | +4U |
| exit_long_tc_d_4_2 ( 142 ) | 1 | +9U |
| exit_long_rapid_u_1 ( 101 ) | 1 | +3U |
| exit_short_rebuy_o_10 ( 562 ) | 1 | +7U |
| exit_long_tc_o_4 ( 145 ) | 1 | +9U |
| exit_profit_long_tc_t_5_1_m ( 142 ) | 1 | +12U |
| exit_long_tc_d_7_1 ( 145 ) | 1 | +16U |
| exit_long_tc_d_5_1 ( 143 ) | 1 | +11U |
| exit_long_tc_d_4_1 ( 142 173 ) | 1 | +9U |
| exit_long_quick_q_2 ( 47 ) | 1 | +5U |
| exit_profit_long_tc_t_1_1_m ( 144 ) | 1 | +3U |
| exit_long_tc_d_6_1 ( 143 ) | 1 | +14U |
| exit_long_rebuy_d_6_1 ( 62 ) | 1 | +5U |
| exit_short_rebuy_w_0_1 ( 562 ) | 1 | +0U |
| exit_long_tc_u_1 ( 144 ) | 1 | +3U |
| exit_long_scalp_1_1_1 ( 173 ) | 1 | +6U |
| exit_long_scalp_w_4_1 ( 173 ) | 1 | +11U |
| exit_short_rebuy_d_8_1 ( 562 ) | 1 | +6U |
| exit_profit_long_scalp_t_1_1_m ( 161 ) | 1 | +4U |
| exit_profit_long_scalp_t_3_1_m ( 173 ) | 1 | +7U |
| exit_bad_trade_abandon_103d ( 173 ) | 1 | -45U |
| exit_long_scalp_w_1_1 ( 173 ) | 1 | +2U |
| exit_long_scalp_w_2_1 ( 173 ) | 1 | +6U |
| exit_short_rebuy_3_1_1 ( 562 ) | 1 | +18U |
| exit_long_normal_u_3 ( 4 43 61 ) | 1 | +9U |
| exit_long_normal_u_4 ( 1 ) | 1 | +10U |
| exit_long_rapid_d_8_1 ( 103 ) | 1 | +20U |
| exit_long_tc_u_11 ( 145 ) | 1 | +39U |
| exit_long_rebuy_d_7_1 ( 63 ) | 1 | +6U |
| exit_profit_long_rebuy_t_1_1_m ( 63 ) | 1 | +1U |
| exit_long_tc_u_3 ( 145 ) | 1 | +7U |
| exit_long_tc_u_1 ( 145 ) | 1 | +4U |
| exit_short_rapid_rpd_1 ( 605 ) | 1 | +2U |
| exit_short_rebuy_d_6_1 ( 562 ) | 1 | +4U |
| exit_long_tc_d_3_2 ( 142 ) | 1 | +7U |
| exit_short_rebuy_w_4_1 ( 562 ) | 1 | +3U |
| exit_long_quick_q_6 ( 47 ) | 1 | +6U |
| exit_short_rebuy_w_2_1 ( 562 ) | 1 | +2U |
| exit_long_tc_2_1_1 ( 143 ) | 1 | +6U |
| exit_short_rebuy_o_2 ( 562 ) | 1 | +2U |
| exit_long_tc_6_1 ( 143 ) | 1 | +5U |
| exit_long_tc_d_4_1 ( 141 142 ) | 1 | +10U |
| exit_profit_long_rapid_t_0_1_m ( 104 ) | 1 | +0U |
| exit_profit_long_rebuy_t_2_1_m ( 62 ) | 1 | +2U |
| exit_profit_short_rapid_t_0_1_m ( 605 ) | 1 | +1U |
| exit_short_rebuy_w_1_1 ( 562 ) | 1 | +1U |
| exit_long_tc_1_1_1 ( 145 ) | 1 | +11U |
| exit_long_rebuy_w_4_1 ( 64 ) | 1 | +4U |
| exit_long_normal_d_5_1 ( 6 102 141 ) | 1 | +12U |
| exit_long_normal_d_6_1 ( 2 6 142 ) | 1 | +14U |
| exit_profit_long_tc_t_1_1_m ( 102 142 ) | 1 | +3U |
| exit_long_tc_d_7_1 ( 144 ) | 1 | +16U |
| exit_profit_long_normal_t_2_1_m ( 3 142 ) | 1 | +6U |
| exit_profit_long_scalp_t_0_1_m ( 162 ) | 1 | +2U |
| exit_bad_trade_abandon_106d ( 120 ) | 1 | -27U |
| exit_profit_long_scalp_t_2_1_m ( 161 ) | 1 | +5U |
| exit_bad_trade_abandon_100d ( 562 ) | 1 | -133U |
| exit_short_rebuy_u_1 ( 562 ) | 1 | +1U |
| exit_short_rebuy_u_2 ( 562 ) | 1 | +2U |
| exit_profit_long_scalp_t_5_1_m ( 173 ) | 1 | +13U |
| exit_profit_long_tc_t_1_1_m ( 141 ) | 1 | +3U |
| exit_long_rebuy_2_1_1 ( 64 ) | 1 | +9U |
| exit_long_scalp_3_1_1 ( 173 ) | 1 | +3U |
| exit_long_scalp_d_3_2 ( 173 ) | 1 | +7U |
| exit_long_normal_u_3 ( 6 141 ) | 1 | +7U |
| exit_profit_long_normal_t_0_1_m ( 2 ) | 1 | +0U |
| exit_long_tc_d_3_2 ( 141 ) | 1 | +9U |
| exit_long_normal_d_4_2 ( 5 ) | 1 | +9U |
| exit_long_tc_d_0_2 ( 141 ) | 1 | +1U |
| exit_long_rapid_rpd_6 ( 102 ) | 1 | +3U |
| 回測結束強制平倉 | 1 | +1U |

**最大的 5 筆虧損**

| 幣 | 方向 | 進場 | 出場 | 虧損 | 原因 |
|---|---|---|---|---|---|
| INJ | 空 | 2026-04-05 12:35 | 2026-07-14 12:35 | -17.7%（-133U） | exit_bad_trade_abandon_100d ( 562 ) |
| WLD | 多 | 2025-05-26 07:20 | 2025-09-06 00:00 | -9.7%（-45U） | exit_bad_trade_abandon_103d ( 173 ) |
| SUI | 多 | 2026-03-05 16:10 | 2026-06-20 00:00 | -4.6%（-27U） | exit_bad_trade_abandon_106d ( 120 ) |
| LDO | 空 | 2025-12-23 12:05 | 2025-12-23 17:45 | 0.3%（+0U） | exit_profit_short_rebuy_t_0_1_m ( 562 ) |
| ETH | 多 | 2025-04-06 20:55 | 2025-04-07 02:45 | 0.5%（+0U） | exit_profit_long_rebuy_t_0_1_m ( 62 ) |

**每月盈虧**（賺錢月份 22/23）

| 月份 | 盈虧 |
|---|---|
| 2025-01 | +88U |
| 2025-02 | +234U |
| 2025-03 | +156U |
| 2025-04 | +35U |
| 2025-05 | +55U |
| 2025-06 | +38U |
| 2025-07 | +53U |
| 2025-08 | +19U |
| 2025-09 | +4U |
| 2025-10 | +169U |
| 2025-11 | +140U |
| 2025-12 | +37U |
| 2026-01 | +25U |
| 2026-02 | +33U |
| 2026-03 | +7U |
| 2026-04 | +15U |
| 2026-05 | +20U |
| 2026-06 | +109U |
| 2026-07 | -116U |
| 2026-08 | +10U |
| 2026-09 | +84U |
| 2026-10 | +77U |
| 2026-11 | +16U |