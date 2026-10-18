# V1 · 相似评级工作台的PDF流程复用

版本：V1，2026-10-18。状态：CSA已接入通用持久存储和方法适配模块、离线验证通过；完整真实报告对照未完成。第二个工作台尚未迁移。
运行及交接规则：`HANDOFF.md`、`ARCHITECTURE.md`。

## 1. 复用什么

MSCI、CSA、CDP、Wind 等工作台通常都包含上传、文件指纹、分页、证据、模型请求、进度、人工备注和导出。共享这些处理能力，各自保留题库、方法年度、评分逻辑、证据要求和输出格式。相似界面不能作为底层已经兼容的证据，接入前逐仓库检查。

采用“共享处理引擎 + 评级适配器”。第一阶段在CSA项目内实现清楚边界；第二个工作台接入成功后，再抽出独立版本化Python包，通过固定版本依赖复用，避免多处复制源码后分别维护。现有工作台是Python后台的可优先接入；纯前端或其他语言项目先评估桥接，不直接搬用CSA服务。

## 2. 稳定的数据契约

| 记录           | 需要字段/约束                                 |
| ------------ | --------------------------------------- |
| Document     | PDF内容指纹、物理页数；名称、来源URL、公开性、资料类型、覆盖期间另有版本 |
| MethodRecord | 评级命名空间、行业、方法年度/版本、题目ID、完整方法内容和schema指纹  |
| Evidence     | Document指纹、原PDF物理页、连续原文、可复核定位、不确定性、内容指纹 |
| Coverage     | 题目/方法指纹、实际已查页段、阅读协议、模型、是否完整、截断/拒绝状态     |
| Assessment   | 方法指纹、证据集合、全部输入报告清单/元数据、项目背景、模型/提示词/验证版本 |
| HumanReview  | 用户备注、确认状态、修改时间；独立于模型结果，重跑不得覆盖           |
| Usage        | 每次真实调用的输入/输出/缓存usage、所属阶段、重试信息和计价依据日期   |

共用的是有定位的原文证据。按题检索覆盖和评级结果必须按评级体系/版本隔离；不能因为两套题目都叫“气候战略”就共享评估结论。跨工作台共享公司的私有资料缓存须有明确范围，默认各项目隔离。

## 3. 评级适配器最小接口（设计稿）

```python
class RatingAdapter:
    namespace: str                 # csa / msci / cdp / wind
    contract_version: str

    def load_methods(self, selection, project): ...
    def canonical_method(self, question): ...  # 与该工作台方法Excel相同记录
    def scan_hints(self, methods): ...
    def build_assessment(self, methods, evidence, project): ...
    def validate_result(self, result, methods, evidence, project): ...
    def export_records(self, methods, results, human_reviews): ...
```

共享引擎负责持久存储、指纹、任务规划、PDF/页码处理、GLM请求、重试边界、证据去重和usage。适配器负责题目筛选、方法、提示词、证据适用规则、状态和导出映射。不要在共享引擎里写CSA行业代码、公开证据判定或某一评级的分数逻辑。

接口为实施目标，不代表这些类已经存在；实施时选择最少接口，避免空抽象和多层转发。

## 4. 每个新工作台的接入顺序

1. 记录实际仓库、启动方法、后端语言、项目保存格式、PDF处理和方法来源；按“可直接共用/需适配/评级专属/尚不清楚”列差异。
2. 保存原版，选一份已获授权的真实报告和6–12道代表题建立基线；保留旧路径作为开关回退。
3. 接入存储、任务检查点和usage；先验证重启恢复、缓存失效和人工备注保护。
4. 实现该评级的适配器，使方法Excel和AI都读取同一份完整方法记录，逐字段核对。
5. 接入证据去重和请求分批；保留本评级所需表格、期间、单位和计算/选择逻辑。
6. 对照冷启动、相同输入复跑、单题修改、新增报告、模型切换及故障恢复，记录真实Token和关键证据召回。
7. 全部通过后开启新流程，记录共享包版本、适配器版本和回退方法；仍由各项目自己的导出器输出Excel。

