# ADR-0008：Cordis 作为候选后台插件底座

- 状态：Proposed
- 日期：2026-10-26
- 依据：负责人同意记录优先验证 Cordis 的建议及其限制；未确认最终包/版本或实现。

## 背景

Eating 需要插件依赖、生命周期和注册撤销；全部自建会逐步维护一个通用插件框架。Cordis 与当前 Node.js/TypeScript Host 候选相符，但不等于提供完整产品扩展和权限边界。

## 决策提议

在 Node.js/TypeScript 方案下优先验证 Cordis。Eating 定义自己的通讯/Harness/界面业务契约，内部适配 Cordis 的装配与清理；前端注册机制、安装批准、独立进程和 OS 权限由相应宿主层负责。

不因采用 Cordis 自动绑定 DSH，不共用 DSH 的内部 Context，不默认采用 Vue WebUI，也不把 Cordis API 直接变成所有模块的跨进程数据契约。

## 原因与备选

优先复用依赖/生命周期能力；保留最小注册表作为实验备选。独立进程与 Cordis 可组合，按风险选择。若 Host 语言或维护条件改变，应重新评估，而非增加无需求的双 Host。

## 影响与风险

上游所核版本为 4.0.0-rc.12，README 明示 API 未稳定；DSH vendor 为 @deepseek-ai/cordis 4.0.5，不能据名称/数字认定兼容。现成 WebUI 是 Vue 生态；React 自注册尚需设计。scope 不是进程/安全沙箱。

## 验证依据与后续

固定 SHA、官方链接及未验证范围见[Cordis 评估](../technical/Cordis选型评估.md)。通过 Phase 0B 的真实插件依赖、清理和面板贡献实验，再决定具体包、版本及是否 Accepted。当前无安装和运行证据。

替代关系：无；实现 [ADR-0007](ADR-0007-插槽式模块与界面注册.md) 的候选技术，不覆盖其产品原则。
