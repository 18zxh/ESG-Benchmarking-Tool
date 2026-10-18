import { useEffect, useState } from "react";
import { api, upload, downloadJson } from "./api";
import { Button, Field, Empty, Notice, Status } from "./ui";
import { SchemaForm } from "./SchemaForm";
import { metadataSchema } from "./schema";
import type { Common, Method, Criterion } from "./types";
import type { RJSFSchema } from "@rjsf/utils";
const phaseNames: Record<string, string> = {
  csa: "CSA",
  msci: "MSCI",
  mainland: "大陆交易所",
  hkex: "港交所",
  benchmark: "横向对标",
};
export function SettingsPage({ boot, refresh, report, fail }: Common) {
  const [key, setKey] = useState(""),
    [baseUrl, setBaseUrl] = useState("https://open.bigmodel.cn/api/paas/v4"),
    [model, setModel] = useState("glm-5.3-flash"),
    [busy, setBusy] = useState(false);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>设置</h1>
          <p>全局模型连接、数据备份与运行信息。</p>
        </div>
      </div>
      <section className="section">
        <h2>共享模型连接</h2>
        <p>
          {boot.providers.length
            ? "当前已登记 " + boot.providers[0].model
            : "尚未连接模型。"}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api("/api/v1/providers", { apiKey: key, model, baseUrl });
              setKey("");
              await refresh();
              report(
                "共享连接已登记。实际可用性在首次调用时验证；密钥只保留在服务内存。",
              );
            } catch (error) {
              fail(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <Field label="GLM官方接口地址">
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
              />
            </Field>
            <Field label="模型">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option>glm-5.3-flash</option>
                <option>glm-5.3-flashx</option>
              </select>
            </Field>
            <Field label="API Key（仅进程内存）">
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                required={!boot.providers.length}
              />
            </Field>
          </div>
          <Button disabled={busy}>登记共享连接</Button>
        </form>
        <p className="muted">
          重启服务后需重新连接。模型任务会将选中的PDF副本、方法与证据发送至该官方接口。
        </p>
      </section>
      <section className="section">
        <h2>数据与备份</h2>
        <p>完整备份包含原PDF、项目、评估记录、独立评论、历史及方法版本。</p>
        <div className="actions">
          <Button variant="outline" asChild>
            <a href="/api/v1/backup" download>
              下载完整本机备份
            </a>
          </Button>
          <a href="/api/v1/usage" target="_blank" rel="noreferrer">
            查看实际模型调用记录
          </a>
        </div>
        <details>
          <summary>如何恢复完整备份</summary>
          <p>
            恢复到尚不存在的新目录，校验后启动该资料库；已有数据不会被覆盖。
          </p>
          <pre>
            .runtime/unified-python/bin/python -m unified.backup restore
            /完整路径/备份.zip --target /完整路径/新的资料目录{`\n`}
            .runtime/unified-python/bin/python -m unified.server --port 8791
            --data-dir /完整路径/新的资料目录
          </pre>
        </details>
      </section>
      <section className="section" id="method-maintenance">
        <h2>方法论维护</h2>
        <p>
          各标准和交易所使用各自原有的方法与来源。需要更新时，由 AI
          协助修订，核对官方来源、适用年度和完整要求后更新，保留版本记录。
        </p>
        <div className="actions">
          <a href="/csa/#/methods">CSA 方法与来源</a>
          <a href="/msci/#/methodology">MSCI 方法与来源</a>
          <a href="/exchange/#/mainland/knowledge">大陆交易所指引</a>
          <a href="/exchange/#/hk/knowledge">港交所指引</a>
        </div>
      </section>
    </>
  );
}