至少用第二个实际工作台完成接入后，再认定共享接口已验证；本轮CSA改造不代表其他工作台已迁移。

## 5. 可交给其他工作台助手的接入指令

> 请先阅读CSA项目的 `docs/HANDOFF.md`、`docs/ARCHITECTURE.md` 和 `docs/WORKBENCH-PIPELINE-REUSE.md`。核对共享组件是否已实现及版本，再检查本工作台源码。复用持久缓存、断点续跑、增量任务、证据去重与Token统计，实现本评级适配器；保留本工作台题库、评分语义、人工备注和Excel格式。先保存基线，通过方法Excel与AI输入一致性、真实PDF对照和故障恢复检查后切换。不要直接复制CSA题库、Full限制、行业映射或状态判定。若语言/架构不兼容，先提交具体桥接方案。

## 6. 收益与长期成本

可确定的收益是相同输入重复调用减少、失败续跑范围缩小、修复可在共享包中统一维护。首次新报告仍需准确阅读，首次节省幅度要逐工作台实测。

长期成本包括接口版本管理、缓存迁移、资料隔离、失效规则维护和各评级适配器验证。先接CSA再接一个真实工作台，可以用较小代价发现接口差异；不要一次改写所有工作台。


## 7. 当前实际可接入的代码

| 实际模块 | 当前能力 | 接入方式 |
| --- | --- | --- |
| `pipeline/workbench_runtime.py` | SQLite条目/任务/usage，指纹和运行上下文 | 纯Python标准库；指定自己的数据库路径及namespace |
| `pipeline/csa_adapter.py` | `CSAAdapter.load_methods()`、`canonical_method()` | 作为方法适配结构示例，各评级实现自己的方法读取/字段契约 |
| `pipeline/native_pdf.py` | CSA阅读/核验/结果复用、证据表和长度分批 | 仍含CSA语义，先审查后抽取通用部分，不能整文件换名接入 |


下一工作台建议先接入存储和任务断点，以最小变更取得重跑收益，再处理模型请求共享。下例只是安全缓存边界的用法，不是可替代完整评估器的实现：

```python
from workbench_runtime import Store, fingerprint

store = Store(path=app_data_dir / 'pipeline-cache.sqlite3')
namespace = 'msci'  # 每个评级独立
key = fingerprint([namespace, project_scope, pdf_sha256,
                   complete_method_record, reader_contract, model_id])
# verified_read必须包含实际页段覆盖和待核实记录；完整阅读通过后才能写入。
store.put(namespace, key, verified_read)
restored = store.get(namespace, key)
```

初评缓存还须加入全部报告清单/元数据、证据、项目期间、结果验证和提示词版本；不得仅用上面的阅读键缓存最终结论。人工意见存放在原工作台项目中，继续与模型结果分离。不同项目默认使用独立缓存目录或项目范围，不自动共用私有资料。


## 8. V1接入限制与配置

共享层实际已实现的是Store/Run、指纹、任务/usage落盘及请求前控制钩子；完整分页与模型评估编排仍在CSA模块。`RatingAdapter`六项接口是接入目标，当前CSAAdapter只实现方法读取和规范化两个接口，不能宣称通用引擎已全部实现。

缓存默认开启，`WORKBENCH_CACHE_ENABLED=0`关闭；共用证据表默认关闭，`WORKBENCH_COMPACT_ENABLED=1`仅用于有界对照。每个工作台指定独立 `WORKBENCH_CACHE_PATH` 和命名空间，另把公司/项目范围、完整方法/源码合同与模型纳入键。任务快照仅存白名单字段，凭据由各工作台现有内存机制提供。暂停/停止在请求前钩子检查，正在执行的请求允许正常返回。

复制共享组件后，先跑本评级的隔离、失效、断点和人工备注测试，再接一份真实报告。当前真实GLM完整冷启动对照未完成，因此不要将“两份报告预计费用”或CSA的局部恢复结果当成其他工作台的实测收益。模块提取以第二个工作台真实接通为后续验收点。
