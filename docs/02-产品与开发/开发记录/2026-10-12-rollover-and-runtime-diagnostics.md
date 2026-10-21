# 待办顺延与运行诊断 Implementation Plan

> For agentic workers: use independent tasks with file ownership and review before integration.

**Goal:** 未完成待办自动跨天顺延，记录运行、挂起、异常退出，并定期依据新日志优化。

**Architecture:** 沿用本地 JSON 待办及 30 秒调度器；补足启动和跨天刷新。Electron 主进程记录结构化状态及错误，独立 Node 监测进程接收心跳并记录失联/恢复/退出，本地 crashReporter 保留原生转储，不上传。Codex 当前聊天每两小时检查新诊断记录，只有新问题或已验证修复时通知。

**Tech Stack:** Electron 44、Node.js、node:test、Codex heartbeat automation。

## Constraints

- 只移动未完成且过去日期的计划日期；保留已完成和未来待办、真实截止时间，避免重复顺延。
- 日志不记录密钥、完整聊天、任务正文；记录时间、PID、会话 ID、错误栈、相关操作和内存指标。
- 休眠、系统整体暂停和正常退出不应产生挂起/闪退误报；异常退出也可能来自外部终止，需要保留判断限制。
- 不基于猜测反复修改；用新证据、最小修复和有意义的回归验证持续优化。
- 本项目没有 Git，不创建提交或分支。测试用临时数据，不调用模型；若后续需要模型，只调用 gpt-6-luna。

## Tasks

- [x] 待办：先添加跨天、启动、跳过日期、重复检查及界面刷新回归，再修复 services.js/scheduler.js，记录顺延条数和日期。
- [x] 日志：先验证异常栈与敏感字段脱敏，再更新 logger.js，保留按日期轮转和刷新接口。
- [x] 监测：先测试心跳缺失、恢复、正常/异常断连、睡眠避免误报，再新增 runtime-diagnostics.js/runtime-watchdog.js 并接入 main.js。
- [x] 渲染：捕获 error/unhandledrejection，接入有界白名单 IPC；记录 renderer/GPU/utility 退出和本地原生崩溃转储。
- [x] 验证：回归、隔离 Electron 中模拟阻塞/异常退出，确认独立进程能落盘；审核后重启实际项目并检查启动日志。
- [x] 持续优化：创建当前聊天 heartbeat，每两小时读取增量日志，安静跳过无新增问题的运行，基于证据修复并记录验证。

## Completion evidence

2026-10-12：80/80 回归、12 个 JavaScript 文件语法检查、六种隔离 Electron 故障场景及完整面板验证通过。实际监测捕获了主进程 57 秒停顿和恢复；仍无充分证据确定根因。随后补充成对同步操作上下文，修复 DOMException 丢失详情及正常日志同步 stderr 镜像风险，回归验证通过并于 12:44 重启生效，主进程 PID 29428、监测 PID 27768。

已建立每两小时的当前聊天巡检（automation ID：automation），增量游标保存在 data/diagnostics/stability-review.json。详细运行记录、限制与验证见 docs/02-产品与开发/开发记录/07-稳定性排查与面板更新.md。
