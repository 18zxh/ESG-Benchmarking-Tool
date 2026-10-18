# 静态规则数据编制规范（B1）

版本：2024-05-01.20261015-v1。日期：2026-10-15。

依据：memory-bank/design-document.md 2.1、2.3；memory-bank/implementation-plan.md N3及B1—B13。条文内容以本地三份2024年试行版指引原文为权威，PRD及对比分析用于产品结构与核对维度。未联网核对后续修订，不称为2026年现行最新规则。

## 必填字段与约束

| 字段 | 类型及取值约束 | 规则 |
| --- | --- | --- |
| exchange | string：sh / sz / bj | 必须与文件名一致 |
| boardOptions | string[] | sh为[主板,科创板]；sz为[主板,创业板]；bj为[]，顺序固定 |
| guideline | object | 以下字段全部必填 |
| guideline.number | 非空string | 上证发〔2024〕33号 / 深证上〔2024〕284号 / 北证公告〔2024〕14号 |
| guideline.name | 非空string | 对应14号/17号/11号指引全称 |
| guideline.articles | integer | sh/sz=63，bj=62 |
| guideline.chapters | integer | 三所均6 |
| guideline.effectiveDate | YYYY-MM-DD string | 2024-05-01 |
| topics | object[] | 恰好21行，三所同id同名同序，无重复id |
| topics[].id | 非空string | 稳定ASCII ID；参见下方固定清单 |
| topics[].dimension | string枚举 | environment / social / governance，分布8/9/4 |
| topics[].name | 非空string | 按索引统一议题名称 |
| topics[].clause | 非空string | 中文第N条；气候为21—28，SME条款后注精确门槛 |
| topics[].requirement | 非空string | N3模型生成概述，全量逐条对照原文核验；不扩大、削弱或增加义务 |
| topics[].governanceDefault | boolean | 仅治理4项为true，其余17项为false；只表示默认检查范围 |

## 增补字段

| 字段 | 类型及用途 |
| --- | --- |
| version | 稳定string，本次2024-05-01.20261015-v1；用于项目及缓存绑定 |
| guideline.publicationDate / version | 发布日期2024-04-12 / 2024-04-12（试行） |
| source | 各所来源文件、SHA-256、原件格式/页数、索引可用性和定位说明 |
| interpretation | 概述与原文关系及适用条件提示 |
| topics[].sourceArticles | integer[]；真实管辖条款号，气候8条，其余1条 |
| topics[].sourcePath / sourceOriginalPath | 项目根目录相对路径，不含用户机器绝对路径 |
| topics[].sourcePages | integer[]，PDF物理页1起算；北交所DOCX无稳定物理页，保留[] |
| topics[].sourceLines | [起始行,结束行]，Markdown行号1起算，含首尾 |
| topics[].sourceText | 全部对应条款原文，仅合并Markdown硬换行；原文与概述分存 |

## 编制规则

- 原件、Markdown及用户PRD/原规划文件只读保留。源文件hash随source-manifest.json保存，校验源文件变化。
- 三所规则各自独立；共同字段为id、name、dimension、governanceDefault、sourceArticles；clause和requirement可按所别不同。source等来源定位字段自然按所不同，不算业务字段漂移。
- 第46条“超过”是严格大于，不能写成达到/不少于；余额含应付票据。沪深为超过300亿元**或**超过总资产50%；北仅超过总资产50%。第二款公示情形独立，不附加首款门槛。
- 第28条沪深保留“已取得的审批或认证”“已具备的规模化生产能力”；北保留“是否取得必要的审批或认证”“是否已具备规模化生产能力”。
- 创新驱动、尽职调查等鼓励性内容不改成普遍强制。污染物、废弃物、生物多样性、科技伦理等保留条件。
- 通用披露框架（5、7、11条）与具体条款结合使用。21项默认选择、检查或导出不等于判定客户官方适用。
- 北交所原件无附表的事实单列来源限制，按正文逐项核对；不补造原附表或物理页码。
- requirement是模型生成并全量复核后的摘要，不代替sourceText原文；approved hash只用于发现文案漂移，不能代替语义核验。
- 知识库topicComparison只存topicId和三所规则集引用；显示名、条款、要求从当前规则集加载。baseline只用于编制核对。

## 固定议题清单

| 序号 | ID | 维度 | 名称 | 正文条款 |
| --- | --- | --- | --- | --- |
| 1 | climate | environment | 应对气候变化 | 21—28 |
| 2 | pollutants | environment | 污染物排放 | 30 |
| 3 | waste | environment | 废弃物处理 | 31 |
| 4 | biodiversity | environment | 生态系统和生物多样性保护 | 32 |
| 5 | environment_compliance | environment | 环境合规管理 | 33 |
| 6 | energy | environment | 能源利用 | 35 |
| 7 | water | environment | 水资源利用 | 36 |
| 8 | circular_economy | environment | 循环经济 | 37 |
| 9 | rural_revitalization | social | 乡村振兴 | 39 |
| 10 | social_contribution | social | 社会贡献 | 40 |
| 11 | innovation | social | 创新驱动 | 42 |
| 12 | technology_ethics | social | 科技伦理 | 43 |
| 13 | supply_chain | social | 供应链安全 | 45 |
| 14 | sme_fair | social | 平等对待中小企业 | 46 |
| 15 | product_quality | social | 产品和服务安全与质量 | 47 |
| 16 | data_privacy | social | 数据安全与客户隐私保护 | 48 |
| 17 | employees | social | 员工 | 50 |
| 18 | due_diligence | governance | 尽职调查 | 52 |
| 19 | stakeholder_communication | governance | 利益相关方沟通 | 53 |
| 20 | anti_bribery | governance | 反商业贿赂及反贪污 | 55 |
| 21 | anti_unfair_competition | governance | 反不正当竞争 | 56 |

## 知识库字段

- modules.json：version和7个modules[id,name,dataPath]；id/name严格依设计2.3，路径为项目相对路径。
- exchange_diff.json：topicComparison 21行[topicId,topicName,sourceMode,sh,sz,bj,baseline]；sh/sz/bj为data/ruleset/{exchange}.json#{topicId}引用。structuralDiff 7行[dimension,sh,sz,bj,sources]；commonality 6行[dimension,content,sources]。
- disclosure.json：3行rows[exchange,name,content,sources]；解释模块无强制判定功能。
- terms.json：22行terms[id,term,definitions{sh,sz,bj},sources]；第59条三所释义原文分列。
- framework.json：9段sections[id,title,content,sources]。
- transition.json：5行rows[id,title,sh,sz,bj,sources]，CSR与过渡缓释分行。
- fulltext.json：3个guides[exchange,guideline,source,articles]；articles[number,label,text,source]共188条（63+63+62），source包含源路径、条款、物理页/行号、规则版本。
- sources均指向实际所别条款，不能缺条款/规则版本。数据只读随源码分发，不含密钥或客户报告。

## 复跑

项目正式目录：`.venv/bin/python pipeline/validate_rulesets.py --self-test --json`。
验证不修改输入；故意改坏枚举仅发生在临时副本，报告必须包含文件和topics[0].dimension；退出码0表示静态机器检查与该故障注入测试通过。语义核验依据verification.json和memory-bank/ruleset-verification.md单列。
