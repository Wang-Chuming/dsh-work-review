---
type: task
domain: life
title: "固定测试 fixture"
status: 排队中
area: tools
created: 2026-10-25
updated: 2026-10-27
tags:
  - testing
---

# 固定测试 fixture

## 详情

用仓库内自包含、虚构内容的 fixture vault 替换测试对真实目录的依赖。

## 验收

- `node --test test/` 在任意机器上全绿。
- fixture 内不出现私有路径或个人信息。