export function MethodsPage({ report, fail }: Pick<Common, "report" | "fail">) {
  const [methods, setMethods] = useState<Method[]>([]),
    [selected, setSelected] = useState<Method>(),
    [rows, setRows] = useState<Criterion[]>([]),
    [query, setQuery] = useState(""),
    [current, setCurrent] = useState(""),
    [raw, setRaw] = useState(""),
    [changed, setChanged] = useState(false),
    [busy, setBusy] = useState(false),
    [validation, setValidation] = useState<{
      valid: boolean;
      errors: string[];
    }>(),
    [diff, setDiff] = useState<any[]>([]),
    [ack, setAck] = useState(false);
  const refresh = async () =>
    setMethods((await api<{ methods: Method[] }>("/methods")).methods);
  useEffect(() => {
    refresh().catch(fail);
  }, []);
  const select = async (id: string) => {
    const value = await api<{ method: Method; criteria: Criterion[] }>(
      "/methods/" + id,
    );
    setSelected(value.method);
    setRows(value.criteria);
    setRaw(JSON.stringify(value.method.payload, null, 2));
    setCurrent("");
    setValidation(undefined);
    setDiff((await api("/methods/" + id + "/diff")).changes);
    setAck(false);
    setChanged(false);
  };
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const editing = selected?.status === "draft";
  const update = (payload: Record<string, any>) => {
    if (!selected) return;
    setSelected({ ...selected, payload });
    setRaw(JSON.stringify(payload, null, 2));
    setChanged(true);
    setValidation(undefined);
    setAck(false);
  };
  const item = selected
    ? (selected.module === "csa"
        ? selected.payload.questions
        : selected.module === "msci"
          ? selected.payload.criteria
          : selected.payload.rules.topics
      ).find((c: any) => c.id === current)
    : undefined;
  const fieldLabels: Record<string, string> =
    selected?.module === "csa"
      ? {
          title: "英文题名",
          titleZh: "中文题名",
          layout: "完整问题原文",
          layoutZh: "完整问题中文",
          guidance: "完整指南原文",
          guidanceZh: "完整指南中文",
          sourceFile: "来源文件",
          page: "来源起始物理页",
          endPage: "来源结束物理页",
        }
      : selected?.module === "msci"
        ? {
            title: "指标名称",
            title_en: "指标英文名称",
            definition: "完整定义",
            definition_en: "完整英文定义",
            scoring_rule: "评分规则（没有官方数值标尺时留空）",
          }
        : {
            name: "议题／指标名称",
            clause: "对应条款",
            requirement: "完整检查要求",
            sourceText: "完整条文原文",
          };
  const itemValue =
    selected?.module === "msci"
      ? item?.criterion
      : selected?.module === "hkex" && item
        ? { ...item, question: item.assessmentQuestion?.question || "" }
        : item;
  if (selected?.module === "hkex")
    (fieldLabels as Record<string, string>).question =
      "完整评估问题（实际模型输入）";
  const itemSchema: RJSFSchema = {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(fieldLabels).map(([key, label]) => [
        key,
        {
          type: key === "page" || key === "endPage" ? "integer" : "string",
          title: label,
        },
      ]),
    ),
  };
  const applyItem = (value: Record<string, any>) => {
    if (!selected || !item) return;
    const payload = structuredClone(selected.payload);
    const collection =
      selected.module === "csa"
        ? payload.questions
        : selected.module === "msci"
          ? payload.criteria
          : payload.rules.topics;
    const index = collection.findIndex((c: any) => c.id === current);
    if (selected.module === "msci")
      collection[index].criterion = {
        ...collection[index].criterion,
        ...value,
      };
    else {
      collection[index] = { ...collection[index], ...value };
      if (selected.module === "hkex") {
        collection[index].assessmentQuestion = {
          ...collection[index].assessmentQuestion,
          question: value.question,
        };
        delete collection[index].question;
      }
    }
    update(payload);
  };
  const save = async () => {
    if (!selected) return;
    const payload = JSON.parse(raw);
    await api("/methods/" + selected.id, {
      version: selected.version,
      sourceNote: selected.sourceNote,
      payload,
    });
    await select(selected.id);
    await refresh();
    report("方法草稿已保存，尚未发布。");
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>方法论维护</h1>
          <p>来源与方法按版本保存；发布后不会改写已有项目。</p>
        </div>
      </div>
      <Notice>
        这是本机维护工作区。新方法先复制为草稿，核对来源、完整条件与版本差异后发布。
      </Notice>
      <div className="maintenance-grid">
        <aside className="method-list" aria-label="方法版本列表">
          {methods.length ? (
            methods.map((m) => (
              <button
                key={m.id}
                className={selected?.id === m.id ? "selected" : ""}
                onClick={() => void perform(() => select(m.id))}
              >
                <strong>
                  {phaseNames[m.module]} · {m.version}
                </strong>
                <small>
                  {m.status === "draft"
                    ? "草稿"
                    : m.isDefault
                      ? "新项目默认版本"
                      : "已发布版本"}
                </small>
              </button>
            ))
          ) : (
            <p>先在评估项目中载入适用方法，来源基线会出现在此处。</p>
          )}
        </aside>
        <article>
          {!selected ? (
            <Empty title="选择一个方法版本">
              <p>
                可查看完整要求、复制草稿、导入修订、校验、预览或回滚默认版本。
              </p>
            </Empty>
          ) : (
            <>
              <div className="section-heading">
                <h2>
                  {phaseNames[selected.module]} · {selected.version}
                </h2>
                <Status value={selected.status} />
              </div>
              <p className="muted">版本指纹：{selected.hash}</p>
              <div className="actions">
                {editing ? (
                  <Button
                    disabled={busy || !changed}
                    onClick={() => void perform(save)}
                  >
                    保存草稿
                  </Button>
                ) : (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const draft = await api<Method>(
                            "/methods/" + selected.id + "/draft",
                            {},
                          );
                          await refresh();
                          await select(draft.id);
                        })
                      }
                    >
                      复制为新草稿
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await api("/methods/" + selected.id + "/default", {});
                          await refresh();
                          report(
                            "已将此已发布版本设为新项目默认版本；已有项目不变。",
                          );
                        })
                      }
                    >
                      设为新项目默认版本
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  onClick={() =>
                    downloadJson(
                      selected.version + "-完整方法包.json",
                      selected,
                    )
                  }
                >
                  导出方法包 JSON
                </Button>
              </div>
              {editing ? (
                <>
                  <SchemaForm
                    schema={metadataSchema}
                    value={{
                      version: selected.version,
                      sourceNote: selected.sourceNote,
                    }}
                    onChange={(v) => {
                      setSelected({ ...selected, ...v });
                      setChanged(true);
                      setValidation(undefined);
                      setAck(false);
                    }}
                  />
                  <label className="field">
                    <span>导入修订方法包 JSON</span>
                    <input
                      type="file"
                      accept=".json,application/json"
                      disabled={busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        void perform(async () => {
                          const value = JSON.parse(await f.text());
                          if (value.module && value.module !== selected.module)
                            throw new Error("导入的方法模块不匹配。");
                          update(value.payload || value);
                          report("修订已载入页面，请核对、保存并校验。");
                        });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>补充方法来源 PDF</span>
                    <input
                      type="file"
                      accept=".pdf,application/pdf"
                      disabled={busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        void perform(async () => {
                          const doc = await upload(f);
                          update({
                            ...selected.payload,
                            sourceDocuments: [
                              ...(selected.payload.sourceDocuments || []),
                              { id: doc.id, name: f.name, sha256: doc.sha256 },
                            ],
                          });
                          report(
                            "来源PDF已登记，请在来源说明与各条目中核对引用和页码。",
                          );
                        });
                      }}
                    />
                  </label>
                </>
              ) : (
                <p className="preserve">{selected.sourceNote}</p>
              )}
              <section className="section">
                <h3>条目维护与预览</h3>
                <input
                  aria-label="搜索方法条目"
                  placeholder="搜索题名或分组"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  aria-label="选择维护条目"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                >
                  <option value="">选择条目</option>
                  {rows
                    .filter((c) => [c.title, c.group].join(" ").includes(query))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.group} · {c.title}
                      </option>
                    ))}
                </select>
                {itemValue ? (
                  <>
                    <p className="muted">条目身份：{current}</p>
                    {editing ? (
                      <SchemaForm
                        schema={itemSchema}
                        value={itemValue}
                        onChange={applyItem}
                      />
                    ) : (
                      <div>
                        <h3>{rows.find((c) => c.id === current)?.title}</h3>
                        <p className="preserve">
                          {rows.find((c) => c.id === current)?.requirement}
                        </p>
                        <p className="preserve">
                          {rows.find((c) => c.id === current)?.detail}
                        </p>
                      </div>
                    )}
                  </>
                ) : null}
                <details>
                  <summary>完整方法与适用条件 JSON</summary>
                  <p>
                    用于批量导入、增删条目、香港关联条文和对标口径等高级维护。复杂结构变化需适配器支持。
                  </p>
                  <textarea
                    className="code-editor"
                    aria-label="完整方法 JSON"
                    readOnly={!editing}
                    value={raw}
                    onChange={(e) => {
                      setRaw(e.target.value);
                      setChanged(true);
                      setValidation(undefined);
                      setAck(false);
                    }}
                  />
                </details>
              </section>
              <section className="section">
                <h3>版本差异</h3>
                <p className="muted">
                  保存草稿后比较；完整JSON中的方法或适用条件变化也需核对。
                </p>
                {diff.length ? (
                  diff.map((d, i) => (
                    <details key={i}>
                      <summary>
                        {d.change} · {d.id}
                      </summary>
                      <div className="diff-columns">
                        <pre>{JSON.stringify(d.before, null, 2)}</pre>
                        <pre>{JSON.stringify(d.after, null, 2)}</pre>
                      </div>
                    </details>
                  ))
                ) : (
                  <p>当前没有已保存的条目展示差异，完整方法包仍可导出核对。</p>
                )}
              </section>
              {editing ? (
                <section className="section">
                  <h3>校验与发布</h3>
                  <Button
                    variant="outline"
                    disabled={busy || changed}
                    onClick={() =>
                      void perform(async () =>
                        setValidation(
                          await api(
                            "/methods/" + selected.id + "/validate",
                            {},
                          ),
                        ),
                      )
                    }
                  >
                    校验已保存草稿
                  </Button>
                  {changed ? (
                    <p className="muted">先保存页面中的修改，再校验发布。</p>
                  ) : null}
                  {validation ? (
                    <div role="status">
                      <p>
                        {validation.valid
                          ? "结构校验通过。请继续核对官方来源及实际适用条件。"
                          : "校验未通过："}
                      </p>
                      {validation.errors.map((e) => (
                        <p className="error" key={e}>
                          {e}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    我已核对官方来源、完整适用条件及本次变更内容
                  </label>
                  <Button
                    disabled={busy || changed || !validation?.valid || !ack}
                    onClick={() =>
                      void perform(async () => {
                        await api("/methods/" + selected.id + "/publish", {
                          acknowledged: ack,
                        });
                        await refresh();
                        await select(selected.id);
                        report(
                          "新版本已发布并用于新项目；旧项目继续绑定原版本。",
                        );
                      })
                    }
                  >
                    发布新版本
                  </Button>
                </section>
              ) : null}
            </>
          )}
        </article>
      </div>
    </>
  );
}
